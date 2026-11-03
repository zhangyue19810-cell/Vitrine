import { ensureDir, writeJsonAtomic } from "../util/fsx";
import { completeVersion, type CompleteOptions, type CompleteResult, type GameEnv } from "./files";
import type { VersionCatalog } from "./manifest";
import type { VersionJson } from "./types";
import { versionDir, versionJsonPath } from "./version-json";

export interface VanillaInstallOptions extends CompleteOptions {
  mcVersion: string;
  /** Folder / instance name; defaults to the Minecraft version. */
  name?: string;
}

export async function fetchVanillaJson(catalog: VersionCatalog, mcVersion: string, signal?: AbortSignal): Promise<VersionJson> {
  const entry = await catalog.find(mcVersion, signal);
  if (!entry) throw new Error(`Minecraft ${mcVersion} is not in the official version list`);
  return catalog.fetchVersionJson(entry, signal);
}

/** Install a vanilla version under `versions/<name>/` and download everything needed to run it. */
export async function installVanilla(env: GameEnv, catalog: VersionCatalog, options: VanillaInstallOptions): Promise<CompleteResult & { id: string }> {
  const id = options.name ?? options.mcVersion;
  const json = await fetchVanillaJson(catalog, options.mcVersion, options.signal);
  await ensureDir(versionDir(env.root, id));
  await writeJsonAtomic(versionJsonPath(env.root, id), { ...json, id });
  const result = await completeVersion(env, id, options);
  return { ...result, id };
}
