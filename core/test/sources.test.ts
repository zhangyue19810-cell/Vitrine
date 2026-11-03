import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SOURCES, SourceRouter, upgradeScheme, type SourceSettings } from "../src/net/sources";

function router(overrides: Partial<SourceSettings> = {}) {
  const settings = { ...DEFAULT_SOURCES, ...overrides };
  return new SourceRouter(() => settings);
}

describe("SourceRouter", () => {
  it("maps Mojang hosts to the mirror root", () => {
    const r = router({ policy: "mirror-first" });
    assert.deepEqual(r.candidates("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"), [
      "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
      "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    ]);
    assert.equal(
      r.toMirror("https://piston-data.mojang.com/v1/objects/abc/client.jar"),
      "https://bmclapi2.bangbang93.com/v1/objects/abc/client.jar",
    );
  });

  it("maps assets and libraries to their own mirror prefixes", () => {
    const r = router();
    assert.equal(
      r.toMirror("https://resources.download.minecraft.net/ab/abcdef"),
      "https://bmclapi2.bangbang93.com/assets/ab/abcdef",
    );
    assert.equal(
      r.toMirror("https://libraries.minecraft.net/com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar"),
      "https://bmclapi2.bangbang93.com/maven/com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar",
    );
  });

  it("maps loader hosts", () => {
    const r = router();
    assert.equal(
      r.toMirror("https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-installer.jar"),
      "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-installer.jar",
    );
    assert.equal(
      r.toMirror("https://meta.fabricmc.net/v2/versions/loader/1.20.1"),
      "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.20.1",
    );
    assert.equal(
      r.toMirror("https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar"),
      "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar",
    );
  });

  it("honours every policy", () => {
    const url = "https://piston-meta.mojang.com/x.json";
    assert.deepEqual(router({ policy: "official-first" }).candidates(url), [url, "https://bmclapi2.bangbang93.com/x.json"]);
    assert.deepEqual(router({ policy: "official-only" }).candidates(url), [url]);
    assert.deepEqual(router({ policy: "mirror-only" }).candidates(url), ["https://bmclapi2.bangbang93.com/x.json"]);
  });

  it("leaves unknown hosts alone", () => {
    const r = router();
    assert.deepEqual(r.candidates("https://example.org/file.jar"), ["https://example.org/file.jar"]);
    assert.deepEqual(router({ policy: "mirror-only" }).candidates("https://example.org/file.jar"), ["https://example.org/file.jar"]);
  });

  it("routes Modrinth and CurseForge content separately from game files", () => {
    const r = router({ contentPolicy: "official-first" });
    const api = "https://api.modrinth.com/v2/project/sodium";
    assert.deepEqual(r.contentCandidates(api), [api, "https://mod.mcimirror.top/modrinth/v2/project/sodium"]);
    assert.deepEqual(r.any(api), r.contentCandidates(api));
    const cdn = "https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar";
    assert.deepEqual(r.any(cdn), [cdn, "https://mod.mcimirror.top/data/AANobbMI/versions/x/sodium.jar"]);
  });

  it("upgrades legacy http urls only for known hosts", () => {
    assert.equal(upgradeScheme("http://files.minecraftforge.net/maven/x"), "https://files.minecraftforge.net/maven/x");
    assert.equal(upgradeScheme("http://example.org/x"), "http://example.org/x");
    assert.equal(upgradeScheme("https://example.org/x"), "https://example.org/x");
  });

  it("applies the upgrade before mapping legacy urls", () => {
    const r = router({ policy: "official-first" });
    assert.deepEqual(r.candidates("http://files.minecraftforge.net/maven/net/minecraftforge/forge/1.7.10/forge.jar"), [
      "https://files.minecraftforge.net/maven/net/minecraftforge/forge/1.7.10/forge.jar",
      "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.7.10/forge.jar",
    ]);
  });
});
