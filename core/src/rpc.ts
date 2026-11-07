import { join } from "node:path";
import { statSync } from "node:fs";
import { analyzeMods, readModIcon, removeModFile, scanMods, setModEnabled, type ModLoaderType } from "./content/local-mods";
import { getProject, listContentVersions, searchContent, type ContentFilter, type ContentKind, type ContentSource, type ModUpdate } from "./content/browse";
import type { McmodFilter } from "./content/mcmod";
import { listResourcePacks, listScreenshots, listShaderPacks, readScreenshot, removePackFile, renamePackFile, type PackFolder } from "./content/packs-local";
import type { Core } from "./core";
import { exportLaunchScript } from "./launch";
import { inspectJava } from "./java/detect";
import { JVM_PRESETS, recommendMemory } from "./mc/jvm";
import { pingServer } from "./net/mc-ping";
import { listExportCandidates } from "./pack/export";
import { previewPack, readPackState } from "./pack/install";
import { latestPackVersion } from "./pack/online";
import { addServer, moveServer, readServers, removeServer, updateServer, type ServerEntry } from "./world/servers";
import { deleteSave, duplicateSave, exportSave, getSaveSize, importSave, listSaves, readSaveIcon, renameLevel, renameSaveFolder } from "./world/saves";
import { mapLimit, isAbort } from "./util/async";
import { freeMemoryMB, totalMemoryMB } from "./util/os";
import type { UiLevel } from "./tasks";

export interface RpcContext {
  signal: AbortSignal;
}

export type RpcHandler = (params: Record<string, unknown>, context: RpcContext) => Promise<unknown> | unknown;

export class RpcError extends Error {
  readonly name = "RpcError";
  constructor(
    message: string,
    readonly code: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Turn anything thrown into the `{code, message}` the interface shows. */
export function describeError(error: unknown): { code: string; message: string; data?: unknown } {
  if (error instanceof RpcError) return { code: error.code, message: error.message, data: error.data };
  const e = error as { message?: string; reason?: string; code?: string; status?: number; name?: string };
  if (isAbort(error)) return { code: "cancelled", message: "已取消" };
  const code = typeof e?.reason === "string" ? e.reason : typeof e?.code === "string" ? e.code : e?.status ? `http-${e.status}` : (e?.name ?? "error");
  return { code, message: e?.message ?? String(error) };
}

// ---------------------------------------------------------------------------------------------- parameter helpers

const bad = (key: string, what: string): never => {
  throw new RpcError(`参数“${key}”${what}`, "bad-params");
};

function str(params: Record<string, unknown>, key: string, max = 4096): string {
  const value = params[key];
  if (typeof value !== "string" || !value) return bad(key, "不能为空");
  if (value.length > max) return bad(key, "太长");
  return value;
}

function optStr(params: Record<string, unknown>, key: string, max = 4096): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return bad(key, "必须是文本");
  if (value.length > max) return bad(key, "太长");
  return value;
}

function optNum(params: Record<string, unknown>, key: string, min = -Infinity, max = Infinity): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return bad(key, "必须是数字");
  return Math.min(max, Math.max(min, value));
}

function optBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") return bad(key, "必须是 true/false");
  return value;
}

function strList(params: Record<string, unknown>, key: string, maxItems = 5000): string[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length > maxItems || value.some((entry) => typeof entry !== "string")) return bad(key, "必须是文本列表");
  return value as string[];
}

function oneOf<T extends string>(params: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = params[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) return bad(key, `必须是 ${allowed.join(" / ")} 之一`);
  return value as T;
}

const SOURCES = ["modrinth", "curseforge"] as const;
const KINDS = ["mod", "modpack", "resourcepack", "shader", "datapack"] as const;
const PACK_FOLDERS = ["resourcepacks", "shaderpacks", "screenshots"] as const;

function filterOf(params: Record<string, unknown>): ContentFilter {
  return { gameVersion: optStr(params, "gameVersion", 40), loader: optStr(params, "loader", 20) };
}

/** Relative path of a file inside one folder of the game directory; anything that could leave it is refused. */
function insideFolder(path: string, folder: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith(`${folder}/`) || normalized.split("/").some((part) => part === ".." || part === "") || normalized.includes(":")) throw new RpcError("路径不在允许的文件夹内", "bad-params");
  return normalized;
}

// ---------------------------------------------------------------------------------------------- the method table

export type RpcTable = Record<string, RpcHandler>;

export function buildRpc(core: Core): RpcTable {
  const table: RpcTable = {};
  const def = (name: string, handler: RpcHandler) => {
    table[name] = handler;
  };
  const gameDir = (params: Record<string, unknown>) => core.gameDirOf(str(params, "instanceId", 200));

  // ---------------- app & ui
  def("app.info", () => core.systemInfo());
  def("app.suggestRoots", () => core.suggestRoots());
  def("app.clearCache", async () => void (await core.clearCache()));
  def("app.bootstrap", async () => {
    const [instances, accounts, selected, system] = await Promise.all([core.listInstances(), core.accounts.list(), core.accounts.selectedId(), core.systemInfo()]);
    return { settings: core.settings.get(), instances, accounts, selectedAccount: selected ?? null, tasks: core.tasks.list(), games: core.games.list(), system, jvmPresets: JVM_PRESETS };
  });
  def("ui.setLevel", (params) => {
    const level = oneOf(params, "level", ["active", "background", "hidden"] as const) as UiLevel;
    core.tasks.setUiLevel(level);
    return { level };
  });
  def("settings.get", () => core.settings.get());
  def("settings.update", async (params) => core.settings.update(params.patch));
  def("logs.tail", (params) => core.logger.tail(optNum(params, "count", 1, 2000) ?? 300));

  // ---------------- host (desktop shell)
  const needHost = <K extends keyof typeof core.host>(name: K) => {
    const fn = core.host[name];
    if (!fn) throw new RpcError("这个功能只在桌面版里可用", "no-host");
    return fn as NonNullable<(typeof core.host)[K]>;
  };
  def("host.pickFile", (params) => needHost("pickFile")({ title: optStr(params, "title", 100), filters: params.filters as { name: string; extensions: string[] }[] | undefined, multi: optBool(params, "multi") }));
  def("host.pickFolder", (params) => needHost("pickFolder")({ title: optStr(params, "title", 100) }));
  def("host.saveFile", (params) => needHost("saveFile")({ title: optStr(params, "title", 100), defaultPath: optStr(params, "defaultPath", 1000), filters: params.filters as { name: string; extensions: string[] }[] | undefined }));
  def("host.openExternal", async (params) => {
    const url = str(params, "url", 2000);
    if (!/^https?:\/\//i.test(url)) throw new RpcError("只能打开 http / https 链接", "bad-params");
    await needHost("openExternal")(url);
  });

  // ---------------- versions & loaders
  def("versions.list", (params, { signal }) => core.listVersions({ force: optBool(params, "force"), signal }));
  def("loaders.list", (params, { signal }) => core.listLoaderVersions(oneOf(params, "kind", ["fabric", "quilt", "forge", "neoforge", "optifine"] as const), str(params, "mcVersion", 40), signal));
  def("loaders.overview", (params, { signal }) => core.loaderOverview(str(params, "mcVersion", 40), signal));

  // ---------------- instances
  def("instances.list", () => core.listInstances());
  def("instances.get", async (params) => {
    const id = str(params, "id", 200);
    const found = (await core.listInstances()).find((entry) => entry.id === id);
    if (!found) throw new RpcError("找不到这个实例", "not-found");
    return found;
  });
  def("instances.create", (params) => {
    const loader = params.loader as { kind?: string; version?: string; raw?: string; meta?: Record<string, string> } | undefined;
    if (loader && (typeof loader.kind !== "string" || typeof loader.version !== "string")) return bad("loader", "格式不正确");
    return core.createInstance({
      name: str(params, "name", 80),
      mcVersion: str(params, "mcVersion", 40),
      loader: loader ? ({ kind: loader.kind, version: loader.version, raw: loader.raw, meta: loader.meta } as never) : undefined,
      isolation: params.isolation === undefined ? undefined : oneOf(params, "isolation", ["auto", "on", "off"] as const),
    });
  });
  def("instances.setConfig", (params) => core.setInstanceConfig(str(params, "id", 200), params.patch));
  def("instances.rename", async (params) => void (await core.renameInstance(str(params, "id", 200), str(params, "name", 80))));
  def("instances.duplicate", (params) => core.duplicateInstance(str(params, "id", 200), str(params, "name", 80)));
  def("instances.remove", async (params) => void (await core.removeInstance(str(params, "id", 200))));
  def("instances.repair", (params) => core.repairInstance(str(params, "id", 200), { verify: params.verify === "hash" ? "hash" : "size" }));
  def("instances.openFolder", async (params) => ({ path: await core.openInstanceFolder(str(params, "id", 200), optStr(params, "sub", 40) ?? "") }));
  def("instances.launch", async (params) => {
    const { taskId } = await core.launch(str(params, "id", 200), { server: optStr(params, "server", 300), world: optStr(params, "world", 100), demo: optBool(params, "demo"), accountId: optStr(params, "accountId", 100) });
    return { taskId };
  });
  def("instances.exportScript", async (params, { signal }) =>
    exportLaunchScript(core, str(params, "id", 200), str(params, "dest", 1000), { includeToken: optBool(params, "includeToken"), signal }),
  );
  def("instances.memoryAdvice", async (params) => {
    const dir = await gameDir({ instanceId: params.id });
    const mods = await scanMods(dir).catch(() => []);
    return { ...recommendMemory({ totalMB: totalMemoryMB(), freeMB: freeMemoryMB(), modCount: mods.length, is64: true }), totalMB: totalMemoryMB(), freeMB: freeMemoryMB(), modCount: mods.length };
  });
  def("instances.analyzeCrash", (params) => core.games.analyze(str(params, "id", 200)));
  def("instances.packState", async (params) => (await readPackState(core.root, str(params, "id", 200))) ?? null);

  // ---------------- games & tasks
  def("games.list", () => core.games.list());
  def("games.tail", (params) => core.games.tail(str(params, "id", 80), optNum(params, "count", 1, 6000) ?? 300));
  def("games.kill", (params) => core.games.kill(str(params, "id", 80)));
  def("games.forget", (params) => core.games.forget(str(params, "id", 80)));
  def("tasks.list", () => core.tasks.list());
  def("tasks.get", (params) => core.tasks.get(str(params, "id", 80)) ?? null);
  def("tasks.cancel", (params) => core.tasks.cancel(str(params, "id", 80)));
  def("tasks.clear", () => core.tasks.clearFinished());

  // ---------------- modpacks
  def("packs.preview", (params) => previewPack(str(params, "file", 2000)));
  def("packs.install", (params) => core.installModpack({ file: str(params, "file", 2000), name: optStr(params, "name", 80), skipOptional: Array.isArray(params.skipOptional) ? strList(params, "skipOptional") : optBool(params, "skipOptional") }));
  def("packs.installOnline", (params) =>
    core.installOnlineModpack({ source: oneOf(params, "source", SOURCES), projectId: str(params, "projectId", 100), versionId: optStr(params, "versionId", 100), name: optStr(params, "name", 80), title: optStr(params, "title", 120) }),
  );
  def("packs.adopt", (params) => core.adoptManual(str(params, "instanceId", 200), strList(params, "files", 200)));
  def("packs.exportCandidates", async (params) => listExportCandidates(await gameDir(params), str(params, "instanceId", 200)));
  def("packs.export", (params) =>
    core.exportModpack({ instanceId: str(params, "instanceId", 200), dest: str(params, "dest", 1000), name: str(params, "name", 100), version: optStr(params, "version", 40) ?? "1.0.0", summary: optStr(params, "summary", 500), include: strList(params, "include", 200), identify: optBool(params, "identify") }),
  );
  def("packs.latest", async (params, { signal }) => {
    const info = await core.requireInstance(str(params, "instanceId", 200));
    const origin = info.config.modpack;
    if (!origin) return null;
    return (await latestPackVersion(core.onlineDeps(signal), origin, signal)) ?? null;
  });

  // ---------------- online content
  def("content.status", () => ({ curseforge: core.curseforge.hasKey }));
  def("mcmod.search", (params, { signal }) => {
    const filter = params.filter === undefined ? undefined : oneOf(params, "filter", ["all", "mod", "modpack"] as const) as McmodFilter;
    return core.mcmod.search(str(params, "query", 120), { filter, page: optNum(params, "page", 0, 200), signal });
  });
  def("content.search", (params, { signal }) =>
    searchContent(core.contentDeps(), {
      source: oneOf(params, "source", SOURCES) as ContentSource,
      kind: oneOf(params, "kind", KINDS) as ContentKind,
      query: optStr(params, "query", 200),
      sort: params.sort === undefined ? undefined : oneOf(params, "sort", ["relevance", "downloads", "updated", "newest"] as const),
      category: optStr(params, "category", 60),
      page: optNum(params, "page", 0, 1000),
      pageSize: optNum(params, "pageSize", 1, 50),
      ...filterOf(params),
      signal,
    }),
  );
  def("content.project", (params, { signal }) => getProject(core.contentDeps(), oneOf(params, "source", SOURCES), str(params, "id", 100), signal));
  def("content.versions", (params, { signal }) => listContentVersions(core.contentDeps(), oneOf(params, "source", SOURCES), str(params, "projectId", 100), filterOf(params), signal));
  def("content.install", (params) =>
    core.installContentTask({
      instanceId: str(params, "instanceId", 200),
      kind: oneOf(params, "kind", ["mod", "resourcepack", "shader", "datapack"] as const),
      source: oneOf(params, "source", SOURCES),
      projectId: str(params, "projectId", 100),
      versionId: optStr(params, "versionId", 100),
      filter: filterOf(params),
      withDependencies: optBool(params, "withDependencies"),
      world: optStr(params, "world", 100),
      title: optStr(params, "title", 120),
    }),
  );
  def("content.checkUpdates", (params) => core.checkUpdatesTask(str(params, "instanceId", 200)));
  def("content.applyUpdates", (params) => {
    if (!Array.isArray(params.updates) || params.updates.length > 500) return bad("updates", "必须是更新列表");
    return core.applyUpdatesTask(str(params, "instanceId", 200), params.updates as ModUpdate[]);
  });

  // ---------------- local mods and packs
  def("mods.list", async (params, { signal }) => {
    const instance = await core.requireInstance(str(params, "instanceId", 200));
    const prefer = instance.loaders.find((entry) => ["fabric", "quilt", "forge", "neoforge", "legacy-forge", "liteloader"].includes(entry.kind))?.kind as ModLoaderType | undefined;
    const mods = await scanMods(instance.gameDir, { signal, prefer });
    return { mods, problems: analyzeMods(mods, { loaders: instance.loaders.map((entry) => entry.kind) }) };
  });
  def("mods.installDependency", (params) => core.installMissingDependency(str(params, "instanceId", 200), str(params, "dependencyId", 120)));
  def("mods.icon", async (params) => readModIcon(join(await gameDir(params), insideFolder(str(params, "path", 600), "mods"))).catch(() => undefined));
  def("mods.setEnabled", async (params) => ({ path: await setModEnabled(await gameDir(params), insideFolder(str(params, "path", 600), "mods"), Boolean(params.enabled)) }));
  def("mods.remove", async (params) => void (await removeModFile(await gameDir(params), insideFolder(str(params, "path", 600), "mods"))));
  def("resourcepacks.list", async (params) => listResourcePacks(await gameDir(params), { icons: optBool(params, "icons") }));
  def("shaderpacks.list", async (params) => listShaderPacks(await gameDir(params)));
  def("screenshots.list", async (params) => listScreenshots(await gameDir(params)));
  def("screenshots.read", async (params) => (await readScreenshot(await gameDir(params), str(params, "file", 300))) ?? null);
  def("localfiles.remove", async (params) => void (await removePackFile(await gameDir(params), oneOf(params, "folder", PACK_FOLDERS) as PackFolder, str(params, "file", 300))));
  def("localfiles.rename", async (params) => void (await renamePackFile(await gameDir(params), oneOf(params, "folder", PACK_FOLDERS) as PackFolder, str(params, "file", 300), str(params, "newName", 300))));

  // ---------------- worlds and servers
  def("worlds.list", async (params) => listSaves(await gameDir(params)));
  def("worlds.size", async (params) => getSaveSize(await gameDir(params), str(params, "folder", 120)));
  def("worlds.icon", async (params) => (await readSaveIcon(await gameDir(params), str(params, "folder", 120))) ?? null);
  def("worlds.rename", async (params) => void (await renameLevel(await gameDir(params), str(params, "folder", 120), str(params, "name", 120))));
  def("worlds.renameFolder", async (params) => void (await renameSaveFolder(await gameDir(params), str(params, "folder", 120), str(params, "newFolder", 120))));
  def("worlds.duplicate", async (params) => ({ folder: await duplicateSave(await gameDir(params), str(params, "folder", 120)) }));
  def("worlds.delete", async (params) => {
    const id = str(params, "instanceId", 200);
    if (core.games.runningFor(id)) throw new RpcError("游戏正在运行，请先退出游戏再删除存档", "busy");
    await deleteSave(await core.gameDirOf(id), str(params, "folder", 120));
  });
  def("worlds.export", async (params) => {
    const dir = await gameDir(params);
    const folder = str(params, "folder", 120);
    const dest = str(params, "dest", 1000);
    const { id: taskId } = core.tasks.start({
      kind: "export",
      title: `导出存档 ${folder}`,
      instanceId: str(params, "instanceId", 200),
      run: async (ctx) => {
        ctx.plan([{ id: "write", label: "压缩存档" }]);
        ctx.stage("write");
        return exportSave(dir, folder, dest, { signal: ctx.signal, onEntry: (done, total) => ctx.log(`${done}/${total}`) });
      },
    });
    return { taskId };
  });
  def("worlds.import", async (params) => {
    const dir = await gameDir(params);
    const file = str(params, "file", 2000);
    const { id: taskId } = core.tasks.start({
      kind: "import",
      title: "导入存档",
      instanceId: str(params, "instanceId", 200),
      run: async (ctx) => {
        ctx.plan([{ id: "write", label: "解压存档" }]);
        ctx.stage("write");
        return { folder: await importSave(dir, file, { signal: ctx.signal }) };
      },
    });
    return { taskId };
  });

  const serversFile = async (params: Record<string, unknown>) => join(await gameDir(params), "servers.dat");
  def("servers.list", async (params) => readServers(await serversFile(params)));
  def("servers.add", async (params) => ({ index: await addServer(await serversFile(params), params.server as ServerEntry) }));
  def("servers.update", async (params) => void (await updateServer(await serversFile(params), optNum(params, "index", 0) ?? bad("index", "缺失"), params.patch as Partial<ServerEntry>)));
  def("servers.remove", async (params) => void (await removeServer(await serversFile(params), optNum(params, "index", 0) ?? bad("index", "缺失"))));
  def("servers.move", async (params) => void (await moveServer(await serversFile(params), optNum(params, "from", 0) ?? bad("from", "缺失"), optNum(params, "to", 0) ?? bad("to", "缺失"))));
  def("servers.ping", (params, { signal }) => pingServer(str(params, "address", 300), { timeoutMs: optNum(params, "timeoutMs", 500, 15000) ?? 5000, signal }));
  def("servers.pingAll", async (params, { signal }) => {
    const servers = await readServers(await serversFile(params));
    return mapLimit(
      servers,
      8,
      async (server) => {
        try {
          return { ip: server.ip, status: await pingServer(server.ip, { timeoutMs: 4000, signal }) };
        } catch (error) {
          if (isAbort(error)) throw error;
          return { ip: server.ip, error: (error as Error).message };
        }
      },
      signal,
    );
  });

  // ---------------- accounts
  def("accounts.list", async () => ({ accounts: await core.accounts.list(), selected: (await core.accounts.selectedId()) ?? null }));
  def("accounts.select", async (params) => {
    await core.accounts.select(str(params, "id", 100));
    core.emit({ type: "accounts" });
  });
  def("accounts.addOffline", async (params) => {
    const account = await core.accounts.addOffline(str(params, "name", 40), { uuid: optStr(params, "uuid", 60), useOwnerUuid: optBool(params, "useOwnerUuid") });
    core.emit({ type: "accounts" });
    return account;
  });
  def("accounts.loginMicrosoft", () => core.beginMicrosoftLogin());
  def("accounts.cancelLogin", (params) => core.cancelLogin(str(params, "loginId", 80)));
  def("accounts.loginAuthlib", async (params, { signal }) => {
    const result = await core.accounts.loginAuthlib(str(params, "server", 500), str(params, "username", 200), str(params, "password", 500), { profileId: optStr(params, "profileId", 60), signal });
    if (result.account) core.emit({ type: "accounts" });
    return result;
  });
  def("accounts.remove", async (params) => {
    await core.accounts.remove(str(params, "id", 100));
    core.emit({ type: "accounts" });
  });

  // ---------------- java
  def("java.list", async (params) => core.javaInstalls(optBool(params, "force")));
  def("java.test", async (params) => (await inspectJava(str(params, "path", 1000), "custom", { os: core.os })) ?? null);
  def("java.install", (params) => {
    const major = optNum(params, "major", 8, 99) ?? 21;
    const { id: taskId } = core.tasks.start({
      kind: "java",
      title: `下载 Java ${major}`,
      run: async (ctx) => {
        ctx.plan([{ id: "java", label: "下载 Java 运行时" }]);
        ctx.stage("java");
        const java = await core.ensureJava({ min: major, max: major }, undefined, ctx.signal, (progress) => ctx.progress(progress, "java"));
        await core.javaInstalls(true);
        return java;
      },
    });
    return { taskId };
  });

  // ---------------- misc
  def("fs.info", (params) => {
    try {
      const info = statSync(str(params, "path", 2000));
      return { exists: true, isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
    } catch {
      return { exists: false };
    }
  });

  return table;
}
