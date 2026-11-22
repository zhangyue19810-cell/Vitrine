import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FileSecretStore } from "../src/account/secrets";
import { Core } from "../src/core";
import { HttpClient } from "../src/net/http";
import { aesCbcBase64, aesCbcDecryptBase64, randomSecretKey, rsaNoPaddingHex, weapi, weapiDecrypt, WEAPI_PUBLIC_KEY } from "../src/music/crypto";
import { buildLyrics, lineIndexAt, mergeTranslation, parseLrc, plainLines } from "../src/music/lrc";
import { CookieJar, NeteaseClient, NeteaseError, coverUrl, playableUrl } from "../src/music/netease";
import { MusicService } from "../src/music/service";
import { currentOs } from "../src/util/os";
import { startMockNetease, mockWav, mockCover, type MockNetease } from "./helpers/mock-netease";
import { RpcClient } from "./helpers/ws-client";
import { startWsServer, type WsServer } from "../src/ws-server";

/* eslint-disable @typescript-eslint/no-explicit-any */

const http = () => new HttpClient({ userAgent: "Vitrine/test", getProxy: () => null });

describe("the request envelope", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

  it("the secret key is 16 letters or digits and every call draws a new one", () => {
    const keys = new Set(Array.from({ length: 50 }, () => randomSecretKey()));
    assert.equal(keys.size, 50);
    for (const key of keys) assert.match(key, /^[A-Za-z0-9]{16}$/);
  });

  it("rejection sampling: bytes outside the multiple of 62 are skipped", () => {
    const keys = randomSecretKey((size) => Uint8Array.from({ length: size }, (_, i) => (i % 2 ? 255 : i % 62)));
    assert.equal(keys.length, 16);
    assert.match(keys, /^[A-Za-z0-9]{16}$/);
  });

  it("AES-128-CBC round trips and the output is base64", () => {
    const encrypted = aesCbcBase64('{"a":1,"b":"中文"}', "0CoJUm6Qyw8W8jud");
    assert.match(encrypted, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(aesCbcDecryptBase64(encrypted, "0CoJUm6Qyw8W8jud"), '{"a":1,"b":"中文"}');
  });

  it("a payload survives the whole envelope: two AES rounds and the reversed key through textbook RSA", () => {
    const payload = { s: "雨天", type: 1, limit: 30, offset: 0, total: true, csrf_token: "" };
    const form = weapi(payload, { publicKey: pair.publicKey });
    assert.match(form.encSecKey, /^[0-9a-f]{256}$/);
    assert.deepEqual(weapiDecrypt(form, pair.privateKey), payload);
    assert.notEqual(weapi(payload, { publicKey: pair.publicKey }).params, form.params, "a fresh secret key every time");
  });

  it("a fixed secret key gives a fixed envelope (reproducible for debugging)", () => {
    const a = weapi({ x: 1 }, { publicKey: pair.publicKey, secretKey: "abcdefghijklmnop" });
    const b = weapi({ x: 1 }, { publicKey: pair.publicKey, secretKey: "abcdefghijklmnop" });
    assert.deepEqual(a, b);
    assert.throws(() => weapi({}, { secretKey: "short" }), /16/);
  });

  it("the site's real public key is a 1024 bit RSA key with exponent 65537", () => {
    const jwk = createPublicKey(WEAPI_PUBLIC_KEY).export({ format: "jwk" });
    const modulus = Buffer.from(jwk.n as string, "base64url").toString("hex");
    assert.equal(modulus.length, 256);
    assert.ok(modulus.startsWith("e0b509f6259df864") && modulus.endsWith("0a22b8e7"));
    assert.equal(Buffer.from(jwk.e as string, "base64url").readUIntBE(0, 3), 65537);
    assert.match(rsaNoPaddingHex("abcdefghijklmnop", WEAPI_PUBLIC_KEY), /^[0-9a-f]{256}$/);
  });
});

describe("lyrics", () => {
  it("reads time stamps in all their spellings, several per line, and sorts the lines", () => {
    const lines = parseLrc("[ti:歌名]\n[00:10.5]second\n[00:01.250]first\n[00:20:30]colon\n[01:02]no fraction\n[00:05.00][00:30.00]twice\n\nplain text without stamp");
    assert.deepEqual(
      lines.map((line) => [line.t, line.text]),
      [[1250, "first"], [5000, "twice"], [10500, "second"], [20300, "colon"], [30000, "twice"], [62000, "no fraction"]],
    );
  });

  it("the offset tag shifts every line and never goes below zero", () => {
    assert.deepEqual(parseLrc("[offset:500]\n[00:01.00]a\n[00:00.20]b").map((line) => line.t), [0, 500]);
  });

  it("credit lines in JSON form become ordinary lines", () => {
    const lines = parseLrc('{"t":0,"c":[{"tx":"作词: "},{"tx":"某人"}]}\n{"t":5,"c":[]}\n[00:03.00]唱');
    assert.deepEqual(lines.map((line) => [line.t, line.text]), [[0, "作词: 某人"], [3000, "唱"]]);
  });

  it("the translation is put beside the line that starts at (nearly) the same time, each used once", () => {
    const merged = mergeTranslation(parseLrc("[00:01.00]一\n[00:02.00]二\n[00:03.00]"), parseLrc("[00:01.10]one\n[00:02.00]two\n[00:03.00]three"));
    assert.deepEqual(merged.map((line) => line.trans), ["one", "two", undefined]);
  });

  it("finds the line being sung with a binary search", () => {
    const lines = parseLrc("[00:01.00]a\n[00:03.00]b\n[00:05.00]c");
    assert.equal(lineIndexAt(lines, 0), -1);
    assert.equal(lineIndexAt(lines, 1000), 0);
    assert.equal(lineIndexAt(lines, 4999), 1);
    assert.equal(lineIndexAt(lines, 99999), 2);
    assert.equal(lineIndexAt([], 5), -1);
  });

  it("lyrics without stamps stay readable, 'no lyric' means instrumental", () => {
    assert.deepEqual(plainLines("[by:x]\n第一行\n\n 第二行 ").map((line) => line.text), ["第一行", "第二行"]);
    const untimed = buildLyrics({ lrc: { lyric: "第一行\n第二行" } });
    assert.equal(untimed.timed, false);
    assert.equal(untimed.lines.length, 2);
    assert.equal(untimed.lines[0].t, -1);
    assert.equal(buildLyrics({ nolyric: true }).instrumental, true);
    const timed = buildLyrics({ lrc: { lyric: "[00:01.00]a" }, tlyric: { lyric: "[00:01.00]A" } });
    assert.equal(timed.timed, true);
    assert.equal(timed.hasTranslation, true);
  });
});

describe("addresses and cookies", () => {
  it("covers on NetEase's CDN are upgraded to https and resized; others are left alone; odd schemes are dropped", () => {
    assert.equal(coverUrl("http://p1.music.126.net/abc/1.jpg"), "https://p1.music.126.net/abc/1.jpg?param=256y256");
    assert.equal(coverUrl("http://127.0.0.1:9/cover/1.png"), "http://127.0.0.1:9/cover/1.png");
    assert.equal(coverUrl("javascript:alert(1)"), "");
    assert.equal(coverUrl("ftp://x/y.png"), "");
    assert.equal(coverUrl(""), "");
  });

  it("only NetEase's own hosts and the host the client talks to may serve audio", () => {
    assert.equal(playableUrl("http://m701.music.126.net/a/b.mp3", "https://music.163.com"), "https://m701.music.126.net/a/b.mp3");
    assert.equal(playableUrl("https://evil.example/a.mp3", "https://music.163.com"), undefined);
    assert.equal(playableUrl("https://music.126.net.evil.example/a.mp3", "https://music.163.com"), undefined);
    assert.equal(playableUrl("http://127.0.0.1:5/audio/1.wav", "http://127.0.0.1:5"), "http://127.0.0.1:5/audio/1.wav");
    assert.equal(playableUrl("not a url", "https://music.163.com"), undefined);
  });

  it("the cookie jar keeps what the site sets, replaces it, and honours expiry", () => {
    const jar = new CookieJar({ a: "1" });
    assert.equal(jar.absorb(["MUSIC_U=token; Max-Age=100; Path=/; HttpOnly", "__csrf=x; Path=/"]), true);
    assert.equal(jar.get("MUSIC_U"), "token");
    assert.equal(jar.header({ os: "pc", a: "default" }), "os=pc; a=1; MUSIC_U=token; __csrf=x");
    assert.equal(jar.absorb("MUSIC_U=token; Path=/"), false, "same value: nothing changed");
    assert.equal(jar.absorb("MUSIC_U=; Max-Age=0"), true);
    assert.equal(jar.has("MUSIC_U"), false);
    jar.absorb("__csrf=y; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    assert.equal(jar.has("__csrf"), false);
    assert.deepEqual(jar.toRecord(), { a: "1" });
  });

  it("the stand-in's pictures and sounds are real files", () => {
    assert.deepEqual([...mockCover(7).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const wav = mockWav(3, 1);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.length, 44 + 16000 * 2);
    assert.ok(wav.subarray(44).some((byte) => byte !== 0), "not silence");
  });
});

describe("the client against the stand-in", () => {
  let mock: MockNetease;
  let client: NeteaseClient;
  let jar: CookieJar;

  before(async () => {
    mock = await startMockNetease({ audioSeconds: 2 });
  });
  after(async () => {
    await mock.close();
  });
  const fresh = () => {
    jar = new CookieJar();
    client = new NeteaseClient({ http: http(), cookies: jar, base: mock.url, publicKey: mock.publicKey });
    mock.calls.length = 0;
  };

  it("searches songs and playlists through the encrypted envelope and presents itself like the website", async () => {
    fresh();
    const songs = await client.search("风", "song", 10, 0);
    assert.ok(songs.total > 0);
    assert.ok(songs.items.every((song) => song.name.includes("风") || song.artists.some((artist) => artist.includes("风"))));
    assert.deepEqual(mock.calls[0].payload, { s: "风", type: 1, limit: 10, offset: 0, total: true, csrf_token: "" });
    assert.equal(mock.calls[0].referer, `${mock.url}/`);
    assert.match(mock.calls[0].userAgent, /Mozilla/);
    assert.match(mock.calls[0].cookie, /os=pc/);
    const first = songs.items[0];
    assert.equal(first.cover, `${mock.url}/cover/${first.id}.png`);
    assert.ok(first.durationMs > 0);
    const lists = await client.search("档案", "playlist", 10, 0);
    assert.equal(lists.items[0].name, "雨天的档案室");
  });

  it("a playlist gets all its songs in order, the ones the playlist call only lists by id included", async () => {
    fresh();
    const { playlist, songs } = await client.playlist(3002);
    assert.equal(playlist.name, "深夜航行");
    assert.deepEqual(songs.map((song) => song.id), mock.playlists.find((list) => list.id === 3002)!.songs);
    assert.ok(mock.calls.some((call) => call.path === "v3/song/detail"), "the rest came from song detail");
    assert.equal(songs.find((song) => song.id === 1012)?.unavailable, true, "taken off the shelf");
    assert.equal(songs.find((song) => song.id === 1007)?.fee, 1);
    await assert.rejects(client.playlist(999_999), (error: Error) => error instanceof NeteaseError && error.code === 404);
  });

  it("asks for song details in batches of 100", async () => {
    fresh();
    await client.songs(Array.from({ length: 250 }, (_, i) => 1001 + i));
    assert.equal(mock.calls.filter((call) => call.path === "v3/song/detail").length, 3);
  });

  it("gives the address of a free song, marks a preview for a guest, and finds none for a removed song", async () => {
    fresh();
    const free = await client.source(1001, "exhigh");
    assert.equal(free?.url, `${mock.url}/audio/1001.wav`);
    assert.equal(free?.trial, false);
    assert.equal(mock.calls.at(-1)?.payload.level, "exhigh");
    assert.equal((await client.source(1007))?.trial, true, "a members' song is a preview for a guest");
    assert.equal(await client.source(1012), undefined, "removed from the shelf");
    assert.equal(await client.source(424242), undefined);
  });

  it("falls back to the website's outer chain for a song the main call gives no address for", async () => {
    fresh();
    const before = mock.stats.outer;
    const source = await client.source(1005);
    assert.equal(source?.url, `${mock.url}/audio/1005.wav`);
    assert.equal(mock.stats.outer, before + 1);
  });

  it("reads lyrics with credits, translation and the odd untimed or missing text", async () => {
    fresh();
    const lyrics = await client.lyrics(1001);
    assert.equal(lyrics.timed, true);
    assert.equal(lyrics.hasTranslation, true);
    assert.match(lyrics.lines[0].text, /^作词: /);
    const sung = lyrics.lines.find((line) => line.text.includes("第一页"));
    assert.equal(sung?.trans?.includes("first page"), true);
    assert.equal((await client.lyrics(1003)).timed, false);
    assert.equal((await client.lyrics(1005)).instrumental, true);
  });

  it("charts and recommended playlists", async () => {
    fresh();
    assert.ok((await client.toplists()).every((list) => list.id > 10_000));
    assert.ok((await client.recommendedPlaylists()).length >= 4);
  });

  it("an error code from the service becomes a Chinese message the interface can show", async () => {
    fresh();
    mock.failNext("toplist", -460);
    await assert.rejects(client.toplists(), (error: Error) => error instanceof NeteaseError && error.code === -460 && /风控/.test(error.message));
    mock.failNext("personalized/playlist", 405);
    await assert.rejects(client.recommendedPlaylists(), /太频繁/);
    mock.failNext("personalized/playlist", 12345, "boom");
    await assert.rejects(client.recommendedPlaylists(), /12345.*boom/);
  });

  it("never has more than three requests in flight", async () => {
    const slow = await startMockNetease({ delayMs: 40 });
    try {
      const slowClient = new NeteaseClient({ http: http(), cookies: new CookieJar(), base: slow.url, publicKey: slow.publicKey });
      await Promise.all(Array.from({ length: 10 }, (_, i) => slowClient.search(`q${i}`, "song")));
      assert.equal(slow.calls.length, 10);
      assert.ok(slow.stats.maxActive <= 3, `max ${slow.stats.maxActive}`);
      assert.ok(slow.stats.maxActive >= 2);
    } finally {
      await slow.close();
    }
  });

  it("an answer that is not JSON, or a server error, is reported instead of thrown as a parse error", async () => {
    fresh();
    const broken = new NeteaseClient({ http: http(), cookies: new CookieJar(), base: `${mock.url}/nothing-here`, publicKey: mock.publicKey });
    await assert.rejects(broken.toplists(), (error: Error) => error instanceof NeteaseError && error.code === 404);
  });
});

describe("the service: login, storage and caching", () => {
  let mock: MockNetease;
  let tmp: string;

  before(async () => {
    mock = await startMockNetease({ audioSeconds: 1 });
    tmp = await mkdtemp(join(tmpdir(), "vitrine-music-"));
  });
  after(async () => {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const service = (secrets: FileSecretStore, now?: () => number) => new MusicService({ http: http(), secrets, level: () => "higher", base: mock.url, publicKey: mock.publicKey, now });

  it("logs in with a QR code, keeps the cookies in the secret store and finds them again after a restart", async () => {
    const secrets = new FileSecretStore(join(tmp, "secrets.json"));
    const music = service(secrets);
    assert.deepEqual(await music.status(), { loggedIn: false });
    await assert.rejects(music.dailySongs(), (error: Error) => error instanceof NeteaseError && error.code === 301);

    const qr = await music.qrStart();
    assert.ok(qr.url.startsWith(`${mock.url}/login?codekey=${qr.key}`));
    assert.equal((await music.qrPoll(qr.key)).state, "waiting");
    mock.scan(qr.key);
    assert.equal((await music.qrPoll(qr.key)).state, "scanned");
    mock.confirm(qr.key);
    const done = await music.qrPoll(qr.key);
    assert.equal(done.state, "done");
    assert.equal(done.status?.loggedIn, true);
    assert.equal(done.status?.account?.nickname, "演示用户");
    assert.equal((await music.dailySongs()).length, 8);
    assert.deepEqual((await music.myPlaylists()).map((list) => list.name), ["我喜欢的音乐", "写代码时听"]);
    assert.equal((await music.source(1007))?.trial, false, "a member hears the whole song");

    await music.logout();
    assert.equal((await music.status()).loggedIn, false);
    assert.equal(await secrets.get("music.netease.cookies"), undefined, "nothing left in the store");
    mock.confirm(qr.key); // not valid any more for a new login: ask for a new code
    const second = await music.qrStart();
    mock.confirm(second.key);
    await music.qrPoll(second.key);
    assert.ok(await secrets.get("music.netease.cookies"));

    const restarted = service(new FileSecretStore(join(tmp, "secrets.json")));
    assert.equal((await restarted.status()).account?.nickname, "演示用户");
  });

  it("a code the service does not know is reported as expired", async () => {
    const music = service(new FileSecretStore(join(tmp, "secrets2.json")));
    assert.equal((await music.qrPoll("no-such-key")).state, "expired");
  });

  it("reuses answers for a while and lets parallel callers share one request", async () => {
    let now = 1_000_000;
    const music = service(new FileSecretStore(join(tmp, "secrets3.json")), () => now);
    mock.calls.length = 0;
    await Promise.all(Array.from({ length: 5 }, () => music.toplists()));
    assert.equal(mock.calls.filter((call) => call.path === "toplist").length, 1);
    await music.toplists();
    assert.equal(mock.calls.filter((call) => call.path === "toplist").length, 1);
    now += 31 * 60_000;
    await music.toplists();
    assert.equal(mock.calls.filter((call) => call.path === "toplist").length, 2);
    assert.deepEqual(await music.search("   ", "song"), { items: [], total: 0 }, "an empty search asks nothing");
  });

  it("the sound quality asked for follows the settings", async () => {
    const music = service(new FileSecretStore(join(tmp, "secrets4.json")));
    await music.source(1001);
    assert.equal(mock.calls.at(-1)?.payload.level, "higher");
  });
});

describe("the interface calls", () => {
  let mock: MockNetease;
  let tmp: string;
  let core: Core;
  let server: WsServer;
  let client: RpcClient;

  before(async () => {
    mock = await startMockNetease({ audioSeconds: 1 });
    tmp = await mkdtemp(join(tmpdir(), "vitrine-musicrpc-"));
    core = await Core.create({ dataDir: join(tmp, "data"), os: currentOs(), music: { base: mock.url, publicKey: mock.publicKey } });
    server = await startWsServer({ core, token: "t" });
    client = await RpcClient.open(server.url);
  });
  after(async () => {
    client?.close();
    await server?.close();
    await core?.dispose();
    await mock?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("search, playlist, source and lyrics work end to end through the RPC table", async () => {
    const found = (await client.call("music.search", { kind: "song", query: "钢琴" })) as any;
    assert.equal(found.items[0].name, "钢琴与铁轨");
    const list = (await client.call("music.playlist", { id: 3001 })) as any;
    assert.equal(list.songs.length, 8);
    const source = (await client.call("music.source", { id: 1002 })) as any;
    assert.match(source.url, /\/audio\/1002\.wav$/);
    assert.equal(((await client.call("music.source", { id: 1012 })) as any), null);
    const lyrics = (await client.call("music.lyrics", { id: 1002 })) as any;
    assert.equal(lyrics.timed, true);
  });

  it("refuses bad parameters and reports service errors with a code", async () => {
    await assert.rejects(client.call("music.playlist", { id: "3001" }), /正整数/);
    await assert.rejects(client.call("music.playlist", { id: -3 }), /正整数/);
    await assert.rejects(client.call("music.search", { kind: "album", query: "x" }), /song \/ playlist/);
    await assert.rejects(client.call("music.search", { kind: "song" }), /不能为空/);
    await assert.rejects(client.call("music.daily", {}), (error: any) => error.code === "music-301");
  });

  it("the music settings are validated and stored", async () => {
    const updated = (await client.call("settings.update", { patch: { music: { volume: 5, mode: "shuffle", quality: "standard" }, ui: { cardSize: "large" } } })) as any;
    assert.equal(updated.music.volume, 1);
    assert.equal(updated.music.mode, "shuffle");
    assert.equal(updated.ui.cardSize, "large");
    await assert.rejects(client.call("settings.update", { patch: { music: { mode: "random" } } }), /播放模式/);
    await assert.rejects(client.call("settings.update", { patch: { ui: { cardSize: "huge" } } }), /档案大小/);
    await client.call("settings.update", { patch: { music: { volume: 0.6, mode: "loop", quality: "exhigh" }, ui: { cardSize: "medium" } } });
  });

  it("covers from the music CDN can be fetched as images through the icon call", async () => {
    const song = (await client.call("music.search", { kind: "song", query: "雨" })) as any;
    const icon = (await client.call("content.icon", { url: song.items[0].cover })) as string;
    assert.match(icon, /^data:image\/png;base64,/);
  });
});
