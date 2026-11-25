import { assetUrl } from "../asset-url";

/**
 * Startup warm-up cache.
 *
 * The splash is CSS-only and already visible while this runs. Fonts and the
 * 3.5 MB cassette GLB are fetched once into an in-memory buffer; the scene
 * later parses that buffer instead of issuing a second request. The cache is
 * temporary by design and released when the document closes.
 */

const MODEL_URL = assetUrl("assets/archive-cassette.glb");
const buffers = new Map<string, ArrayBuffer>();
let warmup: Promise<void> | undefined;

export function preloadVisualAssets(): Promise<void> {
  if (warmup) return warmup;
  warmup = (async () => {
    const jobs: Promise<unknown>[] = [];
    for (const [family, sample, weight] of [
      ["LXGW WenKai", "Vitrine 琉匣 Minecraft", "500"],
      ["Ma Shan Zheng", "琉匣档案启动", "400"],
      ["Kaushan Script", "VITRINE", "400"],
      ["Vitrine Serif", "VITRINE Launcher", "400"],
    ] as const) {
      jobs.push(document.fonts.load(`${weight} 32px "${family}"`, sample).catch(() => undefined));
    }
    jobs.push((async () => {
      try {
        const response = await fetch(MODEL_URL, { cache: "force-cache" });
        if (!response.ok) return;
        buffers.set(MODEL_URL, await response.arrayBuffer());
      } catch {
        /* the scene loader still has its normal network path */
      }
    })());
    await Promise.allSettled(jobs);
  })();
  return warmup;
}

/** Take the temporary bytes once: parsing consumes them, so the warm-up copy is released immediately. */
export function takeVisualAsset(url: string): ArrayBuffer | undefined {
  const buffer = buffers.get(url);
  buffers.delete(url);
  return buffer;
}

export function waitForVisualAssets(ms = 8000): Promise<void> {
  return Promise.race([
    preloadVisualAssets(),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}
