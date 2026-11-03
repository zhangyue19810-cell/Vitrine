import { PackError } from "./types";

/**
 * Paths in a modpack are untrusted input: a manifest entry or an archive member must stay inside the instance
 * folder, and must not replace the files Vitrine itself keeps there (`vitrine.json` carries a pre-launch command
 * and a Java path, so overwriting it would be a way to run code).
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Normalise and validate a relative path. Throws PackError when it is not acceptable. */
export function normalizePackPath(raw: string): string {
  if (typeof raw !== "string") throw new PackError("文件路径无效");
  let path = raw.replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) throw new PackError(`不安全的路径：${raw}`);
  const parts = path.split("/").filter((part) => part !== "");
  if (!parts.length) throw new PackError(`不安全的路径：${raw}`);
  for (const part of parts) {
    if (part === "." || part === "..") throw new PackError(`不安全的路径：${raw}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f<>:"|?*]/.test(part)) throw new PackError(`路径包含非法字符：${raw}`);
    // Windows silently drops trailing dots and spaces, which would let "vitrine.json." alias a protected name.
    if (/[. ]$/.test(part)) throw new PackError(`路径以点或空格结尾：${raw}`);
    if (WINDOWS_RESERVED.test(part)) throw new PackError(`路径使用了 Windows 保留名称：${raw}`);
  }
  return parts.join("/");
}

/** Files and folders inside an instance that a pack must never write to. */
export function isProtectedPath(path: string, instanceId: string): boolean {
  const lower = path.toLowerCase();
  const top = lower.split("/")[0];
  const id = instanceId.toLowerCase();
  if (lower.includes("/") === false && [`${id}.json`, `${id}.jar`, "vitrine.json", "vitrine-pack.json"].includes(lower)) return true;
  if (top === "natives" || top === ".vitrine") return true;
  return /\.(vtmp|vseg)$/.test(lower);
}

export type PathVerdict = { ok: true; path: string } | { ok: false; reason: string };

export function checkPackPath(raw: string, instanceId: string): PathVerdict {
  try {
    const path = normalizePackPath(raw);
    if (isProtectedPath(path, instanceId)) return { ok: false, reason: `不允许写入受保护的文件：${path}` };
    return { ok: true, path };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
