import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { mapLimit } from "../util/async";
import { exists } from "../util/fsx";
import { currentOs, exeName, type OsInfo } from "../util/os";
import { compareVersions, parseJavaMajor } from "../util/version";

export interface JavaInstall {
  /** Path of the java executable. */
  path: string;
  home: string;
  version: string;
  major: number;
  vendor?: string;
  arch: "x64" | "x86" | "arm64" | "unknown";
  is64: boolean;
  isJdk: boolean;
  source: "env" | "path" | "registry" | "common" | "mojang" | "vitrine" | "custom";
}

export interface DetectOptions {
  os?: OsInfo;
  env?: NodeJS.ProcessEnv;
  /** Extra directories that directly contain Java homes (or Mojang runtime trees). */
  extraDirs?: { dir: string; source: JavaInstall["source"] }[];
  /** Extra explicit java homes or executables (user configured). */
  extraPaths?: string[];
  /** Registry reader, injectable for tests. Returns the stdout of `reg query <key> /s`. */
  runReg?: (key: string) => Promise<string>;
  /** Fallback executor for `java -version`; injectable for tests. */
  runJava?: (executable: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Skip the (slow) registry / PATH probing. */
  quick?: boolean;
}

function defaultRunJava(executable: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(executable, args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !stderr && !stdout) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function defaultRunReg(key: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/s"], { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

function parseReleaseFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/.exec(line.trim());
    if (match) out[match[1]] = match[2] ?? match[3] ?? "";
  }
  return out;
}

function normalizeArch(value: string | undefined): JavaInstall["arch"] {
  const v = (value ?? "").toLowerCase();
  if (v === "amd64" || v === "x86_64" || v === "x64") return "x64";
  if (v === "aarch64" || v === "arm64") return "arm64";
  if (v === "x86" || v === "i386" || v === "i586" || v === "i686") return "x86";
  return "unknown";
}

/** Inspect a Java home directory (or an executable inside one). */
export async function inspectJava(
  candidate: string,
  source: JavaInstall["source"],
  options: Pick<DetectOptions, "os" | "runJava"> = {},
): Promise<JavaInstall | undefined> {
  const os = options.os ?? currentOs();
  let home = candidate;
  let executable: string;
  const lower = basename(candidate).toLowerCase();
  if (lower === "java" || lower === "java.exe" || lower === "javaw.exe") {
    executable = candidate.replace(/javaw\.exe$/i, "java.exe");
    home = dirname(dirname(candidate));
  } else {
    executable = join(candidate, "bin", exeName("java", os));
    // macOS bundles keep the real home under Contents/Home
    if (!(await exists(executable)) && (await exists(join(candidate, "Contents", "Home", "bin", "java")))) {
      home = join(candidate, "Contents", "Home");
      executable = join(home, "bin", "java");
    }
  }
  if (!(await exists(executable))) return undefined;

  let release: Record<string, string> = {};
  try {
    release = parseReleaseFile(await readFile(join(home, "release"), "utf8"));
  } catch {
    /* some runtimes ship no release file */
  }
  let version: string | undefined = release.JAVA_VERSION;
  let arch = normalizeArch(release.OS_ARCH);
  let vendor: string | undefined = release.IMPLEMENTOR;
  if (!version) {
    try {
      const run = options.runJava ?? defaultRunJava;
      const { stdout, stderr } = await run(executable, ["-version"]);
      const text = `${stderr}\n${stdout}`;
      version = /version "([^"]+)"/.exec(text)?.[1];
      if (arch === "unknown") arch = /64-Bit/i.test(text) ? (/aarch64|arm64/i.test(text) ? "arm64" : "x64") : "x86";
      vendor ??= /(OpenJDK|Java\(TM\)|Zulu|Temurin|GraalVM|Corretto|Semeru)/i.exec(text)?.[1];
    } catch {
      return undefined;
    }
  }
  if (!version) return undefined;
  const major = parseJavaMajor(version);
  if (!major) return undefined;
  if (arch === "unknown") arch = os.arch;
  const isJdk = (await exists(join(home, "bin", exeName("javac", os)))) || release.IMAGE_TYPE === "JDK";
  return { path: executable, home, version, major, vendor, arch, is64: arch !== "x86", isJdk, source };
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

const WINDOWS_VENDOR_DIRS = [
  "Java",
  "Eclipse Adoptium",
  "Eclipse Foundation",
  "AdoptOpenJDK",
  "Zulu",
  "Microsoft",
  "BellSoft",
  "Amazon Corretto",
  "Semeru",
  "Temurin",
  "OpenJDK",
  "GraalVM",
  "JetBrains",
  "Liberica",
];

const REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\JavaSoft",
  "HKLM\\SOFTWARE\\Eclipse Adoptium",
  "HKLM\\SOFTWARE\\Eclipse Foundation",
  "HKLM\\SOFTWARE\\AdoptOpenJDK",
  "HKLM\\SOFTWARE\\Azul Systems",
  "HKLM\\SOFTWARE\\Microsoft\\JDK",
  "HKLM\\SOFTWARE\\Amazon Corretto",
  "HKLM\\SOFTWARE\\BellSoft",
  "HKLM\\SOFTWARE\\Semeru",
  "HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft",
  "HKLM\\SOFTWARE\\WOW6432Node\\Eclipse Adoptium",
  "HKLM\\SOFTWARE\\WOW6432Node\\Azul Systems",
];

export function parseRegistryHomes(text: string): string[] {
  const homes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(JavaHome|Path|InstallationPath)\s+REG_SZ\s+(.+?)\s*$/i.exec(line);
    if (match && /[\\/]/.test(match[2])) homes.push(match[2]);
  }
  return homes;
}

/** Find the directories that might be Java homes on this machine. */
async function candidateHomes(options: DetectOptions): Promise<{ path: string; source: JavaInstall["source"] }[]> {
  const os = options.os ?? currentOs();
  const env = options.env ?? process.env;
  const out: { path: string; source: JavaInstall["source"] }[] = [];
  const add = (path: string | undefined, source: JavaInstall["source"]) => {
    if (path) out.push({ path: path.replace(/[\\/]+$/, ""), source });
  };
  for (const key of ["JAVA_HOME", "JRE_HOME", "JDK_HOME"]) add(env[key], "env");
  for (const path of options.extraPaths ?? []) add(path, "custom");

  const roots: { dir: string; source: JavaInstall["source"] }[] = [...(options.extraDirs ?? [])];
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  if (os.name === "windows") {
    const pf = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, "C:\\Program Files", "C:\\Program Files (x86)"].filter(Boolean) as string[];
    for (const base of new Set(pf)) for (const vendor of WINDOWS_VENDOR_DIRS) roots.push({ dir: join(base, vendor), source: "common" });
    if (env.LOCALAPPDATA) {
      roots.push({ dir: join(env.LOCALAPPDATA, "Programs", "Eclipse Adoptium"), source: "common" });
      roots.push({ dir: join(env.LOCALAPPDATA, "Packages", "Microsoft.4297127D64EC6_8wekyb3d8bbwe", "LocalCache", "Local", "runtime"), source: "mojang" });
    }
    if (env.APPDATA) roots.push({ dir: join(env.APPDATA, ".minecraft", "runtime"), source: "mojang" });
    roots.push({ dir: join(home, ".jdks"), source: "common" });
    if (env["ProgramFiles(x86)"]) roots.push({ dir: join(env["ProgramFiles(x86)"]!, "Minecraft Launcher", "runtime"), source: "mojang" });
  } else if (os.name === "osx") {
    for (const base of ["/Library/Java/JavaVirtualMachines", join(home, "Library", "Java", "JavaVirtualMachines")]) roots.push({ dir: base, source: "common" });
    for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) roots.push({ dir: base, source: "common" });
  } else {
    for (const base of ["/usr/lib/jvm", "/usr/java", "/opt/java", "/opt", "/usr/local", join(home, ".sdkman", "candidates", "java"), join(home, ".jdks")]) {
      roots.push({ dir: base, source: "common" });
    }
  }

  for (const root of roots) {
    for (const child of await childDirs(root.dir)) {
      add(child, root.source);
      // Mojang runtimes: runtime/<component>/<platform>/<component>
      if (root.source === "mojang" || basename(root.dir) === "runtime") {
        for (const platform of await childDirs(child)) for (const inner of await childDirs(platform)) add(inner, root.source);
      }
    }
  }

  if (!options.quick) {
    if (os.name === "windows") {
      const run = options.runReg ?? defaultRunReg;
      const outputs = await Promise.all(REGISTRY_KEYS.map((key) => run(key)));
      for (const text of outputs) for (const homePath of parseRegistryHomes(text)) add(homePath, "registry");
    }
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
      if (!dir) continue;
      add(join(dir, exeName("java", os)), "path");
    }
  }
  return out;
}

/** Scan the machine for Java installations. Results are de-duplicated by real path and sorted newest first. */
export async function detectJava(options: DetectOptions = {}): Promise<JavaInstall[]> {
  const candidates = await candidateHomes(options);
  const best = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase();
    const previous = best.get(key);
    if (!previous || rank(candidate.source) < rank(previous.source)) best.set(key, candidate);
  }
  const unique = [...best.values()];
  const results = await mapLimit(unique, 8, async (candidate) => {
    try {
      return await inspectJava(candidate.path, candidate.source, options);
    } catch {
      return undefined;
    }
  });
  const byHome = new Map<string, JavaInstall>();
  for (const install of results) {
    if (!install) continue;
    let key = install.home;
    try {
      key = await realpath(install.home);
    } catch {
      /* keep the plain path */
    }
    const previous = byHome.get(key.toLowerCase());
    if (!previous || rank(install.source) < rank(previous.source)) byHome.set(key.toLowerCase(), install);
  }
  return [...byHome.values()].sort((a, b) => b.major - a.major || compareVersions(b.version, a.version));
}

function rank(source: JavaInstall["source"]): number {
  return ["custom", "vitrine", "mojang", "env", "registry", "common", "path"].indexOf(source);
}

export interface JavaRequirement {
  min: number;
  max?: number;
}

/** Choose the install closest to the minimum major version that satisfies the requirement. */
export function pickJava(installs: JavaInstall[], requirement: JavaRequirement): JavaInstall | undefined {
  const fitting = installs.filter((java) => java.major >= requirement.min && (requirement.max === undefined || java.major <= requirement.max));
  if (!fitting.length) return undefined;
  return [...fitting].sort((a, b) => {
    if (a.is64 !== b.is64) return a.is64 ? -1 : 1;
    if (a.major !== b.major) return a.major - b.major; // closest to the minimum first
    if (a.isJdk !== b.isJdk) return a.isJdk ? -1 : 1;
    const bySource = rank(a.source) - rank(b.source);
    if (bySource) return bySource;
    return compareVersions(b.version, a.version);
  })[0];
}

export interface JavaRequirementInput {
  /** `javaVersion.majorVersion` from the version JSON, if present. */
  declared?: number;
  /** Fallback derived from the Minecraft version. */
  fallback: number;
  loaders: { kind: string }[];
  /** Vanilla Minecraft version, e.g. "1.12.2". */
  mcVersion?: string;
}

/**
 * Java range a profile can run on. The upper bound only exists for legacy loaders that break on newer JVMs
 * (LaunchWrapper-based Forge up to 1.12.2 needs Java 8; Forge 1.13-1.16 does not support Java 16+).
 */
export function javaRequirement(input: JavaRequirementInput): JavaRequirement {
  const min = input.declared ?? input.fallback;
  const parts = /^(\d+)\.(\d+)/.exec(input.mcVersion ?? "");
  const minor = parts && Number(parts[1]) === 1 ? Number(parts[2]) : undefined;
  const legacyLoader = input.loaders.some((loader) => ["forge", "liteloader", "optifine"].includes(loader.kind));
  let max: number | undefined;
  if (legacyLoader && minor !== undefined) {
    if (minor <= 12) max = 8;
    else if (minor <= 16) max = 15;
  }
  if (max !== undefined && max < min) max = undefined;
  return { min, max };
}
