import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENGINE, DownloadEngine } from "../src/net/download";
import { HttpClient } from "../src/net/http";
import { DEFAULT_SOURCES, SourceRouter, type SourceSettings } from "../src/net/sources";
import { nullLog } from "../src/util/log";
import { currentOs, type OsInfo } from "../src/util/os";
import { rulesAllow } from "../src/mc/rules";
import { assetIndexPath, assetObjectItems, materializeLegacyAssets } from "../src/mc/assets";
import { completeVersion, type GameEnv } from "../src/mc/files";
import { installVanilla } from "../src/mc/installer";
import { VersionCatalog } from "../src/mc/manifest";
import { buildLaunch, formatCommand, quoteForArgFile, splitArgs, splitHostPort } from "../src/mc/launch-args";
import { spawnGame } from "../src/mc/launcher";
import { prepareNatives } from "../src/mc/natives";
import { InstanceStore, uniqueName, validateInstanceName } from "../src/mc/instances";
import type { LibraryJson, VersionJson } from "../src/mc/types";
import {
  MissingVersionError,
  detectLoaders,
  detectMinecraftVersion,
  librariesDir,
  mergeVersions,
  resolveLibraries,
  resolveVersion,
  versionDir,
  versionJsonPath,
} from "../src/mc/version-json";
import { mavenKey, mavenPath, parseMaven } from "../src/mc/maven";
import { JVM_PRESETS, presetArgs, recommendMemory } from "../src/mc/jvm";
import { detectJava, inspectJava, javaRequirement, parseRegistryHomes, pickJava, type JavaInstall } from "../src/java/detect";
import { startFakeMojang, zipBuffer, type FakeWorld } from "./helpers/fake-mojang";

const WIN: OsInfo = { name: "windows", arch: "x64", version: "10.0.22631" };
const LINUX: OsInfo = { name: "linux", arch: "x64", version: "6.1.0" };
const ctx = (os: OsInfo, features = {}) => ({ os, features });

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-mc-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("rules", () => {
  it("applies the last matching rule and defaults to disallow when rules exist", () => {
    const rules = [
      { action: "allow" as const },
      { action: "disallow" as const, os: { name: "osx" } },
    ];
    assert.equal(rulesAllow(rules, ctx(WIN)), true);
    assert.equal(rulesAllow(rules, ctx({ ...WIN, name: "osx" })), false);
    assert.equal(rulesAllow(undefined, ctx(WIN)), true);
    assert.equal(rulesAllow([{ action: "allow", os: { name: "linux" } }], ctx(WIN)), false);
  });

  it("matches os version regexes and arch", () => {
    const win10 = [{ action: "allow" as const, os: { name: "windows", version: "^10\\." } }];
    assert.equal(rulesAllow(win10, ctx(WIN)), true);
    assert.equal(rulesAllow(win10, ctx({ ...WIN, version: "6.1.7601" })), false);
    const x86 = [{ action: "allow" as const, os: { name: "windows", arch: "x86" } }];
    assert.equal(rulesAllow(x86, ctx(WIN)), false);
    assert.equal(rulesAllow(x86, ctx({ ...WIN, arch: "x86" })), true);
    const arm = [{ action: "allow" as const, os: { arch: "arm64" } }];
    assert.equal(rulesAllow(arm, ctx({ ...WIN, arch: "arm64" })), true);
  });

  it("evaluates feature flags", () => {
    const demo = [{ action: "allow" as const, features: { is_demo_user: true } }];
    assert.equal(rulesAllow(demo, ctx(WIN, { is_demo_user: true })), true);
    assert.equal(rulesAllow(demo, ctx(WIN, {})), false);
  });
});

describe("maven helpers", () => {
  it("parses coordinates and builds paths", () => {
    assert.equal(mavenPath("com.mojang:brigadier:1.1.8"), "com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar");
    assert.equal(mavenPath("org.lwjgl:lwjgl:3.3.1:natives-windows"), "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar");
    assert.equal(mavenPath("net.minecraft:client:1.20.1-2023:mappings@txt"), "net/minecraft/client/1.20.1-2023/client-1.20.1-2023-mappings.txt");
    assert.deepEqual(parseMaven("a.b:c:1.0@zip"), { group: "a.b", artifact: "c", version: "1.0", classifier: undefined, extension: "zip" });
    assert.equal(mavenKey("org.ow2.asm:asm:9.6"), mavenKey("org.ow2.asm:asm:9.7"));
    assert.notEqual(mavenKey("org.lwjgl:lwjgl:3.3.1"), mavenKey("org.lwjgl:lwjgl:3.3.1:natives-windows"));
    assert.throws(() => parseMaven("nope"));
  });
});

const lib = (name: string, extra: Partial<LibraryJson> = {}): LibraryJson => ({ name, ...extra });

describe("version JSON merging", () => {
  const vanilla: VersionJson = {
    id: "1.20.1",
    type: "release",
    mainClass: "net.minecraft.client.main.Main",
    assets: "12",
    assetIndex: { id: "12", url: "https://x/12.json" },
    downloads: { client: { url: "https://x/client.jar", sha1: "aa", size: 1 } },
    javaVersion: { component: "java-runtime-gamma", majorVersion: 17 },
    libraries: [lib("org.ow2.asm:asm:9.3"), lib("com.mojang:brigadier:1.1.8")],
    arguments: { game: ["--username", "${auth_player_name}"], jvm: ["-cp", "${classpath}"] },
  };
  const forge: VersionJson = {
    id: "1.20.1-forge-47.2.0",
    inheritsFrom: "1.20.1",
    type: "release",
    mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
    libraries: [lib("org.ow2.asm:asm:9.6"), lib("net.minecraftforge:forge:1.20.1-47.2.0:universal")],
    arguments: { game: ["--launchTarget", "forgeclient"], jvm: ["-DignoreList=x,${version_name}.jar"] },
  };

  it("child libraries come first and replace parent versions of the same artifact", () => {
    const merged = mergeVersions(vanilla, forge);
    assert.equal(merged.id, "1.20.1-forge-47.2.0");
    assert.equal(merged.inheritsFrom, undefined);
    assert.deepEqual(
      merged.libraries!.map((l) => l.name),
      ["org.ow2.asm:asm:9.6", "net.minecraftforge:forge:1.20.1-47.2.0:universal", "com.mojang:brigadier:1.1.8"],
    );
    assert.equal(merged.mainClass, "cpw.mods.bootstraplauncher.BootstrapLauncher");
    assert.equal(merged.javaVersion?.majorVersion, 17);
    assert.deepEqual(merged.arguments!.game, ["--username", "${auth_player_name}", "--launchTarget", "forgeclient"]);
    assert.deepEqual(merged.arguments!.jvm, ["-cp", "${classpath}", "-DignoreList=x,${version_name}.jar"]);
    assert.equal(merged.downloads?.client?.sha1, "aa");
  });

  it("resolves inheritance from disk and reports a missing parent", async () => {
    await mkdir(versionDir(tmp, "1.20.1"), { recursive: true });
    await mkdir(versionDir(tmp, "forge"), { recursive: true });
    await writeFile(versionJsonPath(tmp, "forge"), JSON.stringify(forge));
    await assert.rejects(resolveVersion(tmp, "forge"), (error: unknown) => error instanceof MissingVersionError && error.versionId === "1.20.1");
    await writeFile(versionJsonPath(tmp, "1.20.1"), JSON.stringify(vanilla));
    const resolved = await resolveVersion(tmp, "forge");
    assert.deepEqual(resolved.chain, ["forge", "1.20.1"]);
    assert.equal(resolved.rootId, "1.20.1");
    assert.equal(resolved.id, "forge");
    assert.equal(detectMinecraftVersion(resolved), "1.20.1");
  });

  it("detects loop in inheritance", async () => {
    for (const [id, parent] of [["a", "b"], ["b", "a"]]) {
      await mkdir(versionDir(tmp, id), { recursive: true });
      await writeFile(versionJsonPath(tmp, id), JSON.stringify({ id, inheritsFrom: parent, mainClass: "x" }));
    }
    await assert.rejects(resolveVersion(tmp, "a"), /circular/);
  });

  it("keeps legacy minecraftArguments from the child, else the parent", () => {
    const parent: VersionJson = { id: "1.12.2", minecraftArguments: "--username ${auth_player_name}", mainClass: "net.minecraft.client.main.Main" };
    const withOwn = mergeVersions(parent, { id: "f", inheritsFrom: "1.12.2", minecraftArguments: "--username ${auth_player_name} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker" });
    assert.match(withOwn.minecraftArguments!, /FMLTweaker/);
    assert.equal(mergeVersions(parent, { id: "g", inheritsFrom: "1.12.2" }).minecraftArguments, parent.minecraftArguments);
  });
});

describe("library resolution", () => {
  it("handles artifacts, natives maps, rules and constructed maven urls", () => {
    const libs: LibraryJson[] = [
      lib("com.mojang:brigadier:1.1.8", { downloads: { artifact: { path: "com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar", url: "https://libraries.minecraft.net/com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar", sha1: "11", size: 5 } } }),
      lib("org.lwjgl:lwjgl:3.3.1:natives-windows", { downloads: { artifact: { path: "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar", url: "https://libraries.minecraft.net/x", sha1: "22", size: 6 } }, rules: [{ action: "allow", os: { name: "windows" } }] }),
      lib("org.lwjgl:lwjgl:3.3.1:natives-linux", { downloads: { artifact: { path: "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar", url: "https://libraries.minecraft.net/y", sha1: "33", size: 7 } }, rules: [{ action: "allow", os: { name: "linux" } }] }),
      lib("org.lwjgl.lwjgl:lwjgl-platform:2.9.4", {
        natives: { windows: "natives-windows-${arch}", linux: "natives-linux" },
        extract: { exclude: ["META-INF/"] },
        downloads: { classifiers: { "natives-windows-64": { path: "o/lwjgl-platform-2.9.4-natives-windows-64.jar", url: "https://libraries.minecraft.net/z", sha1: "44", size: 8 }, "natives-windows-32": { path: "o/lwjgl-platform-2.9.4-natives-windows-32.jar", url: "https://libraries.minecraft.net/z32", sha1: "45", size: 8 }, "natives-linux": { path: "o/linux.jar", url: "https://libraries.minecraft.net/l", sha1: "55", size: 9 } } },
      }),
      lib("net.fabricmc:fabric-loader:0.15.11", { url: "https://maven.fabricmc.net/", sha1: "66", size: 10 }),
      lib("net.minecraftforge:forge:1.12.2-14.23.5.2860", { url: "" }),
      lib("some:thing:1.0", { url: "http://files.minecraftforge.net/maven/" }),
    ];
    const win = resolveLibraries({ libraries: libs }, ctx(WIN));
    const names = win.map((l) => l.name);
    assert.ok(names.includes("com.mojang:brigadier:1.1.8"));
    assert.ok(names.includes("org.lwjgl:lwjgl:3.3.1:natives-windows"));
    assert.ok(!names.includes("org.lwjgl:lwjgl:3.3.1:natives-linux"));
    const oldNative = win.find((l) => l.name === "org.lwjgl.lwjgl:lwjgl-platform:2.9.4:natives-windows-64")!;
    assert.equal(oldNative.native, true);
    assert.equal(oldNative.onClasspath, false);
    assert.deepEqual(oldNative.extractExclude, ["META-INF/"]);
    const newNative = win.find((l) => l.name === "org.lwjgl:lwjgl:3.3.1:natives-windows")!;
    assert.equal(newNative.native, true, "new-style natives jars are extracted too");
    assert.equal(newNative.onClasspath, true);
    const fabric = win.find((l) => l.name.startsWith("net.fabricmc"))!;
    assert.equal(fabric.url, "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar");
    assert.equal(fabric.sha1, "66");
    const local = win.find((l) => l.name.startsWith("net.minecraftforge"))!;
    assert.equal(local.url, undefined, "empty url means the installer provides the file");
    assert.equal(win.find((l) => l.name === "some:thing:1.0")!.url, "http://files.minecraftforge.net/maven/some/thing/1.0/thing-1.0.jar");
    const x86 = resolveLibraries({ libraries: libs }, ctx({ ...WIN, arch: "x86" }));
    assert.ok(x86.some((l) => l.name.endsWith("natives-windows-32")));
    const linux = resolveLibraries({ libraries: libs }, ctx(LINUX));
    assert.ok(linux.some((l) => l.name === "org.lwjgl:lwjgl:3.3.1:natives-linux"));
  });
});

describe("loader and version detection", () => {
  const detect = (names: string[], extra: Partial<VersionJson> = {}) => detectLoaders({ id: "x", libraries: names.map((name) => lib(name)), ...extra }, ctx(WIN));
  it("recognises the common loaders", () => {
    assert.deepEqual(detect(["net.fabricmc:fabric-loader:0.15.11", "net.fabricmc:intermediary:1.20.1"]), [{ kind: "fabric", version: "0.15.11" }]);
    assert.deepEqual(detect(["org.quiltmc:quilt-loader:0.26.0"]), [{ kind: "quilt", version: "0.26.0" }]);
    assert.deepEqual(detect(["net.minecraftforge:forge:1.20.1-47.2.0"]), [{ kind: "forge", version: "47.2.0" }]);
    assert.deepEqual(detect(["net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10"]), [{ kind: "forge", version: "10.13.4.1614" }]);
    assert.deepEqual(detect(["net.neoforged:neoforge:21.1.77"]), [{ kind: "neoforge", version: "21.1.77" }]);
    assert.deepEqual(detect(["net.neoforged:forge:1.20.1-47.1.106"]), [{ kind: "neoforge", version: "47.1.106" }]);
    assert.deepEqual(detect(["optifine:OptiFine:1.12.2_HD_U_G5", "optifine:launchwrapper-of:2.2"]), [{ kind: "optifine", version: "HD_U_G5" }]);
    assert.deepEqual(detect(["com.mojang:brigadier:1.0"]), []);
  });

  it("finds the vanilla version through several routes", () => {
    const base = { chain: ["a"], rootId: "a" };
    assert.equal(detectMinecraftVersion({ id: "My Fabric", libraries: [lib("net.fabricmc:intermediary:1.19.4")], ...base }), "1.19.4");
    assert.equal(detectMinecraftVersion({ id: "F", libraries: [lib("net.minecraftforge:forge:1.12.2-14.23.5.2860")], ...base }), "1.12.2");
    assert.equal(detectMinecraftVersion({ id: "N", arguments: { game: ["--fml.mcVersion", "1.21.1"] }, ...base }), "1.21.1");
    assert.equal(detectMinecraftVersion({ id: "1.8.9", ...base }), "1.8.9");
    assert.equal(detectMinecraftVersion({ id: "child", ...base, chain: ["child", "1.16.5"], rootId: "1.16.5" }), "1.16.5");
  });
});

describe("launch arguments", () => {
  const baseVersion = (): VersionJson & { chain: string[]; rootId: string } => ({
    id: "t",
    chain: ["t"],
    rootId: "t",
    mainClass: "net.minecraft.client.main.Main",
    assetIndex: { id: "12", url: "u" },
    type: "release",
    libraries: [
      lib("a:b:1", { downloads: { artifact: { path: "a/b/1/b-1.jar", url: "u" } } }),
      lib("c:d:2", { downloads: { artifact: { path: "c/d/2/d-2.jar", url: "u" } } }),
    ],
    arguments: {
      game: [
        "--username", "${auth_player_name}", "--uuid", "${auth_uuid}", "--accessToken", "${auth_access_token}", "--version", "${version_name}",
        { rules: [{ action: "allow", features: { is_demo_user: true } }], value: "--demo" },
        { rules: [{ action: "allow", features: { has_custom_resolution: true } }], value: ["--width", "${resolution_width}", "--height", "${resolution_height}"] },
        { rules: [{ action: "allow", features: { is_quick_play_multiplayer: true } }], value: ["--quickPlayMultiplayer", "${quickPlayMultiplayer}"] },
      ],
      jvm: [
        { rules: [{ action: "allow", os: { name: "windows" } }], value: "-XX:HeapDumpPath=x" },
        "-Djava.library.path=${natives_directory}",
        "-cp",
        "${classpath}",
      ],
    },
  });
  const input = (over = {}) => ({
    root: join(tmp, "mc"),
    gameDir: join(tmp, "game"),
    version: baseVersion(),
    account: { name: "Wind", uuid: "00112233-4455-4677-8899-aabbccddeeff", accessToken: ["SEC", "RET"].join(""), userType: "legacy" as const },
    javaMajor: 17,
    nativesDir: join(tmp, "natives"),
    os: WIN,
    ...over,
  });

  it("substitutes placeholders and honours OS and feature rules", () => {
    const built = buildLaunch(input({ memoryMaxMB: 4096, memoryMinMB: 512 }), ctx(WIN));
    assert.ok(built.jvmArgs.includes("-Xmx4096M"));
    assert.ok(built.jvmArgs.includes("-Xms512M"));
    assert.ok(built.jvmArgs.includes("-XX:HeapDumpPath=x"));
    assert.ok(built.jvmArgs.includes(`-Djava.library.path=${join(tmp, "natives")}`));
    const cp = built.jvmArgs[built.jvmArgs.indexOf("-cp") + 1];
    assert.ok(cp.includes("b-1.jar"));
    assert.ok(cp.includes(";"), "windows classpath uses ;");
    const game = built.gameArgs;
    assert.equal(game[game.indexOf("--username") + 1], "Wind");
    assert.equal(game[game.indexOf("--uuid") + 1], "00112233445546778899aabbccddeeff", "uuid is sent without dashes");
    assert.ok(!game.includes("--demo"));
    assert.ok(!game.includes("--width"));
    assert.equal(built.args.at(-game.length - 1), "net.minecraft.client.main.Main");
    const linux = buildLaunch(input({ os: LINUX }), ctx(LINUX));
    assert.ok(!linux.jvmArgs.includes("-XX:HeapDumpPath=x"));
    assert.ok(linux.jvmArgs.join(" ").includes(":"), "unix classpath uses :");
  });

  it("applies resolution, demo and quick-play features", () => {
    const built = buildLaunch(input({ resolution: { width: 1280, height: 720 }, demo: true, quickPlay: { server: "mc.example.com:25570" } }), ctx(WIN));
    const game = built.gameArgs;
    assert.deepEqual(game.slice(game.indexOf("--width"), game.indexOf("--width") + 4), ["--width", "1280", "--height", "720"]);
    assert.ok(game.includes("--demo"));
    assert.equal(game[game.indexOf("--quickPlayMultiplayer") + 1], "mc.example.com:25570");
  });

  it("builds a legacy profile with minecraftArguments and default jvm args", () => {
    const version = { ...baseVersion(), arguments: undefined, minecraftArguments: "--username ${auth_player_name} --session ${auth_session} --gameDir ${game_directory} --assetsDir ${game_assets}" };
    const built = buildLaunch(input({ version, quickPlay: { server: "play.example.org:25565" }, resolution: { width: 800, height: 600, fullscreen: true } }), ctx(WIN));
    assert.ok(built.jvmArgs.some((arg) => arg.startsWith("-Djava.library.path=")));
    assert.ok(built.jvmArgs.includes("-cp"));
    const game = built.gameArgs;
    assert.equal(game[game.indexOf("--session") + 1], "token:SECRET:00112233445546778899aabbccddeeff");
    assert.deepEqual(game.slice(game.indexOf("--server"), game.indexOf("--server") + 4), ["--server", "play.example.org", "--port", "25565"]);
    assert.ok(game.includes("--fullscreen"));
  });

  it("lets user JVM args override memory and adds partial-profile essentials", () => {
    const version = { ...baseVersion(), arguments: { game: [], jvm: ["-Dfoo=bar"] } };
    const built = buildLaunch(input({ version, jvmArgs: ["-Xmx9G", "-XX:+UseZGC"], memoryMaxMB: 2048 }), ctx(WIN));
    assert.ok(!built.jvmArgs.some((a) => a === "-Xmx2048M"));
    assert.ok(built.jvmArgs.includes("-Xmx9G"));
    assert.ok(built.jvmArgs.includes("-cp"), "missing -cp is added");
    assert.ok(built.jvmArgs.some((a) => a.startsWith("-Djava.library.path=")));
  });

  it("splits and quotes arguments", () => {
    assert.deepEqual(splitArgs('-Xmx2G "-Dpath=C:\\My Games\\x" \'a b\' ""'), ["-Xmx2G", "-Dpath=C:\\My Games\\x", "a b", ""]);
    assert.equal(quoteForArgFile("plain"), "plain");
    assert.equal(quoteForArgFile("C:\\a b\\c"), '"C:\\\\a b\\\\c"');
    assert.deepEqual(splitHostPort("a.b.c:25570"), ["a.b.c", 25570]);
    assert.deepEqual(splitHostPort("a.b.c"), ["a.b.c", undefined]);
    assert.deepEqual(splitHostPort("[::1]:25565"), ["::1", 25565]);
    const text = formatCommand("java", ["--accessToken", "SECRET", "a b"], LINUX, ["SECRET"]);
    assert.equal(text, "java --accessToken '******' 'a b'");
    assert.ok(!formatCommand("C:\\Java\\bin\\java.exe", ["-cp", "a;b"], WIN).includes("SECRET"));
  });
});

describe("JVM presets and memory advice", () => {
  it("only applies a preset when it fits the Java version and user flags", () => {
    assert.deepEqual(presetArgs("default", 17), []);
    assert.ok(presetArgs("large-modpack", 21).includes("-XX:G1HeapRegionSize=32M"));
    assert.deepEqual(presetArgs("zgc", 17), []);
    assert.ok(presetArgs("zgc", 21).includes("-XX:+ZGenerational"));
    assert.deepEqual(presetArgs("zgc", 25), ["-XX:+UseZGC"]);
    assert.deepEqual(presetArgs("mojang", 21, ["-XX:+UseParallelGC"]), []);
    assert.equal(JVM_PRESETS.length, 4);
  });

  it("scales memory with the mod count and machine size", () => {
    assert.equal(recommendMemory({ totalMB: 32768, freeMB: 20000, modCount: 0, is64: true }).maxMB, 3072);
    assert.equal(recommendMemory({ totalMB: 32768, freeMB: 20000, modCount: 230, is64: true }).maxMB, 12288);
    assert.equal(recommendMemory({ totalMB: 16384, freeMB: 9000, modCount: 230, is64: true }).maxMB, 9728, "capped to 60% of RAM");
    assert.equal(recommendMemory({ totalMB: 8192, freeMB: 3000, modCount: 90, is64: true }).maxMB, 4864);
    assert.equal(recommendMemory({ totalMB: 32768, freeMB: 1, modCount: 300, is64: false }).maxMB, 1280);
  });
});

describe("natives", () => {
  it("extracts only native files, flattened, and reuses them when unchanged", async () => {
    const libsRoot = join(tmp, "libraries");
    const modern = await zipBuffer({ "windows/x64/org/lwjgl/lwjgl.dll": "dll-data", "windows/x64/org/lwjgl/lwjgl.dll.sha1": "x", "META-INF/MANIFEST.MF": "m" });
    const legacy = await zipBuffer({ "lwjgl64.dll": "old", "META-INF/sig.sf": "s", "notes.txt": "n" });
    await mkdir(join(libsRoot, "a"), { recursive: true });
    await writeFile(join(libsRoot, "a", "modern.jar"), modern);
    await writeFile(join(libsRoot, "a", "legacy.jar"), legacy);
    const libs = [
      { name: "m", path: "a/modern.jar", native: true, extractExclude: [], onClasspath: true, size: modern.length },
      { name: "l", path: "a/legacy.jar", native: true, extractExclude: ["META-INF/"], onClasspath: false, size: legacy.length },
    ];
    const dir = join(tmp, "natives");
    const first = await prepareNatives(libsRoot, libs, dir);
    assert.equal(first.reused, false);
    assert.deepEqual((await readdir(dir)).filter((f) => !f.startsWith(".")).sort(), ["lwjgl.dll", "lwjgl64.dll"]);
    assert.equal(await readFile(join(dir, "lwjgl.dll"), "utf8"), "dll-data");
    const second = await prepareNatives(libsRoot, libs, dir);
    assert.equal(second.reused, true);
    await assert.rejects(prepareNatives(libsRoot, [{ ...libs[0], path: "a/missing.jar" }], join(tmp, "n2")), /missing/);
  });
});

describe("asset index handling", () => {
  it("builds one item per unique object and materializes legacy trees", async () => {
    const router = new SourceRouter(() => DEFAULT_SOURCES);
    const index = { virtual: true, objects: { "a/x.ogg": { hash: "a".repeat(40), size: 3 }, "b/y.ogg": { hash: "a".repeat(40), size: 3 }, "c/z.ogg": { hash: "b".repeat(40), size: 4 }, bad: { hash: "zz", size: 1 } } };
    const items = assetObjectItems(tmp, index, router);
    assert.equal(items.length, 2);
    assert.ok(items[0].urls[0].includes("/assets/aa/" + "a".repeat(40)));
    assert.ok(items[0].urls.some((url) => url.startsWith("https://resources.download.minecraft.net/aa/")));

    await mkdir(join(tmp, "assets", "indexes"), { recursive: true });
    await writeFile(assetIndexPath(tmp, "legacy"), JSON.stringify({ virtual: true, objects: { "sounds/a.ogg": { hash: "a".repeat(40), size: 3 } } }));
    await mkdir(join(tmp, "assets", "objects", "aa"), { recursive: true });
    await writeFile(join(tmp, "assets", "objects", "aa", "a".repeat(40)), "abc");
    const out = await materializeLegacyAssets(tmp, "legacy", join(tmp, "game"));
    assert.equal(out.virtualDir, join(tmp, "assets", "virtual", "legacy"));
    assert.equal(await readFile(join(out.virtualDir!, "sounds", "a.ogg"), "utf8"), "abc");
  });
});

describe("vanilla install against a fake mirror", () => {
  let world: FakeWorld;
  const http = new HttpClient({ userAgent: "vitrine-test" });
  after(() => http.destroy());
  afterEach(async () => world?.close());

  function makeEnv(root: string, os: OsInfo = WIN): GameEnv {
    const settings: SourceSettings = { ...DEFAULT_SOURCES, policy: "mirror-only", mirrorBase: world.mirrorBase };
    const router = new SourceRouter(() => settings);
    const engine = new DownloadEngine(http, () => ({ ...DEFAULT_ENGINE, retries: 2, backoffBaseMs: 5, concurrency: 16 }));
    return { root, http, router, engine, log: nullLog, os };
  }

  it("installs a version end to end: manifest, json, jar, libraries, logging, assets", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 120 }]);
    const env = makeEnv(join(tmp, "mc"));
    const catalog = new VersionCatalog(http, env.router, join(tmp, "cache", "manifest.json"));
    const manifest = await catalog.list();
    assert.equal(manifest.versions[0].id, "1.20.1");
    assert.match(manifest.versions[0].url, /^https:\/\/piston-meta\.mojang\.com\/v1\/packages\//, "mirror urls are normalised back to the official form");

    const stages: string[] = [];
    const result = await installVanilla(env, catalog, { mcVersion: "1.20.1", name: "Survival", onStage: (s) => stages.push(s) });
    assert.deepEqual(stages, ["files", "assets"]);
    assert.equal(result.id, "Survival");
    const spec = world.versions.get("1.20.1")!;
    const root = env.root;
    const json = JSON.parse(await readFile(versionJsonPath(root, "Survival"), "utf8"));
    assert.equal(json.id, "Survival");
    assert.deepEqual(await readFile(join(versionDir(root, "Survival"), "Survival.jar")), spec.jar);
    for (const l of spec.libraries.filter((l) => !l.path.includes("natives-linux"))) assert.deepEqual(await readFile(join(librariesDir(root), l.path)), l.data, l.path);
    assert.ok(!(await readdir(join(librariesDir(root), "org/lwjgl/lwjgl/3.3.1"))).some((f) => f.includes("linux")), "libraries for other OSes are not downloaded");
    for (const asset of spec.assets) assert.deepEqual(await readFile(join(root, "assets", "objects", asset.hash.slice(0, 2), asset.hash)), asset.data);
    assert.ok((await stat(join(root, "assets", "log_configs", "client-1.12.xml"))).isFile());
    assert.ok((await stat(join(root, "assets", "indexes", "12.json"))).isFile());

    // Second pass downloads nothing.
    const before = world.server.stats.requests;
    const again = await completeVersion(env, "Survival");
    assert.equal(again.downloaded, 0);
    assert.equal(world.server.stats.requests, before);
    assert.ok(result.libraries.some((l) => l.native));
    assert.equal(again.missingLocal.length, 0);
  });

  it("repairs a corrupted library and a deleted asset", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 20 }]);
    const env = makeEnv(join(tmp, "mc"));
    const catalog = new VersionCatalog(http, env.router, join(tmp, "cache", "manifest.json"));
    await installVanilla(env, catalog, { mcVersion: "1.20.1" });
    const spec = world.versions.get("1.20.1")!;
    const victim = join(librariesDir(env.root), spec.libraries[0].path);
    const tampered = Buffer.from(spec.libraries[0].data);
    tampered[10] ^= 0xff;
    await writeFile(victim, tampered);
    const asset = spec.assets[3];
    await rm(join(env.root, "assets", "objects", asset.hash.slice(0, 2), asset.hash));
    const quick = await completeVersion(env, "1.20.1");
    assert.equal(quick.downloaded, 1, "a size check only notices the missing asset");
    const full = await completeVersion(env, "1.20.1", { verify: "hash" });
    assert.equal(full.downloaded, 1, "a hash pass notices the tampered library");
    assert.deepEqual(await readFile(victim), spec.libraries[0].data);
  });

  it("copies the parent jar for an inheriting profile instead of downloading it", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 5 }]);
    const env = makeEnv(join(tmp, "mc"));
    const catalog = new VersionCatalog(http, env.router, join(tmp, "cache", "manifest.json"));
    await installVanilla(env, catalog, { mcVersion: "1.20.1" });
    await mkdir(versionDir(env.root, "Modded"), { recursive: true });
    await writeFile(versionJsonPath(env.root, "Modded"), JSON.stringify({ id: "Modded", inheritsFrom: "1.20.1", mainClass: "m.Main", libraries: [] }));
    const before = world.hits["v1"] ?? 0;
    await completeVersion(env, "Modded");
    assert.deepEqual(await readFile(join(versionDir(env.root, "Modded"), "Modded.jar")), world.versions.get("1.20.1")!.jar);
    assert.equal(world.hits["v1"] ?? 0, before, "no client jar download");
  });

  it("falls back to the cached manifest when every source fails", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 1 }]);
    const env = makeEnv(join(tmp, "mc"));
    const cache = join(tmp, "cache", "manifest.json");
    const first = new VersionCatalog(http, env.router, cache);
    await first.list();
    await world.close();
    const second = new VersionCatalog(http, env.router, cache);
    const manifest = await second.list({ force: true });
    assert.equal(manifest.versions[0].id, "1.20.1");
    const third = new VersionCatalog(http, env.router, join(tmp, "nothing.json"));
    await assert.rejects(third.list({ force: true }), /Cannot load the Minecraft version list/);
    world = undefined as unknown as FakeWorld;
  });
});

describe("launching a fake game with a real JVM", () => {
  const http = new HttpClient({ userAgent: "vitrine-test" });
  after(() => http.destroy());
  let world: FakeWorld | undefined;
  afterEach(async () => world?.close());

  async function buildFakeGameJar(): Promise<Buffer> {
    const src = join(tmp, "fake-src");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "FakeMain.java"),
      `public class FakeMain {
  public static void main(String[] a) throws Exception {
    System.out.println("Backend library: LWJGL version 3.3.3");
    System.out.println("ARGS=" + String.join("|", a));
    System.out.println("LIBPATH=" + System.getProperty("java.library.path"));
    System.out.println("CP=" + System.getProperty("java.class.path"));
    System.out.println("ENC=" + System.getProperty("file.encoding"));
    System.out.println("BRAND=" + System.getProperty("minecraft.launcher.brand"));
    System.out.println("中文测试");
    System.err.println("an error line");
    if (java.util.Arrays.asList(a).contains("crash-me")) System.exit(3);
  }
}
`,
    );
    execFileSync("javac", ["-encoding", "UTF-8", "-d", src, join(src, "FakeMain.java")], { stdio: "pipe" });
    const jar = join(tmp, "fake.jar");
    execFileSync("jar", ["cf", jar, "-C", src, "FakeMain.class"], { stdio: "pipe" });
    return readFile(jar);
  }

  it("launches, streams output, detects the window and reports exit codes", async () => {
    const clientJar = await buildFakeGameJar();
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 3, clientJar, mainClass: "FakeMain" }]);
    const os = currentOs();
    const settings: SourceSettings = { ...DEFAULT_SOURCES, policy: "mirror-only", mirrorBase: world.mirrorBase };
    const router = new SourceRouter(() => settings);
    const engine = new DownloadEngine(http, () => ({ ...DEFAULT_ENGINE, backoffBaseMs: 5 }));
    const env: GameEnv = { root: join(tmp, "mc"), http, router, engine, log: nullLog, os };
    const catalog = new VersionCatalog(http, router, join(tmp, "m.json"));
    await installVanilla(env, catalog, { mcVersion: "1.20.1", name: "fake" });
    const { version, libraries } = await completeVersion(env, "fake");

    const nativesDir = join(versionDir(env.root, "fake"), "natives");
    const natives = await prepareNatives(librariesDir(env.root), libraries, nativesDir);
    assert.equal(natives.reused, false);

    const gameDir = join(tmp, "game dir with spaces");
    await mkdir(gameDir, { recursive: true });
    const built = buildLaunch(
      {
        root: env.root,
        gameDir,
        version,
        account: { name: "Wind", uuid: "00112233-4455-4677-8899-aabbccddeeff", accessToken: "tok", userType: "legacy" },
        javaMajor: 21,
        memoryMaxMB: 256,
        nativesDir,
        os,
        gameArgs: ["crash-me"],
      },
      { os, features: {} },
      libraries,
    );
    const java = "java";
    const game = await spawnGame({ javaPath: java, args: built.args, cwd: gameDir, os, javaMajor: 21 });
    const states: string[] = [];
    game.on("state", (s) => states.push(s));
    const exit = await game.waitForExit();
    assert.equal(exit.code, 3);
    const text = game.lines.map((l) => l.text).join("\n");
    assert.match(text, /ARGS=--username\|Wind\|--version\|fake\|--gameDir\|.*game dir with spaces/);
    assert.match(text, /--uuid\|00112233445546778899aabbccddeeff/);
    assert.ok(text.includes(`LIBPATH=${nativesDir}`));
    assert.match(text, /CP=.*fake\.jar/);
    assert.match(text, /ENC=UTF-8/);
    assert.match(text, /BRAND=Vitrine/);
    assert.match(text, /中文测试/);
    assert.ok(game.lines.some((l) => l.stream === "stderr" && l.text === "an error line"));
    assert.ok(states.includes("exited"));
    assert.equal(game.state, "exited");
    assert.ok(game.playTimeMs >= 0);
    assert.ok(game.lines.length >= 7);
  });
});

describe("java detection", () => {
  async function fakeHome(dir: string, release: string | undefined, jdk = false) {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "java"), "#!/bin/sh\necho 'openjdk version \"17.0.1\"' >&2\n", { mode: 0o755 });
    if (jdk) await writeFile(join(dir, "bin", "javac"), "", { mode: 0o755 });
    if (release) await writeFile(join(dir, "release"), release);
  }

  it("reads the release file without spawning java", async () => {
    await fakeHome(join(tmp, "jdk-17"), 'JAVA_VERSION="17.0.9"\nIMPLEMENTOR="Eclipse Adoptium"\nOS_ARCH="x86_64"\nIMAGE_TYPE="JDK"\n', true);
    const java = await inspectJava(join(tmp, "jdk-17"), "common", { os: LINUX, runJava: async () => assert.fail("must not run java") });
    assert.equal(java?.major, 17);
    assert.equal(java?.vendor, "Eclipse Adoptium");
    assert.equal(java?.arch, "x64");
    assert.equal(java?.isJdk, true);
    assert.equal(java?.is64, true);
  });

  it("falls back to java -version and parses legacy version strings", async () => {
    await fakeHome(join(tmp, "jre8"), undefined);
    const java = await inspectJava(join(tmp, "jre8", "bin", "java"), "path", {
      os: LINUX,
      runJava: async () => ({ stdout: "", stderr: 'Picked up JAVA_TOOL_OPTIONS: -Dx=y\njava version "1.8.0_392"\nJava(TM) SE Runtime Environment\nJava HotSpot(TM) 64-Bit Server VM (build 25.392-b08, mixed mode)\n' }),
    });
    assert.equal(java?.major, 8);
    assert.equal(java?.version, "1.8.0_392");
    assert.equal(java?.is64, true);
    assert.equal(java?.isJdk, false);
  });

  it("scans directories, de-duplicates and sorts", async () => {
    await fakeHome(join(tmp, "jvm", "jdk-21"), 'JAVA_VERSION="21.0.2"\nOS_ARCH="x86_64"\n', true);
    await fakeHome(join(tmp, "jvm", "jdk-8"), 'JAVA_VERSION="1.8.0_402"\nOS_ARCH="x86_64"\n');
    await mkdir(join(tmp, "jvm", "not-java"), { recursive: true });
    const found = await detectJava({
      os: LINUX,
      env: { HOME: join(tmp, "home"), JAVA_HOME: join(tmp, "jvm", "jdk-21"), PATH: "" },
      extraDirs: [{ dir: join(tmp, "jvm"), source: "custom" }],
      quick: true,
    });
    const mine = found.filter((j) => j.home.startsWith(tmp));
    assert.deepEqual(mine.map((j) => j.major), [21, 8]);
    assert.equal(mine[0].source, "custom", "the best-ranked source wins for a duplicate");
  });

  it("detects the real JDK of this machine", async () => {
    const found = await detectJava({ quick: false });
    assert.ok(found.some((j) => j.major >= 17), JSON.stringify(found));
  });

  it("parses registry output", () => {
    const text = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\JavaSoft\\JDK\\17.0.9
    JavaHome    REG_SZ    C:\\Program Files\\Java\\jdk-17
    MicroVersion    REG_DWORD    0x9
HKEY_LOCAL_MACHINE\\SOFTWARE\\Eclipse Adoptium\\JDK\\21.0.1.12\\hotspot\\MSI
    Path    REG_SZ    C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.1.12-hotspot\\
`;
    assert.deepEqual(parseRegistryHomes(text), ["C:\\Program Files\\Java\\jdk-17", "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.1.12-hotspot\\"]);
  });

  const mk = (major: number, extra: Partial<JavaInstall> = {}): JavaInstall => ({ path: `/j${major}`, home: `/j${major}`, version: `${major}.0.1`, major, arch: "x64", is64: true, isJdk: true, source: "common", ...extra });

  it("picks the closest suitable Java and honours upper bounds", () => {
    const all = [mk(21), mk(17), mk(8), mk(11, { is64: false, arch: "x86" })];
    assert.equal(pickJava(all, { min: 17 })?.major, 17);
    assert.equal(pickJava(all, { min: 8, max: 8 })?.major, 8);
    assert.equal(pickJava(all, { min: 21 })?.major, 21);
    assert.equal(pickJava([mk(17)], { min: 21 }), undefined);
    assert.equal(pickJava([mk(8, { is64: false, arch: "x86" }), mk(8)], { min: 8 })?.is64, true);
    assert.equal(pickJava([mk(17, { source: "common" }), mk(17, { source: "custom", path: "/mine" })], { min: 17 })?.path, "/mine");
  });

  it("derives requirements for legacy loaders", () => {
    assert.deepEqual(javaRequirement({ declared: 8, fallback: 8, loaders: [{ kind: "forge" }], mcVersion: "1.12.2" }), { min: 8, max: 8 });
    assert.deepEqual(javaRequirement({ declared: 8, fallback: 8, loaders: [{ kind: "forge" }], mcVersion: "1.16.5" }), { min: 8, max: 15 });
    assert.deepEqual(javaRequirement({ declared: 17, fallback: 17, loaders: [{ kind: "forge" }], mcVersion: "1.20.1" }), { min: 17, max: undefined });
    assert.deepEqual(javaRequirement({ declared: 8, fallback: 8, loaders: [{ kind: "fabric" }], mcVersion: "1.12.2" }), { min: 8, max: undefined });
    assert.deepEqual(javaRequirement({ fallback: 21, loaders: [], mcVersion: "1.21.1" }), { min: 21, max: undefined });
  });
});

describe("instance store", () => {
  async function seed(root: string, id: string, json: Record<string, unknown>) {
    await mkdir(versionDir(root, id), { recursive: true });
    await writeFile(versionJsonPath(root, id), JSON.stringify({ id, ...json }));
  }

  it("lists instances with loaders, isolation and config", async () => {
    const root = join(tmp, "mc");
    await seed(root, "1.21.1", { type: "release", mainClass: "m", javaVersion: { component: "c", majorVersion: 21 } });
    await seed(root, "Create Pack", { inheritsFrom: "1.21.1", mainClass: "m", libraries: [{ name: "net.neoforged:neoforge:21.1.77" }] });
    await seed(root, "broken", { inheritsFrom: "9.9.9", mainClass: "m" });
    const store = new InstanceStore(root);
    const list = await store.list();
    const byId = Object.fromEntries(list.map((i) => [i.id, i]));
    assert.equal(byId["1.21.1"].valid, true);
    assert.equal(byId["1.21.1"].isolated, true, "every instance gets its own game folder");
    assert.equal(byId["1.21.1"].gameDir, versionDir(root, "1.21.1"));
    assert.equal(byId["1.21.1"].mcVersion, "1.21.1");
    assert.equal(byId["Create Pack"].isolated, true, "modded instances are isolated by default");
    assert.deepEqual(byId["Create Pack"].loaders, [{ kind: "neoforge", version: "21.1.77" }]);
    assert.equal(byId["Create Pack"].mcVersion, "1.21.1");
    assert.equal(byId["Create Pack"].javaMajor, 21);
    assert.equal(byId["broken"].valid, false);
    assert.match(byId["broken"].problem!, /9\.9\.9/);

    await store.saveConfig("1.21.1", { isolation: "on", displayName: "原版 1.21.1", memory: 4096 });
    const updated = await store.get("1.21.1");
    assert.equal(updated?.isolated, true);
    assert.equal(updated?.name, "原版 1.21.1");
    assert.equal(updated?.config.memory, 4096);
    assert.equal(updated?.gameDir, versionDir(root, "1.21.1"));
  });

  it("copies old shared saves into the instance when switching to full isolation", async () => {
    const root = join(tmp, "mc");
    await seed(root, "1.21.1", { type: "release", mainClass: "m", javaVersion: { component: "c", majorVersion: 21 } });
    await mkdir(join(root, "saves", "Shared World"), { recursive: true });
    await writeFile(join(root, "saves", "Shared World", "level.dat"), "world-data");
    const store = new InstanceStore(root);
    const info = await store.get("1.21.1");
    assert.equal(info?.isolated, true);
    assert.equal(info?.gameDir, versionDir(root, "1.21.1"));
    assert.equal(await readFile(join(versionDir(root, "1.21.1"), "saves", "Shared World", "level.dat"), "utf8"), "world-data");
  });

  it("renames, duplicates and removes", async () => {
    const root = join(tmp, "mc");
    await seed(root, "a", { mainClass: "m" });
    await writeFile(join(versionDir(root, "a"), "a.jar"), "jar");
    await mkdir(join(versionDir(root, "a"), "mods"), { recursive: true });
    await writeFile(join(versionDir(root, "a"), "mods", "x.jar"), "mod");
    const store = new InstanceStore(root);
    await store.duplicate("a", "b");
    assert.equal(await readFile(join(versionDir(root, "b"), "mods", "x.jar"), "utf8"), "mod");
    assert.equal(JSON.parse(await readFile(versionJsonPath(root, "b"), "utf8")).id, "b");
    await store.rename("b", "c");
    assert.equal((await store.get("c"))?.id, "c");
    assert.equal(await store.get("b"), undefined);
    await assert.rejects(store.rename("c", "a"), /已存在/);
    await store.remove("c");
    assert.equal(await store.exists("c"), false);
  });

  it("validates names", () => {
    assert.ok(validateInstanceName(""));
    assert.ok(validateInstanceName("a/b"));
    assert.ok(validateInstanceName("CON"));
    assert.ok(validateInstanceName("trailing."));
    assert.equal(validateInstanceName("机械动力 1.21.1"), undefined);
    assert.equal(uniqueName("Pack", ["pack", "Pack (2)"]), "Pack (3)");
    assert.equal(uniqueName("a:b", []), "a_b");
  });
});
