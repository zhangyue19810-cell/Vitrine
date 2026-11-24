import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WORLD_SCENES, WORLD_SWITCH_MS } from "../../src/worlds";

test("the world carousel has eight unique, bundled Minecraft scenes", () => {
  assert.equal(WORLD_SCENES.length, 8);
  assert.equal(new Set(WORLD_SCENES.map((scene) => scene.id)).size, WORLD_SCENES.length);
  for (const scene of WORLD_SCENES) {
    assert.match(scene.src, /^assets\/worlds\/world-\d{2}-[a-z-]+\.jpg$/);
    assert.ok(existsSync(join(process.cwd(), "public", scene.src)), `${scene.id} is bundled`);
  }
  assert.ok(existsSync(join(process.cwd(), "public", "assets", "worlds", "NOTICE.txt")), "CC BY attribution ships with the scenes");
});

test("the world carousel advances once every ten seconds", () => {
  assert.equal(WORLD_SWITCH_MS, 10_000);
});
