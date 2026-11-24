/** The Minecraft landscapes that form the launcher's living background carousel. */
export interface WorldScene {
  /** Stable name used by tests and future captions. */
  id: string;
  /** Human-readable place name. */
  label: string;
  /** Public asset path, resolved by `assetUrl` at the point of use. */
  src: string;
}

export const WORLD_SCENES: readonly WorldScene[] = [
  { id: "mountains", label: "雪线山脉", src: "assets/worlds/world-01-mountains.jpg" },
  { id: "deep-dark", label: "幽匿深域", src: "assets/worlds/world-02-deep-dark.jpg" },
  { id: "end-city", label: "末地城", src: "assets/worlds/world-03-end-city.jpg" },
  { id: "frozen-ocean", label: "冻洋", src: "assets/worlds/world-04-frozen-ocean.jpg" },
  { id: "jungle", label: "丛林", src: "assets/worlds/world-05-jungle.jpg" },
  { id: "nether", label: "下界", src: "assets/worlds/world-06-nether.jpg" },
  { id: "taiga", label: "针叶林", src: "assets/worlds/world-07-taiga.jpg" },
  { id: "diamonds", label: "钻石矿脉", src: "assets/worlds/world-08-diamonds.jpg" },
] as const;

/** One full 45° turn every 10 seconds. */
export const WORLD_SWITCH_MS = 10_000;
