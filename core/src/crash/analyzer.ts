import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Crash analysis. Rules are matched against the crash report, `latest.log` and JVM `hs_err` files; each match becomes a
 * finding with a plain-language explanation and, when the launcher can do something about it, a structured `fix`
 * the interface turns into a button. The patterns come from the message formats of the loaders and the JVM — they
 * are heuristics, so a finding always carries the evidence line it was based on.
 */

export type CrashSeverity = "error" | "warn" | "info";

export type CrashFix =
  | { kind: "increase-memory"; suggestMb?: number }
  | { kind: "switch-java"; major: number }
  | { kind: "install-mods"; modIds: string[] }
  | { kind: "disable-mods"; modIds: string[]; files?: string[] }
  | { kind: "remove-duplicates"; modIds: string[] }
  | { kind: "repair-files" }
  | { kind: "update-graphics-driver"; vendor?: string }
  | { kind: "reset-jvm-args" }
  | { kind: "check-config"; file?: string }
  | { kind: "free-disk-space" }
  | { kind: "change-game-version"; wanted: string; actual?: string };

export interface CrashFinding {
  id: string;
  severity: CrashSeverity;
  title: string;
  detail: string;
  advice: string[];
  /** Mod ids (or jar names) the finding points at. */
  mods?: string[];
  evidence?: string;
  fix?: CrashFix;
}

export interface CrashInput {
  crashReport?: string;
  log?: string;
  hsErr?: string;
  exitCode?: number | null;
  signal?: string | null;
  javaMajor?: number;
  mcVersion?: string;
  loader?: string;
  maxMemoryMb?: number;
  installedMods?: { id?: string; name?: string; fileName: string }[];
}

export interface CrashAnalysis {
  /** One line naming the most likely cause, or the exception that ended the game. */
  summary: string;
  /** What the game was doing ("Ticking entity", "Initializing game", …) from the crash report. */
  description?: string;
  /** The root exception line (deepest "Caused by"). */
  rootException?: string;
  suspectedMods: string[];
  findings: CrashFinding[];
}

const MAX_TEXT = 2 * 1024 * 1024;
const JAVA_BY_CLASS_VERSION = (version: number) => version - 44;

const clip = (line: string, max = 220) => (line.length > max ? `${line.slice(0, max)}…` : line).trim();

function firstLine(text: string, pattern: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/)) if (pattern.test(line)) return clip(line);
  return undefined;
}

/** Recommend a Java for a class-file major version: the lowest LTS that can run it. */
function javaFor(major: number): number {
  if (major <= 8) return 8;
  if (major <= 11) return 11;
  if (major <= 17) return 17;
  return major <= 21 ? 21 : major;
}

interface Rule {
  id: string;
  /** Cheap pre-check so only plausible rules run their regexes. */
  hint: RegExp;
  run(ctx: Ctx): CrashFinding | CrashFinding[] | undefined;
}

interface Ctx {
  input: CrashInput;
  /** Everything we have, joined — rules search this unless they need one source. */
  all: string;
  crash: string;
  log: string;
  hs: string;
  modFile(id: string): string | undefined;
}

const uniq = <T>(items: T[]) => [...new Set(items)];

const RULES: Rule[] = [
  {
    id: "java-too-old",
    hint: /UnsupportedClassVersionError|Unsupported major\.minor|class file version|requires Java \d+|Java runtime \(class file version/i,
    run({ all, input }) {
      const classVersion = /class file version (\d+)\.\d+/.exec(all) ?? /has been compiled by a more recent version of the Java Runtime \(class file version (\d+)/.exec(all);
      const legacy = /Unsupported major\.minor version (\d+)\.\d+/.exec(all);
      const needed = classVersion ? JAVA_BY_CLASS_VERSION(Number(classVersion[1])) : legacy ? JAVA_BY_CLASS_VERSION(Number(legacy[1])) : Number(/requires Java (\d+)/i.exec(all)?.[1]);
      if (!needed || Number.isNaN(needed)) return undefined;
      if (input.javaMajor && input.javaMajor >= needed) return undefined;
      const target = javaFor(needed);
      return {
        id: "java-too-old",
        severity: "error",
        title: `Java 版本过低，需要 Java ${needed} 或更高`,
        detail: `游戏或某个模组由 Java ${needed} 编译，当前运行的 Java${input.javaMajor ? ` ${input.javaMajor}` : ""} 无法加载它。`,
        advice: [`为这个实例选择 Java ${target}（设置 → Java，或让启动器自动下载 Mojang 运行时）。`],
        evidence: firstLine(all, /UnsupportedClassVersionError|Unsupported major\.minor|class file version/i),
        fix: { kind: "switch-java", major: target },
      };
    },
  },
  {
    id: "java-too-new",
    hint: /Unsupported class file major version|IllegalArgumentException: Unsupported class file/i,
    run({ all, input }) {
      const match = /Unsupported class file major version (\d+)/.exec(all);
      const found = match ? JAVA_BY_CLASS_VERSION(Number(match[1])) : undefined;
      return {
        id: "java-too-new",
        severity: "error",
        title: "Java 版本过高，游戏或模组加载器无法分析它",
        detail: `ASM / Mixin 等字节码工具不认识当前 Java${found ? ` ${found}` : ""} 的类文件格式，这在旧版 Minecraft 或旧版 Forge 上使用新 Java 时很常见。`,
        advice: [`换用该 Minecraft 版本对应的 Java：1.16 及更早用 Java 8，1.17–1.20.4 用 Java 17，1.20.5 及以上用 Java 21。`],
        evidence: firstLine(all, /Unsupported class file major version/i),
        fix: { kind: "switch-java", major: input.mcVersion ? recommendedJava(input.mcVersion) : 17 },
      };
    },
  },
  {
    id: "out-of-memory",
    hint: /OutOfMemoryError|GC overhead|insufficient memory|Could not reserve enough space|Java heap space/i,
    run({ all, input }) {
      if (/unable to create (?:new )?native thread/i.test(all)) {
        return {
          id: "out-of-memory",
          severity: "error",
          title: "系统无法再创建线程（内存或线程数耗尽）",
          detail: "分配给游戏的内存过大会挤占系统可用内存，导致无法创建原生线程。",
          advice: ["适当降低分配内存，关闭其他占内存的程序，必要时增大系统虚拟内存（页面文件）。"],
          evidence: firstLine(all, /unable to create (?:new )?native thread/i),
          fix: { kind: "increase-memory", suggestMb: input.maxMemoryMb ? Math.max(2048, Math.round(input.maxMemoryMb * 0.75)) : undefined },
        };
      }
      if (/Metaspace/.test(all)) {
        return {
          id: "out-of-memory",
          severity: "error",
          title: "Metaspace（类元数据）空间不足",
          detail: "加载的模组和类太多，超出了 JVM 的 Metaspace 上限。",
          advice: ["在额外 JVM 参数里加入 -XX:MaxMetaspaceSize=512m 或更大，或者删去不需要的模组。"],
          evidence: firstLine(all, /Metaspace/),
        };
      }
      if (/Direct buffer memory/.test(all)) {
        return {
          id: "out-of-memory",
          severity: "error",
          title: "直接内存（Direct buffer）不足",
          detail: "材质、着色器或光影占用了大量堆外内存。",
          advice: ["在额外 JVM 参数里加入 -XX:MaxDirectMemorySize=2g，或降低渲染距离与材质分辨率。"],
          evidence: firstLine(all, /Direct buffer memory/),
        };
      }
      if (/insufficient memory for the Java Runtime|Could not reserve enough space|Out of Memory Error \(os_/i.test(all)) {
        return {
          id: "out-of-memory",
          severity: "error",
          title: "电脑可用内存不足，JVM 无法启动",
          detail: "分配给游戏的最大内存超过了系统当前能给出的内存（32 位 Java 的上限约 1.5 GB）。",
          advice: ["降低“最大内存”，使用 64 位 Java，并关闭其他占用内存的程序。"],
          evidence: firstLine(all, /insufficient memory|Could not reserve enough space|Out of Memory Error/i),
          fix: { kind: "increase-memory", suggestMb: input.maxMemoryMb ? Math.max(1024, Math.round(input.maxMemoryMb / 2)) : 2048 },
        };
      }
      return {
        id: "out-of-memory",
        severity: "error",
        title: "游戏内存不足（Java heap space）",
        detail: `游戏用完了分配给它的内存${input.maxMemoryMb ? `（当前最大 ${input.maxMemoryMb} MB）` : ""}。模组很多的整合包、较高的渲染距离和高分辨率材质都会消耗大量内存。`,
        advice: ["在实例设置里调大“最大内存”（一般整合包 6–10 GB），同时保证电脑还剩下足够的空闲内存。", "降低渲染距离或模拟距离。"],
        evidence: firstLine(all, /OutOfMemoryError|GC overhead/),
        fix: { kind: "increase-memory", suggestMb: Math.max(4096, Math.round((input.maxMemoryMb ?? 2048) * 1.5 / 512) * 512) },
      };
    },
  },
  {
    id: "jvm-args",
    hint: /Unrecognized (?:VM )?option|Could not create the Java Virtual Machine|Invalid maximum heap size|Error occurred during initialization of VM|Unrecognized option/i,
    run({ all }) {
      if (/Could not reserve enough space|insufficient memory/i.test(all)) return undefined; // reported by the memory rule
      const option = /Unrecognized (?:VM )?option '([^']+)'/.exec(all)?.[1];
      return {
        id: "jvm-args",
        severity: "error",
        title: "JVM 无法启动：额外 JVM 参数有问题",
        detail: option ? `当前 Java 不认识参数 ${option}。常见原因是参数是为别的 Java 版本写的。` : "JVM 在初始化阶段就报错退出，通常是额外 JVM 参数有误或最大内存设置不合法。",
        advice: ["清空实例设置里的“额外 JVM 参数”后重试；再逐条加回需要的参数。", "确认最大内存是合法数值，并且不大于电脑内存。"],
        evidence: firstLine(all, /Unrecognized|Could not create the Java Virtual Machine|Invalid maximum heap size|Error occurred during initialization of VM/i),
        fix: { kind: "reset-jvm-args" },
      };
    },
  },
  {
    id: "missing-dependency",
    hint: /requires .*which is missing|Requested by|Currently, \S+ is not installed|\[MISSING\]|Could not find required mod|Install \S+, (?:any version|version)/i,
    run({ all, modFile }) {
      const missing = new Map<string, { by: Set<string>; range?: string }>();
      const note = (id: string, by?: string, range?: string) => {
        if (!id || id === "minecraft" || id === "forge" || id === "neoforge" || id === "fabricloader" || id === "java") return;
        const entry = missing.get(id) ?? { by: new Set<string>() };
        if (by) entry.by.add(by);
        if (range && !entry.range) entry.range = range;
        missing.set(id, entry);
      };
      // Fabric / Quilt
      for (const m of all.matchAll(/Mod '([^'\n]+)' \(([^)\n]+)\) \S+ requires (.{1,80}?) of (?:mod )?(\S+), which is missing/g)) note(m[4], m[2], m[3]);
      for (const m of all.matchAll(/^\s*-?\s*Install ([\w.\-]+), (any version|version [^\n]+?)\.?$/gm)) note(m[1], undefined, m[2]);
      // Forge / early NeoForge
      for (const m of all.matchAll(/Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '\[?MISSING\]?'/g)) note(m[1], m[2], m[3]);
      // NeoForge 1.20.5+
      for (const m of all.matchAll(/Mod (.{1,80}?) requires (\S+) (\S+)(?: or above)?\s*[\r\n]+\s*Currently, (\S+) is not installed/g)) note(m[2], m[1], m[3]);
      for (const m of all.matchAll(/Could not find required mod: (\S+)/g)) note(m[1]);
      if (!missing.size) return undefined;
      const ids = [...missing.keys()];
      return {
        id: "missing-dependency",
        severity: "error",
        title: `缺少前置模组：${ids.slice(0, 6).join("、")}${ids.length > 6 ? " 等" : ""}`,
        detail: ids
          .slice(0, 8)
          .map((id) => {
            const entry = missing.get(id)!;
            const who = [...entry.by].map((by) => modFile(by) ?? by);
            return `${id}${entry.range ? `（要求 ${entry.range}）` : ""}${who.length ? `，被 ${who.join("、")} 需要` : ""}`;
          })
          .join("；"),
        advice: ["安装缺少的前置模组（版本要和游戏版本、加载器一致）。", "如果这些模组其实已经装了，检查是否装错了加载器版本，或文件被加了 .disabled 后缀。"],
        mods: ids,
        evidence: firstLine(all, /which is missing|Requested by|Currently, \S+ is not installed|Could not find required mod/),
        fix: { kind: "install-mods", modIds: ids },
      };
    },
  },
  {
    id: "wrong-version",
    hint: /but only the wrong version is present|Actual version|requires .*minecraft|is not compatible with|incompatible/i,
    run({ all, input }) {
      const findings: CrashFinding[] = [];
      for (const m of all.matchAll(/Mod '([^'\n]+)' \(([^)\n]+)\) \S+ requires (?:version )?(.{1,60}?) of (?:mod )?(\S+), but only the wrong version is present: ([^\s!]+)/g)) {
        const [, name, id, wanted, dep, actual] = m;
        if (dep === "minecraft") {
          findings.push({
            id: `wrong-minecraft-${id}`,
            severity: "error",
            title: `${name} 不支持当前的 Minecraft 版本`,
            detail: `${name} 需要 Minecraft ${wanted}，而当前是 ${actual}。`,
            advice: ["下载与当前游戏版本对应的模组文件，或者换一个游戏版本。"],
            mods: [id],
            evidence: clip(m[0]),
            fix: { kind: "change-game-version", wanted, actual },
          });
        } else {
          findings.push({
            id: `wrong-version-${id}-${dep}`,
            severity: "error",
            title: `${name} 需要不同版本的 ${dep}`,
            detail: `${name} 要求 ${dep} ${wanted}，当前是 ${actual}。`,
            advice: [`把 ${dep} 更新（或降级）到满足要求的版本。`],
            mods: [id, dep],
            evidence: clip(m[0]),
          });
        }
      }
      for (const m of all.matchAll(/Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^'\[][^']*)'/g)) {
        const [, dep, by, range, actual] = m;
        if (dep === "minecraft") {
          findings.push({
            id: `wrong-minecraft-${by}`,
            severity: "error",
            title: `${modName(by)} 不支持当前的 Minecraft 版本`,
            detail: `${by} 需要 Minecraft ${range}，而当前是 ${actual}。`,
            advice: ["下载与当前游戏版本对应的模组文件，或者换一个游戏版本。"],
            mods: [by],
            evidence: clip(m[0]),
            fix: { kind: "change-game-version", wanted: range, actual },
          });
        } else if (dep === "forge" || dep === "neoforge") {
          findings.push({
            id: `wrong-loader-${by}`,
            severity: "error",
            title: `${by} 需要另一个版本的 ${dep}`,
            detail: `要求 ${dep} ${range}，当前是 ${actual}。`,
            advice: [`在实例里安装满足 ${range} 的 ${dep} 版本。`],
            mods: [by],
            evidence: clip(m[0]),
          });
        } else {
          findings.push({
            id: `wrong-version-${by}-${dep}`,
            severity: "error",
            title: `${by} 需要不同版本的 ${dep}`,
            detail: `要求 ${dep} ${range}，当前是 ${actual}。`,
            advice: [`把 ${dep} 更新（或降级）到满足要求的版本。`],
            mods: [by, dep],
            evidence: clip(m[0]),
          });
        }
      }
      void input;
      return findings.length ? findings : undefined;
    },
  },
  {
    id: "duplicate-mods",
    hint: /duplicate mod|Duplicate mandatory mods|from mod files:/i,
    run({ all }) {
      const ids: string[] = [];
      const files: string[] = [];
      for (const m of all.matchAll(/Mod ID:? '([^']+)'(?: from mod files:|,? \w+ mod files:) ([^\r\n]+)/g)) {
        ids.push(m[1]);
        files.push(...m[2].split(/,\s*/).map((file) => file.trim()));
      }
      if (!ids.length && !/duplicate mod/i.test(all)) return undefined;
      return {
        id: "duplicate-mods",
        severity: "error",
        title: ids.length ? `同一个模组装了多份：${uniq(ids).slice(0, 5).join("、")}` : "检测到重复安装的模组",
        detail: files.length ? `重复的文件：${uniq(files).join("、")}` : "mods 文件夹里有同一个模组的多个版本。",
        advice: ["在模组管理里把重复项只保留一份（保留较新的版本）。"],
        mods: uniq(ids),
        evidence: firstLine(all, /duplicate mod|from mod files:/i),
        fix: { kind: "remove-duplicates", modIds: uniq(ids) },
      };
    },
  },
  {
    id: "mixin-failure",
    hint: /Mixin|InjectionError|InvalidInjectionException|MixinTransformerError/,
    run({ all, modFile }) {
      if (!/Mixin apply (?:for mod \S+ )?failed|InvalidMixinException|InjectionError|InvalidInjectionException|MixinTransformerError|Mixin transformation of|MixinApplyError/.test(all)) return undefined;
      const byMod = /Mixin apply for mod (\S+) failed/.exec(all)?.[1] ?? /from mod (\S+?)(?:\s|->|:)/.exec(all)?.[1];
      const byConfig = /([\w\-.]+?)\.mixins?(?:\.[\w\-]+)?\.json/.exec(all)?.[1];
      const target = /(?:Mixin transformation of|Mixin apply .* failed .*? -> )\s*([\w.$/]+)/.exec(all)?.[1];
      const id = byMod ?? byConfig;
      const file = id ? modFile(id) : undefined;
      return {
        id: "mixin-failure",
        severity: "error",
        title: id ? `模组 ${id} 的 Mixin 注入失败` : "某个模组的 Mixin 注入失败",
        detail: `这个模组修改游戏代码${target ? `（目标 ${target}）` : ""}时失败，通常是它与当前游戏版本、加载器版本或另一个模组不兼容。`,
        advice: [
          "确认该模组是为当前游戏版本和加载器下载的。",
          "更新这个模组和它修改的相关模组（如渲染、优化类模组）；或暂时移除它试试。",
          ...(file ? [`相关文件：${file}`] : []),
        ],
        mods: id ? [id] : undefined,
        evidence: firstLine(all, /Mixin apply|InvalidMixinException|InjectionError|InvalidInjectionException|MixinTransformerError|Mixin transformation/),
        fix: id ? { kind: "disable-mods", modIds: [id], files: file ? [file] : undefined } : undefined,
      };
    },
  },
  {
    id: "linkage",
    hint: /NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|ClassNotFoundException|AbstractMethodError|IncompatibleClassChangeError/,
    run({ all, crash }) {
      const m = /(NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|ClassNotFoundException|AbstractMethodError|IncompatibleClassChangeError):?\s*([^\r\n]{0,200})/.exec(crash || all);
      if (!m) return undefined;
      const subject = m[2].trim();
      if (/net\/minecraft\/client\/main|jdk\.internal/.test(subject) && /Could not find or load main class/.test(all)) return undefined;
      // "Could not find or load main class X / Caused by: ClassNotFoundException: X" is the missing-main-class rule's business, whatever X is.
      const mainClass = /Could not find or load main class\s+([\w.$]+)/.exec(all)?.[1];
      if (mainClass && subject.replace(/\//g, ".").startsWith(mainClass)) return undefined;
      return {
        id: "linkage",
        severity: "error",
        title: "模组与依赖的版本不匹配（缺少类或方法）",
        detail: `${m[1]}：${clip(subject, 160)}。某个模组调用了另一个库中不存在的代码，几乎总是版本不一致造成的。`,
        advice: ["把相关模组及其前置库更新到同一时期发布的版本。", "如果刚刚更新或新增过模组，先撤销最近的改动。"],
        evidence: clip(m[0]),
      };
    },
  },
  {
    id: "opengl",
    hint: /GLFW error|OpenGL|Pixel format|WGL|GLX|EGL|LWJGL|glfw/i,
    run({ all }) {
      if (!/GLFW error (?:65542|65543|65544)|driver does not appear to support OpenGL|Pixel format not accelerated|Failed to find a suitable pixel format|WGL: .*(?:OpenGL|pixel format)|Unable to initialize GLFW|GLX: Failed to|Couldn't set pixel format|Failed to create OpenGL context|unsupported OpenGL/i.test(all)) return undefined;
      return {
        id: "opengl",
        severity: "error",
        title: "显卡驱动不支持 OpenGL，无法创建游戏窗口",
        detail: "游戏需要 OpenGL 3.2 以上（高版本光影还需要更高）。常见于驱动过旧、远程桌面/虚拟机，或笔记本使用了集成显卡。",
        advice: ["到显卡厂商官网更新驱动（NVIDIA / AMD / Intel）。", "笔记本：在系统图形设置里让 javaw.exe 使用独立显卡。", "远程桌面或虚拟机里通常无法运行，请在本机运行。"],
        evidence: firstLine(all, /GLFW error|Pixel format|driver does not appear|Failed to find a suitable|WGL|GLX|pixel format/i),
        fix: { kind: "update-graphics-driver" },
      };
    },
  },
  {
    id: "jvm-crash",
    hint: /A fatal error has been detected by the Java Runtime Environment|EXCEPTION_ACCESS_VIOLATION|SIGSEGV|Problematic frame/,
    run({ hs, all }) {
      const source = hs || all;
      if (!/fatal error has been detected|EXCEPTION_ACCESS_VIOLATION|SIGSEGV/.test(source)) return undefined;
      const frame = /Problematic frame:\s*#\s*([A-Za-z])\s+\[([^\]+]+)/.exec(source);
      const lib = frame?.[2]?.toLowerCase();
      const vendor = !lib ? undefined : /nvoglv|nvd3d|nvwgf|nvcuda/.test(lib) ? "NVIDIA" : /atio|atig|amdxx|amdvlk|aticfx/.test(lib) ? "AMD" : /^ig\d|igd|igc|iris|ig9icd/.test(lib) ? "Intel" : undefined;
      const overlay = lib && /overlay|gameoverlay|rtss|hook|discord|steam|obs|msi|afterburner/.test(lib);
      return {
        id: "jvm-crash",
        severity: "error",
        title: vendor ? `Java 虚拟机在 ${vendor} 显卡驱动里崩溃` : lib ? `Java 虚拟机在原生库 ${frame![2]} 里崩溃` : "Java 虚拟机发生了原生崩溃",
        detail: `这类崩溃发生在 Java 之外${lib ? `（出错模块 ${frame![2]}）` : ""}，多数由显卡驱动、屏幕覆盖层/录屏软件或损坏的原生库引起，而不是模组逻辑。`,
        advice: [
          vendor ? `更新或回退 ${vendor} 显卡驱动。` : "更新显卡驱动。",
          overlay ? "关闭与出错模块有关的覆盖层（Steam / Discord / MSI Afterburner / OBS 等）。" : "关闭游戏覆盖层、录屏、悬浮窗类软件后重试。",
          "如果装了光影或大量渲染类模组，先关闭它们测试。",
        ],
        evidence: firstLine(source, /Problematic frame|EXCEPTION_ACCESS_VIOLATION|SIGSEGV/),
        fix: vendor ? { kind: "update-graphics-driver", vendor } : undefined,
      };
    },
  },
  {
    id: "corrupt-jar",
    hint: /ZipException|zip END header|error in opening zip|Invalid or corrupt jarfile|Unable to access jarfile|invalid CEN header|Invalid Jar file|ModFileParsingException/i,
    run({ all, modFile }) {
      const file = /Invalid or corrupt jarfile (\S+)/.exec(all)?.[1] ?? /(?:Unable to access jarfile|Invalid Jar file|Failed to read mod file)\s+(?:at )?[:']?\s*([^\s'"]+\.jar)/i.exec(all)?.[1] ?? /([\w\-. ]+\.jar)[^\r\n]{0,40}(?:zip END header|invalid CEN header|ZipException)/i.exec(all)?.[1];
      if (!/ZipException|zip END header|error in opening zip|Invalid or corrupt jarfile|invalid CEN header|Invalid Jar file/i.test(all)) return undefined;
      const base = file?.split(/[\\/]/).pop();
      return {
        id: "corrupt-jar",
        severity: "error",
        title: base ? `文件已损坏：${base}` : "有 jar / zip 文件已损坏",
        detail: "文件没有下载完整或被杀毒软件改动，Java 无法读取它。",
        advice: ["重新下载这个文件；如果是游戏本体或库文件，在“修复游戏文件”里重新校验。", "把启动器和游戏目录加入杀毒软件白名单。"],
        mods: base ? [modFile(base.replace(/\.jar$/i, "")) ?? base] : undefined,
        evidence: firstLine(all, /ZipException|zip END header|error in opening zip|Invalid or corrupt|invalid CEN header|Invalid Jar file/i),
        fix: { kind: "repair-files" },
      };
    },
  },
  {
    id: "missing-main-class",
    hint: /Could not find or load main class|ClassNotFoundException: net\.minecraft\.client\.main\.Main|ClassNotFoundException: cpw\.mods\.bootstraplauncher|ClassNotFoundException: net\.fabricmc/,
    run({ all }) {
      if (!/Could not find or load main class|ClassNotFoundException: (?:net\.minecraft\.client\.main\.Main|cpw\.mods\.bootstraplauncher|net\.fabricmc)/.test(all)) return undefined;
      return {
        id: "missing-main-class",
        severity: "error",
        title: "找不到游戏主类：游戏文件不完整",
        detail: "游戏本体或加载器的库文件缺失、被删除或下载不完整。",
        advice: ["使用“修复游戏文件”重新补全缺失的库和资源。", "如果是加载器实例，重新安装一遍加载器。"],
        evidence: firstLine(all, /Could not find or load main class|ClassNotFoundException/),
        fix: { kind: "repair-files" },
      };
    },
  },
  {
    id: "config-error",
    hint: /ParsingException|Failed to (?:load|parse|read) (?:the )?config|ConfigLoadingException|config[^\n]{0,40}(?:invalid|malformed|corrupt)|TomlParseError|JsonSyntaxException/i,
    run({ all }) {
      const file = /(?:config file|Failed to (?:load|parse|read) config(?: file)?|Config file)\s*[:']?\s*([\w\-./\\]+\.(?:toml|json5?|cfg|properties|yml|yaml))/i.exec(all)?.[1] ?? /([\w\-]+\.(?:toml|json5?|cfg))[^\n]{0,60}(?:ParsingException|invalid|malformed|syntax)/i.exec(all)?.[1];
      if (!file && !/ParsingException[^\n]*config|ConfigLoadingException|TomlParseError/i.test(all)) return undefined;
      return {
        id: "config-error",
        severity: "error",
        title: file ? `配置文件有语法错误：${file.split(/[\\/]/).pop()}` : "某个模组的配置文件有语法错误",
        detail: "手动修改配置时漏了引号、逗号，或者写入了不合法的值，模组读取失败。",
        advice: ["打开 config 文件夹里对应的文件检查语法，或直接删除它让模组重新生成默认配置。"],
        evidence: firstLine(all, /ParsingException|ConfigLoadingException|TomlParseError|JsonSyntaxException|config/i),
        fix: { kind: "check-config", file },
      };
    },
  },
  {
    id: "disk-full",
    hint: /No space left on device|not enough space|磁盘空间不足/i,
    run({ all }) {
      if (!/No space left on device|There is not enough space on the disk|磁盘空间不足/i.test(all)) return undefined;
      return {
        id: "disk-full",
        severity: "error",
        title: "磁盘空间不足",
        detail: "游戏目录所在磁盘已经写满，无法保存存档或日志。",
        advice: ["清理磁盘，或把游戏目录移到空间更大的磁盘。"],
        evidence: firstLine(all, /No space left|not enough space|磁盘空间不足/i),
        fix: { kind: "free-disk-space" },
      };
    },
  },
  {
    id: "file-locked",
    hint: /AccessDeniedException|Access is denied|being used by another process|拒绝访问|另一个程序正在使用/i,
    run({ all }) {
      if (!/AccessDeniedException|Access is denied|being used by another process|拒绝访问|另一个程序正在使用/i.test(all)) return undefined;
      return {
        id: "file-locked",
        severity: "warn",
        title: "文件被占用或没有权限",
        detail: "游戏想读写的文件被别的程序占用（常见于另一个正在运行的游戏、杀毒软件或同步网盘），或者目录没有写权限。",
        advice: ["关闭同时运行的其他 Minecraft 实例和同步软件，不要把游戏目录放在 OneDrive 等同步目录里。", "把游戏目录加入杀毒软件排除项。"],
        evidence: firstLine(all, /AccessDeniedException|Access is denied|being used by another process|拒绝访问|另一个程序正在使用/i),
      };
    },
  },
  {
    id: "session",
    hint: /Invalid session|Failed to verify username|Authentication servers|Outdated login|multiplayer\.disconnect\.unverified_username|Not authenticated/i,
    run({ all }) {
      if (!/Invalid session|Failed to verify username|Outdated login|unverified_username/i.test(all)) return undefined;
      return {
        id: "session",
        severity: "warn",
        title: "登录状态失效或服务器无法验证你的账号",
        detail: "访问令牌已过期，或者服务器要求正版验证而你使用的是离线账号。",
        advice: ["在账号页面重新登录（刷新令牌）。", "离线账号无法进入开启了正版验证的服务器。"],
        evidence: firstLine(all, /Invalid session|Failed to verify username|Outdated login|unverified_username/i),
      };
    },
  },
  {
    id: "ticking-entity",
    hint: /Ticking entity|Entity being ticked/,
    run({ crash }) {
      const type = /Entity Type:\s*([^\s(]+)/.exec(crash)?.[1];
      const at = /Entity's Exact location:\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)/.exec(crash);
      if (!type && !/Ticking entity/.test(crash)) return undefined;
      const where = at ? `${Math.round(Number(at[1]))}, ${Math.round(Number(at[2]))}, ${Math.round(Number(at[3]))}` : undefined;
      return {
        id: "ticking-entity",
        severity: "error",
        title: type ? `实体 ${type} 在每刻更新时出错` : "某个实体在每刻更新时出错",
        detail: `游戏在处理这个实体时抛出了异常${where ? `，位置约在 (${where})` : ""}。它存在于存档里，所以每次进入该区域都会再次崩溃。`,
        advice: [
          "先备份存档，再用创造模式/管理员命令 /kill 清除它（需要先能进入世界，可在 server.properties 或用 NBT 工具处理）。",
          "确认对应模组是否有更新，崩溃常在升级后修复。",
        ],
        mods: type?.includes(":") ? [type.split(":")[0]] : undefined,
        evidence: type ? `Entity Type: ${type}` : undefined,
      };
    },
  },
  {
    id: "ticking-block-entity",
    hint: /Ticking block entity|Block entity being ticked/,
    run({ crash }) {
      const section = /Block entity being ticked[\s\S]{0,600}/.exec(crash)?.[0] ?? "";
      const name = /Name:\s*([^\s/]+)/.exec(section)?.[1];
      const at = /Block location: World: \((-?\d+),(-?\d+),(-?\d+)\)/.exec(section) ?? /Block location: World: \((-?\d+),(-?\d+),(-?\d+)\)/.exec(crash);
      if (!name && !/Ticking block entity/.test(crash)) return undefined;
      return {
        id: "ticking-block-entity",
        severity: "error",
        title: name ? `方块实体 ${name} 在每刻更新时出错` : "某个方块实体在每刻更新时出错",
        detail: `游戏在处理这个方块时抛出了异常${at ? `，坐标 (${at[1]}, ${at[2]}, ${at[3]})` : ""}。它保存在存档里，因此每次加载该区块都会崩溃。`,
        advice: ["备份存档后，在该坐标把方块清除（或用 MCEdit / NBTExplorer 删除这个方块实体）。", "检查对应模组是否有更新。"],
        mods: name?.includes(":") ? [name.split(":")[0]] : undefined,
        evidence: name ? `Name: ${name}` : undefined,
      };
    },
  },
];

function modName(id: string): string {
  return id;
}

/** Newest Java a Minecraft version needs: a hint for "wrong Java" fixes. */
export function recommendedJava(mcVersion: string): number {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mcVersion);
  if (!match) return 21;
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  if (Number(match[1]) > 1) return 21;
  if (minor <= 16) return 8;
  if (minor === 17) return 16;
  if (minor < 20 || (minor === 20 && patch <= 4)) return 17;
  return 21;
}

function rootException(text: string): string | undefined {
  let last: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^(?:Caused by: )?(?:[\w$]+\.)+[\w$]*(?:Exception|Error)(?::|$)/.test(line.trim()) || /^Caused by: /.test(line)) last = line.replace(/^Caused by: /, "").trim();
  }
  return last ? clip(last, 240) : undefined;
}

function parseSuspected(text: string): string[] {
  const line = /Suspected Mods?:\s*([^\r\n]+)/.exec(text)?.[1];
  if (!line || /^none\b/i.test(line.trim())) return [];
  // "Create (create), Flywheel (flywheel)" or, on newer reports, "Create (create)[6.0.0]"
  const ids = [...line.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]);
  return uniq(ids.length ? ids : line.split(",").map((part) => part.trim()).filter(Boolean));
}

export function analyzeCrash(input: CrashInput): CrashAnalysis {
  const crash = (input.crashReport ?? "").slice(0, MAX_TEXT);
  const log = (input.log ?? "").slice(-MAX_TEXT);
  const hs = (input.hsErr ?? "").slice(0, MAX_TEXT);
  const all = [crash, log, hs].filter(Boolean).join("\n");
  const mods = input.installedMods ?? [];
  const modFile = (id: string) => {
    const needle = id.toLowerCase();
    return mods.find((mod) => mod.id?.toLowerCase() === needle || mod.fileName.toLowerCase().startsWith(needle) || mod.name?.toLowerCase() === needle)?.fileName;
  };
  const ctx: Ctx = { input, all, crash, log, hs, modFile };
  const findings: CrashFinding[] = [];
  for (const rule of RULES) {
    if (!rule.hint.test(all)) continue;
    try {
      const result = rule.run(ctx);
      if (result) findings.push(...(Array.isArray(result) ? result : [result]));
    } catch {
      /* a broken rule must never hide the other findings */
    }
  }

  // Exit codes the JVM or Windows gives without leaving a readable log.
  if (!findings.length && typeof input.exitCode === "number" && input.exitCode !== 0) {
    const code = input.exitCode;
    const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`;
    if (code === -1073741819 || code === -1073740791 || code === -1073740940) {
      findings.push({
        id: "native-crash-exit",
        severity: "error",
        title: `游戏进程异常终止（退出码 ${hex}）`,
        detail: "这是 Windows 的内存访问错误，通常来自显卡驱动、覆盖层软件或杀毒软件注入，日志里往往没有 Java 异常。",
        advice: ["更新显卡驱动，关闭 Steam/Discord/录屏/超频软件的游戏内覆盖层。", "把游戏目录加入杀毒软件白名单。", "尝试换用不同版本的 Java。"],
        fix: { kind: "update-graphics-driver" },
      });
    } else if (code === 137 || input.signal === "SIGKILL") {
      findings.push({
        id: "killed",
        severity: "error",
        title: "游戏进程被系统强制结束（可能是内存不足）",
        detail: "进程收到了 SIGKILL / 退出码 137，Linux/macOS 上这通常是系统内存耗尽后被 OOM killer 结束。",
        advice: ["降低分配给游戏的最大内存，并关闭其他程序。"],
        fix: { kind: "increase-memory", suggestMb: input.maxMemoryMb ? Math.max(2048, Math.round(input.maxMemoryMb / 2)) : 2048 },
      });
    }
  }

  const suspected = uniq([...parseSuspected(crash), ...findings.flatMap((finding) => finding.mods ?? [])]).slice(0, 12);
  const description = /^Description:\s*(.+)$/m.exec(crash)?.[1]?.trim();
  const root = rootException(crash) ?? rootException(log.slice(-60_000)) ?? rootException(hs);
  const order = { error: 0, warn: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  if (!findings.length && suspected.length) {
    findings.push({
      id: "suspected-mods",
      severity: "warn",
      title: `崩溃报告指出可疑模组：${suspected.join("、")}`,
      detail: "加载器根据调用栈推断这些模组与崩溃有关，但并不一定是它们的错。",
      advice: ["先把这些模组更新到最新版本；仍然崩溃时，依次禁用它们来定位。"],
      mods: suspected,
      fix: { kind: "disable-mods", modIds: suspected },
    });
  }
  if (!findings.length) {
    findings.push({
      id: "unknown",
      severity: "info",
      title: "没有匹配到已知的崩溃原因",
      detail: root ? `最后的异常：${root}` : "日志里没有找到可以识别的异常。",
      advice: ["导出崩溃报告和日志发给整合包作者或模组作者；", "如果刚刚改过模组、Java 或内存设置，先撤销最近的改动。"],
      evidence: root,
    });
  }

  const best = findings[0];
  return {
    summary: best.id === "unknown" ? (root ?? "没有可以识别的崩溃原因") : best.title,
    description,
    rootException: root,
    suspectedMods: suspected,
    findings,
  };
}

// ---------------------------------------------------------------------------------------------- collecting input

async function tailText(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function newest(dir: string, pattern: RegExp, since?: number): Promise<{ path: string; mtime: number } | undefined> {
  let best: { path: string; mtime: number } | undefined;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!pattern.test(name)) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (!info?.isFile() || (since !== undefined && info.mtimeMs < since)) continue;
    if (!best || info.mtimeMs > best.mtime) best = { path: join(dir, name), mtime: info.mtimeMs };
  }
  return best;
}

/** Read what the game left behind: the newest crash report, `logs/latest.log` and a JVM `hs_err` file. */
export async function collectCrashInput(gameDir: string, options: { since?: number } = {}): Promise<Pick<CrashInput, "crashReport" | "log" | "hsErr"> & { crashReportPath?: string; hsErrPath?: string }> {
  const since = options.since ? options.since - 2000 : undefined;
  const out: Awaited<ReturnType<typeof collectCrashInput>> = {};
  const report = await newest(join(gameDir, "crash-reports"), /^crash-.*\.txt$/i, since);
  if (report) {
    out.crashReport = await tailText(report.path, 1024 * 1024);
    out.crashReportPath = report.path;
  }
  const hs = (await newest(gameDir, /^hs_err_pid\d+\.log$/i, since)) ?? (await newest(join(gameDir, "logs"), /^hs_err_pid\d+\.log$/i, since));
  if (hs) {
    out.hsErr = await tailText(hs.path, 256 * 1024);
    out.hsErrPath = hs.path;
  }
  const latest = join(gameDir, "logs", "latest.log");
  const info = await stat(latest).catch(() => undefined);
  if (info && (since === undefined || info.mtimeMs >= since)) out.log = await tailText(latest, 768 * 1024);
  return out;
}
