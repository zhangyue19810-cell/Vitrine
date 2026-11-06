import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { moveMinecraftRoot, sameRootPath } from "../src/mc/game-root";
import { Core } from "../src/core";
import { currentOs } from "../src/util/os";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-root-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("visible Minecraft game root", () => {
  it("moves the launcher-owned folder to the desktop without leaving the source behind", async () => {
    const source = join(tmp, "data", "minecraft");
    const target = join(tmp, "Desktop", "Minecraft");
    await mkdir(join(source, "saves"), { recursive: true });
    await writeFile(join(source, "saves", "level.dat"), "world");
    assert.equal(await moveMinecraftRoot(source, target), "moved");
    assert.equal(await readFile(join(target, "saves", "level.dat"), "utf8"), "world");
    await assert.rejects(access(source));
  });

  it("never overwrites an existing desktop Minecraft folder", async () => {
    const source = join(tmp, "data", "minecraft");
    const target = join(tmp, "Desktop", "Minecraft");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, "old.txt"), "old");
    await writeFile(join(target, "keep.txt"), "keep");
    assert.equal(await moveMinecraftRoot(source, target), "target-exists");
    assert.equal(await readFile(join(source, "old.txt"), "utf8"), "old");
    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
    await assert.rejects(access(join(target, "old.txt")));
    assert.equal(sameRootPath(join(tmp, "A"), join(tmp, "a"), true), true);
  });

  it("switches an empty game-root setting to the desktop and keeps the saves", async () => {
    const dataDir = join(tmp, "data");
    const source = join(dataDir, "minecraft");
    const target = join(tmp, "Desktop", "Minecraft");
    await mkdir(join(source, "saves"), { recursive: true });
    await writeFile(join(source, "saves", "level.dat"), "world-data");
    const core = await Core.create({ dataDir, defaultRoot: target, minecraftCandidates: [source], os: currentOs() });
    try {
      assert.equal(core.root, target);
      assert.equal(core.settings.get().gameRoot, target);
      assert.equal(await readFile(join(target, "saves", "level.dat"), "utf8"), "world-data");
      await assert.rejects(access(source));
    } finally {
      await core.dispose();
    }
  });
});
