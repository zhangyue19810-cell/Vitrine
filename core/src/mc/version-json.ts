import { join } from "node:path";
import { exists, readJson } from "../util/fsx";
import { isReleaseId } from "../util/version";
import { joinUrl, mavenKey, mavenPath, parseMaven } from "./maven";
import { rulesAllow, type RuleContext } from "./rules";
import type { Argument, Artifact, LibraryJson, LoaderKind, VersionJson } from "./types";

export const MOJANG_LIBRARIES = "https://libraries.minecraft.net/";

export class MissingVersionError extends Error {
  readonly name = "MissingVersionError";
  constructor(readonly versionId: string, readonly child?: string) {
    super(child ? `Version "${child}" needs "${versionId}", which is not installed` : `Version "${versionId}" is not installed`);
  }
}

export const versionsDir = (root: string) => join(root, "versions");
export const versionDir = (root: string, id: string) => join(root, "versions", id);
export const versionJsonPath = (root: string, id: string) => join(root, "versions", id, `${id}.json`);
export const versionJarPath = (root: string, id: string) => join(root, "versions", id, `${id}.jar`);
export const librariesDir = (root: string) => join(root, "libraries");
export const assetsDir = (root: string) => join(root, "assets");

export async function readVersionJson(root: string, id: string): Promise<VersionJson> {
  const path = versionJsonPath(root, id);
  if (!(await exists(path))) throw new MissingVersionError(id);
  const json = await readJson<VersionJson>(path);
  if (!json || typeof json !== "object") throw new Error(`Version JSON of "${id}" is empty`);
  // Folders get renamed by users; the folder name is the truth the launcher goes by.
  return { ...json, id };
}

export interface ResolvedVersion extends VersionJson {
  /** Ids from the requested version up to the root it inherits from. */
  chain: string[];
  /** Id of the last version in the chain (normally the vanilla version). */
  rootId: string;
}

/** Merge a child profile over its parent the way Mojang's launcher does. */
export function mergeVersions(parent: VersionJson, child: VersionJson): VersionJson {
  const childKeys = new Set((child.libraries ?? []).map((lib) => libraryKey(lib)));
  const libraries = [...(child.libraries ?? []), ...(parent.libraries ?? []).filter((lib) => !childKeys.has(libraryKey(lib)))];
  const concat = (a?: Argument[], b?: Argument[]) => (a || b ? [...(a ?? []), ...(b ?? [])] : undefined);
  const args =
    parent.arguments || child.arguments
      ? { game: concat(parent.arguments?.game, child.arguments?.game), jvm: concat(parent.arguments?.jvm, child.arguments?.jvm) }
      : undefined;
  return {
    ...parent,
    ...child,
    id: child.id,
    inheritsFrom: undefined,
    type: child.type ?? parent.type,
    mainClass: child.mainClass ?? parent.mainClass,
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    arguments: args,
    libraries,
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    downloads: { ...parent.downloads, ...child.downloads },
    javaVersion: child.javaVersion ?? parent.javaVersion,
    logging: child.logging ?? parent.logging,
    releaseTime: child.releaseTime ?? parent.releaseTime,
    time: child.time ?? parent.time,
    jar: child.jar ?? parent.jar,
  };
}

function libraryKey(lib: LibraryJson): string {
  return mavenKey(lib.name);
}

/** Load a version and everything it inherits from. */
export async function resolveVersion(
  root: string,
  id: string,
  load: (id: string) => Promise<VersionJson> = (target) => readVersionJson(root, target),
): Promise<ResolvedVersion> {
  const chain: VersionJson[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;
  let child: string | undefined;
  while (current) {
    if (seen.has(current) || chain.length > 8) throw new Error(`Version "${id}" has a circular or too deep inheritance chain`);
    seen.add(current);
    let json: VersionJson;
    try {
      json = await load(current);
    } catch (error) {
      if (error instanceof MissingVersionError && child) throw new MissingVersionError(current, child);
      throw error;
    }
    chain.push(json);
    child = current;
    current = json.inheritsFrom;
  }
  let merged = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) merged = mergeVersions(merged, chain[i]);
  return { ...merged, id, chain: chain.map((entry) => entry.id), rootId: chain[chain.length - 1].id };
}

export interface LibraryFile {
  /** Original maven coordinate. */
  name: string;
  /** Path below the libraries directory. */
  path: string;
  /** Official download URL; undefined when the file is delivered by an installer. */
  url?: string;
  /** Extra sources tried after `url` (Forge's pack.xz-only hosts also exist as plain jars at Mojang). */
  fallbackUrls?: string[];
  sha1?: string;
  sha256?: string;
  sha512?: string;
  md5?: string;
  size?: number;
  /** Contains native libraries that must be extracted before launch. */
  native: boolean;
  extractExclude: string[];
  onClasspath: boolean;
}

function archBits(ctx: RuleContext): string {
  return ctx.os.arch === "x86" ? "32" : "64";
}

function fromArtifact(name: string, artifact: Artifact, extra: Partial<LibraryFile>): LibraryFile {
  return {
    name,
    path: artifact.path ?? mavenPath(name),
    url: artifact.url ? artifact.url : undefined,
    sha1: artifact.sha1,
    size: artifact.size,
    native: false,
    extractExclude: [],
    onClasspath: true,
    ...extra,
  };
}

function constructed(lib: LibraryJson, name: string, extra: Partial<LibraryFile>): LibraryFile {
  const path = mavenPath(name);
  const base = lib.url ?? MOJANG_LIBRARIES;
  return {
    name,
    path,
    // Forge installers ship some libraries inside the installer jar and mark them with an empty url.
    url: lib.url === "" ? undefined : joinUrl(base, path),
    fallbackUrls: lib.url && /(^|\.)minecraftforge\.net/i.test(lib.url) ? [joinUrl(MOJANG_LIBRARIES, path)] : undefined,
    sha1: lib.sha1,
    sha256: lib.sha256,
    sha512: lib.sha512,
    md5: lib.md5,
    size: lib.size,
    native: false,
    extractExclude: [],
    onClasspath: true,
    ...extra,
  };
}

/** Libraries that apply to this machine, with download metadata and native handling resolved. */
export function resolveLibraries(version: Pick<VersionJson, "libraries">, ctx: RuleContext): LibraryFile[] {
  const out: LibraryFile[] = [];
  const seenPaths = new Set<string>();
  const push = (file: LibraryFile) => {
    if (seenPaths.has(file.path) && !file.native) return;
    seenPaths.add(file.path);
    out.push(file);
  };
  for (const lib of version.libraries ?? []) {
    if (!rulesAllow(lib.rules, ctx)) continue;
    // Old Forge profiles mark server-only libraries; the official installer leaves them out of client installs.
    if (lib.clientreq === false) continue;
    const exclude = lib.extract?.exclude ?? [];
    const nativeKey = lib.natives?.[ctx.os.name];
    if (nativeKey) {
      const classifier = nativeKey.replace("${arch}", archBits(ctx));
      // The plain jar (classes) is still needed when the entry also has one.
      const base = lib.downloads?.artifact;
      if (base) push(fromArtifact(lib.name, base, {}));
      const artifact = lib.downloads?.classifiers?.[classifier];
      const coord = `${lib.name}:${classifier}`;
      if (artifact) push(fromArtifact(coord, artifact, { native: true, extractExclude: exclude, onClasspath: false }));
      else if (!lib.downloads) push(constructed(lib, coord, { native: true, extractExclude: exclude, onClasspath: false }));
      continue;
    }
    let parsedClassifier: string | undefined;
    try {
      parsedClassifier = parseMaven(lib.name).classifier;
    } catch {
      continue; // not a maven coordinate, nothing we can do with it
    }
    const isNativeJar = Boolean(parsedClassifier?.startsWith("natives-"));
    const extra: Partial<LibraryFile> = { native: isNativeJar, extractExclude: exclude };
    if (lib.downloads?.artifact) push(fromArtifact(lib.name, lib.downloads.artifact, extra));
    else if (!lib.downloads) push(constructed(lib, lib.name, extra));
  }
  return out;
}

export function buildClasspath(libraries: LibraryFile[], librariesRoot: string, clientJar: string | undefined, separator: string): string {
  const entries = libraries.filter((lib) => lib.onClasspath).map((lib) => join(librariesRoot, lib.path));
  if (clientJar) entries.push(clientJar);
  return [...new Set(entries)].join(separator);
}

/** Collect string values of the game arguments (plain strings and rule-matched values). */
export function flattenArguments(list: Argument[] | undefined, ctx: RuleContext): string[] {
  const out: string[] = [];
  for (const entry of list ?? []) {
    if (typeof entry === "string") out.push(entry);
    else if (rulesAllow(entry.rules, ctx)) {
      if (Array.isArray(entry.value)) out.push(...entry.value);
      else out.push(entry.value);
    }
  }
  return out;
}

export interface LoaderInfo {
  kind: LoaderKind;
  version?: string;
}

/** Detect loaders from a resolved version's libraries, main class and arguments. */
export function detectLoaders(version: VersionJson, ctx: RuleContext): LoaderInfo[] {
  const found: LoaderInfo[] = [];
  const add = (kind: LoaderKind, v?: string) => {
    if (!found.some((entry) => entry.kind === kind)) found.push({ kind, version: v });
  };
  const names = (version.libraries ?? []).map((lib) => lib.name);
  const versionOf = (prefix: string) => {
    const hit = names.find((name) => name.startsWith(prefix));
    return hit ? hit.split(":")[2] : undefined;
  };
  const neo = versionOf("net.neoforged:neoforge:") ?? versionOf("net.neoforged:forge:");
  if (neo) add("neoforge", neo.replace(/^1\.20\.1-/, ""));
  const forge = versionOf("net.minecraftforge:forge:") ?? versionOf("net.minecraftforge:minecraftforge:");
  if (forge && !neo) {
    // "1.20.1-47.2.0" or "1.7.10-10.13.4.1614-1.7.10" → the loader build is the middle part
    const parts = forge.split("-");
    add("forge", parts.length > 1 ? parts[1] : forge);
  }
  const fabric = versionOf("net.fabricmc:fabric-loader:");
  if (fabric) add(names.some((name) => name.startsWith("net.legacyfabric:")) ? "legacy-fabric" : "fabric", fabric);
  const quilt = versionOf("org.quiltmc:quilt-loader:");
  if (quilt) add("quilt", quilt);
  const optifine = versionOf("optifine:OptiFine:");
  if (optifine) add("optifine", optifine.replace(/^[\d.]+_/, ""));
  const lite = versionOf("com.mumfrey:liteloader:");
  if (lite) add("liteloader", lite);
  const text = JSON.stringify(version.arguments?.game ?? []) + (version.minecraftArguments ?? "");
  if (!found.length) {
    if (/FMLTweaker|fml\.common\.launcher/.test(text)) add("forge");
    else if (/OptiFineTweaker/.test(text)) add("optifine");
  }
  void ctx;
  return found;
}

/** Best-effort vanilla Minecraft version of a (possibly loader) profile. */
export function detectMinecraftVersion(version: ResolvedVersion): string | undefined {
  const args = [...flattenGameStrings(version)];
  const fml = args.indexOf("--fml.mcVersion");
  if (fml >= 0 && args[fml + 1] && !args[fml + 1].startsWith("$")) return args[fml + 1];
  if (version.chain.length > 1) return version.rootId;
  const names = (version.libraries ?? []).map((lib) => lib.name);
  const fabric = names.find((name) => name.startsWith("net.fabricmc:intermediary:") || name.startsWith("org.quiltmc:hashed:") || name.startsWith("net.legacyfabric:intermediary:"));
  if (fabric) return fabric.split(":")[2];
  const forge = names.find((name) => name.startsWith("net.minecraftforge:forge:") || name.startsWith("net.minecraftforge:minecraftforge:"));
  if (forge) return forge.split(":")[2].split("-")[0];
  if (version.jar) return version.jar;
  if (isReleaseId(version.id) || /^\d+\.\d+/.test(version.id)) return version.id;
  const assets = version.assetIndex?.id;
  return assets && /^\d+\.\d+/.test(assets) ? assets : undefined;
}

function* flattenGameStrings(version: VersionJson): Generator<string> {
  for (const token of (version.minecraftArguments ?? "").split(/\s+/)) if (token) yield token;
  for (const entry of version.arguments?.game ?? []) {
    if (typeof entry === "string") yield entry;
    else if (Array.isArray(entry.value)) yield* entry.value;
    else yield entry.value;
  }
}

/** Java major version a profile asks for, if it says so. */
export function requiredJavaMajor(version: VersionJson): number | undefined {
  return version.javaVersion?.majorVersion;
}
