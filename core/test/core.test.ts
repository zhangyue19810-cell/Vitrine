import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../src/core";
import { DEFAULT_OWNER_UUID } from "../src/settings";
import { startWsServer, type WsServer } from "../src/ws-server";
import { currentOs } from "../src/util/os";
import { startFakeMojang, type FakeWorld } from "./helpers/fake-mojang";
import { buildFakeGameJar } from "./helpers/fake-game";
import { RpcClient } from "./helpers/ws-client";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("the core over the development transport", () => {
  let tmp: string;
  let world: FakeWorld;
  let core: Core;
  let server: WsServer;
  let client: RpcClient;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vitrine-core-"));
    const clientJar = await buildFakeGameJar(tmp);
    world = await startFakeMojang([{ id: "1.20.1", assetCount: 6, clientJar, mainClass: "FakeMain" }]);
    core = await Core.create({ dataDir: join(tmp, "data"), version: "9.9.9", os: currentOs() });
    await core.settings.update({
      sources: { policy: "mirror-only", mirrorBase: world.mirrorBase, contentPolicy: "mirror-only" },
      network: { proxy: "none" },
      java: { autoInstall: false },
      launch: { afterLaunch: "minimize" },
    });
    server = await startWsServer({ core, token: "test-token" });
    client = await RpcClient.open(server.url);
  });

  after(async () => {
    client?.close();
    await server?.close();
    core?.games.killAll();
    await core?.dispose();
    await world?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const installFake = async () => {
    const { taskId } = await client.call("instances.create", { name: "fake", mcVersion: "1.20.1" });
    return client.waitForTask(taskId);
  };

  describe("transport security", () => {
    it("refuses connections without the token, from foreign origins and with foreign Host headers", async () => {
      await assert.rejects(RpcClient.open(`ws://127.0.0.1:${server.port}/`), /401/);
      await assert.rejects(RpcClient.open(`ws://127.0.0.1:${server.port}/?token=wrong`), /401/);
      await assert.rejects(RpcClient.open(server.url, { Origin: "https://evil.example" }), /403/);
      await assert.rejects(RpcClient.open(server.url, { Host: "evil.example" }), /403/);
      const ok = await RpcClient.open(server.url, { Origin: "http://localhost:5173" });
      assert.ok(ok.events.length >= 0);
      ok.close();
    });

    it("greets with the version and rejects unknown methods and bad parameters with machine-readable codes", async () => {
      await client.waitFor((event) => event.type === "hello" && event.version === "9.9.9");
      await assert.rejects(client.call("nothing.here"), (error: any) => error.code === "no-method");
      await assert.rejects(client.call("instances.get", {}), (error: any) => error.code === "bad-params");
      await assert.rejects(client.call("instances.get", { id: "ghost" }), (error: any) => error.code === "not-found");
      // inherited object properties are not methods
      await assert.rejects(client.call("constructor"), (error: any) => error.code === "no-method");
    });
  });

  describe("bootstrap and settings", () => {
    it("returns everything the interface needs to draw its first frame", async () => {
      const boot = await client.call("app.bootstrap");
      assert.equal(boot.system.version, "9.9.9");
      assert.equal(boot.settings.accounts.ownerUuid, DEFAULT_OWNER_UUID);
      assert.equal(boot.settings.ui.pauseWhenGameRuns, true);
      assert.equal(boot.settings.ui.whenUnfocused, "pause");
      assert.equal(boot.settings.ui.releaseGpuWhenGameRuns, true);
      assert.equal(boot.settings.ui.theme, "auto");
      assert.ok(Array.isArray(boot.instances) && Array.isArray(boot.accounts) && Array.isArray(boot.tasks));
      assert.ok(boot.jvmPresets.length >= 3);
    });

    it("validates updates, persists them and announces the change", async () => {
      await assert.rejects(client.call("settings.update", { patch: { download: { concurrency: "abc" } } }), /必须是数字/);
      await assert.rejects(client.call("settings.update", { patch: { accounts: { msClientId: "not-a-guid" } } }), /GUID/);
      await assert.rejects(client.call("settings.update", { patch: { ui: { fps: 144 } } }), /帧率上限/);
      await assert.rejects(client.call("settings.update", { patch: { ui: { theme: "sepia" } } }), /界面配色/);
      await assert.rejects(client.call("settings.update", { patch: { ui: { releaseGpuWhenGameRuns: "yes" } } }), /开\/关/);
      const updated = await client.call("settings.update", { patch: { ui: { fps: 60, whenUnfocused: "throttle" }, download: { concurrency: 500 } } });
      assert.equal(updated.ui.fps, 60);
      assert.equal(updated.download.concurrency, 128, "numbers are clamped, not rejected");
      const event = await client.waitFor((e) => e.type === "settings" && e.settings.ui.fps === 60);
      assert.equal(event.settings.ui.whenUnfocused, "throttle");
      const saved = JSON.parse(await readFile(core.paths.settingsFile, "utf8"));
      assert.equal(saved.ui.fps, 60);
      await client.call("settings.update", { patch: { ui: { fps: "auto", whenUnfocused: "pause" }, download: { concurrency: 32 } } });
    });
  });

  describe("installing and launching", () => {
    it("lists versions through the configured mirror", async () => {
      const list = await client.call("versions.list", { force: true });
      assert.ok(list.versions.some((entry: any) => entry.id === "1.20.1"));
    });

    it("installs an instance as a task that walks through its stages", async () => {
      const task = await installFake();
      assert.equal(task.state, "done", task.error);
      const stages = new Set(client.events.filter((e) => e.type === "task" && e.task.id === task.id).map((e) => e.task.stage).filter(Boolean));
      for (const stage of ["version-json", "client-jar", "libraries", "assets"]) assert.ok(stages.has(stage), `missing stage ${stage} (saw ${[...stages].join(",")})`);
      const planned = client.events.find((e) => e.type === "task" && e.task.id === task.id && e.task.stages.length)?.task.stages.map((s: any) => s.id);
      assert.deepEqual(planned, ["version-json", "client-jar", "libraries", "assets"]);
      const labelled = client.events.find((e) => e.type === "task" && e.task.id === task.id && e.task.stage === "assets");
      assert.equal(labelled.task.stageLabel, "下载资源文件");

      const list = await client.call("instances.list");
      const fake = list.find((entry: any) => entry.id === "fake");
      assert.ok(fake?.valid, fake?.problem);
      assert.equal(fake.mcVersion, "1.20.1");
      assert.equal(fake.isolated, true);
      assert.equal(fake.running, false);
      await client.waitFor((e) => e.type === "instances");
    });

    it("rejects creating an instance whose name is taken or invalid", async () => {
      const again = await installFake();
      assert.equal(again.state, "failed");
      assert.match(again.error, /已存在/);
      await assert.rejects(client.call("instances.create", { name: "bad/name", mcVersion: "1.20.1" }), /不能包含/);
    });

    it("explains that a launch needs an account", async () => {
      const { taskId } = await client.call("instances.launch", { id: "fake" });
      const task = await client.waitForTask(taskId);
      assert.equal(task.state, "failed");
      assert.match(task.error, /还没有添加任何账户/);
    });

    it("keeps only editable instance settings", async () => {
      const info = await client.call("instances.setConfig", { id: "fake", patch: { note: "  测试  ", lastPlayed: 1, playTimeMs: 99, modpack: { source: "x" }, bogus: true, memory: 4096, width: 99999 } });
      assert.equal(info.config.note, "测试");
      assert.equal(info.config.memory, 4096);
      assert.equal(info.config.width, 16384);
      assert.equal(info.config.lastPlayed, undefined, "internal fields cannot be written by the interface");
      assert.equal(info.config.playTimeMs, undefined);
      assert.equal(info.config.modpack, undefined);
      assert.equal((info.config as any).bogus, undefined);
      await assert.rejects(client.call("instances.setConfig", { id: "fake", patch: { isolation: "sometimes" } }), /隔离模式/);
      await client.call("instances.setConfig", { id: "fake", patch: { memory: "auto", width: 0, note: null } });
    });

    it("uses the configured owner UUID as the default offline account", async () => {
      const owner = "00112233-4455-4677-8899-aabbccddeeff";
      await client.call("settings.update", { patch: { accounts: { ownerUuid: owner } } });
      const account = await client.call("accounts.addOffline", { name: "Wind", useOwnerUuid: true });
      assert.equal(account.uuid, owner);
      assert.equal(account.type, "offline");
      const list = await client.call("accounts.list");
      assert.equal(list.selected, account.id);
      await assert.rejects(client.call("accounts.addOffline", { name: "x y" }), /玩家名/);
    });

    const waitExit = (gameId: string, timeoutMs = 30_000) => client.waitFor((e) => e.type === "game" && e.game.id === gameId && e.game.state === "exited", timeoutMs, `game ${gameId} to exit`);

    it("launches the game, streams its output and records play time", async () => {
      const { taskId } = await client.call("instances.launch", { id: "fake" });
      const task = await client.waitForTask(taskId);
      assert.equal(task.state, "done", task.error);
      const gameId = task.result.gameId;
      const stages = client.events.filter((e) => e.type === "task" && e.task.id === taskId).map((e) => e.task.stage);
      for (const stage of ["account", "java", "files", "natives", "arguments", "start"]) assert.ok(stages.includes(stage), `missing launch stage ${stage}`);

      const exited = (await waitExit(gameId)).game;
      assert.equal(exited.exitCode, 0);
      assert.equal(exited.crash, undefined, "a clean exit is not analysed");
      const text = (await client.call("games.tail", { id: gameId })).join("\n");
      assert.match(text, /ARGS=--username\|Wind\|--version\|fake\|--gameDir\|/);
      assert.match(text, /--uuid\|00112233445546778899aabbccddeeff/);
      assert.match(text, /中文测试/);
      const info = await client.call("instances.get", { id: "fake" });
      assert.ok(info.config.lastPlayed > 0);
      assert.ok(info.config.playTimeMs >= 0);
      assert.equal(info.running, false);
    });

    it("analyses a crash after the game exits with an error", async () => {
      await client.call("instances.setConfig", { id: "fake", patch: { gameArgs: "oom" } });
      const { taskId } = await client.call("instances.launch", { id: "fake" });
      const gameId = (await client.waitForTask(taskId)).result.gameId;
      const exited = (await waitExit(gameId)).game;
      assert.equal(exited.exitCode, 1);
      assert.equal(exited.crash.analysis.findings[0].id, "out-of-memory");
      assert.equal(exited.crash.analysis.findings[0].fix.kind, "increase-memory");
      const again = await client.call("games.list");
      assert.equal(again.find((game: any) => game.id === gameId).crash.analysis.findings[0].id, "out-of-memory");
    });

    it("stops a running game on request without calling it a crash, and refuses a second launch meanwhile", async () => {
      await client.call("instances.setConfig", { id: "fake", patch: { gameArgs: "sleep" } });
      const { taskId } = await client.call("instances.launch", { id: "fake" });
      const gameId = (await client.waitForTask(taskId)).result.gameId;
      await client.waitFor((e) => e.type === "game" && e.game.id === gameId && (e.game.state === "window" || e.game.state === "running"), 20_000, "the window hint");
      const hint = await client.waitFor((e) => e.type === "after-launch" && e.gameId === gameId);
      assert.equal(hint.mode, "minimize");

      await assert.rejects(client.call("instances.launch", { id: "fake" }), /已经在运行/);
      await assert.rejects(client.call("instances.remove", { id: "fake" }), /正在运行/);
      assert.equal((await client.call("instances.list")).find((entry: any) => entry.id === "fake").running, true);
      assert.equal(await client.call("games.kill", { id: gameId }), true);
      const exited = (await waitExit(gameId)).game;
      assert.equal(exited.stoppedByUser, true);
      assert.equal(exited.crash, undefined);
      assert.equal(await client.call("games.kill", { id: gameId }), false, "already stopped");
      assert.equal(await client.call("games.forget", { id: gameId }), true);
    });

    it("stops pushing game output while the window is hidden and lets the interface catch up afterwards", async () => {
      await client.call("ui.setLevel", { level: "hidden" });
      const before = client.events.length;
      const { taskId } = await client.call("instances.launch", { id: "fake" });
      const gameId = (await client.waitForTask(taskId)).result.gameId;
      await client.waitFor((e) => e.type === "game" && e.game.id === gameId && (e.game.state === "window" || e.game.state === "running"), 20_000);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const lines = client.events.slice(before).filter((e) => e.type === "game-lines" && e.id === gameId);
      assert.equal(lines.length, 0, "no log traffic while hidden");
      await client.call("ui.setLevel", { level: "active" });
      const tail = (await client.call("games.tail", { id: gameId })).join("\n");
      assert.match(tail, /Backend library: LWJGL/, "the lines are still there to fetch");
      client.call("games.kill", { id: gameId });
      await waitExit(gameId);
      await client.call("games.forget", { id: gameId });
    });

    it("streams game output in batches while the window is active", async () => {
      const before = client.events.length;
      const { taskId } = await client.call("instances.launch", { id: "fake" });
      const gameId = (await client.waitForTask(taskId)).result.gameId;
      const batch = await client.waitFor((e) => e.type === "game-lines" && e.id === gameId && e.lines.length > 0, 20_000, "a batch of game lines");
      assert.ok(batch.total >= batch.lines.length);
      assert.ok(client.events.slice(before).filter((e) => e.type === "game-lines").length < 20, "lines come in batches, not one event each");
      client.call("games.kill", { id: gameId });
      await waitExit(gameId);
      await client.call("games.forget", { id: gameId });
    });

    it("exports a launch script that starts the instance without the launcher", async () => {
      await client.call("instances.setConfig", { id: "fake", patch: { gameArgs: "crash-me" } });
      const dest = join(tmp, "scripts", process.platform === "win32" ? "fake.bat" : "fake.sh");
      const result = await client.call("instances.exportScript", { id: "fake", dest });
      assert.equal(result.tokenIncluded, false);
      const script = await readFile(dest, "utf8");
      assert.match(script, /--username/);
      assert.match(script, /Wind/);
      assert.match(script, /crash-me/);
      assert.match(script, /FakeMain/);
      assert.match(script, process.platform === "win32" ? /cd \/d/ : /^#!\/bin\/sh/);
    });

    it("removes an idle instance", async () => {
      await client.call("instances.remove", { id: "fake" });
      assert.equal((await client.call("instances.list")).some((entry: any) => entry.id === "fake"), false);
    });
  });
});
