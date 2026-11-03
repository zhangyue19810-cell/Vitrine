/** Loose version comparison good enough for Minecraft, loader and Java versions. */

function tokens(version: string): (number | string)[] {
  return version
    .replace(/^[vV]/, "")
    .split(/[.\-_+]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

export function compareVersions(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return typeof y === "number" ? -1 : 1; // 1.2 < 1.2.1, but 1.2 > 1.2-pre
    if (y === undefined) return typeof x === "number" ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
    } else if (typeof x === "number") return 1; // number beats label
    else if (typeof y === "number") return -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Parse the leading numeric parts of a Minecraft release version ("1.21.1" → [1,21,1]). */
export function mcParts(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** True for stable release ids like "1.21.1" (not snapshots, pre-releases or April-fools builds). */
export function isReleaseId(version: string): boolean {
  return /^\d+\.\d+(\.\d+)?$/.test(version);
}

/**
 * Java major version Minecraft needs when the version JSON carries no `javaVersion`.
 * Used for very old versions and for hand-written version files.
 */
export function fallbackJavaMajor(mcVersion: string): number {
  const parts = mcParts(mcVersion);
  if (!parts) return 21;
  const [major, minor, patch] = parts;
  if (major > 1) return 21;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

/** Parse "java -version" style strings: "1.8.0_392" → 8, "17.0.9" → 17, "21" → 21. */
export function parseJavaMajor(version: string): number | undefined {
  const legacy = /^1\.(\d+)/.exec(version);
  if (legacy) return Number(legacy[1]);
  const modern = /^(\d+)/.exec(version);
  return modern ? Number(modern[1]) : undefined;
}
