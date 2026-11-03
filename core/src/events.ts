import type { PublicAccount } from "./account/types";
import type { CrashAnalysis } from "./crash/analyzer";
import type { GameLifecycle, GameLine } from "./mc/launcher";
import type { AfterLaunch, Settings } from "./settings";
import type { TaskEvent } from "./tasks";

/** A running (or finished) game started by the launcher. */
export interface GameSnapshot {
  id: string;
  instanceId: string;
  instanceName: string;
  state: GameLifecycle;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  lineCount: number;
  /** The user pressed "stop": exit codes are not a crash then. */
  stoppedByUser?: boolean;
  crash?: { analysis: CrashAnalysis; reportPath?: string };
}

/** Everything the interface can be told about. Serialised as-is over the transport. */
export type CoreEvent =
  | TaskEvent
  | { type: "game"; game: GameSnapshot }
  | { type: "game-lines"; id: string; lines: GameLine[]; total: number }
  | { type: "settings"; settings: Settings }
  | { type: "instances"; ids?: string[] }
  | { type: "accounts" }
  | { type: "login"; loginId: string; status: "done" | "error" | "cancelled"; account?: PublicAccount; error?: string; reason?: string }
  /** What the launcher window should do now that a game is up (the host applies it). */
  | { type: "after-launch"; mode: AfterLaunch; gameId: string }
  | { type: "game-exit-ui"; gameId: string };

export const STAGE_LABELS: Record<string, string> = {
  "version-json": "获取版本信息",
  "client-jar": "下载游戏主程序",
  "loader-meta": "获取加载器信息",
  java: "准备 Java",
  "loader-download": "下载加载器",
  "loader-files": "解压加载器文件",
  "loader-libraries": "下载加载器依赖",
  processors: "处理加载器文件",
  "official-installer": "运行官方安装器",
  "optifine-patch": "安装 OptiFine",
  files: "检查文件",
  libraries: "下载运行库",
  assets: "下载资源文件",
  "pack-download": "下载整合包",
  "pack-lookup": "查询整合包信息",
  "pack-read": "读取整合包",
  "pack-resolve": "解析文件列表",
  "pack-files": "下载整合包文件",
  "pack-overrides": "写入覆盖文件",
  "pack-finish": "收尾",
  account: "准备账号",
  natives: "准备本地库",
  prelaunch: "运行启动前命令",
  arguments: "生成启动参数",
  start: "启动游戏",
  repair: "校验并修复文件",
  update: "更新",
  scan: "扫描",
  hash: "计算校验值",
  lookup: "查询",
  write: "写入",
};

const stage = (id: string) => ({ id, label: STAGE_LABELS[id] ?? id });

/** The stages an install walks through, so the interface can draw the whole pipeline before it starts. */
export function installPlan(loader?: string): { id: string; label: string }[] {
  const head = ["version-json", "client-jar"];
  const tail = ["libraries", "assets"];
  let middle: string[] = [];
  if (loader === "fabric" || loader === "quilt") middle = ["loader-meta"];
  else if (loader === "forge" || loader === "neoforge") middle = ["java", "loader-download", "loader-files", "loader-libraries", "processors"];
  else if (loader === "optifine") middle = ["java", "loader-download", "optifine-patch"];
  return [...head, ...middle, ...tail].map(stage);
}

export function modpackPlan(loader?: string, online = false): { id: string; label: string }[] {
  const install = installPlan(loader).map((entry) => entry.id);
  return [...(online ? ["pack-download"] : []), "pack-read", "pack-resolve", ...install, "pack-files", "pack-overrides", "pack-finish"].map(stage);
}

export const launchPlan = (): { id: string; label: string }[] => ["account", "java", "files", "assets", "natives", "prelaunch", "arguments", "start"].map(stage);
