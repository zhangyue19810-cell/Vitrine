export type JvmPreset = "auto" | "default" | "mojang" | "large-modpack" | "zgc";
export type ResolvedJvmPreset = Exclude<JvmPreset, "auto">;

export interface JvmPresetInfo {
  id: JvmPreset;
  label: string;
  description: string;
  args: string[];
  minJava: number;
}

export interface JvmContext {
  javaMajor: number;
  modCount?: number;
  maxMemoryMB?: number;
}

export interface JvmAdvice {
  preset: ResolvedJvmPreset;
  label: string;
  reason: string;
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
  {
    id: "auto",
    label: "智能匹配（推荐）",
    description: "根据 Java 版本、模组数量和分配内存自动选择 GC；原版保持默认，大型整合包使用低停顿 G1，超大内存包在 Java 21+ 上考虑 ZGC。",
    args: [],
    minJava: 8,
  },
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

/**
 * Pick a sensible collector without touching the archive or the game files.
 *
 * ZGC is only suggested when there is enough heap for its higher overhead;
 * otherwise the large-modpack G1 set is the safer choice. Vanilla sessions keep
 * Java's own default so a small machine does not pay for extra tuning.
 */
export function recommendJvmPreset(context: JvmContext): JvmAdvice {
  const mods = Math.max(0, context.modCount ?? 0);
  const memory = Math.max(0, context.maxMemoryMB ?? 0);
  const java = context.javaMajor;
  if (java < 8) {
    return { preset: "default", label: "默认", reason: `Java ${java} 过旧，不追加实验性 GC 参数` };
  }
  if (java >= 21 && mods >= 180 && memory >= 10_240 && memory <= 32_768) {
    return { preset: "zgc", label: "ZGC（Java 21+）", reason: `${mods} 个模组、${(memory / 1024).toFixed(1)} GB 堆，Java ${java} 适合低停顿分代 ZGC` };
  }
  if (mods >= 80 || memory >= 10_240) {
    return { preset: "large-modpack", label: "大型整合包（G1 Region 32M）", reason: `${mods} 个模组、${(memory / 1024).toFixed(1)} GB 堆，优先降低 GC 停顿` };
  }
  if (mods > 0) {
    return { preset: "mojang", label: "官方推荐（G1GC）", reason: `${mods} 个模组，使用稳定的 G1 预设` };
  }
  return { preset: "default", label: "默认", reason: "原版 / 轻量游戏，沿用 Java 的默认 GC 即可" };
}

export function resolveJvmPreset(preset: JvmPreset | undefined, context: JvmContext): ResolvedJvmPreset {
  return preset && preset !== "auto" ? preset : recommendJvmPreset(context).preset;
}

/** Preset arguments, skipped when the user already chose a collector or the Java is too old. */
export function presetArgs(preset: JvmPreset | undefined, javaMajor: number, userArgs: string[] = [], context?: JvmContext): string[] {
  const resolved = resolveJvmPreset(preset, {
    javaMajor,
    modCount: context?.modCount,
    maxMemoryMB: context?.maxMemoryMB,
  });
  const info = JVM_PRESETS.find((entry) => entry.id === resolved);
  if (!info || javaMajor < info.minJava) return [];
  if (userArgs.some((arg) => GC_FLAG.test(arg))) return [];
  // JDK 23+ made ZGC generational by default and dropped the -XX:+ZGenerational switch's usefulness.
  if (info.id === "zgc" && javaMajor >= 24) return ["-XX:+UseZGC"];
  return info.args;
}

const JVM_FLAG = (flag: string, args: string[]) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
const hasCollector = (args: string[]) => args.some((arg) => /^-XX:\+Use\w*GC$/.test(arg));

/**
 * Extra flags used when the player enables launch optimization. They are all
 * conservative HotSpot flags with wide vendor support. The intent is to let a
 * long-running modded game return unused heap pages and to shorten reference
 * processing pauses, not to force a different collector behind the user's back.
 */
export function processOptimizationArgs(javaMajor: number, preset: JvmPreset | undefined, userArgs: string[] = [], context?: JvmContext): string[] {
  if (javaMajor < 8) return [];
  const resolved = resolveJvmPreset(preset, { javaMajor, modCount: context?.modCount, maxMemoryMB: context?.maxMemoryMB });
  const active = [...presetArgs(preset, javaMajor, userArgs, context), ...userArgs];
  const useZgc = resolved === "zgc" || active.some((arg) => /^-XX:\+UseZGC$/.test(arg));
  if (useZgc) return [];
  const g1 = active.some((arg) => /^-XX:\+UseG1GC$/.test(arg)) || !hasCollector(active);
  if (!g1) return [];

  const out: string[] = [];
  const add = (flag: string) => {
    if (!JVM_FLAG(flag, active) && !out.some((entry) => entry === flag || entry.startsWith(`${flag}=`))) out.push(flag);
  };
  if (!hasCollector(active)) add("-XX:+UseG1GC");
  add("-XX:+ParallelRefProcEnabled");
  if ((context?.maxMemoryMB ?? 0) >= 4096 && (context?.modCount ?? 0) >= 24) add("-XX:+UseStringDeduplication");
  add("-XX:MinHeapFreeRatio=10");
  add("-XX:MaxHeapFreeRatio=30");
  return out;
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
  const physicalCap = Math.floor(input.totalMB * 0.6);
  // A heap is committed lazily, so current free memory is not a hard ceiling;
  // still, when the machine is already under pressure, do not promise the whole
  // physical-memory budget. This is the live half of the automatic calculation.
  const liveCap = Math.max(2048, input.freeMB + Math.floor(input.totalMB * 0.3));
  const cap = Math.min(physicalCap, liveCap);
  const maxMB = round256(Math.min(tier, Math.max(2048, cap)));
  const note =
    maxMB < tier
      ? liveCap < physicalCap
        ? `，已按当前空闲内存动态收紧（空闲 ${(input.freeMB / 1024).toFixed(1)} GB）`
        : `，已按物理内存 ${Math.round(input.totalMB / 1024)} GB 的 60% 限制`
      : "";
  return { maxMB, minMB: round256(Math.min(maxMB, 1024)), reason: `${reason}${note}` };
}
