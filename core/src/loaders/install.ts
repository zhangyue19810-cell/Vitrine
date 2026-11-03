import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { javaRequirement, type JavaRequirement } from "../java/detect";
import type { Progress } from "../net/download";
import { isAbort, throwIfAborted } from "../util/async";
import { ensureDir, exists, removeRecursive, writeJsonAtomic } from "../util/fsx";
import { fallbackJavaMajor } from "../util/version";
import { completeVersion, type GameEnv } from "../mc/files";
import { fetchVanillaJson } from "../mc/installer";
import { InstanceStore, validateInstanceName, type IsolationMode } from "../mc/instances";
import type { VersionCatalog } from "../mc/manifest";
import { defaultRuleContext } from "../mc/rules";
import type { LoaderKind, VersionJson } from "../mc/types";
import { mergeVersions, versionDir, versionJarPath, versionJsonPath } from "../mc/version-json";
import { InstallerError, installFromInstaller, installWithOfficialInstaller, type InstallHooks } from "./forge-installer";
import {
  fabricProfileUrl,
  fetchFirst,
  forgeInstallerUrl,
  neoforgeInstallerUrl,
  optifineDownloadUrl,
  type MetaDeps,
} from "./meta";
import { installOptiFine } from "./optifine";

export interface LoaderChoice {
  kind: Exclude<LoaderKind, "none" | "liteloader" | "legacy-fabric" | "cleanroom">;
  version: string;
  /** Maven version string (Forge/NeoForge) when it differs from `version`. */
  raw?: string;
  meta?: Record<string, string>;
}

export interface InstallRequest {
  /** Instance (folder) name. */
  name: string;
  mcVersion: string;
  loader?: LoaderChoice;
  isolation?: IsolationMode;
  signal?: AbortSignal;
  hooks?: InstallHooks;
  /** Allow falling back to the loader's own installer when the built-in pipeline fails. */
  officialFallback?: boolean;
}

export interface InstallDeps {
  env: GameEnv;
  catalog: VersionCatalog;
  meta: MetaDeps;
  instances: InstanceStore;
  /** Find or install a Java matching the requirement; `component` is Mojang's runtime name for auto-install. */
  ensureJava: (requirement: JavaRequirement, component: string | undefined, signal?: AbortSignal) => Promise<{ path: string; major: number }>;
  workDir: string;
  mirrorBase: () => string;
}

export interface InstallResult {
  id: string;
  mcVersion: string;
  loader?: LoaderChoice;
}

async function downloadOne(deps: InstallDeps, urls: string[], dest: string, label: string, signal?: AbortSignal, onProgress?: (p: Progress) => void) {
  const result = await deps.env.engine.run([{ urls, dest, label, group: "installer" }], { signal, onProgress });
  throwIfAborted(signal);
  if (!result.ok) throw new Error(`Could not download ${label}: ${result.failed[0]?.error ?? "unknown error"}`);
}

/**
 * Create a new instance: vanilla jar, optional loader, merged self-contained version JSON, libraries and assets.
 * The version folder is removed again when anything fails.
 */
export async function installInstance(deps: InstallDeps, request: InstallRequest): Promise<InstallResult> {
  const { env, hooks } = { env: deps.env, hooks: request.hooks };
  const problem = validateInstanceName(request.name);
  if (problem) throw new Error(problem);
  const dir = versionDir(env.root, request.name);
  if (await exists(dir)) throw new Error(`已存在名为“${request.name}”的实例`);
  const signal = request.signal;
  const ctx = defaultRuleContext();
  ctx.os = env.os ?? ctx.os;

  hooks?.stage?.("version-json");
  const vanilla = await fetchVanillaJson(deps.catalog, request.mcVersion, signal);
  await mkdir(dir, { recursive: true });
  try {
    // Client jar goes straight to <name>.jar: loaders such as Forge expect the jar to be named after the version.
    hooks?.stage?.("client-jar");
    const client = vanilla.downloads?.client;
    if (!client?.url) throw new Error(`Minecraft ${request.mcVersion} has no client download`);
    const jarPath = versionJarPath(env.root, request.name);
    await downloadOne(deps, env.router.candidates(client.url), jarPath, `${request.name}.jar`, signal, (progress) => hooks?.progress?.(progress, "client-jar"));
    // downloadOne verifies nothing by itself; check size so a truncated mirror response does not slip through.
    const { fileSize } = await import("../util/fsx");
    if (client.size && (await fileSize(jarPath)) !== client.size) throw new Error("The downloaded client jar has the wrong size");

    let merged: VersionJson;
    const loader = request.loader;
    if (!loader) {
      merged = { ...vanilla, id: request.name };
    } else if (loader.kind === "fabric" || loader.kind === "quilt") {
      hooks?.stage?.("loader-meta");
      const urls = deps.env.router.candidates(fabricProfileUrl(loader.kind, request.mcVersion, loader.version));
      const profile = await fetchFirst(deps.meta, urls, (text) => {
        const json = JSON.parse(text) as VersionJson;
        if (!json.mainClass || !json.libraries) throw new Error("not a loader profile");
        return json;
      });
      merged = mergeVersions(vanilla, { ...profile, inheritsFrom: request.mcVersion, id: request.name });
    } else {
      const requirement = javaRequirement({
        declared: vanilla.javaVersion?.majorVersion,
        fallback: fallbackJavaMajor(request.mcVersion),
        loaders: [{ kind: loader.kind }],
        mcVersion: request.mcVersion,
      });
      hooks?.stage?.("java");
      const java = await deps.ensureJava(requirement, vanilla.javaVersion?.component, signal);
      await ensureDir(deps.workDir);
      let profile: VersionJson;
      if (loader.kind === "optifine") {
        const type = loader.meta?.type ?? loader.version.split("_")[0];
        const patch = loader.meta?.patch ?? loader.version.split("_").slice(1).join("_");
        const installerJar = join(deps.workDir, `OptiFine_${request.mcVersion}_${type}_${patch}.jar`);
        hooks?.stage?.("loader-download");
        await downloadOne(deps, [optifineDownloadUrl(deps.mirrorBase(), request.mcVersion, type, patch)], installerJar, `OptiFine ${type} ${patch}`, signal, (progress) => hooks?.progress?.(progress, "loader-download"));
        profile = await installOptiFine({ env, installerJar, mcVersion: request.mcVersion, type, patch, minecraftJar: jarPath, vanilla, javaPath: java.path, signal, hooks });
      } else {
        const entry = { loader: loader.kind, version: loader.version, mcVersion: request.mcVersion, raw: loader.raw, meta: loader.meta };
        const url = loader.kind === "forge" ? forgeInstallerUrl(entry) : neoforgeInstallerUrl(entry);
        const installerJar = join(deps.workDir, `${loader.kind}-${loader.raw ?? loader.version}-installer.jar`);
        hooks?.stage?.("loader-download");
        await downloadOne(deps, env.router.candidates(url), installerJar, `${loader.kind} ${loader.version}`, signal, (progress) => hooks?.progress?.(progress, "loader-download"));
        const params = { env, installerJar, mcVersion: request.mcVersion, minecraftJar: jarPath, vanilla, javaPath: java.path, ruleCtx: ctx, signal, hooks };
        try {
          profile = (await installFromInstaller(params)).profileJson;
        } catch (error) {
          if (isAbort(error) || !(error instanceof InstallerError) || request.officialFallback === false) throw error;
          env.log.warn(`built-in ${loader.kind} install failed (${error.message.split("\n")[0]}); trying the official installer`);
          hooks?.stage?.("official-installer");
          profile = await installWithOfficialInstaller(params);
        }
      }
      merged = mergeVersions(vanilla, { ...profile, inheritsFrom: profile.inheritsFrom ?? request.mcVersion, id: request.name });
    }
    merged.jar = undefined;
    await writeJsonAtomic(versionJsonPath(env.root, request.name), merged);

    hooks?.stage?.("files");
    await completeVersion(env, request.name, {
      signal,
      onStage: (stage) => hooks?.stage?.(stage === "files" ? "libraries" : "assets"),
      onProgress: (progress, stage) => hooks?.progress?.(progress, stage === "files" ? "libraries" : "assets"),
    });

    await deps.instances.saveConfig(request.name, {
      isolation: request.isolation ?? "on",
      createdAt: Date.now(),
      installed: { mcVersion: request.mcVersion, loader: loader ? { kind: loader.kind, version: loader.version } : undefined },
    });
    deps.instances.invalidate(request.name);
    return { id: request.name, mcVersion: request.mcVersion, loader };
  } catch (error) {
    await removeRecursive(dir).catch(() => {});
    deps.instances.invalidate(request.name);
    throw error;
  }
}
