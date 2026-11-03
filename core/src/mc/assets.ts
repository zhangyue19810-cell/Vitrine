import { copyFile, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DownloadItem } from "../net/download";
import type { SourceRouter } from "../net/sources";
import { ensureDir, exists, fileSize, readJson, safeJoin } from "../util/fsx";
import type { AssetIndex, AssetIndexRef } from "./types";

export const ASSET_HOST = "https://resources.download.minecraft.net";

export const assetIndexPath = (root: string, id: string) => join(root, "assets", "indexes", `${id}.json`);
export const assetObjectPath = (root: string, hash: string) => join(root, "assets", "objects", hash.slice(0, 2), hash);

export function assetIndexItem(root: string, ref: AssetIndexRef, router: SourceRouter): DownloadItem {
  return {
    urls: router.candidates(ref.url),
    dest: assetIndexPath(root, ref.id),
    size: ref.size,
    hash: ref.sha1 ? { sha1: ref.sha1 } : undefined,
    label: `assets/indexes/${ref.id}.json`,
    group: "assets",
  };
}

export async function readAssetIndex(root: string, id: string): Promise<AssetIndex> {
  return readJson<AssetIndex>(assetIndexPath(root, id));
}

/** One download item per unique asset object. */
export function assetObjectItems(root: string, index: AssetIndex, router: SourceRouter): DownloadItem[] {
  const seen = new Set<string>();
  const items: DownloadItem[] = [];
  for (const [name, object] of Object.entries(index.objects)) {
    if (!/^[0-9a-f]{40}$/i.test(object.hash) || seen.has(object.hash)) continue;
    seen.add(object.hash);
    items.push({
      urls: router.candidates(`${ASSET_HOST}/${object.hash.slice(0, 2)}/${object.hash}`),
      dest: assetObjectPath(root, object.hash),
      size: object.size,
      hash: { sha1: object.hash },
      label: name,
      group: "assets",
    });
  }
  return items;
}

/**
 * Pre-1.7 clients read sounds from a `virtual/legacy` tree and pre-1.6 clients from `<gameDir>/resources`;
 * both are real file trees built from the content-addressed object store.
 */
export async function materializeLegacyAssets(
  root: string,
  indexId: string,
  gameDir: string,
): Promise<{ virtualDir?: string; resourcesDir?: string }> {
  const index = await readAssetIndex(root, indexId).catch(() => undefined);
  if (!index || (!index.virtual && !index.map_to_resources)) return {};
  const targetRoot = index.map_to_resources ? join(gameDir, "resources") : join(root, "assets", "virtual", indexId === "legacy" ? "legacy" : indexId);
  for (const [name, object] of Object.entries(index.objects)) {
    let target: string;
    try {
      target = safeJoin(targetRoot, name);
    } catch {
      continue;
    }
    const source = assetObjectPath(root, object.hash);
    if ((await fileSize(target)) === object.size) continue;
    if (!(await exists(source))) continue;
    await ensureDir(dirname(target));
    try {
      await link(source, target);
    } catch {
      await copyFile(source, target);
    }
  }
  return index.map_to_resources ? { resourcesDir: targetRoot } : { virtualDir: targetRoot };
}
