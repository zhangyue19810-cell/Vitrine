import { basename, extname, join, resolve, sep } from "node:path";
import type { Core } from "../core";
import type { DownloadItem, Progress } from "./download";
import { anySignal, throwIfAborted } from "../util/async";
import { ensureDir } from "../util/fsx";

/**
 * User-initiated downloads from an arbitrary URL.
 *
 * GitHub release assets are the main use case, so every candidate source is
 * measured before the real transfer starts. The fastest byte stream wins and
 * the remaining sources stay in the downloader's fallback list. Mirror
 * prefixes that merely return an HTML landing page are rejected by a small
 * content sniff, which keeps "Aliyun / Huaqing" style mirrors useful when they
 * host the file and harmless when they do not.
 */

export type CustomDownloadMode = "auto" | "direct" | "github" | "aliyun" | "huaqing";

export interface CustomDownloadRequest {
  url: string;
  folder: string;
  filename?: string;
  mode?: CustomDownloadMode;
  segments?: number;
}

export interface SourceProbe {
  name: string;
  url: string;
  ok: boolean;
  ms: number;
  bytes: number;
  speed: number;
  size?: number;
  contentType?: string;
  error?: string;
}

interface Candidate {
  name: string;
  url: string;
}

const PROBE_BYTES = 96 * 1024;
const PROBE_TIMEOUT_MS = 6500;
const ALIYUN_GITHUB = "https://mirrors.aliyun.com/github/";
const HUAQING_GITHUB = "https://mirrors.huaweicloud.com/github/";
const GITHUB_PROXIES = [
  { name: "GitHub 云加速 · 星云", prefix: "https://ghfast.top/" },
  { name: "GitHub 云加速 · 云桥", prefix: "https://gh-proxy.com/" },
  { name: "GitHub 云加速 · 镜像", prefix: "https://ghproxy.net/" },
] as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function githubPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com" && parsed.hostname.toLowerCase() !== "www.github.com") return undefined;
    return `${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`;
  } catch {
    return undefined;
  }
}

/** All source candidates in display order. Only GitHub URLs get mirror candidates. */
export function downloadCandidates(input: string, mode: CustomDownloadMode = "auto"): Candidate[] {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("下载地址不是有效的网址");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("下载地址必须以 http:// 或 https:// 开头");
  if (parsed.username || parsed.password) throw new Error("下载地址不能包含用户名或密码");
  parsed.hash = "";
  const url = parsed.toString();
  const direct: Candidate = { name: hostOf(url) === "github.com" || hostOf(url).endsWith(".github.com") ? "GitHub 直连" : "原始地址", url };
  if (mode === "direct") return [direct];
  const path = githubPath(url);
  if (!path) return [direct];
  const aliyun: Candidate = { name: "阿里云 GitHub 镜像", url: `${ALIYUN_GITHUB}${path}` };
  const huaqing: Candidate = { name: "华清云 GitHub 镜像", url: `${HUAQING_GITHUB}${path}` };
  const proxies = GITHUB_PROXIES.map((entry) => ({ name: entry.name, url: `${entry.prefix}${url}` }));
  switch (mode) {
    case "aliyun":
      return [aliyun, direct];
    case "huaqing":
      return [huaqing, direct];
    case "github":
      return [...proxies, direct];
    default:
      return [direct, aliyun, huaqing, ...proxies];
  }
}

function filenameFromDisposition(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  const raw = extended?.[1] ?? plain?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Keep a download inside the folder the player chose, and use a name Windows/macOS/Linux all accept. */
export function safeFilename(value: string, fallback = "download.bin"): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
    return last ? safeFilename(last, "") : undefined;
  } catch {
    return undefined;
  }
}

function destinationFor(folder: string, filename: string): string {
  const root = resolve(folder);
  const dest = resolve(join(root, filename));
  if (dest !== root && !dest.startsWith(root + sep)) throw new Error("文件名不能超出保存文件夹");
  return dest;
}

async function probe(core: Core, candidate: Candidate, outer: AbortSignal): Promise<SourceProbe> {
  const started = performance.now();
  const timer = new AbortController();
  const timerId = setTimeout(() => timer.abort(), PROBE_TIMEOUT_MS);
  const signal = anySignal(outer, timer.signal);
  let bytes = 0;
  let contentType = "";
  let size: number | undefined;
  let filename: string | undefined;
  let firstText = "";
  let response: Awaited<ReturnType<Core["http"]["request"]>> | undefined;
  try {
    response = await core.http.request(candidate.url, {
      headers: { range: `bytes=0-${PROBE_BYTES - 1}`, accept: "*/*" },
      signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      decompress: false,
    });
    if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status}`);
    contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    filename = filenameFromDisposition(response.headers["content-disposition"]);
    const range = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(String(response.headers["content-range"] ?? ""));
    const announced = Number(response.headers["content-length"]);
    if (range && range[1] !== "*") size = Number(range[1]);
    else if (Number.isFinite(announced) && announced > 0) size = announced;
    for await (const chunk of response.body) {
      const buffer = chunk as Buffer;
      if (!firstText) firstText = buffer.subarray(0, 64).toString("utf8");
      bytes += buffer.length;
      if (bytes >= PROBE_BYTES) break;
    }
    response.body.destroy();
    const head = firstText.trimStart().slice(0, 48).toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("application/xhtml") || head.startsWith("<!doctype html") || head.startsWith("<html")) {
      throw new Error("镜像返回了网页，不是文件");
    }
    if (bytes < 16) throw new Error("没有收到文件内容");
    const ms = Math.max(1, performance.now() - started);
    return {
      name: candidate.name,
      url: candidate.url,
      ok: true,
      ms,
      bytes,
      speed: bytes / (ms / 1000),
      size,
      contentType: contentType || undefined,
      // The downloader needs the filename returned by a successful source.
      ...(filename ? { filename } : {}),
    } as SourceProbe & { filename?: string };
  } catch (error) {
    response?.body.destroy();
    const message = timer.signal.aborted && !outer.aborted ? "测速超时" : ((error as Error)?.message ?? String(error));
    return {
      name: candidate.name,
      url: candidate.url,
      ok: false,
      ms: Math.max(1, performance.now() - started),
      bytes,
      speed: 0,
      error: message,
    };
  } finally {
    clearTimeout(timerId);
  }
}

function bytesLabel(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Start a custom download as a normal core task so it appears in the download
 * manager, the top island and the task log just like every other transfer.
 */
export function startCustomDownload(core: Core, request: CustomDownloadRequest): { taskId: string } {
  const candidates = downloadCandidates(request.url.trim(), request.mode ?? "auto");
  const folder = request.folder.trim();
  if (!folder) throw new Error("请选择保存文件夹");
  const requestedName = request.filename?.trim();
  const segments = Math.min(16, Math.max(1, Math.round(request.segments ?? core.settings.peek().download.segments)));
  const label = [request.mode ?? "auto", requestedName ?? "", basename(folder)].filter(Boolean).join(" · ");
  const { id } = core.tasks.start({
    kind: "download",
    title: requestedName ? `下载 ${safeFilename(requestedName)}` : "自定义下载",
    run: async (context) => {
      context.plan([
        { id: "probe", label: "测速并选择最快来源" },
        { id: "download", label: "多线程下载" },
        { id: "finish", label: "写入完成" },
      ]);
      context.stage("probe", label);
      throwIfAborted(context.signal);
      const probes = await Promise.all(candidates.map((candidate) => probe(core, candidate, context.signal)));
      const healthy = probes
        .filter((entry): entry is SourceProbe & { filename?: string } => entry.ok)
        .sort((a, b) => b.speed - a.speed || a.ms - b.ms);
      for (const entry of probes) {
        context.log(entry.ok
          ? `测速 ${entry.name}：${bytesLabel(entry.speed)}/s（${entry.ms.toFixed(0)} ms）`
          : `跳过 ${entry.name}：${entry.error ?? "不可用"}`);
      }
      const best = healthy[0];
      if (!best) {
        const reason = probes.map((entry) => `${entry.name}：${entry.error ?? "不可用"}`).slice(0, 4).join("；");
        throw new Error(`所有下载源都不可用。${reason}`);
      }
      context.log(`选用 ${best.name}（${bytesLabel(best.speed)}/s）`);
      const fetchedName = filenameFromUrl(best.url) ?? filenameFromUrl(request.url);
      const inferred = (best as SourceProbe & { filename?: string }).filename ?? fetchedName ?? "download.bin";
      let finalName = safeFilename(requestedName || inferred);
      // A user-supplied stem keeps its name, but a missing extension follows the
      // real asset name so Windows can open the file after the download.
      if (requestedName && !extname(finalName)) {
        const inferredExt = extname(inferred);
        if (inferredExt) finalName = safeFilename(`${finalName}${inferredExt}`);
      }
      const dest = destinationFor(folder, finalName);
      await ensureDir(resolve(folder));
      context.setTitle(`下载 ${finalName}`);
      context.stage("download", best.name);
      const fallback: DownloadItem = {
        urls: [best.url, ...healthy.filter((entry) => entry.url !== best.url).map((entry) => entry.url), ...candidates.map((entry) => entry.url)],
        dest,
        size: best.size,
        segments,
        label: finalName,
        group: "custom",
      };
      const progress: Progress = {
        totalFiles: 1,
        doneFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        bytesTotal: best.size ?? 0,
        bytesDone: 0,
        speed: 0,
        eta: null,
        elapsedMs: 0,
        lanes: [],
      };
      const result = await core.engine.runOrThrow([fallback], {
        signal: context.signal,
        onProgress: (next) => context.progress({ ...next, totalFiles: 1 }),
      });
      context.stage("finish");
      context.log(`已保存到 ${dest}（${bytesLabel(result.bytes)}）`);
      return {
        path: dest,
        source: best.name,
        sourceUrl: best.url,
        bytes: result.bytes,
        probes,
      };
    },
  });
  return { taskId: id };
}
