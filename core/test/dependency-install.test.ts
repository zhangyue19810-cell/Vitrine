import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../src/core";
import { currentOs } from "../src/util/os";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-dep-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("one-click dependency install", () => {
  it("resolves an exact Modrinth project and starts an install with the instance filters", async () => {
    const core = await Core.create({ dataDir: join(tmp, "data"), defaultRoot: join(tmp, "mc"), os: currentOs() });
    try {
      let searchOptions: Record<string, unknown> | undefined;
      let taskRequest: Record<string, unknown> | undefined;
      (core as unknown as { requireInstance: unknown }).requireInstance = async () => ({ id: "Test", mcVersion: "1.20.1", loaders: [{ kind: "fabric", version: "0.15.11" }], gameDir: join(tmp, "mc", "versions", "Test") });
      (core.modrinth as unknown as { search: unknown }).search = async (options: Record<string, unknown>) => {
        searchOptions = options;
        return {
          hits: [{ project_id: "P7dR8mSH", slug: "fabric-api", title: "Fabric API", description: "Core library", author: "FabricMC", downloads: 1, categories: ["library"], versions: ["1.20.1"], project_type: "mod", date_modified: "2024-01-01T00:00:00Z" }],
          total_hits: 1,
          offset: 0,
          limit: 10,
        };
      };
      (core as unknown as { installContentTask: unknown }).installContentTask = (request: Record<string, unknown>) => {
        taskRequest = request;
        return { taskId: "task-1" };
      };
      const result = await core.installMissingDependency("Test", "fabric-api");
      assert.deepEqual(result, { taskId: "task-1", title: "Fabric API", source: "modrinth" });
      assert.equal(searchOptions?.query, "fabric-api");
      assert.equal(searchOptions?.gameVersion, "1.20.1");
      assert.equal(searchOptions?.loader, "fabric");
      assert.equal(taskRequest?.instanceId, "Test");
      assert.equal(taskRequest?.projectId, "P7dR8mSH");
      assert.deepEqual(taskRequest?.filter, { gameVersion: "1.20.1", loader: "fabric" });
      assert.equal(taskRequest?.withDependencies, true);
    } finally {
      await core.dispose();
    }
  });
});
