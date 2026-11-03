import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CurseForgeClient } from "../src/content/curseforge";
import { ModrinthClient } from "../src/content/modrinth";
import { DEFAULT_ENGINE, DownloadEngine, type Progress } from "../src/net/download";
import { HttpClient } from "../src/net/http";
import { DEFAULT_SOURCES, SourceRouter, type SourceSettings } from "../src/net/sources";
import { clearMetaCache, type MetaDeps } from "../src/loaders/meta";
import { type InstallDeps } from "../src/loaders/install";
import type { GameEnv } from "../src/mc/files";
import { InstanceStore } from "../src/mc/instances";
import { VersionCatalog } from "../src/mc/manifest";
import type { VersionJson } from "../src/mc/types";
import { versionDir, versionJsonPath } from "../src/mc/version-json";
import { cdnCandidates, folderFor, parseCurseForgeManifest, parseLoaderId } from "../src/pack/cf-pack";
import { detectPackFormat, openPack } from "../src/pack/detect";
import { exportMrpack, listExportCandidates } from "../src/pack/export";
import { checkPackPath, isProtectedPath, normalizePackPath } from "../src/pack/guard";
import { adoptManualFiles, installPack, previewPack, readPackState, repairPack, resolveLoaderChoice, type PackDeps, type PackHooks } from "../src/pack/install";
import { parseMcbbsPack } from "../src/pack/mcbbs";
import { parseMrpackIndex } from "../src/pack/mrpack";
import { parseIni, parseMultiMcPack } from "../src/pack/multimc";
import { installOnlinePack, latestPackVersion, type OnlineDeps } from "../src/pack/online";
import { PackError } from "../src/pack/types";
import { ZipReader } from "../src/util/zip";
import { nullLog } from "../src/util/log";
import { currentOs } from "../src/util/os";
import { bytes, serveBytes, sha1, startMock, type MockServer } from "./helpers/mock-server";
import { startFakeMojang, zipBuffer, type FakeWorld } from "./helpers/fake-mojang";
import { rawZip } from "./helpers/rawzip";
import { fabricWorld, json, startContent, type Content } from "./helpers/content-server";

const http = new HttpClient({ userAgent: "vitrine-test" });
after(() => http.destroy());

const sha512 = (data: Buffer | string) => createHash("sha512").update(data).digest("hex");

let tmp: string;
let world: FakeWorld | undefined;
let content: Content | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-pack-"));
  clearMetaCache();
});
afterEach(async () => {
  await world?.close();
  await content?.server.close();
  world = undefined;
  content = undefined;
  await rm(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ guards

describe("pack path safety", () => {
  it("rejects paths that escape or confuse the filesystem", () => {
    for (const bad of ["../x", "/abs", "C:/x", "a/../b", "mods/a.jar:stream", "mods/a.jar.", "mods/a.jar ", "mods/con", "mods/a<b", "", ".", "mods\\..\\x"]) {
      assert.throws(() => normalizePackPath(bad), PackError, `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(normalizePackPath("mods\\a.jar"), "mods/a.jar");
    assert.equal(normalizePackPath("./config/a/b.toml"), "config/a/b.toml");
    assert.equal(normalizePackPath("config//x.cfg"), "config/x.cfg");
  });

  it("protects the launcher's own files, case-insensitively, but only at the top level", () => {
    assert.equal(isProtectedPath("vitrine.json", "Pack"), true);
    assert.equal(isProtectedPath("VITRINE.JSON", "Pack"), true);
    assert.equal(isProtectedPath("Pack.json", "Pack"), true);
    assert.equal(isProtectedPath("pack.JAR", "Pack"), true);
    assert.equal(isProtectedPath("natives/lwjgl.dll", "Pack"), true);
    assert.equal(isProtectedPath(".vitrine/x", "Pack"), true);
    assert.equal(isProtectedPath("mods/a.jar.vtmp", "Pack"), true);
    assert.equal(isProtectedPath("config/vitrine.json", "Pack"), false);
    assert.equal(isProtectedPath("mods/a.jar", "Pack"), false);
    assert.deepEqual(checkPackPath("vitrine.json", "Pack").ok, false);
    assert.deepEqual(checkPackPath("mods\\a.jar", "Pack"), { ok: true, path: "mods/a.jar" });
  });
});

// ------------------------------------------------------------------ parsers

describe("manifest parsers", () => {
  it("parses a Modrinth index, applying env rules and the host allow-list", () => {
    const manifest = parseMrpackIndex({
      formatVersion: 1,
      game: "minecraft",
      versionId: "2.0.0",
      name: "  My Pack ",
      summary: "hello",
      dependencies: { minecraft: "1.20.1", "fabric-loader": "0.15.11", "mystery-dep": "1" },
      files: [
        { path: "mods/a.jar", hashes: { sha1: "AA".repeat(20), sha512: "bb".repeat(64) }, env: { client: "required", server: "required" }, downloads: ["https://cdn.modrinth.com/data/a/versions/1/a.jar"], fileSize: 10 },
        { path: "mods/server-only.jar", hashes: { sha1: "cc".repeat(20) }, env: { client: "unsupported", server: "required" }, downloads: ["https://cdn.modrinth.com/data/s/versions/1/s.jar"], fileSize: 10 },
        { path: "mods/opt.jar", hashes: { sha1: "dd".repeat(20) }, env: { client: "optional" }, downloads: ["https://github.com/x/y/releases/download/1/opt.jar"], fileSize: 10 },
        { path: "mods/evil.jar", hashes: { sha1: "ee".repeat(20) }, downloads: ["https://evil.example/evil.jar"], fileSize: 10 },
        { path: "mods/plain-http.jar", hashes: { sha1: "ee".repeat(20) }, downloads: ["http://cdn.modrinth.com/data/p/versions/1/p.jar"], fileSize: 10 },
        { path: "../escape.jar", hashes: { sha1: "ff".repeat(20) }, downloads: ["https://cdn.modrinth.com/data/e/versions/1/e.jar"], fileSize: 10 },
        { path: "mods/A.jar", hashes: { sha1: "11".repeat(20) }, downloads: ["https://cdn.modrinth.com/data/a2/versions/1/a.jar"], fileSize: 10 },
      ],
    });
    assert.equal(manifest.name, "My Pack");
    assert.equal(manifest.version, "2.0.0");
    assert.deepEqual(manifest.loader, { kind: "fabric", version: "0.15.11" });
    assert.deepEqual(manifest.files.map((f) => f.path), ["mods/a.jar", "mods/opt.jar"]);
    assert.equal(manifest.files[0].hashes?.sha1, "aa".repeat(20), "hashes are lower-cased");
    assert.equal(manifest.files[1].optional, true);
    assert.deepEqual(manifest.overrides, ["overrides/", "client-overrides/"]);
    const text = manifest.warnings.join("\n");
    assert.match(text, /仅服务端文件/);
    assert.match(text, /不在 Modrinth 允许的域名/);
    assert.match(text, /路径不合法/);
    assert.match(text, /重复路径/);
    assert.match(text, /mystery-dep/);
  });

  it("refuses indexes that are not usable Minecraft packs", () => {
    assert.throws(() => parseMrpackIndex(null), PackError);
    assert.throws(() => parseMrpackIndex({ game: "hytale", name: "x", dependencies: { minecraft: "1" } }), /不是 Minecraft/);
    assert.throws(() => parseMrpackIndex({ name: "x", dependencies: {} }), /Minecraft 版本/);
    assert.throws(() => parseMrpackIndex({ dependencies: { minecraft: "1.20.1" } }), /名称/);
    const manifest = parseMrpackIndex({ name: "x", formatVersion: 2, dependencies: { minecraft: "1.20.1", forge: "47.2.0", neoforge: "21.1.1" }, files: [] });
    assert.equal(manifest.loader?.kind, "neoforge");
    assert.match(manifest.warnings.join(" "), /多个加载器/);
    assert.match(manifest.warnings.join(" "), /格式版本/);
  });

  it("parses CurseForge manifests and loader ids", () => {
    assert.deepEqual(parseLoaderId("forge-47.2.20"), { kind: "forge", version: "47.2.20" });
    assert.deepEqual(parseLoaderId("neoforge-21.1.172"), { kind: "neoforge", version: "21.1.172" });
    assert.deepEqual(parseLoaderId("fabric-0.15.7"), { kind: "fabric", version: "0.15.7" });
    assert.deepEqual(parseLoaderId("quilt-0.26.0"), { kind: "quilt", version: "0.26.0" });
    assert.equal(parseLoaderId("liteloader-1.0"), undefined);

    const manifest = parseCurseForgeManifest({
      manifestType: "minecraftModpack",
      name: "CF Pack",
      version: "1.0",
      author: "me",
      minecraft: { version: "1.20.1", modLoaders: [{ id: "forge-47.1.0" }, { id: "fabric-0.15.7", primary: true }] },
      files: [{ projectID: 1, fileID: 10, required: true }, { projectID: 2, fileID: 20, required: false }, { projectID: 3, fileID: 10 }, { projectID: "x", fileID: 5 }],
      overrides: "\\my-overrides\\",
    });
    assert.deepEqual(manifest.loader, { kind: "fabric", version: "0.15.7" });
    assert.deepEqual(manifest.files.map((f) => f.curseforge), [{ projectId: 1, fileId: 10 }, { projectId: 2, fileId: 20 }]);
    assert.equal(manifest.files[1].optional, true);
    assert.deepEqual(manifest.overrides, ["my-overrides/"]);
    assert.match(manifest.warnings.join(" "), /多个加载器/);
    const unknown = parseCurseForgeManifest({ name: "L", minecraft: { version: "1.12.2", modLoaders: [{ id: "liteloader-1", primary: true }] }, files: [] });
    assert.equal(unknown.loader, undefined);
    assert.match(unknown.warnings.join(" "), /不支持的加载器/);
    assert.throws(() => parseCurseForgeManifest({ manifestType: "somethingElse", name: "x", minecraft: { version: "1" } }), /不支持的清单类型/);

    assert.equal(folderFor(6, "a.jar"), "mods");
    assert.equal(folderFor(12, "a.zip"), "resourcepacks");
    assert.equal(folderFor(6552, "s.zip"), "shaderpacks");
    assert.equal(folderFor(undefined, "x.jar"), "mods");
    assert.equal(folderFor(undefined, "x.zip"), "resourcepacks");
    const urls = cdnCandidates({ id: 4838934, fileName: "a b.jar", downloadUrl: null });
    assert.equal(urls[0], "https://edge.forgecdn.net/files/4838/934/a%20b.jar");
    assert.ok(urls.some((url) => url.startsWith("https://mediafilez.forgecdn.net/files/4838/934/")));
  });

  it("parses MultiMC / Prism instances", () => {
    assert.deepEqual(parseIni('name=Pack\n# c\n[General]\nJvmArgs="-Xss1M -Dx=\\"y\\""\nMaxMemAlloc=6144\n'), { name: "Pack", JvmArgs: '-Xss1M -Dx="y"', MaxMemAlloc: "6144" });
    const manifest = parseMultiMcPack({
      pack: { formatVersion: 1, components: [{ uid: "net.minecraft", version: "1.20.1" }, { uid: "net.fabricmc.intermediary", version: "1.20.1" }, { uid: "net.fabricmc.fabric-loader", version: "0.15.11" }, { uid: "org.lwjgl3", version: "3.3.3" }, { uid: "custom.thing", cachedName: "Custom", version: "9" }] },
      cfg: "name=Prism Pack\nOverrideMemory=true\nMaxMemAlloc=8192\nOverrideJavaArgs=true\nJvmArgs=-XX:+UseZGC\nOverrideWindow=true\nMinecraftWinWidth=1600\nMinecraftWinHeight=900\nnotes=hi\n",
      gameDirPrefix: "Pack/.minecraft/",
    });
    assert.equal(manifest.name, "Prism Pack");
    assert.equal(manifest.mcVersion, "1.20.1");
    assert.deepEqual(manifest.loader, { kind: "fabric", version: "0.15.11" });
    assert.deepEqual(manifest.settings, { memoryMb: 8192, jvmArgs: "-XX:+UseZGC", width: 1600, height: 900 });
    assert.deepEqual(manifest.overrides, ["Pack/.minecraft/"]);
    const text = manifest.warnings.join("\n");
    assert.match(text, /LWJGL/);
    assert.match(text, /Custom 9/);
    assert.doesNotMatch(text, /intermediary/);
    assert.throws(() => parseMultiMcPack({ pack: { components: [{ uid: "net.fabricmc.fabric-loader", version: "1" }] } }), /Minecraft 版本/);
    // not overridden → not applied
    const plain = parseMultiMcPack({ pack: { components: [{ uid: "net.minecraft", version: "1.8.9" }] }, cfg: "MaxMemAlloc=9999\nJvmArgs=-Xfoo\n", fallbackName: "Folder" });
    assert.equal(plain.settings, undefined);
    assert.equal(plain.name, "Folder");
  });

  it("parses MCBBS packs: file API entries and CurseForge references", () => {
    const manifest = parseMcbbsPack({
      manifestType: "minecraftModpack",
      manifestVersion: 2,
      name: "BBS Pack",
      version: "3",
      fileApi: "https://files.example.com/pack/",
      addons: [{ id: "game", version: "1.16.5" }, { id: "forge", version: "36.2.39" }, { id: "optifine", version: "x" }],
      files: [
        { type: "addon", path: "mods/中文 模组.jar", hash: "ab".repeat(20), force: true },
        { type: "curseforge", projectID: 5, fileID: 50, force: false },
        { type: "addon", path: "../bad.jar", hash: "ab".repeat(20) },
        { type: "mystery" },
      ],
      launchInfo: { minMemory: 3072 },
    });
    assert.deepEqual(manifest.loader, { kind: "forge", version: "36.2.39" });
    assert.equal(manifest.files.length, 2);
    assert.equal(manifest.files[0].urls[0], "https://files.example.com/pack/mods/%E4%B8%AD%E6%96%87%20%E6%A8%A1%E7%BB%84.jar");
    assert.equal(manifest.files[0].hashes?.sha1, "ab".repeat(20));
    assert.deepEqual(manifest.files[1].curseforge, { projectId: 5, fileId: 50 });
    assert.equal(manifest.files[1].optional, true);
    assert.equal(manifest.settings?.memoryMb, 3072);
    assert.match(manifest.warnings.join(" "), /optifine/);
    assert.match(manifest.warnings.join(" "), /2 个文件条目/);
  });
});

// ------------------------------------------------------------------ detection

describe("format detection", () => {
  it("recognises each format from the archive contents", async () => {
    const make = async (name: string, files: Record<string, string>) => {
      const path = join(tmp, name);
      await writeFile(path, await zipBuffer(files));
      return path;
    };
    const mr = await make("a.mrpack", { "modrinth.index.json": JSON.stringify({ name: "M", dependencies: { minecraft: "1.20.1" }, files: [] }) });
    const cf = await make("b.zip", { "manifest.json": JSON.stringify({ manifestType: "minecraftModpack", name: "C", minecraft: { version: "1.20.1", modLoaders: [] }, files: [] }) });
    const mmc = await make("c.zip", { "Folder/mmc-pack.json": JSON.stringify({ components: [{ uid: "net.minecraft", version: "1.20.1" }] }), "Folder/instance.cfg": "name=Prismy\n", "Folder/.minecraft/options.txt": "x" });
    const bbs = await make("d.zip", { "mcbbs.packmeta": JSON.stringify({ name: "B", addons: [{ id: "game", version: "1.16.5" }] }), "manifest.json": JSON.stringify({ manifestType: "minecraftModpack", name: "ignored", minecraft: { version: "1.12.2" } }) });
    const junk = await make("e.zip", { "readme.txt": "hi", "manifest.json": JSON.stringify({ unrelated: true }) });
    await writeFile(join(tmp, "f.zip"), "this is not a zip");

    const formats: string[] = [];
    for (const path of [mr, cf, mmc, bbs]) {
      const pack = await openPack(path);
      formats.push(pack.format);
      pack.close();
    }
    assert.deepEqual(formats, ["mrpack", "curseforge", "multimc", "mcbbs"]);
    const pack = await openPack(mmc);
    assert.equal(pack.manifest.name, "Prismy");
    assert.deepEqual(pack.manifest.overrides, ["Folder/.minecraft/"]);
    pack.close();

    await assert.rejects(openPack(junk), (error: PackError) => error.code === "unknown-format");
    await assert.rejects(openPack(join(tmp, "f.zip")), (error: PackError) => error.code === "unknown-format");
    const zip = await ZipReader.open(junk);
    assert.equal(await detectPackFormat(zip), undefined);
    zip.close();
  });
});

// ------------------------------------------------------------------ install pipeline

function setup(w: FakeWorld, c: Content, apiKey?: string) {
  const settings: SourceSettings = { ...DEFAULT_SOURCES, policy: "mirror-only", mirrorBase: w.mirrorBase, contentPolicy: "mirror-only", contentMirrorBase: c.server.url };
  const router = new SourceRouter(() => settings);
  const engine = new DownloadEngine(http, () => ({ ...DEFAULT_ENGINE, retries: 2, backoffBaseMs: 5, concurrency: 16 }));
  const env: GameEnv = { root: join(tmp, "mc"), http, router, engine, log: nullLog, os: currentOs() };
  const instances = new InstanceStore(env.root);
  const meta: MetaDeps = { http, router, mirrorBase: () => w.mirrorBase };
  const install: InstallDeps = {
    env,
    catalog: new VersionCatalog(http, router, join(tmp, "manifest.json")),
    meta,
    instances,
    ensureJava: async () => ({ path: "java", major: 21 }),
    workDir: join(tmp, "work"),
    mirrorBase: () => w.mirrorBase,
  };
  const modrinth = new ModrinthClient({ http, router });
  const curseforge = new CurseForgeClient({ http, router }, () => apiKey);
  const deps: PackDeps = { install, curseforge };
  const online: OnlineDeps = { ...deps, modrinth, workDir: join(tmp, "work") };
  const stages: string[] = [];
  const snapshots: Progress[] = [];
  const warnings: string[] = [];
  const files: { status: string; path: string }[] = [];
  const hooks: PackHooks = {
    stage: (stage) => stages.push(stage),
    progress: (progress, stage) => {
      if (stage === "pack-files") snapshots.push(progress);
    },
    warning: (message) => warnings.push(message),
    file: (event) => files.push({ status: event.status, path: event.item.dest }),
  };
  return { env, instances, deps, online, modrinth, curseforge, stages, snapshots, warnings, files, hooks, router };
}

interface ModSpec {
  path: string;
  data: Buffer;
  url: string;
  client?: "required" | "optional" | "unsupported";
}

function makeMods(content: Content, count: number): ModSpec[] {
  const mods: ModSpec[] = [];
  for (let i = 0; i < count; i++) {
    const data = bytes(1500 + ((i * 53) % 3000), 7000 + i);
    const name = `mod-${String(i).padStart(3, "0")}.jar`;
    const urlPath = `/data/proj${i}/versions/v${i}/${name}`;
    content.statics.set(urlPath, data);
    mods.push({ path: `mods/${name}`, data, url: `https://cdn.modrinth.com${urlPath}` });
  }
  return mods;
}

function mrIndexFor(mods: ModSpec[], extra: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    game: "minecraft",
    versionId: "1.2.3",
    name: "Test Pack",
    summary: "A pack for testing",
    dependencies: { minecraft: "1.20.1", "fabric-loader": "0.15.11" },
    files: mods.map((mod) => ({
      path: mod.path,
      hashes: { sha1: sha1(mod.data), sha512: sha512(mod.data) },
      env: { client: mod.client ?? "required", server: "required" },
      downloads: [mod.url],
      fileSize: mod.data.length,
    })),
    ...extra,
  };
}

async function writePack(name: string, files: Record<string, string | Buffer>): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, await zipBuffer(files));
  return path;
}

describe("installing a Modrinth pack", () => {
  it("downloads many files in parallel lanes, verifies them and applies overrides safely", async () => {
    world = await fabricWorld();
    content = await startContent();
    const mods = makeMods(content, 48);
    const file = join(tmp, "test.mrpack");
    await writeFile(
      file,
      rawZip([
        { name: "modrinth.index.json", data: JSON.stringify(mrIndexFor(mods)) },
        { name: "overrides/config/pack.toml", data: "answer = 42\n" },
        { name: "overrides/options.txt", data: "from-overrides\n" },
        { name: "client-overrides/options.txt", data: "from-client-overrides\n" },
        { name: "server-overrides/server.properties", data: "nope\n" },
        // none of these may land anywhere they could do harm
        { name: "overrides/vitrine.json", data: JSON.stringify({ preLaunch: "evil" }) },
        { name: "overrides/Test Pack.json", data: "{}" },
        { name: "overrides/natives/lwjgl.dll", data: "x" },
        { name: "overrides/../outside.txt", data: "x" },
        { name: "overrides/..\\outside2.txt", data: "x" },
        { name: "overrides/C:/windows.txt", data: "x" },
        { name: "overrides/mods/handmade.jar", data: "bundled jar" },
      ]),
    );
    const s = setup(world, content);
    const result = await installPack(s.deps, { file, hooks: s.hooks });

    assert.equal(result.id, "Test Pack");
    assert.equal(result.complete, true);
    assert.equal(result.totalFiles, 48);
    assert.equal(result.downloaded, 48);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(result.loader, { kind: "fabric", version: "0.15.11" });

    const dir = versionDir(s.env.root, "Test Pack");
    for (const mod of mods) assert.deepEqual(await readFile(join(dir, mod.path)), mod.data, mod.path);
    assert.equal(await readFile(join(dir, "config/pack.toml"), "utf8"), "answer = 42\n");
    assert.equal(await readFile(join(dir, "options.txt"), "utf8"), "from-client-overrides\n", "client-overrides win over overrides");
    assert.equal(await readFile(join(dir, "mods/handmade.jar"), "utf8"), "bundled jar");
    await assert.rejects(stat(join(dir, "server.properties")));
    await assert.rejects(stat(join(dir, "natives/lwjgl.dll")));
    for (const escaped of [join(tmp, "mc", "versions", "outside.txt"), join(tmp, "mc", "versions", "outside2.txt"), join(tmp, "mc", "outside.txt"), join(dir, "C:")]) {
      await assert.rejects(stat(escaped), `${escaped} must not exist`);
    }
    const config = await s.instances.loadConfig("Test Pack");
    assert.equal(config.preLaunch, undefined, "a pack must not be able to set a pre-launch command");
    assert.equal(config.isolation, "on");
    assert.deepEqual({ source: config.modpack?.source, name: config.modpack?.name, version: config.modpack?.version }, { source: "mrpack", name: "Test Pack", version: "1.2.3" });
    assert.equal(config.note, "A pack for testing");
    assert.equal(JSON.parse(await readFile(versionJsonPath(s.env.root, "Test Pack"), "utf8")).id, "Test Pack", "the version JSON was not replaced");
    assert.match(s.warnings.join("\n"), /6 个文件的路径不安全或会覆盖启动器自己的文件/);

    // the instance resolves as a valid Fabric instance
    const info = await s.instances.get("Test Pack");
    assert.equal(info?.valid, true);
    assert.equal(info?.loaders[0]?.kind, "fabric");

    // the frontend gets stage changes in order and lane-level progress
    const order = ["pack-read", "pack-resolve", "version-json", "client-jar", "loader-meta", "pack-files", "pack-overrides", "pack-finish"];
    const indexes = order.map((stage) => s.stages.indexOf(stage));
    assert.ok(indexes.every((index) => index >= 0), `stages: ${s.stages.join(",")}`);
    assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, "stages happen in order");
    assert.ok(s.snapshots.length >= 1);
    const last = s.snapshots[s.snapshots.length - 1];
    assert.equal(last.totalFiles, 48);
    assert.equal(last.doneFiles + last.skippedFiles, 48);
    assert.ok(Math.max(...s.snapshots.map((p) => p.lanes.length)) >= 8, "progress reports one entry per lane");
    assert.equal(s.files.filter((event) => event.status === "done").length, 48);

    // parallelism actually happened on the wire
    assert.ok(content.server.stats.maxActive >= 8, `max simultaneous downloads was ${content.server.stats.maxActive}`);

    const state = await readPackState(s.env.root, "Test Pack");
    assert.equal(state?.complete, true);
    assert.equal(state?.files.length, 48);
  });

  it("keeps an incomplete instance when a file is damaged on the server and repairs it later", async () => {
    world = await fabricWorld();
    content = await startContent();
    const mods = makeMods(content, 6);
    const brokenPath = new URL(mods[2].url).pathname;
    content.corrupt.add(brokenPath);
    const file = await writePack("broken.mrpack", { "modrinth.index.json": JSON.stringify(mrIndexFor(mods)) });
    const s = setup(world, content);
    const result = await installPack(s.deps, { file, name: "Flaky" });
    assert.equal(result.complete, false);
    assert.equal(result.downloaded, 5);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, mods[2].path);
    assert.match(result.failed[0].error, /sha|mismatch/i);
    const dir = versionDir(s.env.root, "Flaky");
    await assert.rejects(stat(join(dir, mods[2].path)), "a damaged download is never left in place");
    assert.deepEqual((await readdir(join(dir, "mods"))).filter((name) => name.endsWith(".vtmp")), []);
    assert.equal((await readPackState(s.env.root, "Flaky"))?.complete, false);

    // the server recovers; repair fetches only what is missing
    content.corrupt.clear();
    const before = content.server.stats.requests;
    const repaired = await repairPack(s.deps, "Flaky");
    assert.equal(repaired.complete, true);
    assert.equal(repaired.downloaded, 1);
    assert.equal(repaired.alreadyOk, 5);
    assert.equal(content.server.stats.requests - before, 1, "only the missing file is requested");
    assert.deepEqual(await readFile(join(dir, mods[2].path)), mods[2].data);
    assert.equal((await readPackState(s.env.root, "Flaky"))?.complete, true);

    // hash verification catches a file that was changed on disk without changing its size
    await writeFile(join(dir, mods[4].path), Buffer.from(mods[4].data).fill(0x42));
    assert.equal((await repairPack(s.deps, "Flaky")).downloaded, 0, "size-only check cannot see it");
    const deep = await repairPack(s.deps, "Flaky", { verify: "hash" });
    assert.equal(deep.downloaded, 1);
    assert.deepEqual(await readFile(join(dir, mods[4].path)), mods[4].data);
  });

  it("removes the instance when cancelled during the file download", async () => {
    world = await fabricWorld();
    content = await startContent();
    content.fileDelayMs = 200;
    const mods = makeMods(content, 40);
    const file = await writePack("cancel.mrpack", { "modrinth.index.json": JSON.stringify(mrIndexFor(mods)) });
    const s = setup(world, content);
    const controller = new AbortController();
    const hooks: PackHooks = { ...s.hooks, progress: (progress, stage) => { if (stage === "pack-files" && progress.bytesDone > 0) controller.abort(); } };
    await assert.rejects(installPack(s.deps, { file, name: "Cancelled", signal: controller.signal, hooks }), (error: Error) => error.name === "AbortError");
    assert.deepEqual(await s.instances.names(), []);
  });

  it("can leave out optional files", async () => {
    world = await fabricWorld();
    content = await startContent();
    const mods = makeMods(content, 4);
    mods[1].client = "optional";
    mods[3].client = "optional";
    const file = await writePack("opt.mrpack", { "modrinth.index.json": JSON.stringify(mrIndexFor(mods)) });
    const preview = await previewPack(file);
    assert.deepEqual(preview.optionalFiles.map((entry) => entry.path), [mods[1].path, mods[3].path]);
    assert.equal(preview.fileCount, 4);
    assert.equal(preview.format, "mrpack");
    const s = setup(world, content);
    const none = await installPack(s.deps, { file, name: "NoOptional", skipOptional: true });
    assert.equal(none.totalFiles, 2);
    const some = await installPack(s.deps, { file, name: "SomeOptional", skipOptional: [mods[1].path.toUpperCase()] });
    assert.equal(some.totalFiles, 3);
    const all = await installPack(s.deps, { file, name: "AllOptional" });
    assert.equal(all.totalFiles, 4);
  });

  it("derives a unique folder name and keeps the original title as display name", async () => {
    world = await fabricWorld();
    content = await startContent();
    const file = await writePack("name.mrpack", { "modrinth.index.json": JSON.stringify(mrIndexFor([], { name: '新蒸程: "空艇" 1.7.5?' })) });
    const s = setup(world, content);
    const first = await installPack(s.deps, { file });
    assert.equal(first.id, "新蒸程_ _空艇_ 1.7.5_");
    assert.equal((await s.instances.loadConfig(first.id)).displayName, '新蒸程: "空艇" 1.7.5?');
    const second = await installPack(s.deps, { file });
    assert.equal(second.id, "新蒸程_ _空艇_ 1.7.5_ (2)");
    await assert.rejects(installPack(s.deps, { file, name: first.id }), /已存在名为/);
    await assert.rejects(installPack(s.deps, { file, name: "bad/name" }), /名称不能包含/);
  });

  it("rejects a manifest path that would replace the launcher's own files", async () => {
    world = await fabricWorld();
    content = await startContent();
    const sneaky: ModSpec = { path: "vitrine.json", data: Buffer.from('{"preLaunch":"evil"}'), url: "https://cdn.modrinth.com/data/x/versions/1/vitrine.json" };
    content.statics.set("/data/x/versions/1/vitrine.json", sneaky.data);
    const file = await writePack("sneaky.mrpack", { "modrinth.index.json": JSON.stringify(mrIndexFor([sneaky])) });
    const s = setup(world, content);
    const result = await installPack(s.deps, { file, name: "Sneaky" });
    assert.equal(result.totalFiles, 0);
    assert.match(result.warnings.join(" "), /受保护/);
    assert.equal((await s.instances.loadConfig("Sneaky")).preLaunch, undefined);
  });
});

describe("installing a CurseForge pack", () => {
  const fileRecord = (id: number, modId: number, name: string, data: Buffer, downloadUrl: string | null) => ({
    id,
    modId,
    displayName: name,
    fileName: name,
    releaseType: 1,
    fileDate: "2024-01-01T00:00:00Z",
    fileLength: data.length,
    downloadUrl,
    isAvailable: true,
    hashes: [{ value: sha1(data), algo: 1 }],
    gameVersions: ["1.20.1"],
  });

  it("resolves files through the API, uses the CDN for restricted ones and supports manual download", async () => {
    world = await fabricWorld();
    content = await startContent();
    const c = content;
    const normal = bytes(3000, 11);
    const cdnOnly = bytes(2500, 12);
    const restricted = bytes(2800, 13);
    const resource = bytes(1800, 14);
    const records = [
      fileRecord(4838934, 100, "normal-mod.jar", normal, "https://edge.forgecdn.net/files/4838/934/normal-mod.jar"),
      fileRecord(4838935, 101, "cdn-only.jar", cdnOnly, null),
      fileRecord(4838936, 102, "restricted.jar", restricted, null),
      fileRecord(4838937, 103, "faithful.zip", resource, "https://edge.forgecdn.net/files/4838/937/faithful.zip"),
    ];
    c.statics.set("/files/4838/934/normal-mod.jar", normal);
    c.statics.set("/files/4838/935/cdn-only.jar", cdnOnly);
    c.statics.set("/files/4838/937/faithful.zip", resource);
    // restricted.jar is deliberately absent from the CDN
    c.routes.set("POST /curseforge/v1/mods/files", (_req, res, _url, body) => {
      const ids: number[] = JSON.parse(body).fileIds;
      json(res, { data: records.filter((record) => ids.includes(record.id)) });
    });
    c.routes.set("POST /curseforge/v1/mods", (_req, res, _url, body) => {
      const ids: number[] = JSON.parse(body).modIds;
      const all = [
        { id: 100, name: "Normal Mod", classId: 6, links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/normal" } },
        { id: 101, name: "CDN Only", classId: 6, links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/cdn-only" } },
        { id: 102, name: "Restricted", classId: 6, links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/restricted" } },
        { id: 103, name: "Faithful", classId: 12, links: { websiteUrl: "https://www.curseforge.com/minecraft/texture-packs/faithful" } },
      ];
      json(res, { data: all.filter((mod) => ids.includes(mod.id)) });
    });
    const manifest = {
      manifestType: "minecraftModpack",
      manifestVersion: 1,
      name: "CF Test",
      version: "0.9",
      author: "tester",
      minecraft: { version: "1.20.1", modLoaders: [{ id: "fabric-0.15.11", primary: true }] },
      files: [
        { projectID: 100, fileID: 4838934, required: true },
        { projectID: 101, fileID: 4838935, required: true },
        { projectID: 102, fileID: 4838936, required: true },
        { projectID: 103, fileID: 4838937, required: true },
        { projectID: 104, fileID: 999, required: true },
      ],
      overrides: "overrides",
    };
    c.routes.set("GET /curseforge/v1/mods/104/files/999", (_req, res) => json(res, { message: "not found" }, 404));
    const file = await writePack("cf.zip", { "manifest.json": JSON.stringify(manifest), "overrides/config/cf.cfg": "ok", "overrides/mods/extra.jar": "extra" });

    const s = setup(world, content, "secret-key");
    const result = await installPack(s.deps, { file, hooks: s.hooks });
    assert.equal(result.id, "CF Test");
    assert.equal(result.complete, false);
    assert.equal(result.totalFiles, 4);
    assert.equal(result.downloaded, 3);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].fileId, 999);
    assert.deepEqual(result.failed.map((entry) => ({ path: entry.path, restricted: entry.restricted, page: entry.pageUrl })), [{ path: "mods/restricted.jar", restricted: true, page: "https://www.curseforge.com/minecraft/mc-mods/restricted/files/4838936" }]);
    const dir = versionDir(s.env.root, "CF Test");
    assert.deepEqual(await readFile(join(dir, "mods/normal-mod.jar")), normal);
    assert.deepEqual(await readFile(join(dir, "mods/cdn-only.jar")), cdnOnly);
    assert.deepEqual(await readFile(join(dir, "resourcepacks/faithful.zip")), resource, "resource packs go to resourcepacks/");
    assert.equal(await readFile(join(dir, "config/cf.cfg"), "utf8"), "ok");
    assert.equal((await s.instances.loadConfig("CF Test")).modpack?.source, "curseforge-zip");
    assert.match(s.warnings.join("\n"), /不允许第三方分发/);

    // the API key goes to the official host only, never to a mirror
    const apiCalls = c.seen.filter((entry) => entry.path.includes("/curseforge/"));
    assert.ok(apiCalls.length >= 2);
    assert.ok(apiCalls.every((entry) => entry.headers["x-api-key"] === undefined), "key must not be sent to the mirror");

    // manual download: wrong content is refused, the right file is adopted
    const wrong = join(tmp, "restricted.jar");
    await writeFile(wrong, "not the right file");
    const refused = await adoptManualFiles(s.deps, "CF Test", [wrong, join(tmp, "unrelated.jar")]);
    assert.equal(refused.adopted.length, 0);
    assert.match(refused.rejected[0].reason, /校验和/);
    assert.match(refused.rejected[1].reason, /没有哪个缺失的文件/);
    await writeFile(wrong, restricted);
    const accepted = await adoptManualFiles(s.deps, "CF Test", [wrong]);
    assert.deepEqual(accepted.adopted, ["mods/restricted.jar"]);
    assert.equal(accepted.remaining.length, 0);
    assert.deepEqual(await readFile(join(dir, "mods/restricted.jar")), restricted);
    // one unresolved file is still outstanding, so the pack is not complete
    assert.equal((await readPackState(s.env.root, "CF Test"))?.complete, false);
  });

  it("fails with a clear message when neither the key nor the mirror can answer", async () => {
    world = await fabricWorld();
    content = await startContent();
    content.routes.set("POST /curseforge/v1/mods/files", (_req, res) => json(res, { error: "unavailable" }, 503));
    content.routes.set("POST /curseforge/v1/mods", (_req, res) => json(res, { error: "unavailable" }, 503));
    const manifest = { manifestType: "minecraftModpack", name: "Nokey", minecraft: { version: "1.20.1", modLoaders: [] }, files: [{ projectID: 1, fileID: 2, required: true }], overrides: "overrides" };
    const file = await writePack("nokey.zip", { "manifest.json": JSON.stringify(manifest) });
    const s = setup(world, content);
    await assert.rejects(installPack(s.deps, { file, name: "Nokey" }), (error: PackError) => error.code === "no-api-key" && /API Key/.test(error.message));
    assert.deepEqual(await s.instances.names(), [], "nothing is created when resolving fails");
  });
});

describe("installing MultiMC / Prism packs", () => {
  it("copies the game folder and carries over memory and JVM settings", async () => {
    world = await fabricWorld();
    content = await startContent();
    const file = await writePack("prism.zip", {
      "Prism Pack/mmc-pack.json": JSON.stringify({ formatVersion: 1, components: [{ uid: "net.minecraft", version: "1.20.1" }, { uid: "net.fabricmc.fabric-loader", version: "0.15.11" }] }),
      "Prism Pack/instance.cfg": "name=Prism Pack\nOverrideMemory=true\nMaxMemAlloc=7168\nOverrideJavaArgs=true\nJvmArgs=-XX:+UseZGC\n",
      "Prism Pack/.minecraft/mods/local.jar": "local mod",
      "Prism Pack/.minecraft/config/x.cfg": "x=1",
      "Prism Pack/.minecraft/vitrine.json": '{"preLaunch":"evil"}',
      "Prism Pack/icon.png": "not copied",
    });
    const s = setup(world, content);
    const result = await installPack(s.deps, { file });
    assert.equal(result.id, "Prism Pack");
    assert.equal(result.overrideFiles, 2);
    const dir = versionDir(s.env.root, "Prism Pack");
    assert.equal(await readFile(join(dir, "mods/local.jar"), "utf8"), "local mod");
    await assert.rejects(stat(join(dir, "icon.png")));
    const config = await s.instances.loadConfig("Prism Pack");
    assert.equal(config.memory, 7168);
    assert.equal(config.jvmArgs, "-XX:+UseZGC");
    assert.equal(config.preLaunch, undefined);
    assert.equal(config.modpack?.source, "multimc");
  });
});

describe("loader resolution", () => {
  it("maps a pack's loader version to the maven version the installer needs", async () => {
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 1 }]);
    world.add("/maven/net/minecraftforge/forge/maven-metadata.xml", "<metadata><versioning><versions><version>1.7.10-10.13.4.1614-1.7.10</version><version>1.20.1-47.2.20</version></versions></versioning></metadata>");
    world.add("/maven/net/neoforged/neoforge/maven-metadata.xml", "<metadata><versioning><versions><version>21.1.172</version></versions></versioning></metadata>");
    world.add("/maven/net/neoforged/forge/maven-metadata.xml", "<metadata><versioning><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>");
    content = await startContent();
    const { install } = setup(world, content).deps;
    const meta = install.meta;
    assert.deepEqual(await resolveLoaderChoice(meta, "1.7.10", { kind: "forge", version: "10.13.4.1614" }), { kind: "forge", version: "10.13.4.1614", raw: "1.7.10-10.13.4.1614-1.7.10", meta: { artifact: "forge" } });
    assert.equal((await resolveLoaderChoice(meta, "1.20.1", { kind: "forge", version: "1.20.1-47.2.20" })).raw, "1.20.1-47.2.20", "full maven versions are accepted");
    assert.deepEqual(await resolveLoaderChoice(meta, "1.21.1", { kind: "neoforge", version: "21.1.172" }), { kind: "neoforge", version: "21.1.172", raw: "21.1.172", meta: { artifact: "neoforge" } });
    const legacy = await resolveLoaderChoice(meta, "1.20.1", { kind: "neoforge", version: "47.1.106" });
    assert.equal(legacy.meta?.artifact, "forge");
    // unknown versions fall back to the conventional name instead of failing here
    assert.equal((await resolveLoaderChoice(meta, "1.20.1", { kind: "forge", version: "47.9.9" })).raw, "1.20.1-47.9.9");
    assert.deepEqual(await resolveLoaderChoice(meta, "1.20.1", { kind: "fabric", version: "0.15.11" }), { kind: "fabric", version: "0.15.11" });
  });
});

describe("online packs", () => {
  it("downloads a Modrinth pack by version, records where it came from and detects updates", async () => {
    world = await fabricWorld();
    content = await startContent();
    const c = content;
    const mods = makeMods(c, 5);
    const archive = await zipBuffer({ "modrinth.index.json": JSON.stringify(mrIndexFor(mods)), "overrides/config/x.toml": "x" });
    c.statics.set("/data/PACK1/versions/VER2/Test-Pack-1.2.3.mrpack", archive);
    const version = (id: string, number: string, type = "release") => ({
      id,
      project_id: "PACK1",
      name: number,
      version_number: number,
      game_versions: ["1.20.1"],
      loaders: ["fabric"],
      version_type: type,
      date_published: "2024-05-01T00:00:00Z",
      downloads: 1,
      dependencies: [],
      files: [{ hashes: { sha1: sha1(archive), sha512: sha512(archive) }, url: `https://cdn.modrinth.com/data/PACK1/versions/${id}/Test-Pack-${number}.mrpack`, filename: `Test-Pack-${number}.mrpack`, primary: true, size: archive.length }],
    });
    c.statics.set("/data/PACK1/versions/VER2/Test-Pack-1.2.3.mrpack", archive);
    c.routes.set("GET /modrinth/v2/project/test-pack", (_req, res) => json(res, { id: "PACK1", slug: "test-pack", title: "Test Pack", description: "d", icon_url: "https://cdn.modrinth.com/icon.png", project_type: "modpack", categories: [], game_versions: ["1.20.1"], loaders: ["fabric"], downloads: 1, followers: 1 }));
    c.routes.set("GET /modrinth/v2/project/PACK1/version", (_req, res) => json(res, [version("VER3", "1.3.0", "beta"), version("VER2", "1.2.3"), version("VER1", "1.0.0")]));
    c.routes.set("GET /modrinth/v2/version/VER2", (_req, res) => json(res, version("VER2", "1.2.3")));
    const s = setup(world, content);
    const stages: string[] = [];
    const result = await installOnlinePack(s.online, { source: "modrinth", projectId: "test-pack", versionId: "VER2", hooks: { ...s.hooks, stage: (stage) => stages.push(stage) } });
    assert.equal(result.complete, true);
    assert.equal(result.totalFiles, 5);
    assert.ok(stages.indexOf("pack-download") < stages.indexOf("pack-read"));
    const config = await s.instances.loadConfig(result.id);
    assert.deepEqual({ source: config.modpack?.source, projectId: config.modpack?.projectId, versionId: config.modpack?.versionId, version: config.modpack?.version, iconUrl: config.modpack?.iconUrl }, { source: "modrinth", projectId: "PACK1", versionId: "VER2", version: "1.2.3", iconUrl: "https://cdn.modrinth.com/icon.png" });
    assert.deepEqual(await readdir(join(tmp, "work", "packs")), [], "the downloaded archive is removed afterwards");

    const latest = await latestPackVersion(s.online, config.modpack!);
    assert.equal(latest?.latest.versionId, "VER2", "newest release, not the beta");
    assert.equal(latest?.updateAvailable, false);
    const older = await latestPackVersion(s.online, { ...config.modpack!, versionId: "VER1" });
    assert.equal(older?.updateAvailable, true);
    assert.equal(await latestPackVersion(s.online, { source: "mrpack", name: "local" }), undefined);
  });
});

// ------------------------------------------------------------------ export

describe("exporting", () => {
  it("lists what can be exported and picks sensible defaults", async () => {
    const dir = join(tmp, "game");
    for (const sub of ["mods", "config", "saves/World", "logs", "natives", "screenshots", "resourcepacks", ".vitrine"]) await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, "mods/a.jar"), "a");
    await writeFile(join(dir, "saves/World/level.dat"), "w".repeat(100));
    await writeFile(join(dir, "options.txt"), "o");
    await writeFile(join(dir, "servers.dat"), "s");
    await writeFile(join(dir, "Pack.json"), "{}");
    await writeFile(join(dir, "Pack.jar"), "jar");
    await writeFile(join(dir, "vitrine.json"), "{}");
    await writeFile(join(dir, "vitrine-pack.json"), "{}");
    const candidates = await listExportCandidates(dir, "Pack");
    const names = candidates.map((entry) => entry.path);
    assert.deepEqual(names.filter((name) => ["logs", "natives", ".vitrine", "Pack.json", "Pack.jar", "vitrine.json", "vitrine-pack.json"].includes(name)), []);
    assert.deepEqual(candidates.filter((entry) => entry.defaultInclude).map((entry) => entry.path), ["config", "mods", "resourcepacks"]);
    assert.ok(candidates.find((entry) => entry.path === "saves")?.note);
    assert.equal(candidates.find((entry) => entry.path === "saves")?.size, 100);
    assert.equal(candidates.find((entry) => entry.path === "options.txt")?.defaultInclude, false);
  });

  it("lists known mods as downloads, bundles unknown ones and round-trips through the importer", async () => {
    world = await fabricWorld();
    content = await startContent();
    const c = content;
    const dir = join(tmp, "game");
    await mkdir(join(dir, "mods"), { recursive: true });
    await mkdir(join(dir, "config"), { recursive: true });
    await mkdir(join(dir, "logs"), { recursive: true });
    const known = bytes(2000, 21);
    const unknown = bytes(1500, 22);
    await writeFile(join(dir, "mods/known.jar"), known);
    await writeFile(join(dir, "mods/homebrew.jar"), unknown);
    await writeFile(join(dir, "config/c.toml"), "value = 1\n");
    await writeFile(join(dir, "logs/latest.log"), "never exported");
    await writeFile(join(dir, "options.txt"), "personal");
    c.statics.set("/data/KNOWN/versions/KV1/known.jar", known);
    c.routes.set("POST /modrinth/v2/version_files", (_req, res, _url, body) => {
      const request = JSON.parse(body) as { hashes: string[]; algorithm: string };
      assert.equal(request.algorithm, "sha1");
      const out: Record<string, unknown> = {};
      if (request.hashes.includes(sha1(known))) {
        out[sha1(known)] = { id: "KV1", project_id: "KNOWN", name: "1", version_number: "1", game_versions: ["1.20.1"], loaders: ["fabric"], version_type: "release", date_published: "2024-01-01T00:00:00Z", downloads: 1, dependencies: [], files: [{ hashes: { sha1: sha1(known), sha512: sha512(known) }, url: "https://cdn.modrinth.com/data/KNOWN/versions/KV1/known.jar", filename: "known.jar", primary: true, size: known.length }] };
      }
      json(res, out);
    });
    c.routes.set("GET /modrinth/v2/projects", (_req, res, url) => {
      assert.deepEqual(JSON.parse(url.searchParams.get("ids")!), ["KNOWN"]);
      json(res, [{ id: "KNOWN", slug: "known", title: "Known", description: "d", project_type: "mod", categories: [], game_versions: [], loaders: [], downloads: 1, followers: 1, client_side: "optional", server_side: "unsupported" }]);
    });
    const s = setup(world, content);
    const dest = join(tmp, "out", "My Export.mrpack");
    const progress: string[] = [];
    const result = await exportMrpack({ modrinth: s.modrinth }, { gameDir: dir, instanceId: "Pack", dest, name: "My Export", version: "0.1.0", summary: "exported", mcVersion: "1.20.1", loader: { kind: "fabric", version: "0.15.11" }, include: ["mods", "config", "options.txt", "logs", "../escape"], onProgress: (info) => { if (!progress.includes(info.stage)) progress.push(info.stage); } });
    assert.equal(result.listed, 1);
    assert.equal(result.bundled, 3, "homebrew mod + config + options.txt");
    assert.deepEqual(result.bundledContent, ["mods/homebrew.jar"]);
    assert.match(result.warnings.join(" "), /再分发/);
    assert.match(result.warnings.join(" "), /已忽略不能导出的项目/);
    assert.deepEqual(progress, ["scan", "hash", "lookup", "write"]);
    assert.ok(result.size > 0);

    const zip = await ZipReader.open(dest);
    const names = zip.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["modrinth.index.json", "overrides/config/c.toml", "overrides/mods/homebrew.jar", "overrides/options.txt"]);
    const index = await zip.readJson<Record<string, unknown> & { files: Record<string, unknown>[] }>("modrinth.index.json");
    assert.deepEqual(index.dependencies, { minecraft: "1.20.1", "fabric-loader": "0.15.11" });
    assert.equal(index.files.length, 1);
    assert.deepEqual(index.files[0], { path: "mods/known.jar", hashes: { sha1: sha1(known), sha512: sha512(known) }, env: { client: "optional", server: "unsupported" }, downloads: ["https://cdn.modrinth.com/data/KNOWN/versions/KV1/known.jar"], fileSize: known.length });
    zip.close();

    // what we export, we can import: the listed mod is downloaded, the bundled files come from overrides
    const imported = await installPack(s.deps, { file: dest, name: "Roundtrip" });
    assert.equal(imported.complete, true);
    const roundtrip = versionDir(s.env.root, "Roundtrip");
    assert.deepEqual(await readFile(join(roundtrip, "mods/known.jar")), known);
    assert.deepEqual(await readFile(join(roundtrip, "mods/homebrew.jar")), unknown);
    assert.equal(await readFile(join(roundtrip, "config/c.toml"), "utf8"), "value = 1\n");
  });

  it("bundles everything when Modrinth cannot be reached", async () => {
    world = await fabricWorld();
    content = await startContent();
    content.routes.set("POST /modrinth/v2/version_files", (_req, res) => json(res, { error: "down" }, 503));
    const dir = join(tmp, "game");
    await mkdir(join(dir, "mods"), { recursive: true });
    await writeFile(join(dir, "mods/a.jar"), "a");
    const s = setup(world, content);
    const result = await exportMrpack({ modrinth: s.modrinth }, { gameDir: dir, instanceId: "Pack", dest: join(tmp, "x.mrpack"), name: "X", version: "1", mcVersion: "1.20.1", include: ["mods"] });
    assert.equal(result.listed, 0);
    assert.equal(result.bundled, 1);
    assert.match(result.warnings.join(" "), /无法连接 Modrinth/);
    await assert.rejects(exportMrpack({ modrinth: s.modrinth }, { gameDir: dir, instanceId: "Pack", dest: join(tmp, "y.mrpack"), name: "Y", version: "1", mcVersion: "1.20.1", include: ["nothing-here"] }), /没有选中/);
  });
});
