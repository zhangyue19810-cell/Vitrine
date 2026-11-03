import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { decodeModifiedUtf8, encodeModifiedUtf8, getBigInt, getNumber, getString, nbt, parseNbt, toPlain, writeNbt, type NbtRoot } from "../src/world/nbt";
import { addServer, moveServer, readServers, removeServer, updateServer, validateServerAddress } from "../src/world/servers";
import { deleteSave, duplicateSave, exportSave, getSaveSize, importSave, listSaves, readSaveIcon, renameLevel, renameSaveFolder, validateFolderName } from "../src/world/saves";
import { parseAddress, parseChatComponent, parseLegacyMotd, pingServer } from "../src/net/mc-ping";
import { rawZip } from "./helpers/rawzip";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-world-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("NBT", () => {
  const sample = (): NbtRoot => ({
    name: "root",
    tag: nbt.compound({
      b: nbt.byte(-5),
      s: nbt.short(-1234),
      i: nbt.int(2_000_000_000),
      l: nbt.long(-9_000_000_000_000_000_000n),
      f: nbt.float(1.5),
      d: nbt.double(Math.PI),
      str: nbt.string("你好, Minecraft §a"),
      bytes: { type: "byteArray", value: Buffer.from([1, 2, 3, 255]) },
      ints: { type: "intArray", value: [1, -2, 3] },
      longs: { type: "longArray", value: [1n, -2n] },
      list: nbt.list("int", [nbt.int(1), nbt.int(2)]),
      empty: nbt.list("string"),
      nested: nbt.compound({ inner: nbt.compound({ deep: nbt.string("x") }) }),
    }),
  });

  it("round-trips every tag type, uncompressed and gzipped", () => {
    for (const mode of ["none", "gzip"] as const) {
      const back = parseNbt(writeNbt(sample(), mode));
      assert.equal(back.name, "root");
      assert.deepEqual(toPlain(back.tag), toPlain(sample().tag));
    }
  });

  it("keeps the element type of an empty list", () => {
    const back = parseNbt(writeNbt(sample()));
    const empty = (back.tag as { value: Map<string, { type: string; elementType?: string }> }).value.get("empty");
    assert.equal(empty?.type, "list");
    assert.equal(empty?.elementType, "string");
  });

  it("reads typed values through dotted paths", () => {
    const back = parseNbt(writeNbt(sample()));
    assert.equal(getString(back.tag, "nested.inner.deep"), "x");
    assert.equal(getNumber(back.tag, "i"), 2_000_000_000);
    assert.equal(getBigInt(back.tag, "l"), -9_000_000_000_000_000_000n);
    assert.equal(getString(back.tag, "missing.path"), undefined);
    assert.equal(getNumber(back.tag, "str"), undefined);
  });

  it("encodes NUL and supplementary characters as Java's modified UTF-8", () => {
    assert.deepEqual([...encodeModifiedUtf8("a\u0000")], [0x61, 0xc0, 0x80]);
    const emoji = "🙂 方块";
    assert.equal(decodeModifiedUtf8(encodeModifiedUtf8(emoji)), emoji);
    // surrogate pairs are stored as two 3-byte sequences, never a 4-byte one
    assert.equal(encodeModifiedUtf8("🙂").length, 6);
  });

  it("rejects truncated, non-compound and absurdly nested data", () => {
    const good = writeNbt(sample());
    assert.throws(() => parseNbt(good.subarray(0, good.length - 7)), /ends unexpectedly/);
    assert.throws(() => parseNbt(Buffer.from([1, 0, 0, 5])), /NBT/);
    // 600 nested compounds
    const parts: number[] = [10, 0, 0];
    for (let i = 0; i < 600; i++) parts.push(10, 0, 1, 0x61);
    assert.throws(() => parseNbt(Buffer.from(parts)), /nested too deeply|ends unexpectedly/);
  });

  it("refuses to write a list holding mixed tag types", () => {
    const bad: NbtRoot = { name: "", tag: nbt.compound({ l: nbt.list("int", [nbt.int(1), nbt.string("x")]) }) };
    assert.throws(() => writeNbt(bad), /one type/);
  });
});

describe("servers.dat", () => {
  const path = () => join(tmp, "game", "servers.dat");

  it("starts empty and creates the file on first add", async () => {
    assert.deepEqual(await readServers(path()), []);
    const index = await addServer(path(), { name: "  我的服务器 ", ip: " play.example.org:25570 " });
    assert.equal(index, 0);
    assert.deepEqual(await readServers(path()), [{ name: "我的服务器", ip: "play.example.org:25570", icon: undefined, acceptTextures: undefined, hidden: undefined }]);
  });

  it("falls back to the address for a blank name and validates addresses", async () => {
    await addServer(path(), { name: "", ip: "mc.example.org" });
    assert.equal((await readServers(path()))[0].name, "mc.example.org");
    await assert.rejects(addServer(path(), { name: "x", ip: "bad host" }), /空格/);
    await assert.rejects(addServer(path(), { name: "x", ip: "host:70000" }), /端口/);
    assert.equal(validateServerAddress("[::1]:25565"), undefined);
    assert.equal(validateServerAddress("a:b:c"), "服务器地址格式不正确（应为 主机 或 主机:端口）");
    assert.equal(validateServerAddress(""), "服务器地址不能为空");
  });

  it("edits, reorders and removes entries and keeps the previous file as servers.dat_old", async () => {
    await addServer(path(), { name: "A", ip: "a.example.org" });
    await addServer(path(), { name: "B", ip: "b.example.org" });
    await addServer(path(), { name: "C", ip: "c.example.org" });
    await updateServer(path(), 1, { name: "Bee", acceptTextures: true, hidden: true });
    let list = await readServers(path());
    assert.equal(list[1].name, "Bee");
    assert.equal(list[1].acceptTextures, true);
    assert.equal(list[1].hidden, true);
    await updateServer(path(), 1, { acceptTextures: undefined });
    assert.equal((await readServers(path()))[1].acceptTextures, undefined);

    await moveServer(path(), 2, 0);
    assert.deepEqual((await readServers(path())).map((entry) => entry.name), ["C", "A", "Bee"]);
    await removeServer(path(), 1);
    list = await readServers(path());
    assert.deepEqual(list.map((entry) => entry.name), ["C", "Bee"]);

    const old = await readServers(`${path()}_old`);
    assert.equal(old.length, 3, "the copy written just before the last change");
    await assert.rejects(removeServer(path(), 9), /没有这个服务器/);
    await assert.rejects(updateServer(path(), 9, { name: "x" }), /没有这个服务器/);
  });

  it("does not drop fields it does not understand", async () => {
    await addServer(path(), { name: "Keep", ip: "keep.example.org" });
    const root = parseNbt(await readFile(path()));
    const list = (root.tag as { value: Map<string, { value: { value: Map<string, unknown> }[] }> }).value.get("servers")!;
    list.value[0].value.set("customField", nbt.int(42));
    await writeFile(path(), writeNbt(root));

    await updateServer(path(), 0, { name: "Renamed" });
    const after = parseNbt(await readFile(path()));
    assert.equal(getNumber(after.tag, "servers"), undefined);
    const plain = toPlain(after.tag) as { servers: { customField: number; name: string }[] };
    assert.equal(plain.servers[0].customField, 42);
    assert.equal(plain.servers[0].name, "Renamed");
  });
});

// ---------------------------------------------------------------------------------------------- saves

const levelDat = (overrides: { name?: string; lastPlayed?: number; gameType?: number; hardcore?: number; seed?: bigint } = {}) =>
  gzipSync(
    writeNbt({
      name: "",
      tag: nbt.compound({
        Data: nbt.compound({
          LevelName: nbt.string(overrides.name ?? "Test World"),
          LastPlayed: nbt.long(BigInt(overrides.lastPlayed ?? 1_700_000_000_000)),
          GameType: nbt.int(overrides.gameType ?? 1),
          hardcore: nbt.byte(overrides.hardcore ?? 0),
          allowCommands: nbt.byte(1),
          Difficulty: nbt.byte(2),
          DataVersion: nbt.int(3955),
          Version: nbt.compound({ Name: nbt.string("1.21.1"), Id: nbt.int(3955) }),
          WorldGenSettings: nbt.compound({ seed: nbt.long(overrides.seed ?? -4172144997902289642n) }),
        }),
      }),
    }),
  );

async function makeWorld(gameDir: string, folder: string, overrides: Parameters<typeof levelDat>[0] = {}) {
  const dir = join(gameDir, "saves", folder);
  await mkdir(join(dir, "region"), { recursive: true });
  await mkdir(join(dir, "datapacks", "pack-a"), { recursive: true });
  await writeFile(join(dir, "level.dat"), levelDat(overrides));
  await writeFile(join(dir, "region", "r.0.0.mca"), Buffer.alloc(4096, 7));
  await writeFile(join(dir, "datapacks", "bonus.zip"), "zip");
  await writeFile(join(dir, "session.lock"), "lock");
  await writeFile(join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

describe("saves", () => {
  const gameDir = () => join(tmp, "game");

  it("lists worlds with their level.dat details, most recent first", async () => {
    await makeWorld(gameDir(), "old", { name: "Old Base", lastPlayed: 1_600_000_000_000 });
    await makeWorld(gameDir(), "new", { name: "天空之城", lastPlayed: 1_800_000_000_000, gameType: 0, hardcore: 1, seed: 12345n });
    await mkdir(join(gameDir(), "saves", "not-a-world"), { recursive: true });

    const saves = await listSaves(gameDir());
    assert.deepEqual(saves.map((save) => save.folder), ["new", "old"]);
    const first = saves[0];
    assert.equal(first.name, "天空之城");
    assert.equal(first.gameType, "survival");
    assert.equal(first.hardcore, true);
    assert.equal(first.cheats, true);
    assert.equal(first.difficulty, "normal");
    assert.equal(first.version, "1.21.1");
    assert.equal(first.dataVersion, 3955);
    assert.equal(first.seed, "12345");
    assert.equal(first.hasIcon, true);
    assert.deepEqual(first.datapacks, ["bonus.zip", "pack-a"]);
    assert.equal(saves[1].gameType, "creative");
    assert.ok((await readSaveIcon(gameDir(), "new"))?.startsWith("data:image/png;base64,"));
    assert.equal(await readSaveIcon(gameDir(), "ghost"), undefined);
    assert.ok((await getSaveSize(gameDir(), "new")) >= 4096);
  });

  it("reports a world with a damaged level.dat instead of hiding it", async () => {
    const dir = await makeWorld(gameDir(), "broken");
    await writeFile(join(dir, "level.dat"), Buffer.from("not nbt at all"));
    const [save] = await listSaves(gameDir());
    assert.equal(save.folder, "broken");
    assert.match(save.problem ?? "", /level\.dat/);
  });

  it("falls back to level.dat_old when level.dat is missing", async () => {
    const dir = await makeWorld(gameDir(), "recoverable", { name: "Recovered" });
    await rm(join(dir, "level.dat"));
    await writeFile(join(dir, "level.dat_old"), levelDat({ name: "Recovered" }));
    assert.equal((await listSaves(gameDir()))[0].name, "Recovered");
  });

  it("renames the displayed name and keeps level.dat_old", async () => {
    await makeWorld(gameDir(), "w", { name: "Before" });
    await renameLevel(gameDir(), "w", "  After  ");
    assert.equal((await listSaves(gameDir()))[0].name, "After");
    const old = parseNbt(await readFile(join(gameDir(), "saves", "w", "level.dat_old")));
    assert.equal(getString(old.tag, "Data.LevelName"), "Before");
    await assert.rejects(renameLevel(gameDir(), "w", "   "), /不能为空/);
  });

  it("renames and duplicates folders without touching session.lock", async () => {
    await makeWorld(gameDir(), "alpha");
    await renameSaveFolder(gameDir(), "alpha", "beta");
    assert.deepEqual(await readdir(join(gameDir(), "saves")), ["beta"]);
    await makeWorld(gameDir(), "gamma");
    await assert.rejects(renameSaveFolder(gameDir(), "beta", "gamma"), /已经存在/);
    await assert.rejects(renameSaveFolder(gameDir(), "beta", "../escape"), /存档文件夹名无效/);

    const copy = await duplicateSave(gameDir(), "beta");
    assert.notEqual(copy, "beta");
    const files = await readdir(join(gameDir(), "saves", copy));
    assert.ok(files.includes("level.dat"));
    assert.ok(!files.includes("session.lock"));
  });

  it("deletes only folders that are worlds", async () => {
    await makeWorld(gameDir(), "doomed");
    await mkdir(join(gameDir(), "saves", "precious"), { recursive: true });
    await writeFile(join(gameDir(), "saves", "precious", "notes.txt"), "keep me");
    await assert.rejects(deleteSave(gameDir(), "precious"), /不是存档/);
    await assert.rejects(deleteSave(gameDir(), ".."), /存档文件夹名无效/);
    await deleteSave(gameDir(), "doomed");
    assert.deepEqual(await readdir(join(gameDir(), "saves")), ["precious"]);
  });

  it("validates folder names", () => {
    for (const bad of ["", " lead", "trail ", "a/b", "a\\b", "..", ".", "dot.", "q?", "a".repeat(101)]) assert.ok(validateFolderName(bad), `${JSON.stringify(bad)} should be refused`);
    for (const good of ["New World", "我的世界 (1)", "a.b"]) assert.equal(validateFolderName(good), undefined);
  });

  it("exports a world to a zip and imports it back under a free name", async () => {
    await makeWorld(gameDir(), "Showcase");
    const zip = join(tmp, "out", "Showcase.zip");
    const result = await exportSave(gameDir(), "Showcase", zip);
    assert.ok(result.files >= 4);
    assert.ok(result.size > 0);

    const imported = await importSave(gameDir(), zip);
    assert.notEqual(imported, "Showcase", "the original must never be overwritten");
    const names = await readdir(join(gameDir(), "saves", imported));
    assert.ok(names.includes("level.dat") && names.includes("region") && names.includes("datapacks"));
    assert.ok(!names.includes("session.lock"));
    assert.equal((await listSaves(gameDir())).length, 2);
  });

  it("imports archives whose world sits in a subfolder and skips macOS metadata", async () => {
    const zip = join(tmp, "shared.zip");
    await writeFile(
      zip,
      rawZip([
        { name: "__MACOSX/World/level.dat", data: "junk" },
        { name: "pack-readme.txt", data: "hi" },
        { name: "World/level.dat", data: levelDat({ name: "Shared" }) },
        { name: "World/region/r.0.0.mca", data: "region" },
        { name: "World/session.lock", data: "x" },
      ]),
    );
    const folder = await importSave(gameDir(), zip);
    assert.equal(folder, "World");
    assert.deepEqual((await readdir(join(gameDir(), "saves", folder))).sort(), ["level.dat", "region"]);
    assert.equal((await listSaves(gameDir()))[0].name, "Shared");
  });

  it("uses the zip's name when level.dat is at the archive root", async () => {
    const zip = join(tmp, "My Cool Map.zip");
    await writeFile(zip, rawZip([{ name: "level.dat", data: levelDat() }, { name: "data/map_0.dat", data: "m" }]));
    assert.equal(await importSave(gameDir(), zip), "My Cool Map");
  });

  it("refuses archives without level.dat or with path-traversal entries and leaves no half-imported folder", async () => {
    const none = join(tmp, "none.zip");
    await writeFile(none, rawZip([{ name: "readme.txt", data: "no world here" }]));
    await assert.rejects(importSave(gameDir(), none), /level\.dat/);

    const evil = join(tmp, "evil.zip");
    await writeFile(evil, rawZip([{ name: "W/level.dat", data: levelDat() }, { name: "W/../../escaped.txt", data: "pwned" }]));
    await assert.rejects(importSave(gameDir(), evil));
    assert.deepEqual(await readdir(join(gameDir(), "saves")).catch(() => []), []);
    await assert.rejects(readFile(join(tmp, "escaped.txt")));
  });
});

// ---------------------------------------------------------------------------------------------- ping

describe("MOTD parsing", () => {
  it("applies section-sign codes and resets", () => {
    assert.deepEqual(parseLegacyMotd("§aGreen§l Bold§r Plain §cRed"), [
      { text: "Green", color: "#55ff55" },
      { text: " Bold", color: "#55ff55", bold: true },
      { text: " Plain " },
      { text: "Red", color: "#ff5555" },
    ]);
  });

  it("flattens chat components with inheritance", () => {
    const segments = parseChatComponent({ text: "Hello ", color: "gold", bold: true, extra: [{ text: "World", color: "#123456" }, { text: "!", bold: false }] });
    assert.deepEqual(segments, [
      { text: "Hello ", color: "#ffaa00", bold: true },
      { text: "World", color: "#123456", bold: true },
      { text: "!", color: "#ffaa00", bold: false },
    ]);
    assert.deepEqual(parseChatComponent(["a", { text: "b" }]), [{ text: "a" }, { text: "b" }]);
    assert.deepEqual(parseChatComponent(null), []);
  });

  it("parses host and port forms", () => {
    assert.deepEqual(parseAddress("mc.example.org"), { host: "mc.example.org" });
    assert.deepEqual(parseAddress("mc.example.org:25570"), { host: "mc.example.org", port: 25570 });
    assert.deepEqual(parseAddress("[::1]:25565"), { host: "::1", port: 25565 });
    assert.deepEqual(parseAddress("::1"), { host: "::1" });
  });
});

function varInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}
const frame = (id: number, payload: Buffer) => {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
};
const text = (value: string) => Buffer.concat([varInt(Buffer.byteLength(value)), Buffer.from(value)]);

interface FakeServer {
  server: Server;
  port: number;
  handshakes: { protocol: number; host: string; port: number; next: number }[];
  close(): Promise<void>;
}

async function listen(onConnection: (socket: Socket, record: FakeServer["handshakes"]) => void): Promise<FakeServer> {
  const handshakes: FakeServer["handshakes"] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnection(socket, handshakes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    handshakes,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/** A modern server: parse the handshake, answer the status request, echo the ping. */
function modernBehaviour(status: unknown) {
  return (socket: Socket, handshakes: FakeServer["handshakes"]) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        let length = 0;
        let size = 0;
        let shift = 0;
        let ok = false;
        for (let i = 0; i < Math.min(5, buffer.length); i++) {
          length |= (buffer[i] & 0x7f) << shift;
          shift += 7;
          if (!(buffer[i] & 0x80)) {
            size = i + 1;
            ok = true;
            break;
          }
        }
        if (!ok || buffer.length < size + length) return;
        const body = buffer.subarray(size, size + length);
        buffer = Buffer.from(buffer.subarray(size + length));
        if (stage === 0) {
          // handshake: id, protocol, host string, port, next state
          let pos = 1;
          const readVar = () => {
            let value = 0;
            let s = 0;
            for (;;) {
              const byte = body[pos++];
              value |= (byte & 0x7f) << s;
              s += 7;
              if (!(byte & 0x80)) return value;
            }
          };
          const protocol = readVar();
          const hostLength = readVar();
          const host = body.subarray(pos, pos + hostLength).toString();
          pos += hostLength;
          const port = body.readUInt16BE(pos);
          pos += 2;
          handshakes.push({ protocol, host, port, next: readVar() });
          stage = 1;
        } else if (stage === 1) {
          socket.write(frame(0, text(JSON.stringify(status))));
          stage = 2;
        } else {
          socket.write(frame(1, body.subarray(1)));
        }
      }
    });
  };
}

describe("server list ping", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("reads a modern status response, including a coloured MOTD, players, icon and latency", async () => {
    const fake = await listen(
      modernBehaviour({
        version: { name: "Paper 1.21.1", protocol: 767 },
        players: { max: 100, online: 7, sample: [{ name: "Steve", id: "00000000-0000-0000-0000-000000000001" }, { bogus: true }] },
        description: { text: "", extra: [{ text: "琉匣测试服", color: "aqua", bold: true }, { text: "\n§7欢迎" }] },
        favicon: "data:image/png;base64,AAAA",
        enforcesSecureChat: true,
        forgeData: { channels: [] },
      }),
    );
    closers.push(fake.close);
    const status = await pingServer(`127.0.0.1:${fake.port}`, { timeoutMs: 2000 });
    assert.equal(status.version.name, "Paper 1.21.1");
    assert.equal(status.version.protocol, 767);
    assert.deepEqual(status.players, { online: 7, max: 100, sample: [{ name: "Steve", id: "00000000-0000-0000-0000-000000000001" }] });
    assert.equal(status.motdPlain, "琉匣测试服\n欢迎");
    assert.equal(status.motd[0].color, "#55ffff");
    assert.equal(status.motd[0].bold, true);
    assert.equal(status.icon, "data:image/png;base64,AAAA");
    assert.equal(status.modded, true);
    assert.equal(status.enforcesSecureChat, true);
    assert.ok((status.latencyMs ?? 0) >= 1);
    assert.equal(status.legacy, undefined);
    assert.deepEqual(fake.handshakes[0], { protocol: 765, host: "127.0.0.1", port: fake.port, next: 1 });
  });

  it("follows an SRV record only when no port was typed, and sends the typed host in the handshake", async () => {
    const fake = await listen(modernBehaviour({ version: { name: "1.21.1", protocol: 767 }, players: { max: 20, online: 0 }, description: "plain" }));
    closers.push(fake.close);
    let asked = "";
    const resolveSrv = async (name: string) => {
      asked = name;
      return [{ name: "127.0.0.1.", port: fake.port }];
    };
    const status = await pingServer("play.example.test", { timeoutMs: 2000, resolveSrv });
    assert.equal(asked, "_minecraft._tcp.play.example.test");
    assert.equal(status.port, fake.port);
    assert.equal(status.host, "127.0.0.1");
    assert.equal(fake.handshakes[0].host, "play.example.test");

    asked = "";
    await assert.rejects(pingServer("play.example.test:1", { timeoutMs: 500, resolveSrv }));
    assert.equal(asked, "", "an explicit port skips SRV");
  });

  it("falls back to the pre-1.7 ping for old servers", async () => {
    const legacy = await listen((socket) => {
      socket.on("data", (data) => {
        if (data[0] !== 0xfe) return socket.destroy();
        const body = ["§1", "74", "1.6.4", "§6Old §lserver", "3", "20"].join("\u0000");
        const encoded = Buffer.from(body, "utf16le").swap16();
        const header = Buffer.alloc(3);
        header[0] = 0xff;
        header.writeUInt16BE(body.length, 1);
        socket.end(Buffer.concat([header, encoded]));
      });
    });
    closers.push(legacy.close);
    const status = await pingServer(`127.0.0.1:${legacy.port}`, { timeoutMs: 2000 });
    assert.equal(status.legacy, true);
    assert.equal(status.version.name, "1.6.4");
    assert.equal(status.version.protocol, 74);
    assert.deepEqual(status.players, { online: 3, max: 20, sample: [] });
    assert.equal(status.motdPlain, "Old server");
    assert.equal(status.motd[0].color, "#ffaa00");
  });

  it("reports closed ports and silent servers clearly", async () => {
    const dead = await listen(() => {});
    const port = dead.port;
    await dead.close();
    await assert.rejects(pingServer(`127.0.0.1:${port}`, { timeoutMs: 500 }), /ECONNREFUSED/);

    const silent = await listen(() => {});
    closers.push(silent.close);
    const started = Date.now();
    await assert.rejects(pingServer(`127.0.0.1:${silent.port}`, { timeoutMs: 400 }), /没有响应|超时/);
    assert.ok(Date.now() - started < 3000);
  });

  it("can be cancelled", async () => {
    const silent = await listen(() => {});
    closers.push(silent.close);
    const controller = new AbortController();
    const pending = pingServer(`127.0.0.1:${silent.port}`, { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending);
  });
});
