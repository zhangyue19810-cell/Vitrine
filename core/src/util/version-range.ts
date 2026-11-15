/**
 * Version-range matching for advisory mod metadata. Fabric/Quilt use semver-ish ranges (`>=1.2 <2`, `^1.2`, `1.2.x`,
 * `*`), while Forge/NeoForge use Maven intervals (`[1.0,2.0)`). This is intentionally conservative: when a range or
 * installed version cannot be understood the result is `undefined`, and callers must not report a conflict.
 */

interface ParsedVersion {
  numbers: number[];
  pre: string[];
}

function parseVersion(value: string): ParsedVersion | undefined {
  const text = value.trim().replace(/^v/i, "").split("+")[0];
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) return undefined;
  return {
    numbers: match[1].split(".").map(Number),
    pre: match[2]?.split(/[.-]/).filter(Boolean) ?? [],
  };
}

function comparePre(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1; // 1.0.0 > 1.0.0-beta
  if (!right.length) return -1;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const a = /^\d+$/.test(left[i]) ? Number(left[i]) : undefined;
    const b = /^\d+$/.test(right[i]) ? Number(right[i]) : undefined;
    if (a !== undefined && b !== undefined) {
      if (a !== b) return a < b ? -1 : 1;
    } else if (a !== undefined) {
      return -1;
    } else if (b !== undefined) {
      return 1;
    } else if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two versions. `undefined` means at least one side is not a version this matcher understands. */
export function compareRangeVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length, 3); i++) {
    const x = a.numbers[i] ?? 0;
    const y = b.numbers[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

const isWildcard = (value: string) => value === "" || value === "*" || value === "x" || value === "X";

function numericParts(value: string): number[] | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim().replace(/^v/i, ""));
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

function bump(parts: number[], index: number): string {
  const next = parts.slice();
  next[index] += 1;
  for (let i = index + 1; i < next.length; i++) next[i] = 0;
  return next.join(".");
}

function compareConstraint(value: string, op: string, target: string): boolean | undefined {
  const result = compareRangeVersions(value, target);
  if (result === undefined) return undefined;
  if (op === ">") return result > 0;
  if (op === ">=") return result >= 0;
  if (op === "<") return result < 0;
  if (op === "<=") return result <= 0;
  return result === 0;
}

function mavenInterval(value: string, interval: string): boolean | undefined {
  const exact = /^\[([^,\]]+)\]$/.exec(interval);
  if (exact) return compareRangeVersions(value, exact[1]) === 0;
  const match = /^([\[(])([^,]*),([^\])]*)([\])])$/.exec(interval);
  if (!match) return undefined;
  const [, leftBracket, lower, upper, rightBracket] = match;
  if (lower.trim()) {
    const result = compareRangeVersions(value, lower.trim());
    if (result === undefined) return undefined;
    if (leftBracket === "[" ? result < 0 : result <= 0) return false;
  }
  if (upper.trim()) {
    const result = compareRangeVersions(value, upper.trim());
    if (result === undefined) return undefined;
    if (rightBracket === "]" ? result > 0 : result >= 0) return false;
  }
  return true;
}

function satisfiesToken(value: string, token: string): boolean | undefined {
  const raw = token.trim();
  if (!raw) return undefined;
  if (isWildcard(raw)) return true;
  if (raw.startsWith("[") || raw.startsWith("(")) return mavenInterval(value, raw);

  const hyphen = /^(.+?)\s+-\s+(.+)$/.exec(raw);
  if (hyphen) {
    const lower = compareConstraint(value, ">=", hyphen[1].trim());
    const upper = compareConstraint(value, "<=", hyphen[2].trim());
    return lower === undefined || upper === undefined ? undefined : lower && upper;
  }

  if (raw.startsWith("^")) {
    const base = raw.slice(1);
    const parts = numericParts(base);
    if (!parts) return undefined;
    const level = parts[0] > 0 ? 0 : parts[1] > 0 ? 1 : 2;
    const lower = compareConstraint(value, ">=", base);
    const upper = compareConstraint(value, "<", bump(parts, level));
    return lower === undefined || upper === undefined ? undefined : lower && upper;
  }
  if (raw.startsWith("~")) {
    const base = raw.slice(1);
    const parts = numericParts(base);
    if (!parts) return undefined;
    const count = base.split(".").length;
    const upper = compareConstraint(value, "<", bump(parts, count <= 1 ? 0 : 1));
    const lower = compareConstraint(value, ">=", base);
    return lower === undefined || upper === undefined ? undefined : lower && upper;
  }

  const wildcard = /^(\d+(?:\.\d+)*)\.[xX*]$/.exec(raw);
  if (wildcard) {
    const parts = numericParts(wildcard[1]);
    if (!parts) return undefined;
    const lower = compareConstraint(value, ">=", wildcard[1]);
    const upper = compareConstraint(value, "<", bump(parts, wildcard[1].split(".").length - 1));
    return lower === undefined || upper === undefined ? undefined : lower && upper;
  }

  const prefixed = /^(>=|<=|>|<|==|=)\s*(.+)$/.exec(raw);
  if (prefixed) return compareConstraint(value, prefixed[1] === "=" ? "=" : prefixed[1], prefixed[2].trim());
  return compareConstraint(value, "=", raw);
}

/**
 * Check an installed version against a declared range. Returns true/false when both are usable, or undefined when the
 * data is too loose to judge (for example `${file.jarVersion}` or a non-standard version string).
 */
export function versionSatisfies(version: string | undefined, range: string | undefined): boolean | undefined {
  const wanted = range?.trim();
  if (wanted === "*") return true;
  if (!version || !wanted) return undefined;
  const value = version.trim().replace(/^v/i, "");
  if (!parseVersion(value)) return undefined;

  const groups = wanted.split("||").map((group) => group.trim()).filter(Boolean);
  if (!groups.length) return true;
  let unknown = false;
  for (const group of groups) {
    // Maven can declare several closed/open intervals separated by commas; ordinary ranges use spaces or commas.
    const intervals = group.match(/[\[(][^\])]*[\])]/g);
    const tokens = intervals?.length ? intervals : /\s+-\s+/.test(group) ? [group] : group.split(/[\s,]+/).filter(Boolean);
    let all = true;
    let gap = false;
    for (const token of tokens) {
      const verdict = satisfiesToken(value, token);
      if (verdict === undefined) {
        gap = true;
        break;
      }
      if (!verdict) {
        all = false;
        break;
      }
    }
    if (gap) unknown = true;
    else if (all) return true;
  }
  return unknown ? undefined : false;
}
