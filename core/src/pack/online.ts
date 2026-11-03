import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cfHashes, type CfFile } from "../content/curseforge";
import { fileHashes, type ModrinthClient, type ModrinthVersion } from "../content/modrinth";
import type { ModpackOrigin } from "../mc/instances";
import type { HashSpec } from "../net/download";
import { AbortError, throwIfAborted } from "../util/async";
import { ensureDir } from "../util/fsx";
import { cdnCandidates } from "./cf-pack";
import { installPack, type PackDeps, type PackHooks, type PackInstallResult } from "./install";
import { PackError } from "./types";

export interface OnlineDeps extends PackDeps {
  modrinth: ModrinthClient;
  /** Scratch folder; downloaded archives live in `<workDir>/packs` until the install finishes. */
  workDir: string;
}

export interface OnlinePackRequest {
  source: "modrinth" | "curseforge";
  /** Modrinth project id / slug, or CurseForge mod id. */
  projectId: string;
  /** Modrinth version id or CurseForge file id; the newest release when omitted. */
  versionId?: string;
  name?: string;
  signal?: AbortSignal;
  hooks?: PackHooks;
  skipOptional?: boolean | string[];
  concurrency?: number;
}

export interface LatestPack {
  versionId: string;
  version: string;
  publishedAt?: string;
  changelog?: string;
}

function pickModrinthVersion(versions: ModrinthVersion[]): ModrinthVersion | undefined {
  const withPack = versions.filter((version) => version.files.some((file) => file.filename.toLowerCase().endsWith(".mrpack")));
  return withPack.find((version) => version.version_type === "release") ?? withPack[0];
}

function pickCurseForgeFile(files: CfFile[]): CfFile | undefined {
  const sorted = [...files].filter((file) => file.isAvailable !== false).sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate));
  return sorted.find((file) => file.releaseType === 1) ?? sorted[0];
}

async function downloadArchive(deps: OnlineDeps, urls: string[], dest: string, size: number | undefined, hashes: HashSpec | undefined, label: string, request: OnlinePackRequest) {
  await ensureDir(join(deps.workDir, "packs"));
  request.hooks?.stage?.("pack-download");
  const run = await deps.install.env.engine.run([{ urls, dest, size, hash: hashes, label }], {
    signal: request.signal,
    onProgress: (progress) => request.hooks?.progress?.(progress, "pack-download"),
  });
  if (run.cancelled) throw new AbortError();
  if (!run.ok) throw new PackError(`整合包下载失败：${run.failed[0]?.error ?? "未知错误"}`, "failed");
}

/** Download a modpack from Modrinth or CurseForge and install it as a new instance. */
export async function installOnlinePack(deps: OnlineDeps, request: OnlinePackRequest): Promise<PackInstallResult> {
  const router = deps.install.env.router;
  throwIfAborted(request.signal);
  let archive: string;
  let origin: Partial<ModpackOrigin>;

  if (request.source === "modrinth") {
    request.hooks?.stage?.("pack-lookup");
    const project = await deps.modrinth.project(request.projectId, request.signal);
    const version = request.versionId ? await deps.modrinth.version(request.versionId, request.signal) : pickModrinthVersion(await deps.modrinth.versions(project.id, {}, request.signal));
    if (!version) throw new PackError("这个整合包没有可用的 .mrpack 版本", "failed");
    const file = version.files.find((entry) => entry.filename.toLowerCase().endsWith(".mrpack")) ?? version.files.find((entry) => entry.primary) ?? version.files[0];
    if (!file) throw new PackError("这个版本没有文件", "failed");
    archive = join(deps.workDir, "packs", `${version.id}-${file.filename}`);
    await downloadArchive(deps, router.contentCandidates(file.url), archive, file.size, fileHashes(file), file.filename, request);
    origin = { source: "modrinth", name: project.title, version: version.version_number, projectId: project.id, versionId: version.id, iconUrl: project.icon_url };
  } else {
    const modId = Number(request.projectId);
    if (!Number.isInteger(modId)) throw new PackError("CurseForge 项目 ID 必须是数字");
    request.hooks?.stage?.("pack-lookup");
    const mod = await deps.curseforge.mod(modId, request.signal);
    const file = request.versionId ? await deps.curseforge.file(modId, Number(request.versionId), request.signal) : pickCurseForgeFile(await deps.curseforge.files(modId, { pageSize: 30 }, request.signal));
    if (!file) throw new PackError("这个整合包没有可用的文件", "failed");
    if (!file.downloadUrl && mod.allowModDistribution === false) {
      const page = mod.links?.websiteUrl ? `${mod.links.websiteUrl.replace(/\/+$/, "")}/files/${file.id}` : undefined;
      throw new PackError(`这个整合包的作者不允许第三方启动器下载。请在 CurseForge 网站下载 .zip 后用“导入整合包”导入${page ? `：${page}` : ""}`, "unresolved");
    }
    archive = join(deps.workDir, "packs", `cf-${file.id}-${file.fileName}`);
    const urls = cdnCandidates(file).flatMap((url) => router.any(url));
    await downloadArchive(deps, [...new Set(urls)], archive, file.fileLength > 0 ? file.fileLength : undefined, cfHashes(file), file.fileName, request);
    origin = { source: "curseforge", name: mod.name, version: file.displayName, projectId: String(modId), versionId: String(file.id), iconUrl: mod.logo?.url };
  }

  try {
    return await installPack(deps, { file: archive, name: request.name, signal: request.signal, hooks: request.hooks, skipOptional: request.skipOptional, concurrency: request.concurrency, origin });
  } finally {
    await rm(archive, { force: true }).catch(() => {});
  }
}

/** The newest release of the pack an instance was installed from, if it can be looked up. */
export async function latestPackVersion(deps: OnlineDeps, origin: ModpackOrigin, signal?: AbortSignal): Promise<{ updateAvailable: boolean; latest: LatestPack } | undefined> {
  if (origin.source === "modrinth" && origin.projectId) {
    const version = pickModrinthVersion(await deps.modrinth.versions(origin.projectId, {}, signal));
    if (!version) return undefined;
    return { updateAvailable: version.id !== origin.versionId, latest: { versionId: version.id, version: version.version_number, publishedAt: version.date_published, changelog: version.changelog } };
  }
  if (origin.source === "curseforge" && origin.projectId) {
    const file = pickCurseForgeFile(await deps.curseforge.files(Number(origin.projectId), { pageSize: 30 }, signal));
    if (!file) return undefined;
    return { updateAvailable: String(file.id) !== origin.versionId, latest: { versionId: String(file.id), version: file.displayName, publishedAt: file.fileDate } };
  }
  return undefined;
}
