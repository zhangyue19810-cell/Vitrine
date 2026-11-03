export type JvmPreset = "default" | "mojang" | "large-modpack" | "zgc";

export interface JvmPresetInfo {
  id: JvmPreset;
  label: string;
  description: string;
  args: string[];
  minJava: number;
}

const G1_BASE = [
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+UseG1GC",
  "-XX:G1NewSizePercent=20",
  "-XX:G1ReservePercent=20",
  "-XX:MaxGCPauseMillis=50",
  "-XX:G1HeapRegionSize=32M",
];

export const JVM_PRESETS: JvmPresetInfo[] = [
  { id: "default", label: "默认", description: "不额外添加 GC 参数，交给 Java 自己决定。", args: [], minJava: 8 },
  {
    id: "mojang",
    label: "官方推荐（G1GC）",
    description: "与 Mojang 官方启动器相同的 G1GC 参数，适合大多数原版和轻量整合包。",
    args: G1_BASE,
    minJava: 8,
  },
  {
    id: "large-modpack",
    label: "大型整合包（G1 Region 32M）",
    description: "在官方参数基础上加大 G1 Region 并减少引用处理停顿；200+ 模组、机械动力类大型结构时可以缓解巨型对象分配造成的卡顿。",
    args: [...G1_BASE, "-XX:+ParallelRefProcEnabled", "-XX:-OmitStackTraceInFastThrow"],
    minJava: 8,
  },
  {
    id: "zgc",
    label: "ZGC（Java 21+）",
    description: "低停顿的分代 ZGC，内存占用更高；需要 Java 21 或更新。",
    args: ["-XX:+UseZGC", "-XX:+ZGenerational"],
    minJava: 21,
  },
];

const GC_FLAG = /^-XX:[+-]?(Use\w*GC|UnlockExperimentalVMOptions)/;

/** Preset arguments, skipped when the user already chose a collector or the Java is too old. */
export function presetArgs(preset: JvmPreset | undefined, javaMajor: number, userArgs: string[] = []): string[] {
  const info = JVM_PRESETS.find((entry) => entry.id === (preset ?? "default"));
  if (!info || javaMajor < info.minJava) return [];
  if (userArgs.some((arg) => GC_FLAG.test(arg))) return [];
  // JDK 23+ made ZGC generational by default and dropped the -XX:+ZGenerational switch's usefulness.
  if (info.id === "zgc" && javaMajor >= 24) return ["-XX:+UseZGC"];
  return info.args;
}

export interface MemoryInput {
  totalMB: number;
  freeMB: number;
  modCount: number;
  is64: boolean;
}

export interface MemoryAdvice {
  maxMB: number;
  minMB: number;
  reason: string;
}

const round256 = (value: number) => Math.max(512, Math.floor(value / 256) * 256);

/** Pick a heap size from the machine and the number of mods. */
export function recommendMemory(input: MemoryInput): MemoryAdvice {
  if (!input.is64) return { maxMB: 1280, minMB: 512, reason: "32 位 Java 最多只能使用约 1.5 GB 内存" };
  let tier: number;
  let reason: string;
  if (input.modCount <= 0) {
    tier = 3072;
    reason = "原版或轻量游戏";
  } else if (input.modCount <= 50) {
    tier = 4096;
    reason = `约 ${input.modCount} 个模组`;
  } else if (input.modCount <= 120) {
    tier = 6144;
    reason = `约 ${input.modCount} 个模组`;
  } else if (input.modCount <= 200) {
    tier = 8192;
    reason = `约 ${input.modCount} 个模组（大型整合包）`;
  } else {
    tier = input.totalMB >= 28 * 1024 ? 12288 : 10240;
    reason = `约 ${input.modCount} 个模组（超大型整合包）`;
  }
  const cap = Math.floor(input.totalMB * 0.6);
  const maxMB = round256(Math.min(tier, Math.max(2048, cap)));
  const note = maxMB < tier ? `，已按物理内存 ${Math.round(input.totalMB / 1024)} GB 的 60% 限制` : "";
  return { maxMB, minMB: round256(Math.min(maxMB, 1024)), reason: `${reason}${note}` };
}
