import { createHash, randomBytes } from "node:crypto";

/** Java's UUID.nameUUIDFromBytes: MD5, then stamp version 3 and the IETF variant. */
export function nameUuidFromBytes(data: Buffer): string {
  const hash = createHash("md5").update(data).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash.toString("hex"));
}

/** The UUID Minecraft assigns to a player name on an offline-mode server. */
export function offlineUuid(name: string): string {
  return nameUuidFromBytes(Buffer.from(`OfflinePlayer:${name}`, "utf8"));
}

export function formatUuid(hex32: string): string {
  const h = hex32.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isUuid(text: string): boolean {
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(text.trim());
}

export function randomUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes.toString("hex"));
}

/** Minecraft player names: 3-16 characters of letters, digits and underscore. */
export function validatePlayerName(name: string): string | undefined {
  if (!name) return "请输入玩家名";
  if (name.length < 3 || name.length > 16) return "玩家名长度需要在 3 到 16 个字符之间";
  if (!/^[A-Za-z0-9_]+$/.test(name)) return "玩家名只能包含英文字母、数字和下划线";
  return undefined;
}
