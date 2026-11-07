import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeMods, hashMods, parseFabricMod, parseLiteMod, parseMcmodInfo, parseModsToml, parseQuiltMod, readModFile, readModIcon, relaxJson, removeModFile, scanMods, setModEnabled } from "../src/content/local-mods";
import { sha1 } from "./helpers/mock-server";
import { zipBuffer } from "./helpers/fake-mojang";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-mods-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const jar = async (name: string, files: Record<string, string | Buffer>, dir = join(tmp, "game", "mods")) => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, await zipBuffer(files));
  return path;
};

describe("mod descriptors", () => {
  it("reads fabric.mod.json", () => {
    const meta = parseFabricMod({
      schemaVersion: 1,
      id: "sodium",
      version: "0.5.8",
      name: "Sodium",
      description: "Fast renderer",
      authors: ["JellySquid", { name: "IMS" }],
      contact: { homepage: "https://example.org/sodium" },
      environment: "client",
      provides: ["rubidium-ish"],
      depends: { fabricloader: ">=0.14.21", minecraft: ["1.20.1", "1.20.2"], "fabric-api": "*" },
      recommends: { indium: "*" },
      suggests: { modmenu: "*" },
      breaks: { optifabric: "*" },
    });
    assert.deepEqual({ id: meta.id, name: meta.name, version: meta.version, environment: meta.environment, authors: meta.authors, homepage: meta.homepage, provides: meta.provides }, { id: "sodium", name: "Sodium", version: "0.5.8", environment: "client", authors: ["JellySquid", "IMS"], homepage: "https://example.org/sodium", provides: ["rubidium-ish"] });
    const kinds = Object.fromEntries(meta.dependencies.map((dep) => [dep.id, dep.kind]));
    assert.deepEqual(kinds, { fabricloader: "required", minecraft: "required", "fabric-api": "required", indium: "recommended", modmenu: "optional", optifabric: "incompatible" });
    assert.equal(meta.dependencies.find((dep) => dep.id === "minecraft")?.version, "1.20.1 || 1.20.2");
    assert.throws(() => parseFabricMod("nope"));
  });

  it("reads quilt.mod.json", () => {
    const meta = parseQuiltMod({
      schema_version: 1,
      quilt_loader: {
        id: "qsl",
        version: "1.0",
        provides: ["quilted_fabric_api", { id: "extra" }],
        depends: ["minecraft", { id: "needed", versions: ">=1" }, { id: "nice", optional: true }],
        breaks: [{ id: "bad", versions: "*" }],
        metadata: { name: "QSL", description: "libs", contributors: { Alice: "Owner", Bob: "Dev" }, contact: { homepage: "https://q.example" } },
      },
    });
    assert.equal(meta.id, "qsl");
    assert.equal(meta.name, "QSL");
    assert.deepEqual(meta.authors, ["Alice", "Bob"]);
    assert.deepEqual(meta.provides, ["quilted_fabric_api", "extra"]);
    assert.deepEqual(meta.dependencies.map((dep) => `${dep.id}:${dep.kind}`), ["minecraft:required", "needed:required", "nice:optional", "bad:incompatible"]);
    assert.throws(() => parseQuiltMod({}), /quilt_loader/);
  });

  it("reads Forge and NeoForge mods.toml, including several mods and placeholder versions", () => {
    const forge = `
modLoader = "javafml"
loaderVersion = "[47,)"
license = "MIT"

[[mods]]
modId = "create"
version = "\${file.jarVersion}"
displayName = "Create"
description = '''Rotation
and more'''
authors = "simibubi, kotakotadev"
displayURL = "https://create.example"
logoFile = "logo.png"

[[mods]]
modId = "flywheel"
version = "1.0"

[[dependencies.create]]
modId = "forge"
mandatory = true
versionRange = "[47,)"
side = "BOTH"

[[dependencies.create]]
modId = "jei"
mandatory = false
versionRange = "*"
`;
    const mods = parseModsToml(forge, { jarVersion: "0.5.1.f" });
    assert.equal(mods.length, 2);
    assert.equal(mods[0].version, "0.5.1.f");
    assert.deepEqual(mods[0].authors, ["simibubi, kotakotadev"]);
    assert.equal(mods[0].loaders[0], "forge");
    assert.deepEqual(mods[0].dependencies.map((dep) => `${dep.id}:${dep.kind}`), ["forge:required", "jei:optional"]);
    assert.equal(parseModsToml(forge, {})[0].version, "unknown");

    const neo = `
modLoader = "javafml"
[[mods]]
modId = "sable"
version = "1.2"
[[dependencies.sable]]
modId = "neoforge"
type = "required"
versionRange = "[21.1,)"
[[dependencies.sable]]
modId = "create"
type = "optional"
[[dependencies.sable]]
modId = "oldmod"
type = "incompatible"
`;
    const parsed = parseModsToml(neo, { neoforgeFile: true });
    assert.equal(parsed[0].loaders[0], "neoforge");
    assert.deepEqual(parsed[0].dependencies.map((dep) => `${dep.id}:${dep.kind}`), ["neoforge:required", "create:optional", "oldmod:incompatible"]);
    // 1.20.2-1.20.4 NeoForge mods still shipped META-INF/mods.toml and depended on "neoforge"
    const transitional = parseModsToml(neo, {});
    assert.equal(transitional[0].loaders[0], "neoforge");
    assert.throws(() => parseModsToml("not = [valid toml", {}));
    assert.throws(() => parseModsToml('modLoader = "javafml"', {}), /no \[\[mods\]\]/);
  });

  it("reads legacy mcmod.info, even when it is sloppy JSON", () => {
    assert.equal(parseMcmodInfo('[{"modid":"jei","name":"Just Enough Items","version":"4.16","authorList":["mezz"],"dependencies":["forge"]}]')[0].authors[0], "mezz");
    assert.equal(parseMcmodInfo('{"modListVersion":2,"modList":[{"modid":"x","name":"X"}]}')[0].id, "x");
    const sloppy = '[{"modid":"old","name":"Old Mod","description":"line one\nline two",},]';
    const [meta] = parseMcmodInfo(sloppy);
    assert.equal(meta.description, "line one line two");
    assert.equal(relaxJson('{"a":"x\ny",}'), '{"a":"x y"}');
    assert.throws(() => parseMcmodInfo("[]"), /no mods/);
    assert.equal(parseLiteMod({ name: "macros", version: "1.2", author: "mumfrey" }).loaders[0], "liteloader");
  });
});

describe("reading mod files", () => {
  it("collects ids provided by jars nested inside a Fabric mod", async () => {
    const inner1 = await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "fabric-resource-loader-v0", version: "1", provides: ["fabric-resources-v0"] }) });
    const inner2 = await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "fabric-api-base", version: "1" }) });
    const path = await jar("fabric-api.jar", {
      "fabric.mod.json": JSON.stringify({ id: "fabric-api", name: "Fabric API", version: "0.92.0", jars: [{ file: "META-INF/jars/a.jar" }, { file: "META-INF/jars/b.jar" }, { file: "META-INF/jars/missing.jar" }] }),
      "META-INF/jars/a.jar": inner1,
      "META-INF/jars/b.jar": inner2,
    });
    const meta = await readModFile(path);
    assert.equal(meta.id, "fabric-api");
    assert.deepEqual([...meta.provides].sort(), ["fabric-api-base", "fabric-resource-loader-v0", "fabric-resources-v0"]);
  });

  it("handles multi-loader jars and descriptors that cannot be read", async () => {
    const both = await jar("multi.jar", {
      "fabric.mod.json": JSON.stringify({ id: "multi", name: "Multi", version: "1" }),
      "META-INF/neoforge.mods.toml": '[[mods]]\nmodId="multi"\nversion="${file.jarVersion}"\ndisplayName="Multi"\n',
      "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\nImplementation-Version: 2.5.0\r\n",
    });
    const fabric = await readModFile(both);
    assert.deepEqual(fabric.loaders.sort(), ["fabric", "neoforge"]);
    assert.equal(fabric.version, "1");
    const neo = await readModFile(both, "neoforge");
    assert.equal(neo.version, "2.5.0");
    const jarless = await jar("plain.jar", { "readme.txt": "x" });
    await assert.rejects(readModFile(jarless), /没有找到模组描述文件/);
    const broken = await jar("broken.jar", { "fabric.mod.json": "{ not json" });
    await assert.rejects(readModFile(broken), /fabric\.mod\.json/);
    await writeFile(join(tmp, "game", "mods", "notazip.jar"), "plain text");
    await assert.rejects(readModFile(join(tmp, "game", "mods", "notazip.jar")));
  });

  it("extracts icons as data URLs", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fabric = await jar("a.jar", { "fabric.mod.json": JSON.stringify({ id: "a", icon: { "16": "assets/a/small.png", "128": "assets/a/big.png" } }), "assets/a/small.png": "small", "assets/a/big.png": png });
    assert.equal(await readModIcon(fabric), `data:image/png;base64,${png.toString("base64")}`);
    const forge = await jar("b.jar", { "META-INF/mods.toml": '[[mods]]\nmodId="b"\nlogoFile="logo.png"\n', "logo.png": png });
    assert.equal(await readModIcon(forge), `data:image/png;base64,${png.toString("base64")}`);
    const none = await jar("c.jar", { "fabric.mod.json": JSON.stringify({ id: "c" }) });
    assert.equal(await readModIcon(none), undefined);
  });
});

describe("scanning and managing mods", () => {
  it("lists mods with metadata, caches parsing and survives bad files", async () => {
    const game = join(tmp, "game");
    const sodium = await jar("sodium-0.5.8.jar", { "fabric.mod.json": JSON.stringify({ id: "sodium", name: "Sodium", version: "0.5.8" }) });
    await jar("lithium.jar.disabled", { "fabric.mod.json": JSON.stringify({ id: "lithium", name: "Lithium", version: "0.11" }) });
    await jar("mystery.jar", { "readme.txt": "?" });
    await writeFile(join(game, "mods", "notes.txt"), "not a mod");
    await mkdir(join(game, "mods", "subfolder"), { recursive: true });
    const progress: number[] = [];
    const mods = await scanMods(game, { onProgress: (done) => progress.push(done) });
    assert.deepEqual(mods.map((mod) => mod.file), ["lithium.jar.disabled", "mystery.jar", "sodium-0.5.8.jar"].sort((a, b) => (mods.find((m) => m.file === a)?.meta?.name ?? a).toLowerCase().localeCompare((mods.find((m) => m.file === b)?.meta?.name ?? b).toLowerCase())));
    const byFile = Object.fromEntries(mods.map((mod) => [mod.file, mod]));
    assert.equal(byFile["lithium.jar.disabled"].disabled, true);
    assert.equal(byFile["lithium.jar.disabled"].path, "mods/lithium.jar.disabled");
    assert.equal(byFile["sodium-0.5.8.jar"].meta?.name, "Sodium");
    assert.match(byFile["mystery.jar"].error ?? "", /没有找到模组描述文件/);
    assert.equal(progress.length, 3);

    // the second scan answers from the cache: a same-size, same-mtime file is not parsed again
    const before = await stat(sodium);
    const swapped = Buffer.from(await readFile(sodium));
    swapped.fill(0x20, 0, 4); // damage the zip header without changing size
    await writeFile(sodium, swapped);
    await utimes(sodium, before.atime, before.mtime);
    const again = await scanMods(game);
    assert.equal(again.find((mod) => mod.file === "sodium-0.5.8.jar")?.meta?.name, "Sodium");
    assert.ok((await readdir(join(game, ".vitrine"))).includes("mods-cache.json"));
    // a real change is noticed
    await writeFile(sodium, await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "sodium", name: "Sodium Updated", version: "0.6" }) }));
    assert.equal((await scanMods(game)).find((mod) => mod.file === "sodium-0.5.8.jar")?.meta?.name, "Sodium Updated");
    assert.deepEqual(await scanMods(join(tmp, "empty")), []);
  });

  it("hashes mods once and remembers the result", async () => {
    const game = join(tmp, "game");
    const path = await jar("a.jar", { "fabric.mod.json": JSON.stringify({ id: "a" }) });
    const mods = await scanMods(game);
    const hashed = await hashMods(game, mods);
    assert.equal(hashed[0].sha1, sha1(await readFile(path)));
    const rescanned = await scanMods(game);
    assert.equal(rescanned[0].sha1, hashed[0].sha1, "hash comes back from the cache");
  });

  it("enables, disables and removes mods without leaving the mods folder", async () => {
    const game = join(tmp, "game");
    await jar("a.jar", { "fabric.mod.json": JSON.stringify({ id: "a" }) });
    assert.equal(await setModEnabled(game, "mods/a.jar", false), "mods/a.jar.disabled");
    assert.equal(await setModEnabled(game, "mods/a.jar.disabled", false), "mods/a.jar.disabled", "already off");
    assert.equal(await setModEnabled(game, "mods/a.jar.disabled", true), "mods/a.jar");
    await writeFile(join(game, "mods", "a.jar.disabled"), "stale copy");
    await assert.rejects(setModEnabled(game, "mods/a.jar", false), /同名文件/);
    await assert.rejects(setModEnabled(game, "../outside.jar", false), /不安全/);
    await assert.rejects(setModEnabled(game, "mods/missing.jar", false), /不存在/);
    await assert.rejects(removeModFile(game, "mods/../options.txt"), /只能删除模组文件/);
    await writeFile(join(game, "options.txt"), "keep");
    await assert.rejects(removeModFile(game, "options.txt"), /只能删除模组文件/);
    await removeModFile(game, "mods/a.jar.disabled");
    assert.deepEqual(await readdir(join(game, "mods")), ["a.jar"]);
  });
});

describe("checking a mod set", () => {
  it("finds duplicates, missing dependencies and declared conflicts, ignoring loader built-ins and disabled files", async () => {
    const game = join(tmp, "game");
    const fabricApiInner = await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "fabric-lifecycle-events-v1" }) });
    await jar("fabric-api.jar", { "fabric.mod.json": JSON.stringify({ id: "fabric-api", name: "Fabric API", jars: [{ file: "META-INF/jars/l.jar" }] }), "META-INF/jars/l.jar": fabricApiInner });
    await jar("good.jar", { "fabric.mod.json": JSON.stringify({ id: "good", name: "Good", depends: { fabricloader: "*", minecraft: "1.20.1", java: ">=17", "fabric-api": "*", "fabric-lifecycle-events-v1": "*" } }) });
    await jar("needy.jar", { "fabric.mod.json": JSON.stringify({ id: "needy", name: "Needy", depends: { geckolib: ">=4", architectury: "*" }, recommends: { optional: "*" } }) });
    await jar("dup-1.jar", { "fabric.mod.json": JSON.stringify({ id: "dup", name: "Dup" }) });
    await jar("dup-2.jar", { "fabric.mod.json": JSON.stringify({ id: "dup", name: "Dup" }) });
    await jar("dup-3.jar.disabled", { "fabric.mod.json": JSON.stringify({ id: "dup", name: "Dup" }) });
    await jar("breaker.jar", { "fabric.mod.json": JSON.stringify({ id: "breaker", name: "Breaker", breaks: { good: "*" } }) });
    await jar("architectury.jar", { "fabric.mod.json": JSON.stringify({ id: "architectury", name: "Architectury" }) });
    const problems = analyzeMods(await scanMods(game));
    const summary = problems.map((problem) => `${problem.kind}:${problem.id}`).sort();
    assert.deepEqual(summary, ["duplicate:dup", "incompatible:good", "missing-dependency:geckolib"]);
    assert.match(problems.find((problem) => problem.kind === "missing-dependency")!.message, /Needy.*geckolib.*>=4/);
    assert.deepEqual(problems.find((problem) => problem.kind === "duplicate")!.files.sort(), ["dup-1.jar", "dup-2.jar"]);
  });

  it("reports a disabled dependency with an enable action and surfaces unreadable jars", async () => {
    const game = join(tmp, "disabled-checks");
    const modsDir = join(game, "mods");
    await jar("api.jar.disabled", { "fabric.mod.json": JSON.stringify({ id: "api", name: "API", version: "1" }) }, modsDir);
    await jar("user.jar", { "fabric.mod.json": JSON.stringify({ id: "user", name: "User", depends: { api: "*" } }) }, modsDir);
    await writeFile(join(modsDir, "broken.jar"), "not a zip");
    const problems = analyzeMods(await scanMods(game), { loaders: ["fabric"] });
    const disabled = problems.find((problem) => problem.kind === "disabled-dependency");
    assert.ok(disabled);
    assert.equal(disabled.id, "api");
    assert.deepEqual(disabled.fix, { kind: "enable-mod", files: ["api.jar.disabled"] });
    assert.match(disabled.message, /已经装了.*被禁用/);
    const unreadable = problems.find((problem) => problem.kind === "unreadable");
    assert.ok(unreadable);
    assert.deepEqual(unreadable.files, ["broken.jar"]);
    assert.match(unreadable.message, /无法读取模组信息/);
  });

  it("groups wrong-loader mods and suggests the loader they actually need", async () => {
    const game = join(tmp, "loader-checks");
    const modsDir = join(game, "mods");
    await jar("one.jar", { "fabric.mod.json": JSON.stringify({ id: "one", name: "One" }) }, modsDir);
    await jar("two.jar", { "fabric.mod.json": JSON.stringify({ id: "two", name: "Two" }) }, modsDir);
    const problems = analyzeMods(await scanMods(game), { loaders: ["forge"] });
    const wrong = problems.filter((problem) => problem.kind === "wrong-loader");
    assert.equal(wrong.length, 1, "one grouped problem per required loader");
    assert.deepEqual(wrong[0].fix, { kind: "switch-loader", loader: "fabric" });
    assert.deepEqual(wrong[0].files.sort(), ["one.jar", "two.jar"]);
    assert.match(wrong[0].message, /当前实例是 forge/);
  });
});
