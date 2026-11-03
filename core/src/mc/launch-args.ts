import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { classpathSeparator, type OsInfo } from "../util/os";
import { assetsDir, buildClasspath, flattenArguments, librariesDir, resolveLibraries, versionJarPath, type LibraryFile, type ResolvedVersion } from "./version-json";
import type { RuleContext } from "./rules";
import type { FeatureFlags } from "./types";

export type UserType = "msa" | "legacy" | "mojang";

export interface LaunchAccount {
  name: string;
  uuid: string;
  accessToken: string;
  userType: UserType;
  xuid?: string;
  clientId?: string;
  /** Extra JVM arguments the account type needs (authlib-injector). */
  jvmArgs?: string[];
}

export interface LaunchInput {
  root: string;
  gameDir: string;
  version: ResolvedVersion;
  account: LaunchAccount;
  javaMajor: number;
  memoryMaxMB?: number;
  memoryMinMB?: number;
  /** User supplied JVM arguments (already split). */
  jvmArgs?: string[];
  /** User supplied game arguments (already split). */
  gameArgs?: string[];
  resolution?: { width?: number; height?: number; fullscreen?: boolean };
  quickPlay?: { server?: string; world?: string };
  demo?: boolean;
  launcherName?: string;
  launcherVersion?: string;
  nativesDir: string;
  os: OsInfo;
  /** Where the legacy asset tree lives, when the asset index asks for one. */
  legacyAssetsDir?: string;
  /** Written to the log4j option when the file exists. */
  utf8?: boolean;
  /** Overrides the `--versionType` value (shown in F3). */
  versionType?: string;
}

export interface BuiltLaunch {
  mainClass: string;
  jvmArgs: string[];
  gameArgs: string[];
  /** jvmArgs + mainClass + gameArgs: what follows the java executable. */
  args: string[];
  classpath: string;
  libraries: LibraryFile[];
  clientJar: string | undefined;
  placeholders: Record<string, string>;
}

export function replacePlaceholders(text: string, values: Record<string, string>, unknown?: (key: string) => void): string {
  return text.replace(/\$\{([^}]+)\}/g, (whole, key: string) => {
    if (key in values) return values[key];
    unknown?.(key);
    return whole;
  });
}

/** Split a user-typed argument string, honouring double and single quotes. */
export function splitArgs(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
    } else current += ch;
  }
  if (has || current) out.push(current);
  return out;
}

export function clientJarFor(root: string, version: ResolvedVersion): string | undefined {
  const own = versionJarPath(root, version.id);
  if (existsSync(own)) return own;
  const parent = versionJarPath(root, version.jar ?? version.rootId);
  return existsSync(parent) ? parent : undefined;
}

const FLAG_NAMES = ["-Xmx", "-Xms", "-Xss"];

function hasFlag(args: string[], prefix: string): boolean {
  return args.some((arg) => arg.startsWith(prefix));
}

export function buildLaunch(input: LaunchInput, ctx: RuleContext, libraries = resolveLibraries(input.version, ctx)): BuiltLaunch {
  const { version, account } = input;
  const sep = classpathSeparator(input.os);
  const clientJar = clientJarFor(input.root, version);
  const classpath = buildClasspath(libraries, librariesDir(input.root), clientJar, sep);
  const jarName = clientJar ? basename(clientJar, ".jar") : version.id;

  const features: FeatureFlags = {
    is_demo_user: Boolean(input.demo),
    has_custom_resolution: Boolean(input.resolution?.width && input.resolution?.height),
    has_quick_plays_support: Boolean(input.quickPlay?.server || input.quickPlay?.world),
    is_quick_play_singleplayer: Boolean(input.quickPlay?.world),
    is_quick_play_multiplayer: Boolean(input.quickPlay?.server),
    is_quick_play_realms: false,
  };
  const scoped: RuleContext = { os: ctx.os, features };

  const assetsRoot = assetsDir(input.root);
  const gameAssets = input.legacyAssetsDir ?? assetsRoot;
  const values: Record<string, string> = {
    auth_player_name: account.name,
    auth_uuid: account.uuid.replace(/-/g, ""),
    auth_access_token: account.accessToken,
    auth_session: `token:${account.accessToken}:${account.uuid.replace(/-/g, "")}`,
    auth_xuid: account.xuid ?? "0",
    clientid: account.clientId ?? "0",
    user_type: account.userType,
    user_properties: "{}",
    version_name: jarName,
    version_type: input.versionType ?? input.launcherName ?? version.type ?? "release",
    game_directory: input.gameDir,
    assets_root: assetsRoot,
    assets_index_name: version.assetIndex?.id ?? version.assets ?? "legacy",
    game_assets: gameAssets,
    natives_directory: input.nativesDir,
    library_directory: librariesDir(input.root),
    classpath_separator: sep,
    classpath,
    launcher_name: input.launcherName ?? "Vitrine",
    launcher_version: input.launcherVersion ?? "0.1.0",
    primary_jar: clientJar ?? "",
    primary_jar_name: `${jarName}.jar`,
    resolution_width: String(input.resolution?.width ?? 854),
    resolution_height: String(input.resolution?.height ?? 480),
    quickPlayPath: join(input.gameDir, "quickPlay", "log.json"),
    quickPlaySingleplayer: input.quickPlay?.world ?? "",
    quickPlayMultiplayer: input.quickPlay?.server ?? "",
    quickPlayRealms: "",
  };

  // ---- JVM arguments ----
  let jvm = flattenArguments(version.arguments?.jvm, scoped);
  if (!version.arguments?.jvm) {
    jvm = [
      "-Djava.library.path=${natives_directory}",
      "-Dminecraft.launcher.brand=${launcher_name}",
      "-Dminecraft.launcher.version=${launcher_version}",
      "-cp",
      "${classpath}",
    ];
  }
  // Odd profiles (Fabric on legacy versions) ship a partial jvm list; make sure the essentials exist.
  if (!jvm.some((arg) => arg === "-cp" || arg === "-classpath" || arg === "--class-path")) jvm.push("-cp", "${classpath}");
  if (!jvm.some((arg) => arg.startsWith("-Djava.library.path="))) jvm.unshift("-Djava.library.path=${natives_directory}");

  const user = input.jvmArgs ?? [];
  const lead: string[] = [];
  if (input.memoryMaxMB && !hasFlag(user, "-Xmx")) lead.push(`-Xmx${Math.round(input.memoryMaxMB)}M`);
  if (input.memoryMinMB && !hasFlag(user, "-Xms")) lead.push(`-Xms${Math.round(input.memoryMinMB)}M`);
  if (input.utf8 !== false) {
    lead.push("-Dfile.encoding=UTF-8", "-Dsun.stdout.encoding=UTF-8", "-Dsun.stderr.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8");
  }
  void FLAG_NAMES;

  const log = version.logging?.client;
  const logArgs: string[] = [];
  if (log?.argument && log.file?.id) {
    const path = join(input.root, "assets", "log_configs", log.file.id);
    if (existsSync(path)) logArgs.push(log.argument.replace("${path}", path));
  }

  const warnUnknown = new Set<string>();
  const fill = (text: string) => replacePlaceholders(text, values, (key) => warnUnknown.add(key));
  const jvmFinal = [...lead, ...(account.jvmArgs ?? []), ...user, ...jvm.map(fill), ...logArgs];

  // ---- game arguments ----
  const legacy = (version.minecraftArguments ?? "").split(/\s+/).filter(Boolean);
  const game = [...legacy, ...flattenArguments(version.arguments?.game, scoped)].map(fill);
  const has = (flag: string) => game.includes(flag);
  if (input.resolution?.width && input.resolution.height && !has("--width")) game.push("--width", String(input.resolution.width), "--height", String(input.resolution.height));
  if (input.resolution?.fullscreen && !has("--fullscreen")) game.push("--fullscreen");
  if (input.quickPlay?.server && !has("--quickPlayMultiplayer") && !has("--server")) {
    const [host, port] = splitHostPort(input.quickPlay.server);
    game.push("--server", host);
    if (port) game.push("--port", String(port));
  }
  if (input.demo && !has("--demo")) game.push("--demo");
  game.push(...(input.gameArgs ?? []));

  const mainClass = version.mainClass;
  if (!mainClass) throw new Error(`Version "${version.id}" has no main class`);
  return {
    mainClass,
    jvmArgs: jvmFinal,
    gameArgs: game,
    args: [...jvmFinal, mainClass, ...game],
    classpath,
    libraries,
    clientJar,
    placeholders: values,
  };
}

export function splitHostPort(address: string): [string, number | undefined] {
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
  if (bracket) return [bracket[1], bracket[2] ? Number(bracket[2]) : undefined];
  const colon = address.lastIndexOf(":");
  if (colon > 0 && address.indexOf(":") === colon && /^\d+$/.test(address.slice(colon + 1))) return [address.slice(0, colon), Number(address.slice(colon + 1))];
  return [address, undefined];
}

/** Quote one argument for a Java `@argfile`. */
export function quoteForArgFile(arg: string): string {
  if (arg !== "" && !/[\s"'\\#]/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Windows' CreateProcess limit is 32767 characters; leave headroom. */
export function commandLineLength(java: string, args: string[]): number {
  return java.length + args.reduce((sum, arg) => sum + arg.length + 3, 0);
}

/** Render a command for display or for an exported launch script. Secrets are masked unless asked otherwise. */
export function formatCommand(java: string, args: string[], os: OsInfo, mask?: string[]): string {
  const hide = (arg: string) => (mask && mask.some((secret) => secret && arg === secret) ? "******" : arg);
  const quote = (arg: string) => {
    const value = hide(arg);
    if (os.name === "windows") return /[\s"&|<>^%]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
    return /[^\w@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
  };
  return [java, ...args].map(quote).join(" ");
}
