/** Shapes of Mojang's launcher JSON (version manifest, version JSON, asset index, runtime manifests). */

export type VersionType = "release" | "snapshot" | "old_beta" | "old_alpha";

export interface ManifestEntry {
  id: string;
  type: VersionType | string;
  url: string;
  time?: string;
  releaseTime: string;
  sha1?: string;
  complianceLevel?: number;
}

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: ManifestEntry[];
}

export interface OsRule {
  name?: string;
  version?: string;
  arch?: string;
}

export interface Rule {
  action: "allow" | "disallow";
  os?: OsRule;
  features?: Record<string, boolean>;
}

export interface Artifact {
  path?: string;
  url: string;
  sha1?: string;
  size?: number;
  id?: string;
}

export interface LibraryJson {
  name: string;
  /** Maven repository root for libraries without a `downloads` block (Fabric, old Forge, ...). */
  url?: string;
  sha1?: string;
  sha256?: string;
  sha512?: string;
  md5?: string;
  size?: number;
  downloads?: {
    artifact?: Artifact;
    classifiers?: Record<string, Artifact>;
  };
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
  rules?: Rule[];
  clientreq?: boolean;
  serverreq?: boolean;
  checksums?: string[];
}

export interface ArgumentValue {
  rules?: Rule[];
  value: string | string[];
}

export type Argument = string | ArgumentValue;

export interface AssetIndexRef {
  id: string;
  sha1?: string;
  size?: number;
  totalSize?: number;
  url: string;
}

export interface LoggingConfig {
  argument: string;
  file: Artifact & { id: string };
  type?: string;
}

export interface VersionJson {
  id: string;
  inheritsFrom?: string;
  /** Legacy field of old Forge profiles: which version folder holds the client jar. */
  jar?: string;
  type?: string;
  time?: string;
  releaseTime?: string;
  mainClass?: string;
  minecraftArguments?: string;
  arguments?: { game?: Argument[]; jvm?: Argument[] };
  libraries?: LibraryJson[];
  assetIndex?: AssetIndexRef;
  assets?: string;
  downloads?: {
    client?: Artifact;
    server?: Artifact;
    client_mappings?: Artifact;
    server_mappings?: Artifact;
    [key: string]: Artifact | undefined;
  };
  javaVersion?: { component: string; majorVersion: number };
  logging?: { client?: LoggingConfig };
  minimumLauncherVersion?: number;
  complianceLevel?: number;
}

export interface AssetObject {
  hash: string;
  size: number;
}

export interface AssetIndex {
  objects: Record<string, AssetObject>;
  virtual?: boolean;
  map_to_resources?: boolean;
}

export interface FeatureFlags {
  is_demo_user?: boolean;
  has_custom_resolution?: boolean;
  has_quick_plays_support?: boolean;
  is_quick_play_singleplayer?: boolean;
  is_quick_play_multiplayer?: boolean;
  is_quick_play_realms?: boolean;
  [key: string]: boolean | undefined;
}

export type LoaderKind = "none" | "forge" | "neoforge" | "fabric" | "quilt" | "liteloader" | "optifine" | "legacy-fabric" | "cleanroom";
