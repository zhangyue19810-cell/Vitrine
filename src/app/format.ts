const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 100 ? 0 : digits)} ${UNITS[unit]}`;
}

export const formatSpeed = (bytesPerSecond: number) => `${formatBytes(bytesPerSecond)}/s`;

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${String(m % 60).padStart(2, "0")} 分`;
}

export function formatPlayTime(ms: number | undefined): string {
  if (!ms || ms < 60_000) return "不足 1 分钟";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 100 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

export function relativeTime(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return "从未";
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  const days = Math.floor(diff / (24 * 60 * minute));
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

export function formatDate(timestamp: number | string | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatDateTime(timestamp: number | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return `${formatDate(timestamp)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 1.2万 / 3.4亿 for counts of downloads. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 1_000_000 ? 0 : 1)} 万`;
  return String(Math.round(value));
}

export function formatPercent(fraction: number | undefined, digits = 0): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return "—";
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(digits)}%`;
}

export const LOADER_LABELS: Record<string, string> = {
  none: "原版",
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  neoforge: "NeoForge",
  optifine: "OptiFine",
  liteloader: "LiteLoader",
  "legacy-fabric": "Legacy Fabric",
  cleanroom: "Cleanroom",
};

export const loaderLabel = (kind: string | undefined) => (kind ? (LOADER_LABELS[kind] ?? kind) : "原版");

export const VERSION_TYPE_LABELS: Record<string, string> = {
  release: "正式版",
  snapshot: "快照",
  old_beta: "远古 Beta",
  old_alpha: "远古 Alpha",
  unknown: "未知",
};

/** Compare dotted Minecraft versions loosely (1.21.1 > 1.21 > 1.20.6); non-numeric parts sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1));
  const pb = b.split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** A short, human reading of an RPC error. */
export function errorMessage(error: unknown): string {
  const e = error as { message?: string; code?: string };
  if (e?.code === "disconnected") return "与核心的连接已断开，正在重连…";
  if (e?.code === "cancelled") return "已取消";
  return e?.message ?? String(error);
}
