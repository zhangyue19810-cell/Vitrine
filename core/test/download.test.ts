import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENGINE, DownloadEngine, type DownloadItem, type EngineSettings, type Progress } from "../src/net/download";
import { HttpClient } from "../src/net/http";
import { bytes, serveBytes, sha1, startMock, type MockServer } from "./helpers/mock-server";

const http = new HttpClient({ userAgent: "vitrine-test" });
after(() => http.destroy());

function engine(overrides: Partial<EngineSettings> = {}) {
  const settings: EngineSettings = { ...DEFAULT_ENGINE, retries: 3, backoffBaseMs: 5, ...overrides };
  return new DownloadEngine(http, () => settings);
}

let dir: string;
let servers: MockServer[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vitrine-dl-"));
});
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  await rm(dir, { recursive: true, force: true });
});
async function mock(handler: Parameters<typeof startMock>[0]) {
  const server = await startMock(handler);
  servers.push(server);
  return server;
}

describe("DownloadEngine", () => {
  it("downloads many small files in parallel and reports consistent progress", async () => {
    const files = Array.from({ length: 200 }, (_, i) => bytes(500 + ((i * 97) % 20000), i + 1));
    const server = await mock((req, res) => {
      const index = Number(/\/f(\d+)$/.exec(req.url!)![1]);
      return serveBytes(req, res, files[index], { delayMs: 15 });
    });
    const items: DownloadItem[] = files.map((data, i) => ({
      urls: [`${server.url}/f${i}`],
      dest: join(dir, "objects", `${i}.bin`),
      size: data.length,
      hash: { sha1: sha1(data) },
    }));
    const snapshots: Progress[] = [];
    const result = await engine({ concurrency: 32 }).run(items, { onProgress: (p) => snapshots.push(p), progressIntervalMs: 20 });
    assert.equal(result.ok, true);
    assert.equal(result.downloaded, 200);
    assert.equal(result.failed.length, 0);
    for (let i = 0; i < files.length; i++) assert.deepEqual(await readFile(join(dir, "objects", `${i}.bin`)), files[i]);
    assert.ok(server.stats.maxActive >= 16, `expected real parallelism, saw ${server.stats.maxActive}`);
    assert.ok(server.stats.maxActive <= 32, `must not exceed the configured lanes, saw ${server.stats.maxActive}`);
    const last = snapshots.at(-1)!;
    assert.equal(last.doneFiles, 200);
    assert.equal(last.bytesDone, last.bytesTotal);
    assert.equal(last.bytesTotal, files.reduce((sum, f) => sum + f.length, 0));
    assert.ok(snapshots.length > 2, "progress should be reported while running");
  });

  it("splits a large file into parallel range requests", async () => {
    const data = bytes(24 * 1024 * 1024, 7);
    const server = await mock((req, res) => serveBytes(req, res, data, { chunk: 256 * 1024 }));
    const item: DownloadItem = { urls: [`${server.url}/big.jar`], dest: join(dir, "big.jar"), size: data.length, hash: { sha1: sha1(data) } };
    const result = await engine({ segments: 4 }).run([item]);
    assert.equal(result.ok, true);
    assert.equal(sha1(await readFile(item.dest)), sha1(data));
    const ranges = server.stats.log.map((entry) => entry.range).filter(Boolean);
    assert.equal(ranges.length, 4, `expected 4 range requests, got ${JSON.stringify(ranges)}`);
    assert.equal(new Set(ranges).size, 4);
    assert.ok(server.stats.maxActive >= 3, "parts must run concurrently");
  });

  it("falls back to a single stream when the server ignores Range", async () => {
    const data = bytes(10 * 1024 * 1024, 9);
    const server = await mock((req, res) => serveBytes(req, res, data, { ranges: false }));
    const item: DownloadItem = { urls: [`${server.url}/x.jar`], dest: join(dir, "x.jar"), size: data.length, hash: { sha1: sha1(data) } };
    const result = await engine({ segments: 4 }).run([item]);
    assert.equal(result.ok, true);
    assert.equal(server.stats.requests, 1);
    assert.equal(sha1(await readFile(item.dest)), sha1(data));
  });

  it("resumes a dropped connection with a Range request", async () => {
    const data = bytes(3 * 1024 * 1024, 3);
    let calls = 0;
    const server = await mock((req, res) => {
      calls++;
      return serveBytes(req, res, data, { dropAfter: calls === 1 ? 1024 * 1024 : undefined });
    });
    const item: DownloadItem = { urls: [`${server.url}/r.bin`], dest: join(dir, "r.bin"), size: data.length, hash: { sha1: sha1(data) } };
    const snapshots: Progress[] = [];
    const result = await engine().run([item], { onProgress: (p) => snapshots.push(p), progressIntervalMs: 10 });
    assert.equal(result.ok, true);
    assert.equal(sha1(await readFile(item.dest)), sha1(data));
    assert.equal(server.stats.requests, 2);
    assert.equal(server.stats.log[0].range, undefined);
    assert.match(server.stats.log[1].range!, /^bytes=\d+-$/);
    assert.ok(Number(/bytes=(\d+)-/.exec(server.stats.log[1].range!)![1]) > 0);
    // A failed attempt must not leave the byte counter above the real total.
    assert.ok(snapshots.every((p) => p.bytesDone <= data.length + 1), "bytesDone must never exceed the file size");
  });

  it("rejects corrupted data, retries, then switches to the next source", async () => {
    const good = bytes(50_000, 5);
    const bad = Buffer.from(good);
    bad[100] ^= 0xff;
    const a = await mock((req, res) => serveBytes(req, res, bad));
    const b = await mock((req, res) => serveBytes(req, res, good));
    const item: DownloadItem = { urls: [`${a.url}/f`, `${b.url}/f`], dest: join(dir, "f.bin"), size: good.length, hash: { sha1: sha1(good) } };
    const result = await engine({ retries: 2 }).run([item]);
    assert.equal(result.ok, true);
    assert.equal(a.stats.requests, 2, "the corrupted source is retried once");
    assert.equal(b.stats.requests, 1);
    assert.deepEqual(await readFile(item.dest), good);
  });

  it("does not retry a 404 on the same URL but moves to the mirror", async () => {
    const data = bytes(1000, 2);
    const a = await mock((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    const b = await mock((req, res) => serveBytes(req, res, data));
    const item: DownloadItem = { urls: [`${a.url}/f`, `${b.url}/f`], dest: join(dir, "f.bin"), size: data.length };
    const result = await engine({ retries: 3 }).run([item]);
    assert.equal(result.ok, true);
    assert.equal(a.stats.requests, 1);
    assert.equal(b.stats.requests, 1);
  });

  it("retries transient 5xx responses", async () => {
    const data = bytes(2000, 4);
    let calls = 0;
    const server = await mock((req, res) => {
      if (++calls <= 2) {
        res.writeHead(503, { "retry-after": "0" });
        res.end("busy");
        return;
      }
      return serveBytes(req, res, data);
    });
    const item: DownloadItem = { urls: [`${server.url}/f`], dest: join(dir, "f.bin"), size: data.length };
    const result = await engine({ retries: 3 }).run([item]);
    assert.equal(result.ok, true);
    assert.equal(server.stats.requests, 3);
  });

  it("reports a failure when every source is unreachable", async () => {
    const dead = await mock((_req, res) => {
      res.end();
    });
    const url = `${dead.url}/gone`;
    await dead.close();
    servers = [];
    const items: DownloadItem[] = [
      { urls: [url], dest: join(dir, "a.bin"), size: 10 },
      { urls: [url], dest: join(dir, "b.bin"), size: 10, optional: true },
    ];
    const result = await engine({ retries: 1 }).run(items);
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 2);
    await assert.rejects(engine({ retries: 1 }).runOrThrow([items[0]]), /failed to download/);
    const optionalOnly = await engine({ retries: 1 }).run([items[1]]);
    assert.equal(optionalOnly.ok, true, "optional failures do not fail the run");
  });

  it("can be cancelled mid-download and leaves no finished file behind", async () => {
    const data = bytes(4 * 1024 * 1024, 11);
    const server = await mock((req, res) => serveBytes(req, res, data, { bytesPerSecond: 500_000 }));
    const item: DownloadItem = { urls: [`${server.url}/slow`], dest: join(dir, "slow.bin"), size: data.length };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await engine({ segmentMinSize: 1 << 30 }).run([item], { signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.ok(Date.now() - started < 3000, "cancellation must be prompt");
    await assert.rejects(stat(item.dest));
  });

  it("honours the speed limit", async () => {
    const data = bytes(1_200_000, 13);
    const server = await mock((req, res) => serveBytes(req, res, data));
    const item: DownloadItem = { urls: [`${server.url}/f`], dest: join(dir, "f.bin"), size: data.length };
    const started = Date.now();
    const result = await engine({ speedLimit: 600_000, segmentMinSize: 1 << 30 }).run([item]);
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.ok(elapsed >= 1200, `limited transfer finished too quickly (${elapsed} ms)`);
    assert.ok(elapsed < 5000, `limited transfer took far too long (${elapsed} ms)`);
  });

  it("skips files that are already valid and re-downloads damaged ones", async () => {
    const files = [bytes(5000, 1), bytes(6000, 2), bytes(7000, 3)];
    const server = await mock((req, res) => serveBytes(req, res, files[Number(req.url!.slice(2))]));
    const items: DownloadItem[] = files.map((data, i) => ({
      urls: [`${server.url}/f${i}`],
      dest: join(dir, `${i}.bin`),
      size: data.length,
      hash: { sha1: sha1(data) },
    }));
    assert.equal((await engine().run(items)).downloaded, 3);
    const before = server.stats.requests;
    const again = await engine().run(items);
    assert.equal(again.skipped, 3);
    assert.equal(server.stats.requests, before, "nothing should be requested for valid files");

    // Same size but different content: only a hash check notices.
    const tampered = Buffer.from(files[1]);
    tampered[0] ^= 1;
    await writeFile(items[1].dest, tampered);
    assert.equal((await engine().findInvalid(items, "size")).length, 0);
    const damaged = await engine().findInvalid(items, "hash");
    assert.deepEqual(damaged.map((item) => item.dest), [items[1].dest]);
    const repaired = await engine().run(items.map((item) => ({ ...item, verify: "hash" as const })));
    assert.equal(repaired.downloaded, 1);
    assert.deepEqual(await readFile(items[1].dest), files[1]);
  });

  it("merges duplicate destinations and their URL lists", async () => {
    const data = bytes(1234, 6);
    const server = await mock((req, res) => serveBytes(req, res, data));
    const dest = join(dir, "same.bin");
    const result = await engine().run([
      { urls: [`${server.url}/a`], dest, size: data.length },
      { urls: [`${server.url}/b`], dest, size: data.length },
    ]);
    assert.equal(result.downloaded, 1);
    assert.equal(server.stats.requests, 1);
  });
});
