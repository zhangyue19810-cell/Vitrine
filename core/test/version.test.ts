import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareRangeVersions as compareVersions, versionSatisfies } from "../src/util/version-range";

describe("mod version ranges", () => {
  it("compares numeric and prerelease versions", () => {
    assert.ok((compareVersions("1.20.1", "1.20.0") ?? 0) > 0);
    assert.ok((compareVersions("1.20.1-pre1", "1.20.1") ?? 0) < 0);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
    assert.equal(compareVersions("not-a-version", "1.0"), undefined);
  });

  it("handles Fabric-style ranges", () => {
    assert.equal(versionSatisfies("1.5.0", ">=1.2.0 <2.0.0"), true);
    assert.equal(versionSatisfies("2.0.0", ">=1.2.0 <2.0.0"), false);
    assert.equal(versionSatisfies("1.4.9", "^1.2.3"), true);
    assert.equal(versionSatisfies("2.0.0", "^1.2.3"), false);
    assert.equal(versionSatisfies("1.2.9", "~1.2.3"), true);
    assert.equal(versionSatisfies("1.3.0", "~1.2.3"), false);
    assert.equal(versionSatisfies("1.2.7", "1.2.x"), true);
    assert.equal(versionSatisfies("1.3.0", "1.2.x"), false);
    assert.equal(versionSatisfies("1.0.0-beta", ">=1.0.0"), false);
    assert.equal(versionSatisfies("1.0.0", "*"), true);
    assert.equal(versionSatisfies("1.5.0", "1.0.0 - 2.0.0"), true);
  });

  it("handles Forge Maven intervals", () => {
    assert.equal(versionSatisfies("1.5.0", "[1.0,2.0)"), true);
    assert.equal(versionSatisfies("2.0.0", "[1.0,2.0)"), false);
    assert.equal(versionSatisfies("2.0.0", "(,2.0]"), true);
    assert.equal(versionSatisfies("1.0.0", "[1.0,)"), true);
    assert.equal(versionSatisfies("1.0.0", "[1.0]"), true);
    assert.equal(versionSatisfies("1.0.1", "[1.0]"), false);
  });

  it("does not invent a conflict for unknown data", () => {
    assert.equal(versionSatisfies("unknown", "[1.0,2.0)"), undefined);
    assert.equal(versionSatisfies("1.0.0", "garbage range $$$"), undefined);
  });
});
