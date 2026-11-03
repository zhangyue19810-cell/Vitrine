import type { ModpackOrigin } from "../mc/instances";
import type { HashSpec } from "../net/download";

export type PackFormat = "mrpack" | "curseforge" | "multimc" | "mcbbs";
export type PackLoaderKind = "fabric" | "quilt" | "forge" | "neoforge";

export interface PackLoader {
  kind: PackLoaderKind;
  /** Loader version as the pack states it (Forge "47.2.20", Fabric "0.15.11", NeoForge "21.1.172"). */
  version: string;
}

export interface PackFile {
  /** Path relative to the game directory, forward slashes, already shape-checked. */
  path: string;
  /** Download candidates. CurseForge entries get theirs when the file list is resolved. */
  urls: string[];
  size?: number;
  hashes?: HashSpec;
  /** The pack marks this file as optional (Modrinth env.client = "optional", CurseForge required = false). */
  optional?: boolean;
  label?: string;
  /** CurseForge reference, resolved through the API into urls / hashes / size. */
  curseforge?: { projectId: number; fileId: number };
  /** A page a person can open when the file cannot be fetched automatically. */
  pageUrl?: string;
  /** The author does not allow third-party distribution: the CDN is tried, but a manual download may be needed. */
  restricted?: boolean;
}

export interface PackSettings {
  memoryMb?: number;
  jvmArgs?: string;
  width?: number;
  height?: number;
}

/** Everything the installer needs, independent of the archive format. */
export interface PackManifest {
  format: PackFormat;
  name: string;
  version?: string;
  author?: string;
  summary?: string;
  mcVersion: string;
  loader?: PackLoader;
  files: PackFile[];
  /** Archive folders (with trailing slash) copied over the game directory, in order; later ones win. */
  overrides: string[];
  /** Things the UI should tell the person (skipped files, unsupported components, …). */
  warnings: string[];
  settings?: PackSettings;
  origin: ModpackOrigin;
}

export class PackError extends Error {
  readonly name = "PackError";
  constructor(
    message: string,
    readonly code: "unknown-format" | "bad-manifest" | "unsupported" | "no-api-key" | "unresolved" | "failed" = "bad-manifest",
  ) {
    super(message);
  }
}

export const ORIGIN_SOURCE: Record<PackFormat, ModpackOrigin["source"]> = {
  mrpack: "mrpack",
  curseforge: "curseforge-zip",
  multimc: "multimc",
  mcbbs: "mcbbs",
};

export function hashSpecFrom(value: Record<string, unknown> | undefined): HashSpec | undefined {
  if (!value) return undefined;
  const out: HashSpec = {};
  for (const key of ["sha1", "sha256", "sha512", "md5"] as const) {
    const entry = value[key];
    if (typeof entry === "string" && /^[0-9a-f]+$/i.test(entry)) out[key] = entry.toLowerCase();
  }
  return Object.keys(out).length ? out : undefined;
}
