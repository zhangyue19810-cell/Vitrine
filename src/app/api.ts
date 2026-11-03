import type { Bridge } from "./bridge";
import type {
  AccountType,
  CrashAnalysis,
  ContentKind,
  ContentProject,
  ContentSearchResult,
  ContentSource,
  ContentVersion,
  ExportCandidate,
  GameLine,
  GameSnapshot,
  InstallContentResult,
  InstanceConfig,
  InstanceSummary,
  JavaInstall,
  JvmPresetInfo,
  LatestPack,
  LoaderVersion,
  LocalMod,
  LoginChallenge,
  MemoryAdvice,
  ModProblem,
  ModUpdate,
  PackPreview,
  PackState,
  PublicAccount,
  ResourcePackInfo,
  SaveInfo,
  ScreenshotInfo,
  ServerEntry,
  ServerStatus,
  Settings,
  ShaderPackInfo,
  TaskSnapshot,
  UiLevel,
} from "./types";

export interface SystemInfo {
  version: string;
  os: { name: "windows" | "linux" | "osx"; arch: string; version?: string };
  cpuCount: number;
  totalMemoryMB: number;
  freeMemoryMB: number;
  dataDir: string;
  root: string;
  hasCurseForgeKey: boolean;
  hasMicrosoftClientId: boolean;
}

export interface Bootstrap {
  settings: Settings;
  instances: InstanceSummary[];
  accounts: PublicAccount[];
  selectedAccount: string | null;
  tasks: TaskSnapshot[];
  games: GameSnapshot[];
  system: SystemInfo;
  jvmPresets: JvmPresetInfo[];
}

export interface VersionList {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: "release" | "snapshot" | "old_beta" | "old_alpha"; releaseTime: string }[];
}

export type LoaderOverview = Record<string, { count: number; error?: string; latest?: string; recommended?: string }>;
export type LoaderChoice = { kind: string; version: string; raw?: string; meta?: Record<string, string> };

type FileFilter = { name: string; extensions: string[] };

/** Every method of the core's RPC table the interface uses: [parameters, result]. */
export interface RpcMap {
  "app.info": [void, SystemInfo];
  "app.suggestRoots": [void, { path: string; kind: string; versions: number }[]];
  "app.clearCache": [void, null];
  "app.bootstrap": [void, Bootstrap];
  "ui.setLevel": [{ level: UiLevel }, { level: UiLevel }];
  "settings.get": [void, Settings];
  "settings.update": [{ patch: unknown }, Settings];
  "host.pickFile": [{ title?: string; filters?: FileFilter[]; multi?: boolean }, string[] | undefined];
  "host.pickFolder": [{ title?: string }, string | undefined];
  "host.saveFile": [{ title?: string; defaultPath?: string; filters?: FileFilter[] }, string | undefined];
  "host.openExternal": [{ url: string }, null];
  "versions.list": [{ force?: boolean }, VersionList];
  "loaders.list": [{ kind: string; mcVersion: string }, LoaderVersion[]];
  "loaders.overview": [{ mcVersion: string }, LoaderOverview];
  "instances.list": [void, InstanceSummary[]];
  "instances.get": [{ id: string }, InstanceSummary];
  "instances.create": [{ name: string; mcVersion: string; loader?: LoaderChoice; isolation?: "auto" | "on" | "off" }, { taskId: string }];
  "instances.setConfig": [{ id: string; patch: Partial<InstanceConfig> | Record<string, unknown> }, InstanceSummary];
  "instances.rename": [{ id: string; name: string }, null];
  "instances.duplicate": [{ id: string; name: string }, { taskId: string }];
  "instances.remove": [{ id: string }, null];
  "instances.repair": [{ id: string; verify?: "size" | "hash" }, { taskId: string }];
  "instances.openFolder": [{ id: string; sub?: string }, { path: string }];
  "instances.launch": [{ id: string; server?: string; world?: string; demo?: boolean; accountId?: string }, { taskId: string }];
  "instances.exportScript": [{ id: string; dest: string; includeToken?: boolean }, { path: string; tokenIncluded: boolean; warnings: string[] }];
  "instances.memoryAdvice": [{ id: string }, MemoryAdvice & { totalMB: number; freeMB: number; modCount: number }];
  "instances.analyzeCrash": [{ id: string }, CrashAnalysis];
  "instances.packState": [{ id: string }, PackState | null];
  "games.list": [void, GameSnapshot[]];
  "games.tail": [{ id: string; count?: number }, GameLine[]];
  "games.kill": [{ id: string }, unknown];
  "games.forget": [{ id: string }, unknown];
  "tasks.list": [void, TaskSnapshot[]];
  "tasks.get": [{ id: string }, TaskSnapshot | null];
  "tasks.cancel": [{ id: string }, unknown];
  "tasks.clear": [void, unknown];
  "packs.preview": [{ file: string }, PackPreview];
  "packs.install": [{ file: string; name?: string; skipOptional?: boolean | string[] }, { taskId: string }];
  "packs.installOnline": [{ source: ContentSource; projectId: string; versionId?: string; name?: string; title?: string }, { taskId: string }];
  "packs.exportCandidates": [{ instanceId: string }, ExportCandidate[]];
  "packs.export": [{ instanceId: string; dest: string; name: string; version?: string; summary?: string; include: string[]; identify?: boolean }, { taskId: string }];
  "packs.latest": [{ instanceId: string }, LatestPack | null];
  "content.status": [void, { curseforge: boolean }];
  "content.search": [
    { source: ContentSource; kind: ContentKind; query?: string; sort?: "relevance" | "downloads" | "updated" | "newest"; category?: string; page?: number; pageSize?: number; gameVersion?: string; loader?: string },
    ContentSearchResult,
  ];
  "content.project": [{ source: ContentSource; id: string }, ContentProject & { description?: string; gallery?: string[]; links?: Record<string, string> }];
  "content.versions": [{ source: ContentSource; projectId: string; gameVersion?: string; loader?: string }, ContentVersion[]];
  "content.install": [
    { instanceId: string; kind: Exclude<ContentKind, "modpack">; source: ContentSource; projectId: string; versionId?: string; gameVersion?: string; loader?: string; withDependencies?: boolean; world?: string; title?: string },
    { taskId: string },
  ];
  "content.checkUpdates": [{ instanceId: string }, { taskId: string }];
  "content.applyUpdates": [{ instanceId: string; updates: ModUpdate[] }, { taskId: string }];
  "mods.list": [{ instanceId: string }, { mods: LocalMod[]; problems: ModProblem[] }];
  "mods.icon": [{ instanceId: string; path: string }, string | undefined];
  "mods.setEnabled": [{ instanceId: string; path: string; enabled: boolean }, { path: string }];
  "mods.remove": [{ instanceId: string; path: string }, null];
  "resourcepacks.list": [{ instanceId: string; icons?: boolean }, ResourcePackInfo[]];
  "shaderpacks.list": [{ instanceId: string }, ShaderPackInfo[]];
  "screenshots.list": [{ instanceId: string }, ScreenshotInfo[]];
  "screenshots.read": [{ instanceId: string; file: string }, string | null];
  "localfiles.remove": [{ instanceId: string; folder: "resourcepacks" | "shaderpacks" | "screenshots"; file: string }, null];
  "localfiles.rename": [{ instanceId: string; folder: "resourcepacks" | "shaderpacks" | "screenshots"; file: string; newName: string }, null];
  "worlds.list": [{ instanceId: string }, SaveInfo[]];
  "worlds.size": [{ instanceId: string; folder: string }, number];
  "worlds.icon": [{ instanceId: string; folder: string }, string | null];
  "worlds.rename": [{ instanceId: string; folder: string; name: string }, null];
  "worlds.renameFolder": [{ instanceId: string; folder: string; newFolder: string }, null];
  "worlds.duplicate": [{ instanceId: string; folder: string }, { folder: string }];
  "worlds.delete": [{ instanceId: string; folder: string }, null];
  "worlds.export": [{ instanceId: string; folder: string; dest: string }, { taskId: string }];
  "worlds.import": [{ instanceId: string; file: string }, { taskId: string }];
  "servers.list": [{ instanceId: string }, ServerEntry[]];
  "servers.add": [{ instanceId: string; server: ServerEntry }, { index: number }];
  "servers.update": [{ instanceId: string; index: number; patch: Partial<ServerEntry> }, null];
  "servers.remove": [{ instanceId: string; index: number }, null];
  "servers.move": [{ instanceId: string; from: number; to: number }, null];
  "servers.ping": [{ address: string; timeoutMs?: number }, ServerStatus];
  "servers.pingAll": [{ instanceId: string }, { ip: string; status?: ServerStatus; error?: string }[]];
  "accounts.list": [void, { accounts: PublicAccount[]; selected: string | null }];
  "accounts.select": [{ id: string }, null];
  "accounts.addOffline": [{ name: string; uuid?: string; useOwnerUuid?: boolean }, PublicAccount];
  "accounts.loginMicrosoft": [void, { loginId: string; challenge: LoginChallenge }];
  "accounts.cancelLogin": [{ loginId: string }, boolean];
  "accounts.loginAuthlib": [
    { server: string; username: string; password: string; profileId?: string },
    { account?: PublicAccount; profiles?: { id: string; name: string }[] },
  ];
  "accounts.remove": [{ id: string }, null];
  "java.list": [{ force?: boolean } | void, JavaInstall[]];
  "java.test": [{ path: string }, JavaInstall | null];
  "java.install": [{ major?: number }, { taskId: string }];
  "fs.info": [{ path: string }, { exists: boolean; isFile?: boolean; isDirectory?: boolean; size?: number }];
}

export type { AccountType };

let current: Bridge | undefined;

export function setBridge(bridge: Bridge | undefined) {
  current = bridge;
}

export function getBridge(): Bridge | undefined {
  return current;
}

/** Call a core method. Errors carry `.code` (see core/src/rpc.ts) and a Chinese `.message` fit to show. */
export function rpc<K extends keyof RpcMap>(method: K, params?: RpcMap[K][0] extends void ? undefined : RpcMap[K][0], signal?: AbortSignal): Promise<RpcMap[K][1]> {
  if (!current) return Promise.reject(new Error("未连接到核心"));
  return current.call<RpcMap[K][1]>(method, (params ?? {}) as Record<string, unknown>, signal);
}

/** Like `rpc`, but resolves to `undefined` instead of rejecting (for fire-and-forget calls that only matter when they work). */
export async function tryRpc<K extends keyof RpcMap>(method: K, params?: RpcMap[K][0] extends void ? undefined : RpcMap[K][0]): Promise<RpcMap[K][1] | undefined> {
  try {
    return await rpc(method, params);
  } catch {
    return undefined;
  }
}
