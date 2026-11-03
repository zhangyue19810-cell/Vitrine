import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listResourcePacks, listScreenshots, listShaderPacks, readEnabledResourcePacks, readScreenshot, removePackFile, renamePackFile } from "../src/content/packs-local";
import { zipBuffer } from "./helpers/fake-mojang";

let game: string;
beforeEach(async () => {
  game = await mkdtemp(join(tmpdir(), "vitrine-packs-"));
});
afterEach(async () => {
  await rm(game, { recursive: true, force: true });
});

const png = Buffer.from("89504e470d0a1a0a", "hex");

describe("resource packs", () => {
  it("lists zip and folder packs with description, format, icon and enabled state", async () => {
    const dir = join(game, "resourcepacks");
    await mkdir(join(dir, "Folder Pack"), { recursive: true });
    await writeFile(join(dir, "Faithful.zip"), await zipBuffer({ "pack.mcmeta": JSON.stringify({ pack: { pack_format: 34, description: [{ text: "Faithful ", color: "gold" }, { text: "32x" }] } }), "pack.png": png }));
    await writeFile(join(dir, "Folder Pack", "pack.mcmeta"), '{"pack":{"pack_format":15,"description":"§aFrom a folder"}}');
    await writeFile(join(dir, "Folder Pack", "pack.png"), png);
    await writeFile(join(dir, "notes.txt"), "ignored");
    await writeFile(join(game, "options.txt"), 'lang:zh_cn\nresourcePacks:["vanilla","file/Faithful.zip"]\nincompatibleResourcePacks:[]\n');

    assert.deepEqual([...(await readEnabledResourcePacks(game))], ["vanilla", "Faithful.zip"]);
    const packs = await listResourcePacks(game, { icons: true });
    assert.deepEqual(packs.map((pack) => pack.fileName), ["Faithful.zip", "Folder Pack"], "enabled packs come first");
    assert.equal(packs[0].enabled, true);
    assert.equal(packs[0].description, "Faithful 32x");
    assert.equal(packs[0].packFormat, 34);
    assert.ok(packs[0].icon?.startsWith("data:image/png;base64,"));
    assert.equal(packs[1].kind, "folder");
    assert.equal(packs[1].description, "From a folder");
    assert.equal(packs[1].enabled, false);
    assert.equal((await listResourcePacks(game))[0].icon, undefined, "icons are optional");
  });

  it("keeps broken packs in the list with a reason", async () => {
    const dir = join(game, "resourcepacks");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "no-meta.zip"), await zipBuffer({ "assets/minecraft/x.txt": "x" }));
    await writeFile(join(dir, "garbage.zip"), "this is not a zip");
    await writeFile(join(dir, "bad-json.zip"), await zipBuffer({ "pack.mcmeta": "{ nope" }));
    const packs = await listResourcePacks(game);
    assert.equal(packs.length, 3);
    for (const pack of packs) assert.ok(pack.problem, `${pack.fileName} should explain itself`);
    assert.deepEqual(await listResourcePacks(join(game, "missing")), []);
  });
});

describe("shader packs", () => {
  it("recognises valid shaderpacks and their settings files", async () => {
    const dir = join(game, "shaderpacks");
    await mkdir(join(dir, "FolderShader", "shaders"), { recursive: true });
    await writeFile(join(dir, "BSL.zip"), await zipBuffer({ "shaders/composite.fsh": "// shader" }));
    await writeFile(join(dir, "BSL.zip.txt"), "sunPathRotation=-40");
    await writeFile(join(dir, "NotAShader.zip"), await zipBuffer({ "readme.md": "hi" }));
    const list = await listShaderPacks(game);
    assert.deepEqual(list.map((pack) => [pack.fileName, pack.valid, pack.hasSettings]), [
      ["BSL.zip", true, true],
      ["FolderShader", true, false],
      ["NotAShader.zip", false, false],
    ]);
  });
});

describe("screenshots and file actions", () => {
  it("lists newest first, reads thumbnails and refuses oversized or path-like names", async () => {
    const dir = join(game, "screenshots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "old.png"), png);
    await writeFile(join(dir, "new.png"), Buffer.concat([png, Buffer.alloc(100)]));
    await writeFile(join(dir, "notes.txt"), "x");
    await utimes(join(dir, "old.png"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const shots = await listScreenshots(game);
    assert.deepEqual(shots.map((shot) => shot.fileName), ["new.png", "old.png"]);
    assert.ok((await readScreenshot(game, "old.png"))?.startsWith("data:image/png;base64,"));
    assert.equal(await readScreenshot(game, "new.png", 50), undefined);
    assert.equal(await readScreenshot(game, "nope.png"), undefined);
    await assert.rejects(readScreenshot(game, "../options.txt"), /文件名无效/);
  });

  it("removes and renames only inside the chosen folder", async () => {
    const dir = join(game, "shaderpacks");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.zip"), "zip");
    await writeFile(join(dir, "a.zip.txt"), "settings");
    await writeFile(join(dir, "b.zip"), "zip");
    await renamePackFile(game, "shaderpacks", "b.zip", "c.zip");
    await assert.rejects(renamePackFile(game, "shaderpacks", "c.zip", "a.zip"), /已经存在/);
    await assert.rejects(renamePackFile(game, "shaderpacks", "c.zip", "../escape.zip"), /文件名无效/);
    await removePackFile(game, "shaderpacks", "a.zip");
    assert.deepEqual((await readdir(dir)).sort(), ["c.zip"], "the settings file goes with its shaderpack");
    await assert.rejects(removePackFile(game, "shaderpacks", "ghost.zip"), /不存在/);
    await assert.rejects(removePackFile(game, "shaderpacks", "..\\x"), /文件名无效/);
  });
});
