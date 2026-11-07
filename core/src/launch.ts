import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureAuthlibInjector } from "./account/yggdrasil";
import type { PreparedAccount } from "./account/manager";
import { analyzeCrash, collectCrashInput } from "./crash/analyzer";
import type { CoreEvent, GameSnapshot } from "./events";
import { launchPlan } from "./events";
import { inspectJava, javaRequirement } from "./java/detect";
import { materializeLegacyAssets } from "./mc/assets";
import { completeVersion } from "./mc/files";
import { presetArgs, recommendMemory } from "./mc/jvm";
import { buildLaunch, formatCommand, splitArgs, splitHostPort, type BuiltLaunch, type LaunchAccount } from "./mc/launch-args";
import { spawnGame, type GameLine, type GameProcess } from "./mc/launcher";
import { prepareNatives } from "./mc/natives";
import { defaultRuleContext } from "./mc/rules";
import { librariesDir, resolveLibraries, resolveVersion, versionDir } from "./mc/version-json";
import type { InstanceInfo } from "./mc/instances";
import { scanMods } from "./content/local-mods";
import type { Progress } from "./net/download";
import type { TaskContext } from "./tasks";
import { throwIfAborted } from "./util/async";
import { ensureDir, writeFileAtomic } from "./util/fsx";
import { freeMemoryMB, totalMemoryMB } from "./util/os";
import { runProcess } from "./util/proc";
import { fallbackJavaMajor } from "./util/version";
import type { Core } from "./core";

export interface LaunchOptions {
  /** Join this server on start (overrides the instance's auto-join). */
  server?: string;
  /** Open this save on start (1.20+). */
  world?: string;
  demo?: boolean;
  /** Use this account instead of the instance's / the selected one. */
  accountId?: string;
}

/** What a launch plan needs from its caller: a launch task, or nothing at all when exporting a script. */
export interface PlanReporter {
  readonly signal?: AbortSignal;
  stage(id: string, detail?: string): void;
  progress(progress: Progress, stage?: string): void;
  log(line: string): void;
  warn(message: string): void;
}

export const silentReporter: PlanReporter = { stage() {}, progress() {}, log() {}, warn() {} };

export interface LaunchPlan {
  info: InstanceInfo;
  javaPath: string;
  javaMajor: number;
  built: BuiltLaunch;
  gameDir: string;
  account: PreparedAccount;
  maxMemoryMB: number;
  env: Record<string, string>;
  wrapper: string[];
  preLaunch?: string;
  /** Strings that must not appear in logs or exported scripts. */
  secrets: string[];
  memoryReason?: string;
}

async function countJars(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => /\.jar$/i.test(name)).length;
  } catch {
    return 0;
  }
}

/** Resolve everything a launch needs and build the command line. Downloads whatever is missing. */
export async function planLaunch(core: Core, id: string, reporter: PlanReporter, options: LaunchOptions & { skipFiles?: boolean } = {}): Promise<LaunchPlan> {
  const settings = core.settings.peek();
  const signal = reporter.signal;
  const info = await core.instances.get(id);
  if (!info) throw new Error("找不到这个实例，它可能已被删除。");
  if (!info.valid) throw new Error(`这个实例无法启动：${info.problem ?? "版本文件有问题"}。可以尝试“修复游戏文件”或重新安装。`);
  const config = info.config;
  const os = core.os;
  const ruleCtx = defaultRuleContext();
  ruleCtx.os = os;

  reporter.stage("account");
  const prepared = await core.accounts.prepareLaunch(options.accountId ?? config.accountId, signal);
  throwIfAborted(signal);

  reporter.stage("java");
  const version0 = await resolveVersion(core.root, id);
  const requirement = javaRequirement({
    declared: version0.javaVersion?.majorVersion,
    fallback: fallbackJavaMajor(info.mcVersion ?? ""),
    loaders: info.loaders,
    mcVersion: info.mcVersion,
  });
  let java: { path: string; major: number; is64: boolean };
  if (config.javaPath) {
    const found = await inspectJava(config.javaPath, "custom", { os });
    if (!found) throw new Error(`这个实例指定的 Java 无法运行：${config.javaPath}`);
    if (found.major < requirement.min) reporter.warn(`所选 Java ${found.major} 低于这个版本需要的 Java ${requirement.min}，游戏很可能无法启动。`);
    else if (requirement.max !== undefined && found.major > requirement.max) reporter.warn(`所选 Java ${found.major} 高于这个版本支持的 Java ${requirement.max}，旧版加载器在新 Java 上常常无法启动。`);
    java = { path: found.path, major: found.major, is64: found.is64 };
  } else {
    java = await core.ensureJava(requirement, version0.javaVersion?.component, signal, (progress) => reporter.progress(progress, "java"));
  }
  throwIfAborted(signal);

  let version = version0;
  let libraries = resolveLibraries(version0, ruleCtx);
  if (!options.skipFiles) {
    reporter.stage("files");
    const done = await completeVersion(core.env, id, {
      signal,
      concurrency: settings.download.concurrency,
      onStage: (stage) => reporter.stage(stage),
      onProgress: (progress, stage) => reporter.progress(progress, stage),
    });
    version = done.version;
    libraries = done.libraries;
    if (done.missingLocal.length) {
      throw new Error(`缺少加载器安装时生成的 ${done.missingLocal.length} 个文件（例如 ${done.missingLocal[0].path}）。请在实例页面使用“修复游戏文件”，或重新安装加载器。`);
    }
  }
  throwIfAborted(signal);

  reporter.stage("natives");
  const nativesDir = join(versionDir(core.root, id), "natives");
  await prepareNatives(librariesDir(core.root), libraries, nativesDir);
  const assetIndexId = version.assetIndex?.id ?? version.assets;
  const legacy = assetIndexId ? await materializeLegacyAssets(core.root, assetIndexId, info.gameDir) : {};

  reporter.stage("arguments");
  const modCount = await countJars(join(info.gameDir, "mods"));
  const advice = recommendMemory({ totalMB: totalMemoryMB(), freeMB: freeMemoryMB(), modCount, is64: java.is64 });
  const wanted = config.memory ?? settings.launch.memory;
  const maxMB = typeof wanted === "number" ? wanted : advice.maxMB;
  const minMB = Math.min(maxMB, typeof wanted === "number" ? 512 : advice.minMB);

  const accountJvm: string[] = [];
  if (prepared.authlib) {
    reporter.log("准备外置登录组件（authlib-injector）…");
    const jar = await ensureAuthlibInjector({ http: core.http, router: core.router, engine: core.engine, dir: core.paths.authlibDir }, signal);
    accountJvm.push(`-javaagent:${jar}=${prepared.authlib.root}`);
    if (prepared.authlib.prefetched) accountJvm.push(`-Dauthlibinjector.yggdrasil.prefetched=${prepared.authlib.prefetched}`);
  }
  const userJvm = [...splitArgs(settings.launch.jvmArgs), ...splitArgs(config.jvmArgs)];
  const jvmArgs = [...presetArgs(config.jvmPreset ?? settings.launch.jvmPreset, java.major, userJvm), ...userJvm];

  const width = config.width ?? settings.launch.width;
  const height = config.height ?? settings.launch.height;
  const fullscreen = config.fullscreen ?? settings.launch.fullscreen;
  const resolution = fullscreen || (width > 0 && height > 0) ? { width: width > 0 ? width : undefined, height: height > 0 ? height : undefined, fullscreen } : undefined;
  const server = options.server ?? config.autoJoin;
  if (server) splitHostPort(server);
  const quickPlay = options.world ? { world: options.world } : server ? { server } : undefined;

  const account: LaunchAccount = { ...prepared.launch, jvmArgs: accountJvm };
  const built = buildLaunch(
    {
      root: core.root,
      gameDir: info.gameDir,
      version,
      account,
      javaMajor: java.major,
      memoryMaxMB: maxMB,
      memoryMinMB: minMB,
      jvmArgs,
      gameArgs: [...splitArgs(settings.launch.gameArgs), ...splitArgs(config.gameArgs)],
      resolution,
      quickPlay,
      demo: options.demo,
      launcherName: "Vitrine",
      launcherVersion: core.version,
      nativesDir,
      os,
      legacyAssetsDir: legacy.resourcesDir ?? legacy.virtualDir,
      versionType: settings.launch.versionType || "Vitrine",
    },
    ruleCtx,
    libraries,
  );
  const secrets = [prepared.launch.accessToken].filter((token) => token && token !== "0" && token.length > 6);
  return {
    info,
    javaPath: java.path,
    javaMajor: java.major,
    built,
    gameDir: info.gameDir,
    account: prepared,
    maxMemoryMB: maxMB,
    env: config.env ?? {},
    wrapper: splitArgs(config.wrapper),
    preLaunch: config.preLaunch?.trim() || undefined,
    secrets,
    memoryReason: typeof wanted === "number" ? "手动设置" : advice.reason,
  };
}

/** A `.bat` / `.sh` that starts the instance without the launcher. */
export async function exportLaunchScript(core: Core, id: string, dest: string, options: { includeToken?: boolean; signal?: AbortSignal } = {}): Promise<{ path: string; tokenIncluded: boolean; warnings: string[] }> {
  const plan = await planLaunch(core, id, { ...silentReporter, signal: options.signal }, { skipFiles: true });
  const warnings: string[] = [];
  const online = plan.secrets.length > 0;
  const mask = options.includeToken ? [] : plan.secrets;
  if (online && !options.includeToken) warnings.push("脚本里没有写入登录令牌：联网游戏将无法验证身份，只能单人游戏。需要联机请在导出时选择包含令牌（令牌会以明文保存，请勿分享该脚本）。");
  if (online && options.includeToken) warnings.push("脚本包含了你的登录令牌，请不要分享给别人；令牌过期后需要重新导出。");
  const windows = core.os.name === "windows";
  const command = formatCommand(plan.javaPath, plan.built.args, core.os, mask);
  let text: string;
  if (windows) {
    text = ["@echo off", "chcp 65001 >nul", `cd /d "${plan.gameDir}"`, command.replace(/%/g, "%%"), "pause", ""].join("\r\n");
  } else {
    text = ["#!/bin/sh", `cd '${plan.gameDir.replace(/'/g, `'\\''`)}' || exit 1`, `exec ${command}`, ""].join("\n");
  }
  await ensureDir(join(dest, ".."));
  await writeFileAtomic(dest, text);
  if (!windows) await (await import("./util/fsx")).setExecutable(dest);
  return { path: dest, tokenIncluded: Boolean(options.includeToken) && online, warnings };
}

// ---------------------------------------------------------------------------------------------- running games

interface Session {
  snapshot: GameSnapshot;
  process: GameProcess;
  plan: LaunchPlan;
  pending: GameLine[];
  timer?: NodeJS.Timeout;
  afterLaunchSent: boolean;
}

const LINE_BATCH_MS = 250;
const MAX_LINES_PER_EVENT = 400;

export class GameManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly core: Core) {}

  private emit(event: CoreEvent) {
    this.core.emit(event);
  }

  list(): GameSnapshot[] {
    return [...this.sessions.values()].map((session) => ({ ...session.snapshot })).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): GameSnapshot | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.snapshot } : undefined;
  }

  tail(id: string, count = 300): string[] {
    return this.sessions.get(id)?.process.tail(Math.min(Math.max(count, 1), 6000)) ?? [];
  }

  /** The running game of an instance, if any. */
  runningFor(instanceId: string): GameSnapshot | undefined {
    for (const session of this.sessions.values()) if (session.snapshot.instanceId === instanceId && session.snapshot.state !== "exited") return { ...session.snapshot };
    return undefined;
  }

  anyRunning(): boolean {
    for (const session of this.sessions.values()) if (session.snapshot.state !== "exited") return true;
    return false;
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.snapshot.state === "exited") return false;
    session.snapshot.stoppedByUser = true;
    session.process.kill();
    return true;
  }

  killAll() {
    for (const id of this.sessions.keys()) this.kill(id);
  }

  forget(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.snapshot.state !== "exited") return false;
    return this.sessions.delete(id);
  }

  /** Start the process for a finished plan. */
  async spawn(plan: LaunchPlan, reporter: PlanReporter = silentReporter): Promise<GameSnapshot> {
    const { core } = this;
    if (plan.preLaunch) {
      reporter.stage("prelaunch");
      const windows = core.os.name === "windows";
      const result = await runProcess(windows ? "cmd.exe" : "sh", windows ? ["/d", "/s", "/c", plan.preLaunch] : ["-c", plan.preLaunch], {
        cwd: plan.gameDir,
        env: plan.env,
        signal: reporter.signal,
        timeoutMs: 120_000,
        onLine: (line) => reporter.log(`[启动前命令] ${line}`),
      });
      if (result.code !== 0) throw new Error(`启动前命令失败（退出码 ${result.code}）。最后输出：${result.tail.slice(-3).join(" ")}`);
    }
    throwIfAborted(reporter.signal);
    reporter.stage("start");
    const id = randomUUID();
    const child = await spawnGame({
      javaPath: plan.javaPath,
      args: plan.built.args,
      cwd: plan.gameDir,
      env: plan.env,
      os: core.os,
      javaMajor: plan.javaMajor,
      argFilePath: join(core.paths.argFilesDir, `${id}.args`),
      wrapper: plan.wrapper.length ? plan.wrapper : undefined,
    });
    const snapshot: GameSnapshot = { id, instanceId: plan.info.id, instanceName: plan.info.name, state: child.state, pid: child.pid, startedAt: child.startedAt, lineCount: 0 };
    const session: Session = { snapshot, process: child, plan, pending: [], afterLaunchSent: false };
    this.sessions.set(id, session);
    await core.instances.saveConfig(plan.info.id, { lastPlayed: snapshot.startedAt }).catch(() => {});
    core.instances.invalidate(plan.info.id);
    this.emit({ type: "instances", ids: [plan.info.id] });

    child.on("line", (line: GameLine) => {
      snapshot.lineCount++;
      session.pending.push(line);
      session.timer ??= setTimeout(() => this.flush(session), LINE_BATCH_MS);
    });
    child.on("state", (state) => {
      // "exited" is announced once, by onExit, together with the exit code and the crash analysis.
      if (state === "exited") return;
      snapshot.state = state;
      snapshot.pid = child.pid;
      this.emit({ type: "game", game: { ...snapshot } });
      if ((state === "window" || state === "running") && !session.afterLaunchSent) {
        session.afterLaunchSent = true;
        this.emit({ type: "after-launch", mode: core.settings.peek().launch.afterLaunch, gameId: id });
      }
    });
    child.once("exit", (code, signal) => void this.onExit(session, code, signal));
    this.emit({ type: "game", game: { ...snapshot } });
    return { ...snapshot };
  }

  private flush(session: Session) {
    session.timer = undefined;
    const lines = session.pending.splice(0);
    if (!lines.length || this.core.tasks.getUiLevel() === "hidden") return;
    this.emit({ type: "game-lines", id: session.snapshot.id, lines: lines.length > MAX_LINES_PER_EVENT ? lines.slice(-MAX_LINES_PER_EVENT) : lines, total: session.snapshot.lineCount });
  }

  private async onExit(session: Session, code: number | null, signal: NodeJS.Signals | null) {
    const { snapshot, plan } = session;
    clearTimeout(session.timer);
    this.flush(session);
    snapshot.state = "exited";
    snapshot.exitCode = code;
    snapshot.signal = signal;
    snapshot.endedAt = session.process.endedAt ?? Date.now();
    const config = await this.core.instances.loadConfig(plan.info.id).catch(() => undefined);
    await this.core.instances.saveConfig(plan.info.id, { playTimeMs: (config?.playTimeMs ?? 0) + (snapshot.endedAt - snapshot.startedAt), lastPlayed: snapshot.startedAt }).catch(() => {});
    this.core.instances.invalidate(plan.info.id);
    const failed = (code !== null && code !== 0) || signal !== null;
    if (failed && !snapshot.stoppedByUser) {
      // Scanning a very large mods folder must not keep the interface waiting for the "exited" event.
      const budget = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 8000).unref());
      const work = (async () => {
        const found = await collectCrashInput(plan.gameDir, { since: snapshot.startedAt });
        const mods = await scanMods(plan.gameDir).catch(() => []);
        const analysis = analyzeCrash({
          crashReport: found.crashReport,
          log: found.log ?? session.process.tail(1500).join("\n"),
          hsErr: found.hsErr,
          exitCode: code,
          signal,
          javaMajor: plan.javaMajor,
          mcVersion: plan.info.mcVersion,
          loader: plan.info.loaders[0]?.kind,
          maxMemoryMb: plan.maxMemoryMB,
          installedMods: mods.map((mod) => ({ id: mod.meta?.id, name: mod.meta?.name, fileName: mod.file, loaders: mod.meta?.loaders })),
        });
        snapshot.crash = { analysis, reportPath: found.crashReportPath ?? found.hsErrPath };
      })();
      const log = this.core.logger.scope("game");
      let late = false;
      work.then(
        () => {
          if (late) this.emit({ type: "game", game: { ...snapshot } });
        },
        (error: Error) => log.warn(`crash analysis failed: ${error.message}`),
      );
      if ((await Promise.race([work.then(() => "done" as const, () => "done" as const), budget])) === "late") {
        late = true;
        log.warn("crash analysis is taking long; the result will follow");
      }
    }
    this.emit({ type: "game", game: { ...snapshot } });
    this.emit({ type: "instances", ids: [plan.info.id] });
    this.emit({ type: "game-exit-ui", gameId: snapshot.id });
  }

  /** Re-run the crash analysis for an instance from whatever its folder holds now (the "analyse again" button). */
  async analyze(instanceId: string) {
    const info = await this.core.instances.get(instanceId);
    if (!info) throw new Error("找不到这个实例");
    const found = await collectCrashInput(info.gameDir);
    if (!found.crashReport && !found.log && !found.hsErr) throw new Error("这个实例没有可分析的崩溃报告或日志。");
    const mods = await scanMods(info.gameDir).catch(() => []);
    const analysis = analyzeCrash({
      crashReport: found.crashReport,
      log: found.log,
      hsErr: found.hsErr,
      mcVersion: info.mcVersion,
      loader: info.loaders[0]?.kind,
      installedMods: mods.map((mod) => ({ id: mod.meta?.id, name: mod.meta?.name, fileName: mod.file, loaders: mod.meta?.loaders })),
    });
    return { analysis, reportPath: found.crashReportPath ?? found.hsErrPath };
  }
}

/** Create the launch task. The returned task finishes when the game process has started. */
export async function startLaunch(core: Core, id: string, options: LaunchOptions = {}): Promise<{ taskId: string; promise: Promise<{ gameId: string }> }> {
  const running = core.games.runningFor(id);
  if (running) throw new Error("这个实例已经在运行了。");
  const pending = core.tasks.list().find((task) => task.kind === "launch" && task.instanceId === id && (task.state === "queued" || task.state === "running"));
  if (pending) throw new Error("这个实例正在启动中。");
  const name = (await core.instances.get(id))?.name ?? id;
  const { id: taskId, promise } = core.tasks.start({
    kind: "launch",
    title: `启动 ${name}`,
    instanceId: id,
    lane: "launch",
    run: async (ctx: TaskContext) => {
      const config = await core.instances.loadConfig(id);
      ctx.plan(launchPlan().filter((stage) => stage.id !== "prelaunch" || Boolean(config.preLaunch?.trim())));
      const plan = await planLaunch(core, id, ctx, options);
      ctx.log(`Java ${plan.javaMajor}（${plan.javaPath}）· 最大内存 ${plan.maxMemoryMB} MB${plan.memoryReason ? `（${plan.memoryReason}）` : ""}`);
      const game = await core.games.spawn(plan, ctx);
      return { gameId: game.id };
    },
  });
  return { taskId, promise };
}
