import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENGINE, DownloadEngine } from "../src/net/download";
import { HttpClient } from "../src/net/http";
import { DEFAULT_SOURCES, SourceRouter, type SourceSettings } from "../src/net/sources";
import { nullLog } from "../src/util/log";
import { currentOs } from "../src/util/os";
import { sha1, bytes, serveBytes } from "./helpers/mock-server";
import { startFakeMojang, zipBuffer, type FakeWorld } from "./helpers/fake-mojang";
import { PROC_SOURCE, compileJava, manifestFor } from "./helpers/java";
import type { GameEnv } from "../src/mc/files";
import { InstanceStore } from "../src/mc/instances";
import { VersionCatalog } from "../src/mc/manifest";
import { librariesDir, resolveVersion, versionDir, versionJarPath, versionJsonPath } from "../src/mc/version-json";
import { clearMetaCache, listForge, listNeoForge, listFabricLike, listOptiFine, mcVersionOfNeoForge, parseForgeVersion, parseMavenMetadata, type MetaDeps } from "../src/loaders/meta";
import { installInstance, type InstallDeps } from "../src/loaders/install";
import type { VersionJson } from "../src/mc/types";

const http = new HttpClient({ userAgent: "vitrine-test" });
after(() => http.destroy());

let tmp: string;
let world: FakeWorld | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-ld-"));
  clearMetaCache();
});
afterEach(async () => {
  await world?.close();
  world = undefined;
  delete process.env.PROC_LOG;
  await rm(tmp, { recursive: true, force: true });
});

function setup(w: FakeWorld) {
  const settings: SourceSettings = { ...DEFAULT_SOURCES, policy: "mirror-only", mirrorBase: w.mirrorBase };
  const router = new SourceRouter(() => settings);
  const engine = new DownloadEngine(http, () => ({ ...DEFAULT_ENGINE, retries: 2, backoffBaseMs: 5, concurrency: 16 }));
  const env: GameEnv = { root: join(tmp, "mc"), http, router, engine, log: nullLog, os: currentOs() };
  const catalog = new VersionCatalog(http, router, join(tmp, "manifest.json"));
  const meta: MetaDeps = { http, router, mirrorBase: () => w.mirrorBase };
  const instances = new InstanceStore(env.root);
  const stages: string[] = [];
  const deps: InstallDeps = {
    env,
    catalog,
    meta,
    instances,
    ensureJava: async () => ({ path: "java", major: 21 }),
    workDir: join(tmp, "work"),
    mirrorBase: () => w.mirrorBase,
  };
  return { env, catalog, meta, instances, deps, stages, hooks: { stage: (s: string, d?: string) => stages.push(d ? `${s}:${d}` : s) } };
}

describe("loader metadata", () => {
  it("parses maven metadata and version strings", () => {
    const xml = `<metadata><versioning><versions><version>1.20.1-47.2.0</version><version>1.7.10-10.13.4.1614-1.7.10</version><version>junk</version></versions></versioning></metadata>`;
    assert.deepEqual(parseMavenMetadata(xml), ["1.20.1-47.2.0", "1.7.10-10.13.4.1614-1.7.10", "junk"]);
    assert.deepEqual(parseForgeVersion("1.20.1-47.2.0"), { mcVersion: "1.20.1", version: "47.2.0" });
    assert.deepEqual(parseForgeVersion("1.7.10-10.13.4.1614-1.7.10"), { mcVersion: "1.7.10", version: "10.13.4.1614" });
    assert.equal(parseForgeVersion("junk"), undefined);
    assert.equal(mcVersionOfNeoForge("21.1.77"), "1.21.1");
    assert.equal(mcVersionOfNeoForge("21.0.5-beta"), "1.21");
    assert.equal(mcVersionOfNeoForge("20.4.237"), "1.20.4");
    assert.equal(mcVersionOfNeoForge("nope"), undefined);
  });

  it("lists loader versions through the mirror, newest first", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 1 }]);
    world.add("/maven/net/minecraftforge/forge/maven-metadata.xml", `<metadata><versioning><versions><version>1.20.1-47.1.0</version><version>1.20.1-47.2.0</version><version>1.19.4-45.0.1</version></versions></versioning></metadata>`);
    world.add("/maven/net/neoforged/neoforge/maven-metadata.xml", `<metadata><versioning><versions><version>21.1.5</version><version>21.1.77</version><version>20.4.2</version></versions></versioning></metadata>`);
    world.add("/maven/net/neoforged/forge/maven-metadata.xml", `<metadata><versioning><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>`);
    world.add("/fabric-meta/v2/versions/loader/1.20.1", JSON.stringify([{ loader: { version: "0.15.9", stable: true } }, { loader: { version: "0.15.11", stable: true } }, { loader: { version: "0.16.0-beta.1", stable: false } }]));
    world.add("/optifine/1.20.1", JSON.stringify([{ mcversion: "1.20.1", patch: "I5", type: "HD_U", filename: "OptiFine_1.20.1_HD_U_I5.jar" }, { mcversion: "1.20.1", patch: "I6", type: "HD_U", filename: "OptiFine_1.20.1_HD_U_I6.jar", forge: "Forge 47.0.1 or later" }]));
    const { meta } = setup(world);
    const forge = await listForge(meta, "1.20.1");
    assert.deepEqual(forge.map((v) => v.version), ["47.2.0", "47.1.0"]);
    assert.equal(forge[0].raw, "1.20.1-47.2.0");
    const neo = await listNeoForge(meta, "1.21.1");
    assert.deepEqual(neo.map((v) => v.version), ["21.1.77", "21.1.5"]);
    const neo120 = await listNeoForge(meta, "1.20.1");
    assert.equal(neo120[0].meta?.artifact, "forge");
    const fabric = await listFabricLike(meta, "fabric", "1.20.1");
    assert.deepEqual(fabric.map((v) => v.version), ["0.16.0-beta.1", "0.15.11", "0.15.9"]);
    assert.equal(fabric[0].stable, false);
    const of = await listOptiFine(meta, "1.20.1");
    assert.deepEqual(of.map((v) => v.version), ["HD_U_I6", "HD_U_I5"]);
  });
});

describe("Fabric and vanilla instances", () => {
  it("installs a Fabric instance with a merged, self-contained version JSON", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 10 }]);
    const loaderJar = await zipBuffer({ "fabric.mod.json": "{}" });
    const intermediary = await zipBuffer({ "mappings/mappings.tiny": "x" });
    world.add("/maven/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar", loaderJar);
    world.add("/maven/net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar", intermediary);
    const profile: VersionJson = {
      id: "fabric-loader-0.15.11-1.20.1",
      inheritsFrom: "1.20.1",
      type: "release",
      mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
      arguments: { game: [], jvm: ["-DFabricMcEmu= net.minecraft.client.main.Main "] },
      libraries: [
        { name: "net.fabricmc:fabric-loader:0.15.11", url: "https://maven.fabricmc.net/", sha1: sha1(loaderJar), size: loaderJar.length },
        { name: "net.fabricmc:intermediary:1.20.1", url: "https://maven.fabricmc.net/", sha1: sha1(intermediary), size: intermediary.length },
      ],
    };
    world.add("/fabric-meta/v2/versions/loader/1.20.1/0.15.11/profile/json", JSON.stringify(profile));
    const { deps, env, stages, hooks, instances } = setup(world);
    const result = await installInstance(deps, { name: "Fabric 1.20.1", mcVersion: "1.20.1", loader: { kind: "fabric", version: "0.15.11" }, hooks });
    assert.equal(result.id, "Fabric 1.20.1");
    assert.deepEqual(stages.filter((s) => !s.includes(":")), ["version-json", "client-jar", "loader-meta", "files", "libraries", "assets"]);

    const json = JSON.parse(await readFile(versionJsonPath(env.root, "Fabric 1.20.1"), "utf8"));
    assert.equal(json.id, "Fabric 1.20.1");
    assert.equal(json.inheritsFrom, undefined, "merged JSON is self-contained");
    assert.equal(json.mainClass, "net.fabricmc.loader.impl.launch.knot.KnotClient");
    assert.ok(json.libraries.some((l: { name: string }) => l.name === "org.lwjgl:lwjgl:3.3.1"), "vanilla libraries are merged in");
    assert.deepEqual(await readFile(join(librariesDir(env.root), "net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar")), loaderJar);
    assert.deepEqual(await readFile(versionJarPath(env.root, "Fabric 1.20.1")), world.versions.get("1.20.1")!.jar);
    const info = await instances.get("Fabric 1.20.1");
    assert.deepEqual(info?.loaders, [{ kind: "fabric", version: "0.15.11" }]);
    assert.equal(info?.mcVersion, "1.20.1");
    assert.equal(info?.isolated, true);
    assert.equal(info?.config.installed?.loader?.kind, "fabric");
    assert.equal(info?.valid, true);
  });

  it("removes the instance folder when the install fails", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 2 }]);
    const { deps, env, instances } = setup(world);
    await assert.rejects(installInstance(deps, { name: "Broken", mcVersion: "1.20.1", loader: { kind: "fabric", version: "9.9.9" } }));
    assert.equal(await instances.exists("Broken"), false);
    await assert.rejects(stat(versionDir(env.root, "Broken")));
  });

  it("installs plain vanilla under a custom name and refuses duplicates", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 3 }]);
    const { deps, env } = setup(world);
    await installInstance(deps, { name: "My Survival", mcVersion: "1.20.1" });
    assert.deepEqual(await readFile(versionJarPath(env.root, "My Survival")), world.versions.get("1.20.1")!.jar);
    await assert.rejects(installInstance(deps, { name: "My Survival", mcVersion: "1.20.1" }), /已存在/);
    await assert.rejects(installInstance(deps, { name: "bad/name", mcVersion: "1.20.1" }), /不能包含/);
    await assert.rejects(installInstance(deps, { name: "Nope", mcVersion: "0.0" }), /not in the official version list/);
  });
});

describe("Forge-style installer pipeline (real Java processors)", () => {
  const VERSION = "1.20.1-47.2.0";
  const FORGE_PATH = `net/minecraftforge/forge/${VERSION}`;

  async function buildModernInstaller(options: { failingProcessor?: boolean; withFakeInstaller?: boolean } = {}) {
    const sources: Record<string, string> = { "Proc.java": PROC_SOURCE };
    if (options.withFakeInstaller) {
      sources["FakeInstaller.java"] = `
import java.nio.file.*;
public class FakeInstaller {
  public static void main(String[] a) throws Exception {
    if (a.length < 2 || !a[0].equals("--installClient")) System.exit(4);
    Path dir = Paths.get(a[1]);
    Path ver = dir.resolve("versions/${VERSION.replace("1.20.1-", "1.20.1-forge-")}");
    Files.createDirectories(ver);
    String json = "{\\"id\\":\\"1.20.1-forge-47.2.0\\",\\"inheritsFrom\\":\\"1.20.1\\",\\"mainClass\\":\\"cpw.mods.bootstraplauncher.BootstrapLauncher\\",\\"libraries\\":[{\\"name\\":\\"net.minecraftforge:forge:${VERSION}:client\\",\\"downloads\\":{\\"artifact\\":{\\"path\\":\\"${FORGE_PATH}/forge-${VERSION}-client.jar\\",\\"url\\":\\"\\"}}}],\\"arguments\\":{\\"game\\":[\\"--launchTarget\\",\\"forgeclient\\"],\\"jvm\\":[\\"-DignoreList=x,\${version_name}.jar\\"]}}";
    Files.write(ver.resolve("1.20.1-forge-47.2.0.json"), json.getBytes("UTF-8"));
    Path lib = dir.resolve("libraries/${FORGE_PATH}/forge-${VERSION}-client.jar");
    Files.createDirectories(lib.getParent());
    Files.write(lib, "official-client".getBytes("UTF-8"));
    System.out.println("official installer done");
  }
}
`;
    }
    const classes = await compileJava(tmp, sources);
    const procJar = await zipBuffer({ "Proc.class": classes["Proc.class"], "META-INF/MANIFEST.MF": manifestFor("Proc") });
    const binpatch = bytes(777, 21);
    const universal = await zipBuffer({ "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n", "marker.txt": "universal" });
    const procCoord = "net.minecraftforge:fakeproc:1.0";
    const patchedPath = `[net.minecraftforge:forge:${VERSION}:client]`;
    const profile = {
      spec: 1,
      profile: "forge",
      version: `1.20.1-forge-47.2.0`,
      json: "/version.json",
      path: `net.minecraftforge:forge:${VERSION}`,
      minecraft: "1.20.1",
      data: {
        BINPATCH: { client: "/data/client.lzma", server: "/data/server.lzma" },
        MOJMAPS: { client: "[net.minecraft:client:1.20.1-20230612.114412:mappings@txt]", server: "[net.minecraft:server:1.20.1-20230612.114412:mappings@txt]" },
        PATCHED: { client: patchedPath, server: `[net.minecraftforge:forge:${VERSION}:server]` },
        MCP_VERSION: { client: "'20230612.114412'", server: "'20230612.114412'" },
      },
      processors: [
        { sides: ["server"], jar: procCoord, classpath: [procCoord], args: ["--task", "SERVER_ONLY"] },
        { jar: procCoord, classpath: [procCoord], args: ["--task", "DOWNLOAD_MOJMAPS", "--version", "1.20.1", "--side", "client", "--output", "{MOJMAPS}"] },
        ...(options.failingProcessor ? [{ jar: procCoord, classpath: [procCoord], args: ["--task", "FAIL"] }] : []),
        {
          jar: procCoord,
          classpath: [procCoord],
          args: ["--task", "PATCH", "--in", "{MINECRAFT_JAR}", "--patch", "{BINPATCH}", "--out", "{PATCHED}", "--mcp", "{MCP_VERSION}"],
          outputs: { "{PATCHED}": `'${sha1(Buffer.concat([world!.versions.get("1.20.1")!.jar, binpatch]))}'` },
        },
      ],
      libraries: [
        { name: procCoord, downloads: { artifact: { path: "net/minecraftforge/fakeproc/1.0/fakeproc-1.0.jar", url: "https://maven.minecraftforge.net/net/minecraftforge/fakeproc/1.0/fakeproc-1.0.jar", sha1: sha1(procJar), size: procJar.length } } },
      ],
    };
    const versionJson = {
      id: "1.20.1-forge-47.2.0",
      inheritsFrom: "1.20.1",
      type: "release",
      mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
      libraries: [
        { name: `net.minecraftforge:forge:${VERSION}:universal`, downloads: { artifact: { path: `${FORGE_PATH}/forge-${VERSION}-universal.jar`, url: "", sha1: sha1(universal), size: universal.length } } },
        { name: `net.minecraftforge:forge:${VERSION}:client`, downloads: { artifact: { path: `${FORGE_PATH}/forge-${VERSION}-client.jar`, url: "" } } },
      ],
      arguments: { game: ["--launchTarget", "forgeclient", "--fml.mcVersion", "1.20.1", "--fml.forgeVersion", "47.2.0"], jvm: ["-DignoreList=bootstraplauncher,${version_name}.jar", "-DlibraryDirectory=${library_directory}"] },
    };
    const files: Record<string, Buffer | string> = {
      "install_profile.json": JSON.stringify(profile),
      "version.json": JSON.stringify(versionJson),
      "data/client.lzma": binpatch,
      [`maven/${FORGE_PATH}/forge-${VERSION}-universal.jar`]: universal,
      "META-INF/MANIFEST.MF": manifestFor(options.withFakeInstaller ? "FakeInstaller" : undefined),
    };
    if (options.withFakeInstaller) files["FakeInstaller.class"] = classes["FakeInstaller.class"];
    const installer = await zipBuffer(files);
    world!.add(`/maven/net/minecraftforge/fakeproc/1.0/fakeproc-1.0.jar`, procJar);
    world!.add(`/maven/${FORGE_PATH}/forge-${VERSION}-installer.jar`, installer);
    world!.add(
      "/maven/net/minecraftforge/forge/maven-metadata.xml",
      `<metadata><versioning><versions><version>${VERSION}</version></versions></versioning></metadata>`,
    );
    return { binpatch, universal };
  }

  it("runs client processors, skips server ones, pre-seeds mappings and writes the patched jar", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 4 }]);
    const { binpatch, universal } = await buildModernInstaller();
    const { deps, env, stages, hooks, instances } = setup(world);
    process.env.PROC_LOG = join(tmp, "proc.log");
    const result = await installInstance(deps, { name: "Forge Test", mcVersion: "1.20.1", loader: { kind: "forge", version: "47.2.0", raw: VERSION }, hooks });
    assert.equal(result.id, "Forge Test");

    const patched = await readFile(join(librariesDir(env.root), FORGE_PATH, `forge-${VERSION}-client.jar`));
    assert.deepEqual(patched, Buffer.concat([world.versions.get("1.20.1")!.jar, binpatch]));
    assert.deepEqual(await readFile(join(librariesDir(env.root), FORGE_PATH, `forge-${VERSION}-universal.jar`)), universal);

    const log = (await readFile(process.env.PROC_LOG, "utf8")).trim().split("\n");
    assert.deepEqual(log.map((line) => line.split(" ")[0]), ["DOWNLOAD_MOJMAPS", "PATCH"], "server-side processor is skipped");
    assert.ok(stages.some((s) => s.startsWith("processors:2/2")), stages.join(","));

    const mappings = join(librariesDir(env.root), "net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-mappings.txt");
    assert.match(await readFile(mappings, "utf8"), /mappings for 1\.20\.1/, "mojmaps were pre-seeded from the mirror");

    const json = JSON.parse(await readFile(versionJsonPath(env.root, "Forge Test"), "utf8"));
    assert.equal(json.inheritsFrom, undefined);
    assert.equal(json.mainClass, "cpw.mods.bootstraplauncher.BootstrapLauncher");
    assert.ok(json.arguments.jvm.includes("-DignoreList=bootstraplauncher,${version_name}.jar"));
    assert.equal(json.javaVersion.majorVersion, 17, "vanilla's Java requirement is inherited");
    const info = await instances.get("Forge Test");
    assert.deepEqual(info?.loaders, [{ kind: "forge", version: "47.2.0" }]);
    assert.equal(info?.mcVersion, "1.20.1");
    const resolved = await resolveVersion(env.root, "Forge Test");
    assert.equal(resolved.chain.length, 1);

    // Running the processors again finds valid outputs and skips them.
    const { installFromInstaller } = await import("../src/loaders/forge-installer");
    const again = await installFromInstaller({
      env,
      installerJar: join(tmp, "work", `forge-${VERSION}-installer.jar`),
      mcVersion: "1.20.1",
      minecraftJar: versionJarPath(env.root, "Forge Test"),
      vanilla: world.versions.get("1.20.1")!.json as unknown as VersionJson,
      javaPath: "java",
      ruleCtx: { os: env.os!, features: {} },
    });
    assert.equal(again.method, "processors");
    const log2 = (await readFile(process.env.PROC_LOG, "utf8")).trim().split("\n");
    assert.deepEqual(log2.map((line) => line.split(" ")[0]), ["DOWNLOAD_MOJMAPS", "PATCH", "DOWNLOAD_MOJMAPS"], "the patch step is skipped because its output is already valid");
  });

  it("falls back to the official installer when a processor fails", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 2 }]);
    await buildModernInstaller({ failingProcessor: true, withFakeInstaller: true });
    const { deps, env } = setup(world);
    const warnings: string[] = [];
    env.log = { ...nullLog, warn: (m) => warnings.push(m) };
    await installInstance(deps, { name: "Fallback", mcVersion: "1.20.1", loader: { kind: "forge", version: "47.2.0", raw: VERSION } });
    assert.ok(warnings.some((w) => /trying the official installer/.test(w)));
    assert.equal(await readFile(join(librariesDir(env.root), FORGE_PATH, `forge-${VERSION}-client.jar`), "utf8"), "official-client");
    const json = JSON.parse(await readFile(versionJsonPath(env.root, "Fallback"), "utf8"));
    assert.equal(json.id, "Fallback");
    assert.equal(json.mainClass, "cpw.mods.bootstraplauncher.BootstrapLauncher");
  });

  it("reports the processor output when fallback is disabled", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 2 }]);
    await buildModernInstaller({ failingProcessor: true });
    const { deps, instances } = setup(world);
    await assert.rejects(
      installInstance(deps, { name: "NoFallback", mcVersion: "1.20.1", loader: { kind: "forge", version: "47.2.0", raw: VERSION }, officialFallback: false }),
      /failed with exit code 1[\s\S]*boom/,
    );
    assert.equal(await instances.exists("NoFallback"), false);
  });

  it("installs a legacy (v0) Forge installer and filters server-only libraries", async () => {
    world = await startFakeMojang([{ id: "1.12.2", assetCount: 2, legacy: true, javaMajor: 8 }]);
    const universal = await zipBuffer({ "cpw/mods/fml/Marker.class": "x" });
    const lib = await zipBuffer({ "a.txt": "lib" });
    world.add("/maven/com/typesafe/akka/akka-actor_2.11/2.3.3/akka-actor_2.11-2.3.3.jar", lib);
    const profile = {
      install: { profileName: "Forge", target: "1.12.2-forge1.12.2-14.23.5.2860", path: "net.minecraftforge:forge:1.12.2-14.23.5.2860", version: "1.12.2-forge1.12.2-14.23.5.2860", filePath: "forge-1.12.2-14.23.5.2860-universal.jar", minecraft: "1.12.2" },
      versionInfo: {
        id: "1.12.2-forge1.12.2-14.23.5.2860",
        inheritsFrom: "1.12.2",
        type: "release",
        mainClass: "net.minecraft.launchwrapper.Launch",
        minecraftArguments: "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker",
        libraries: [
          { name: "net.minecraftforge:forge:1.12.2-14.23.5.2860" },
          { name: "com.typesafe.akka:akka-actor_2.11:2.3.3", url: "https://files.minecraftforge.net/maven/", clientreq: true },
          { name: "org.example:server-only:1.0", serverreq: true, clientreq: false },
        ],
      },
    };
    const installer = await zipBuffer({ "install_profile.json": JSON.stringify(profile), "forge-1.12.2-14.23.5.2860-universal.jar": universal });
    world.add("/maven/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar", installer);
    const { deps, env, instances } = setup(world);
    await installInstance(deps, { name: "Forge 1.12.2", mcVersion: "1.12.2", loader: { kind: "forge", version: "14.23.5.2860", raw: "1.12.2-14.23.5.2860" } });
    assert.deepEqual(await readFile(join(librariesDir(env.root), "net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860.jar")), universal);
    assert.deepEqual(await readFile(join(librariesDir(env.root), "com/typesafe/akka/akka-actor_2.11/2.3.3/akka-actor_2.11-2.3.3.jar")), lib);
    const json = JSON.parse(await readFile(versionJsonPath(env.root, "Forge 1.12.2"), "utf8"));
    assert.match(json.minecraftArguments, /FMLTweaker/);
    const info = await instances.get("Forge 1.12.2");
    assert.deepEqual(info?.loaders, [{ kind: "forge", version: "14.23.5.2860" }]);
    assert.equal(info?.mcVersion, "1.12.2");
    await assert.rejects(stat(join(librariesDir(env.root), "org/example/server-only")));
  });
});

describe("OptiFine", () => {
  it("patches the jar with the installer's Patcher and builds a LaunchWrapper profile", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 2 }]);
    const classes = await compileJava(tmp, {
      "optifine/Patcher.java": `package optifine;
import java.nio.file.*;
public class Patcher { public static void main(String[] a) throws Exception { Files.copy(Paths.get(a[0]), Paths.get(a[2]), StandardCopyOption.REPLACE_EXISTING); System.out.println("patched " + a[1]); } }`,
    });
    const installer = await zipBuffer({ "optifine/Patcher.class": classes["optifine/Patcher.class"], "launchwrapper-of-2.2.jar": "wrapper-bytes", "META-INF/MANIFEST.MF": manifestFor() });
    world.add("/optifine/1.20.1/HD_U/I6", installer);
    const { deps, env, instances } = setup(world);
    await installInstance(deps, { name: "OptiFine 1.20.1", mcVersion: "1.20.1", loader: { kind: "optifine", version: "HD_U_I6", meta: { type: "HD_U", patch: "I6" } } });
    const patched = join(librariesDir(env.root), "optifine/OptiFine/1.20.1_HD_U_I6/OptiFine-1.20.1_HD_U_I6.jar");
    assert.deepEqual(await readFile(patched), world.versions.get("1.20.1")!.jar, "Patcher output is placed in the library tree");
    assert.equal(await readFile(join(librariesDir(env.root), "optifine/launchwrapper-of/2.2/launchwrapper-of-2.2.jar"), "utf8"), "wrapper-bytes");
    const json = JSON.parse(await readFile(versionJsonPath(env.root, "OptiFine 1.20.1"), "utf8"));
    assert.equal(json.mainClass, "net.minecraft.launchwrapper.Launch");
    assert.ok(json.arguments.game.includes("optifine.OptiFineTweaker"));
    assert.deepEqual(json.libraries.slice(0, 2).map((l: { name: string }) => l.name), ["optifine:OptiFine:1.20.1_HD_U_I6", "optifine:launchwrapper-of:2.2"]);
    const info = await instances.get("OptiFine 1.20.1");
    assert.deepEqual(info?.loaders.map((l) => l.kind), ["optifine"]);
  });
});
