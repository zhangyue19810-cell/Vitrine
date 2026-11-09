import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskManager, type TaskEvent, type TaskSnapshot } from "../src/tasks";
import type { LaneState, Progress } from "../src/net/download";
import { sleep } from "../src/util/async";

const lane = (n: number): LaneState => ({ lane: n, state: "downloading", label: `file-${n}`, host: "example.org", received: n, total: 100, parts: 1, attempt: 0 });
const progress = (done: number, total = 100): Progress => ({
  totalFiles: total,
  doneFiles: done,
  skippedFiles: 0,
  failedFiles: 0,
  bytesTotal: total * 10,
  bytesDone: done * 10,
  speed: 1000,
  eta: 1,
  elapsedMs: 10,
  lanes: [lane(1), lane(2), lane(3)],
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
};

const record = (manager: TaskManager) => {
  const events: TaskEvent[] = [];
  manager.onEvent((event) => events.push(event));
  return events;
};
const snapshots = (events: TaskEvent[]) => events.flatMap((event) => (event.type === "task" ? [event.task] : []));

describe("TaskManager", () => {
  it("runs a task, publishes stages in order and keeps the result", async () => {
    const manager = new TaskManager();
    const events = record(manager);
    const { id, promise } = manager.start({
      kind: "install",
      title: "安装 1.21.1",
      run: async (ctx) => {
        ctx.plan([{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]);
        ctx.stage("a");
        ctx.stage("b", "2/9");
        ctx.log("hello");
        return { ok: true };
      },
    });
    assert.deepEqual(await promise, { ok: true });
    const snaps = snapshots(events).filter((task) => task.id === id);
    assert.equal(snaps[0].state, "queued");
    assert.ok(snaps.some((task) => task.state === "running"));
    const mid = snaps.find((task) => task.stage === "b");
    assert.deepEqual(mid?.stages.map((stage) => stage.state), ["done", "active", "pending"]);
    assert.equal(mid?.stageDetail, "2/9");
    const last = snaps[snaps.length - 1];
    assert.equal(last.state, "done");
    assert.equal(last.fraction, 1);
    assert.ok(last.stages.every((stage) => stage.state === "done"));
    assert.deepEqual(manager.get(id)?.result, { ok: true });
    assert.ok(manager.get(id)?.log.includes("hello"));
    assert.ok(events.some((event) => event.type === "task-log" && event.lines.includes("hello")));
  });

  it("parses 'stage:detail' names such as processors:3/12", async () => {
    const manager = new TaskManager();
    const { id, promise } = manager.start({
      kind: "install",
      title: "t",
      run: async (ctx) => {
        ctx.plan([{ id: "processors", label: "处理" }]);
        ctx.stage("processors:3/12");
        assert.equal(manager.get(ctx.id)?.stage, "processors");
        assert.equal(manager.get(ctx.id)?.stageDetail, "3/12");
      },
    });
    await promise;
    assert.equal(manager.get(id)?.state, "done");
  });

  it("labels stages and keeps the plan intact when an unplanned stage appears", async () => {
    const manager = new TaskManager({ labels: { extra: "额外步骤" } });
    const { id, promise } = manager.start({
      kind: "install",
      title: "t",
      run: async (ctx) => {
        ctx.plan([{ id: "a", label: "第一步" }, { id: "b", label: "第二步" }]);
        ctx.stage("a");
        ctx.stage("extra");
        const snap = manager.get(ctx.id)!;
        assert.equal(snap.stageLabel, "额外步骤");
        assert.deepEqual(snap.stages.map((stage) => stage.state), ["active", "pending"], "an unplanned stage must not complete the plan");
        ctx.stage("b");
        assert.equal(manager.get(ctx.id)?.stageLabel, "第二步");
        assert.deepEqual(manager.get(ctx.id)?.stages.map((stage) => stage.state), ["done", "active"]);
      },
    });
    await promise;
    assert.equal(manager.get(id)?.state, "done");
  });

  it("records failures with a readable message and a machine code", async () => {
    const manager = new TaskManager();
    const { id, promise } = manager.start({
      kind: "launch",
      title: "x",
      lane: "launch",
      run: async () => {
        throw Object.assign(new Error("需要重新登录"), { reason: "expired" });
      },
    });
    await assert.rejects(promise, /需要重新登录/);
    const task = manager.get(id)!;
    assert.equal(task.state, "failed");
    assert.equal(task.error, "需要重新登录");
    assert.equal(task.errorCode, "expired");
    assert.ok(task.log.some((line) => line.includes("需要重新登录")));
  });

  it("cancels running work through its signal and queued work immediately", async () => {
    const manager = new TaskManager({ maxConcurrent: 1 });
    let started = 0;
    const slow = manager.start({
      kind: "install",
      title: "slow",
      run: async (ctx) => {
        started++;
        await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      },
    });
    const queued = manager.start({ kind: "install", title: "queued", run: async () => void started++ });
    await sleep(20);
    assert.equal(manager.get(queued.id)?.state, "queued");
    assert.equal(await manager.cancel(queued.id), true);
    assert.equal(manager.get(queued.id)?.state, "cancelled");
    assert.equal(await manager.cancel(slow.id), true);
    await assert.rejects(slow.promise);
    assert.equal(manager.get(slow.id)?.state, "cancelled");
    assert.equal(manager.get(slow.id)?.error, undefined, "a cancellation is not an error");
    assert.equal(started, 1, "the cancelled queued task never ran");
    assert.equal(await manager.cancel(slow.id), false);
    await manager.idle();
  });

  it("limits parallel installs but never makes a launch wait", async () => {
    const manager = new TaskManager({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const gate = deferred();
    const install = () =>
      manager.start({
        kind: "install",
        title: "i",
        run: async () => {
          active++;
          peak = Math.max(peak, active);
          await gate.promise;
          active--;
        },
      });
    const installs = [install(), install(), install(), install()];
    await sleep(20);
    assert.equal(active, 2);
    let launched = false;
    const launch = manager.start({ kind: "launch", title: "play", lane: "launch", run: async () => void (launched = true) });
    await launch.promise;
    assert.equal(launched, true, "launch bypasses the install queue");
    gate.resolve();
    await Promise.all(installs.map((entry) => entry.promise));
    assert.equal(peak, 2);
  });

  it("publishes progress by how closely the interface is watching", async () => {
    const manager = new TaskManager();
    const events = record(manager);
    const release = deferred();
    const { id, promise } = manager.start({
      kind: "install",
      title: "dl",
      run: async (ctx) => {
        ctx.stage("files");
        for (let i = 1; i <= 50; i++) ctx.progress(progress(i), "files");
        await release.promise;
        for (let i = 51; i <= 60; i++) ctx.progress(progress(i), "files");
        await sleep(10);
      },
    });
    await sleep(250);
    const published = () => snapshots(events).filter((task) => task.id === id && task.progress);
    // 50 rapid updates collapse into a handful of events while active …
    assert.ok(published().length >= 1 && published().length <= 3, `got ${published().length}`);
    assert.equal(published()[0].progress?.lanes.length, 3, "lanes are included in the foreground");
    assert.ok((published().at(-1)!.fraction ?? 0) > 0);

    // … and the lanes disappear when the window is in the background.
    manager.setUiLevel("background");
    const before = published().length;
    release.resolve();
    await sleep(900);
    const later = published().slice(before);
    assert.ok(later.length >= 1);
    assert.ok(later.every((task) => task.progress?.lanes.length === 0 || task.state !== "running"), "no lane detail in the background");
    await promise;
    assert.equal(manager.get(id)?.state, "done");
  });

  it("goes quiet while hidden and catches up the moment the window returns", async () => {
    const manager = new TaskManager();
    manager.setUiLevel("hidden");
    const events = record(manager);
    const release = deferred();
    const { id, promise } = manager.start({
      kind: "install",
      title: "dl",
      run: async (ctx) => {
        ctx.stage("files");
        ctx.log("line 1");
        for (let i = 1; i <= 30; i++) ctx.progress(progress(i), "files");
        await release.promise;
      },
    });
    await sleep(300);
    const quietCount = events.length;
    assert.ok(quietCount <= 5, `hidden windows get state changes only (got ${quietCount})`);
    assert.equal(events.some((event) => event.type === "task-log"), false, "log lines are held back while hidden");

    manager.setUiLevel("active");
    const caughtUp = snapshots(events).filter((task) => task.id === id).at(-1)!;
    assert.equal(caughtUp.progress?.doneFiles, 30, "the latest numbers arrive immediately");
    assert.ok(events.some((event) => event.type === "task-log" && event.lines.includes("line 1")), "held log lines are flushed");
    release.resolve();
    await promise;
  });

  it("returns live pending progress through get even when event publication is throttled", async () => {
    const manager = new TaskManager();
    manager.setUiLevel("hidden");
    const release = deferred();
    const { id, promise } = manager.start({
      kind: "install",
      title: "dl",
      run: async (ctx) => {
        ctx.stage("files");
        ctx.progress(progress(25), "files");
        await release.promise;
      },
    });
    await sleep(30);
    const live = manager.get(id)!;
    assert.equal(live.progress?.doneFiles, 25, "the downloads page can poll the newest progress without waiting for a throttled event");
    assert.equal(live.fraction, 0.25);
    release.resolve();
    await promise;
  });

  it("keeps terminal state events immediate regardless of the level", async () => {
    const manager = new TaskManager();
    manager.setUiLevel("hidden");
    const events = record(manager);
    const { id, promise } = manager.start({ kind: "other", title: "quick", run: async () => 1 });
    await promise;
    const states = snapshots(events).filter((task) => task.id === id).map((task) => task.state);
    assert.deepEqual(states.filter((state, index) => state !== states[index - 1]), ["queued", "running", "done"]);
  });

  it("clears finished tasks and trims old history", async () => {
    const manager = new TaskManager();
    const events = record(manager);
    for (let i = 0; i < 130; i++) await manager.start({ kind: "other", title: `t${i}`, run: async () => i }).promise;
    assert.equal(manager.list().length, 100, "history is bounded");
    assert.ok(events.some((event) => event.type === "task-removed"));
    const running = deferred();
    const live = manager.start({ kind: "other", title: "live", run: () => running.promise });
    await sleep(5);
    const removed = manager.clearFinished();
    assert.equal(removed.length, 100);
    assert.deepEqual(manager.list().map((task: TaskSnapshot) => task.id), [live.id]);
    running.resolve();
    await live.promise;
  });
});
