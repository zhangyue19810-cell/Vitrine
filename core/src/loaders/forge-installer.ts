import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Progress } from "../net/download";
import { ensureDir, exists, hashFile, readJson, removeRecursive, writeFileAtomic, copyDir } from "../util/fsx";
import { classpathSeparator } from "../util/os";
import { runProcess } from "../util/proc";
import { ZipReader } from "../util/zip";
import { libraryItems, type GameEnv } from "../mc/files";
import { mavenPath } from "../mc/maven";
import type { RuleContext } from "../mc/rules";
import type { LibraryJson, VersionJson } from "../mc/types";
import { librariesDir, resolveLibraries } from "../mc/version-json";

export interface InstallHooks {
  stage?: (stage: string, detail?: string) => void;
  progress?: (progress: Progress, stage: string) => void;
  /** Output of external processes (installer processors). */
  output?: (line: string) => void;
}

export interface InstallerParams {
  env: GameEnv;
  installerJar: string;
  mcVersion: string;
  /** Vanilla client jar the processors patch. */
  minecraftJar: string;
  vanilla: VersionJson;
  javaPath: string;
  ruleCtx: RuleContext;
  signal?: AbortSignal;
  hooks?: InstallHooks;
}

interface Processor {
  sides?: string[];
  jar: string;
  classpath?: string[];
  args?: string[];
  outputs?: Record<string, string>;
}

interface InstallProfile {
  spec?: number;
  json?: string;
  path?: string;
  minecraft?: string;
  data?: Record<string, { client?: string; server?: string }>;
  processors?: Processor[];
  libraries?: LibraryJson[];
  // legacy (v0)
  install?: { path: string; filePath?: string; minecraft?: string; target?: string };
  versionInfo?: VersionJson;
}

export class InstallerError extends Error {
  readonly name = "InstallerError";
  constructor(message: string, readonly tail: string[] = []) {
    super(tail.length ? `${message}\n${tail.slice(-12).join("\n")}` : message);
  }
}

function manifestMainClass(manifest: string): string | undefined {
  // Manifest lines wrap at 72 columns with a leading space on the continuation.
  const joined = manifest.replace(/\r?\n /g, "");
  return /^Main-Class:\s*(.+?)\s*$/m.exec(joined)?.[1];
}

/** Replace {KEY} tokens using the resolved data map. */
function replaceTokens(text: string, values: Record<string, string>): string {
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

/** Resolve one argument: `[coord]` → library path, `'literal'` → literal, otherwise token replacement. */
function resolveArg(arg: string, values: Record<string, string>, libs: string): string {
  if (arg.startsWith("[") && arg.endsWith("]")) return join(libs, mavenPath(arg.slice(1, -1)));
  if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) return arg.slice(1, -1);
  return replaceTokens(arg, values);
}

async function extractEntry(zip: ZipReader, name: string, dest: string): Promise<void> {
  const entry = zip.get(name);
  if (!entry) throw new InstallerError(`The installer does not contain ${name}`);
  await zip.extractTo(dest, { map: (candidate) => (candidate === entry ? name : undefined) });
}

/**
 * Run the installer's own steps for the client side. Modern installers (Forge 1.13+, NeoForge) list "processors"
 * that patch and remap the vanilla jar; legacy installers (Forge up to 1.12.2) only carry a profile and a jar.
 */
export async function installFromInstaller(params: InstallerParams): Promise<{ profileJson: VersionJson; method: "processors" | "legacy" }> {
  const zip = await ZipReader.open(params.installerJar);
  try {
    const profile = await zip.readJson<InstallProfile>("install_profile.json");
    if (profile.versionInfo && profile.install) return { profileJson: await installLegacy(zip, profile, params), method: "legacy" };
    return { profileJson: await installModern(zip, profile, params), method: "processors" };
  } finally {
    zip.close();
  }
}

async function installLegacy(zip: ZipReader, profile: InstallProfile, params: InstallerParams): Promise<VersionJson> {
  const { env } = params;
  const install = profile.install!;
  params.hooks?.stage?.("loader-files");
  const target = join(librariesDir(env.root), mavenPath(install.path));
  if (install.filePath) {
    const entry = zip.get(install.filePath);
    if (!entry) throw new InstallerError(`The installer does not contain ${install.filePath}`);
    await ensureDir(dirname(target));
    await zip.extractTo(dirname(target), { map: (candidate) => (candidate === entry ? basename(target) : undefined) });
  }
  return { ...profile.versionInfo! };
}

async function installModern(zip: ZipReader, profile: InstallProfile, params: InstallerParams): Promise<VersionJson> {
  const { env, hooks } = params;
  const libsRoot = librariesDir(env.root);
  const versionJson = await zip.readJson<VersionJson>((profile.json ?? "/version.json").replace(/^\//, ""));

  hooks?.stage?.("loader-libraries");
  // Files shipped inside the installer (the universal jar and friends) go straight into the library tree.
  await zip.extractTo(libsRoot, { map: (entry) => (entry.name.startsWith("maven/") ? entry.name.slice("maven/".length) : undefined) });
  const libs = [...resolveLibraries({ libraries: profile.libraries ?? [] }, params.ruleCtx), ...resolveLibraries(versionJson, params.ruleCtx)];
  const items = libraryItems(env, libs);

  // Mojang's mappings are fetched by a processor from Mojang's servers; fetching them through the mirror
  // first lets the processor find a valid file and skip its own download.
  const mojmaps = params.vanilla.downloads?.client_mappings;
  const workDir = await mkdtemp(join(tmpdir(), "vitrine-forge-"));
  try {
    const values: Record<string, string> = {
      SIDE: "client",
      MINECRAFT_JAR: params.minecraftJar,
      MINECRAFT_VERSION: params.mcVersion,
      ROOT: env.root,
      INSTALLER: params.installerJar,
      LIBRARY_DIR: libsRoot,
    };
    for (const [key, entry] of Object.entries(profile.data ?? {})) {
      const raw = entry.client;
      if (raw === undefined) continue;
      if (raw.startsWith("[") && raw.endsWith("]")) values[key] = join(libsRoot, mavenPath(raw.slice(1, -1)));
      else if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) values[key] = raw.slice(1, -1);
      else if (raw.startsWith("/")) {
        const relative = raw.slice(1);
        await extractEntry(zip, relative, workDir);
        values[key] = join(workDir, ...relative.split("/"));
      } else values[key] = raw;
    }

    const processors = (profile.processors ?? []).filter((processor) => !processor.sides || processor.sides.includes("client"));
    if (mojmaps?.url) {
      for (const processor of processors) {
        const args = processor.args ?? [];
        if (!args.includes("DOWNLOAD_MOJMAPS")) continue;
        const outIndex = args.indexOf("--output");
        if (outIndex < 0 || !args[outIndex + 1]) continue;
        items.push({
          urls: env.router.candidates(mojmaps.url),
          dest: resolveArg(args[outIndex + 1], values, libsRoot),
          size: mojmaps.size,
          hash: { sha1: mojmaps.sha1 },
          label: "client mappings",
          group: "loader",
        });
      }
    }

    const downloaded = await env.engine.run(items, {
      signal: params.signal,
      onProgress: (progress) => hooks?.progress?.(progress, "loader-libraries"),
    });
    if (!downloaded.ok) {
      const first = downloaded.failed.find((entry) => !entry.item.dest.endsWith("mappings.txt")) ?? downloaded.failed[0];
      throw new InstallerError(`Failed to download installer library ${first?.item.label ?? first?.item.dest}: ${first?.error}`);
    }

    const separator = classpathSeparator(env.os);
    for (let index = 0; index < processors.length; index++) {
      const processor = processors[index];
      const name = processor.jar.split(":")[1] ?? processor.jar;
      hooks?.stage?.("processors", `${index + 1}/${processors.length} ${name}`);
      const outputs = new Map<string, string>();
      for (const [key, expected] of Object.entries(processor.outputs ?? {})) {
        outputs.set(resolveArg(key, values, libsRoot), resolveArg(expected, values, libsRoot).toLowerCase());
      }
      if (outputs.size && (await outputsValid(outputs))) continue;

      const jarPath = join(libsRoot, mavenPath(processor.jar));
      const classpath = [jarPath, ...(processor.classpath ?? []).map((coord) => join(libsRoot, mavenPath(coord)))];
      for (const path of classpath) if (!(await exists(path))) throw new InstallerError(`A processor library is missing: ${path}`);
      const jar = await ZipReader.open(jarPath);
      let mainClass: string | undefined;
      try {
        const manifest = jar.get("META-INF/MANIFEST.MF");
        mainClass = manifest ? manifestMainClass(await jar.readText(manifest)) : undefined;
      } finally {
        jar.close();
      }
      if (!mainClass) throw new InstallerError(`Processor ${processor.jar} has no Main-Class`);
      const args = (processor.args ?? []).map((arg) => resolveArg(arg, values, libsRoot));
      for (const path of outputs.keys()) await ensureDir(dirname(path));
      const result = await runProcess(params.javaPath, ["-cp", classpath.join(separator), mainClass, ...args], {
        cwd: workDir,
        signal: params.signal,
        javaPath: params.javaPath,
        onLine: hooks?.output,
      });
      if (result.code !== 0) {
        const prefix = `Installer step "${name}" failed with exit code ${result.code}`;
        throw new InstallerError(javaInstallerFailure(prefix, params.javaPath, result.tail), result.tail);
      }
      if (outputs.size && !(await outputsValid(outputs))) {
        throw new InstallerError(`Installer step "${name}" produced unexpected files (checksum mismatch)`, result.tail);
      }
    }
  } finally {
    await removeRecursive(workDir).catch(() => {});
  }
  return versionJson;
}

async function outputsValid(outputs: Map<string, string>): Promise<boolean> {
  for (const [path, sha1] of outputs) {
    if (!(await exists(path))) return false;
    if (sha1 && /^[0-9a-f]{40}$/.test(sha1) && (await hashFile(path, "sha1")).toLowerCase() !== sha1) return false;
  }
  return true;
}

/** Add an actionable hint when the JVM itself cannot boot, not when Forge rejected a file. */
function javaInstallerFailure(prefix: string, javaPath: string, tail: string[]): string {
  const text = tail.join("\n");
  if (/Failed setting boot class path|Error occurred during initialization of VM|Could not create the Java Virtual Machine/i.test(text)) {
    return `${prefix}\nJava VM 无法启动（${javaPath}）。启动器已忽略环境中的 JAVA_TOOL_OPTIONS / _JAVA_OPTIONS / JDK_JAVA_OPTIONS；请到“设置 → Java”改选一个与 Minecraft 版本匹配的 64 位 JDK。`;
  }
  return prefix;
}

/**
 * Last resort: let the loader's own installer do everything (`--installClient`) in a scratch Minecraft folder,
 * then adopt its libraries and version JSON. Slower, and it talks to the official servers directly.
 */
export async function installWithOfficialInstaller(params: InstallerParams, expectedVersionId?: string): Promise<VersionJson> {
  const { env, hooks } = params;
  const staging = await mkdtemp(join(tmpdir(), "vitrine-official-"));
  try {
    hooks?.stage?.("official-installer");
    await ensureDir(join(staging, "versions", params.mcVersion));
    await writeFileAtomic(join(staging, "launcher_profiles.json"), JSON.stringify({ profiles: {}, clientToken: "vitrine", launcherVersion: { name: "vitrine", format: 21 } }));
    await writeFileAtomic(join(staging, "versions", params.mcVersion, `${params.mcVersion}.json`), JSON.stringify({ ...params.vanilla, id: params.mcVersion }));
    const target = join(staging, "versions", params.mcVersion, `${params.mcVersion}.jar`);
    const { copyFile } = await import("node:fs/promises");
    await copyFile(params.minecraftJar, target);
    const result = await runProcess(params.javaPath, ["-jar", params.installerJar, "--installClient", staging], {
      cwd: staging,
      signal: params.signal,
      javaPath: params.javaPath,
      onLine: hooks?.output,
    });
    if (result.code !== 0) {
      const prefix = `The official installer failed with exit code ${result.code}`;
      throw new InstallerError(javaInstallerFailure(prefix, params.javaPath, result.tail), result.tail);
    }
    const { readdir } = await import("node:fs/promises");
    const folders = (await readdir(join(staging, "versions"), { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== params.mcVersion);
    const pick = folders.find((entry) => entry.name === expectedVersionId) ?? folders[0];
    if (!pick) throw new InstallerError("The official installer did not create a version", result.tail);
    const json = await readJson<VersionJson>(join(staging, "versions", pick.name, `${pick.name}.json`));
    await copyDir(join(staging, "libraries"), librariesDir(env.root));
    return json;
  } finally {
    await removeRecursive(staging).catch(() => {});
  }
}
