import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENGINE, DownloadEngine } from "../src/net/download";
import { HttpClient } from "../src/net/http";
import { DEFAULT_SOURCES, SourceRouter } from "../src/net/sources";
import { AccountManager } from "../src/account/manager";
import { MicrosoftAuth, type MicrosoftEndpoints } from "../src/account/microsoft";
import { formatUuid, isUuid, offlineUuid, randomUuid, validatePlayerName } from "../src/account/offline";
import { FileSecretStore, MemorySecretStore, plainCipher } from "../src/account/secrets";
import { AuthError } from "../src/account/types";
import { YggdrasilClient, ensureAuthlibInjector, nide8Root } from "../src/account/yggdrasil";
import { sha1, startMock, type MockServer } from "./helpers/mock-server";
import { createHash } from "node:crypto";

const OWNER = "00112233-4455-4677-8899-aabbccddeeff";
const http = new HttpClient({ userAgent: "vitrine-test" });
after(() => http.destroy());

let tmp: string;
let servers: MockServer[] = [];
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-acc-"));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  await rm(tmp, { recursive: true, force: true });
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("offline accounts", () => {
  it("derives the same UUID as Java's nameUUIDFromBytes", () => {
    assert.equal(offlineUuid("Notch"), "b50ad385-829d-3141-a216-7e7d7539ba7f");
    assert.match(offlineUuid("Anything"), /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(formatUuid("00112233445546778899AABBCCDDEEFF"), OWNER);
    assert.equal(isUuid(OWNER), true);
    assert.equal(isUuid(OWNER.replace(/-/g, "")), true);
    assert.equal(isUuid("not-a-uuid"), false);
  });

  it("validates player names", () => {
    assert.equal(validatePlayerName("Wind_01"), undefined);
    assert.ok(validatePlayerName(""));
    assert.ok(validatePlayerName("ab"));
    assert.ok(validatePlayerName("a".repeat(17)));
    assert.ok(validatePlayerName("风"));
    assert.ok(validatePlayerName("has space"));
  });
});

describe("secret store", () => {
  it("persists values through a cipher and survives a reload", async () => {
    const path = join(tmp, "secrets.json");
    const store = new FileSecretStore(path, plainCipher);
    await store.set("a", "hello");
    await store.set("b", "世界");
    assert.equal(await store.get("a"), "hello");
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("hello"), "values are not stored in clear text");
    const again = new FileSecretStore(path, plainCipher);
    assert.equal(await again.get("b"), "世界");
    await again.delete("a");
    assert.equal(await new FileSecretStore(path, plainCipher).get("a"), undefined);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0, "file is private");
  });
});

interface MsState {
  tokenCalls: number;
  deviceCalls: number;
  pendingPolls: number;
  mode: "ok" | "no-xbox" | "no-game" | "app-not-approved" | "declined" | "expired";
  expiresIn: number;
  refreshGeneration: number;
  refreshBad?: boolean;
}

async function startMicrosoftMock(state: MsState): Promise<{ server: MockServer; endpoints: MicrosoftEndpoints }> {
  const server = await startMock(async (req, res) => {
    const url = req.url ?? "";
    const body = await readBody(req);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url === "/devicecode") {
      state.deviceCalls++;
      const form = new URLSearchParams(body);
      assert.equal(form.get("client_id"), "client-123");
      assert.match(form.get("scope")!, /XboxLive\.signin/);
      return json(200, { device_code: "DEV", user_code: "ABCD1234", verification_uri: "https://microsoft.com/link", expires_in: 60, interval: 0.02, message: "go" });
    }
    if (url === "/token") {
      state.tokenCalls++;
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        if (state.refreshBad) return json(400, { error: "invalid_grant", error_description: "expired" });
        state.refreshGeneration++;
        return json(200, { access_token: `ms-access-${state.refreshGeneration}`, refresh_token: `refresh-${state.refreshGeneration}`, expires_in: 3600 });
      }
      if (state.mode === "declined") return json(400, { error: "authorization_declined" });
      if (state.mode === "expired") return json(400, { error: "expired_token" });
      if (state.pendingPolls-- > 0) return json(400, { error: state.pendingPolls % 2 ? "authorization_pending" : "slow_down" });
      return json(200, { access_token: ["ms-", "access-0"].join(""), refresh_token: "refresh-0", expires_in: 3600 });
    }
    if (url === "/xbl") {
      const payload = JSON.parse(body);
      assert.match(payload.Properties.RpsTicket, /^d=ms-access-\d+$/);
      return json(200, { Token: "XBL", DisplayClaims: { xui: [{ uhs: "uhs1" }] } });
    }
    if (url === "/xsts") {
      if (state.mode === "no-xbox") return json(401, { XErr: 2148916233 });
      return json(200, { Token: "XSTS", DisplayClaims: { xui: [{ uhs: "uhs1" }] } });
    }
    if (url === "/login") {
      assert.equal(JSON.parse(body).identityToken, "XBL3.0 x=uhs1;XSTS");
      if (state.mode === "app-not-approved") return json(403, { errorMessage: "Invalid app registration, see https://aka.ms/AppRegInfo for more information" });
      return json(200, { access_token: `mc-token-${state.refreshGeneration}`, expires_in: state.expiresIn });
    }
    if (url === "/profile") {
      assert.match(String(req.headers.authorization), /^Bearer mc-token-\d+$/);
      if (state.mode === "no-game") return json(404, { error: "NOT_FOUND" });
      return json(200, {
        id: OWNER.replace(/-/g, ""),
        name: "WindPlayer",
        skins: [{ state: "ACTIVE", url: "http://textures.example/skin.png", variant: "SLIM" }],
        capes: [{ state: "ACTIVE", url: "http://textures.example/cape.png" }],
      });
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  const base = server.url;
  return {
    server,
    endpoints: { deviceCode: `${base}/devicecode`, token: `${base}/token`, xblAuth: `${base}/xbl`, xstsAuth: `${base}/xsts`, mcLogin: `${base}/login`, mcProfile: `${base}/profile` },
  };
}

const newState = (over: Partial<MsState> = {}): MsState => ({ tokenCalls: 0, deviceCalls: 0, pendingPolls: 2, mode: "ok", expiresIn: 86400, refreshGeneration: 0, ...over });

describe("Microsoft sign-in chain", () => {
  it("walks device code → Xbox → XSTS → Minecraft and reads the profile", async () => {
    const state = newState();
    const { endpoints } = await startMicrosoftMock(state);
    const auth = new MicrosoftAuth(http, () => "client-123", endpoints);
    const { challenge, complete } = await auth.beginDeviceLogin();
    assert.equal(challenge.userCode, "ABCD1234");
    assert.equal(challenge.verificationUri, "https://microsoft.com/link");
    const tokens = await complete();
    assert.equal(tokens.refreshToken, "refresh-0");
    assert.equal(tokens.session.profile.name, "WindPlayer");
    assert.equal(tokens.session.profile.id, OWNER);
    assert.equal(tokens.session.profile.skinVariant, "slim");
    assert.equal(tokens.session.profile.skinUrl, "https://textures.example/skin.png");
    assert.equal(tokens.session.profile.capeUrl, "https://textures.example/cape.png");
    assert.ok(tokens.session.expiresAt > Date.now() + 80_000_000);
    assert.ok(state.tokenCalls >= 3, "pending and slow_down answers keep polling");
  });

  it("requires a client id and maps error responses to clear reasons", async () => {
    const noId = new MicrosoftAuth(http, () => "", (await startMicrosoftMock(newState())).endpoints);
    await assert.rejects(noId.beginDeviceLogin(), (e: unknown) => e instanceof AuthError && e.reason === "no-client-id");

    for (const [mode, reason] of [
      ["no-xbox", "no-xbox-account"],
      ["no-game", "no-game"],
      ["app-not-approved", "app-not-approved"],
      ["declined", "declined"],
      ["expired", "expired"],
    ] as const) {
      const { endpoints } = await startMicrosoftMock(newState({ mode, pendingPolls: 0 }));
      const auth = new MicrosoftAuth(http, () => "client-123", endpoints);
      const { complete } = await auth.beginDeviceLogin();
      await assert.rejects(complete(), (e: unknown) => e instanceof AuthError && e.reason === reason, mode);
    }
  });

  it("can be cancelled while waiting for the user", async () => {
    const { endpoints } = await startMicrosoftMock(newState({ pendingPolls: 10_000 }));
    const auth = new MicrosoftAuth(http, () => "client-123", endpoints);
    const controller = new AbortController();
    const { complete } = await auth.beginDeviceLogin(controller.signal);
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(complete(), (e: Error) => e.name === "AbortError");
  });
});

describe("account manager", () => {
  function manager(endpoints: MicrosoftEndpoints, secrets = new MemorySecretStore(), now = () => Date.now()) {
    return new AccountManager({
      file: join(tmp, "accounts.json"),
      secrets,
      microsoft: new MicrosoftAuth(http, () => "client-123", endpoints),
      yggdrasil: new YggdrasilClient(http),
      ownerUuid: () => OWNER,
      now,
    });
  }
  const dummy: MicrosoftEndpoints = { deviceCode: "", token: "", xblAuth: "", xstsAuth: "", mcLogin: "", mcProfile: "" };

  it("manages offline accounts, including the player's own UUID", async () => {
    const m = manager(dummy);
    const standard = await m.addOffline("Steve");
    assert.equal(standard.uuid, offlineUuid("Steve"));
    const mine = await m.addOffline("Wind", { useOwnerUuid: true });
    assert.equal(mine.uuid, OWNER);
    const custom = await m.addOffline("Other", { uuid: "11111111222233334444555555555555" });
    assert.equal(custom.uuid, "11111111-2222-3333-4444-555555555555");
    await assert.rejects(m.addOffline("x"), /3 到 16/);
    await assert.rejects(m.addOffline("Valid", { uuid: "nope" }), /UUID/);
    assert.equal((await m.list()).length, 3);
    assert.equal(await m.selectedId(), custom.id, "the newest account becomes selected");
    await m.select(mine.id);
    const prepared = await m.prepareLaunch();
    assert.deepEqual(prepared.launch, { name: "Wind", uuid: OWNER, accessToken: "0", userType: "legacy" });
    // persistence
    const reloaded = manager(dummy);
    assert.equal(await reloaded.selectedId(), mine.id);
    assert.equal((await reloaded.list()).length, 3);
    await reloaded.remove(mine.id);
    assert.notEqual(await reloaded.selectedId(), mine.id);
    // same name and uuid is updated, not duplicated
    await reloaded.addOffline("Steve");
    assert.equal((await reloaded.list()).filter((a) => a.name === "Steve").length, 1);
  });

  it("signs in with Microsoft, reuses a fresh token and refreshes an expired one once", async () => {
    const state = newState({ pendingPolls: 0 });
    const { endpoints } = await startMicrosoftMock(state);
    let clock = Date.now();
    const secrets = new MemorySecretStore();
    const m = manager(endpoints, secrets, () => clock);
    const { challenge, done } = await m.beginMicrosoft();
    assert.equal(challenge.userCode, "ABCD1234");
    const account = await done;
    assert.equal(account.type, "microsoft");
    assert.equal(account.name, "WindPlayer");
    assert.equal(account.signedIn, true);
    assert.equal(account.skinUrl, "https://textures.example/skin.png", "http texture URLs are upgraded for the app:// CSP");
    assert.ok(!(await readFile(join(tmp, "accounts.json"), "utf8")).includes("refresh-0"), "tokens are not in accounts.json");

    const before = state.tokenCalls;
    const first = await m.prepareLaunch(account.id);
    assert.equal(first.launch.userType, "msa");
    assert.equal(first.launch.accessToken, "mc-token-0");
    assert.equal(state.tokenCalls, before, "a fresh token needs no refresh");

    clock += 2 * 86400_000; // token expired
    const [a, b] = await Promise.all([m.prepareLaunch(account.id), m.prepareLaunch(account.id)]);
    assert.equal(state.tokenCalls, before + 1, "concurrent launches share one refresh");
    assert.equal(a.launch.accessToken, "mc-token-1");
    assert.equal(b.launch.accessToken, "mc-token-1");
    assert.equal(await secrets.get(`ms:${account.id}:refresh`), "refresh-1", "the rotated refresh token is stored");

    clock += 2 * 86400_000;
    state.refreshBad = true;
    await assert.rejects(m.prepareLaunch(account.id), (e: unknown) => e instanceof AuthError && e.reason === "expired");
  });

  it("logs in to an authlib-injector server and refreshes invalid tokens", async () => {
    const calls: string[] = [];
    let valid = true;
    let base = "";
    const server = await startMock(async (req, res) => {
      const url = req.url ?? "";
      const body = await readBody(req);
      calls.push(`${req.method} ${url}`);
      const json = (status: number, payload?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (url === "/") {
        res.writeHead(200, { "x-authlib-injector-api-location": `${base}/api/yggdrasil/`, "content-type": "text/html" });
        return void res.end("<html>skin site</html>");
      }
      if (url === "/api/yggdrasil" || url === "/api/yggdrasil/") return json(200, { meta: { serverName: "Test Skin Server" }, skinDomains: ["skin.test"] });
      if (url === "/api/yggdrasil/authserver/authenticate") {
        const payload = JSON.parse(body);
        if (payload.password !== "pw") return json(403, { error: "ForbiddenOperationException", errorMessage: "Invalid credentials." });
        return json(200, { accessToken: "ygg-1", clientToken: payload.clientToken, availableProfiles: [{ id: "aaaaaaaabbbbccccddddeeeeeeeeeeee", name: "First" }, { id: OWNER.replace(/-/g, ""), name: "Second" }] });
      }
      if (url === "/api/yggdrasil/authserver/refresh") {
        const payload = JSON.parse(body);
        return json(200, { accessToken: `ygg-${calls.length}`, clientToken: payload.clientToken, selectedProfile: payload.selectedProfile, availableProfiles: [] });
      }
      if (url === "/api/yggdrasil/authserver/validate") return json(valid ? 204 : 403);
      json(404, {});
    });
    servers.push(server);
    base = server.url;

    const { endpoints } = await startMicrosoftMock(newState());
    const m = manager(endpoints);
    await assert.rejects(m.loginAuthlib(base, "me@example.com", "wrong"), /账号或密码错误/);
    const pick = await m.loginAuthlib(base, "me@example.com", "pw");
    assert.equal(pick.account, undefined);
    assert.deepEqual(pick.profiles?.map((p) => p.name), ["First", "Second"]);
    const result = await m.loginAuthlib(base, "me@example.com", "pw", { profileId: OWNER });
    assert.equal(result.account?.name, "Second");
    assert.equal(result.account?.uuid, OWNER);
    assert.equal(result.account?.serverName, "Test Skin Server");
    assert.equal(result.account?.server, `${base}/api/yggdrasil`, "the API location header is followed");

    const ready = await m.prepareLaunch(result.account!.id);
    assert.equal(ready.launch.userType, "mojang");
    assert.equal(ready.authlib?.root, `${base}/api/yggdrasil`);
    assert.ok(ready.authlib?.prefetched, "metadata is kept for authlib-injector's prefetch");
    assert.equal(JSON.parse(Buffer.from(ready.authlib!.prefetched!, "base64").toString()).meta.serverName, "Test Skin Server");

    valid = false;
    const refreshed = await m.prepareLaunch(result.account!.id);
    assert.match(refreshed.launch.accessToken, /^ygg-\d+$/);
    assert.notEqual(refreshed.launch.accessToken, ready.launch.accessToken);
    assert.equal(nide8Root("abc123"), "https://auth.mc-user.com:233/abc123");
  });
});

describe("authlib-injector download", () => {
  it("fetches the latest agent through the mirror and verifies its checksum", async () => {
    const jar = Buffer.from("fake-agent-jar");
    const sha256 = createHash("sha256").update(jar).digest("hex");
    let base = "";
    const server = await startMock(async (req, res) => {
      if (req.url === "/mirrors/authlib-injector/artifact/latest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ build_number: 53, version: "1.2.5", download_url: "https://authlib-injector.yushi.moe/artifact/53/authlib-injector-1.2.5.jar", checksums: { sha256 } }));
      } else if (req.url === "/mirrors/authlib-injector/artifact/53/authlib-injector-1.2.5.jar") {
        res.writeHead(200);
        res.end(jar);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    base = server.url;
    const router = new SourceRouter(() => ({ ...DEFAULT_SOURCES, policy: "mirror-only", mirrorBase: base }));
    const engine = new DownloadEngine(http, () => ({ ...DEFAULT_ENGINE, backoffBaseMs: 5, retries: 1 }));
    const path = await ensureAuthlibInjector({ http, router, engine, dir: join(tmp, "authlib") });
    assert.equal(await readFile(path, "utf8"), "fake-agent-jar");
    assert.match(path, /authlib-injector-1\.2\.5\.jar$/);
    const hits = server.stats.requests;
    await ensureAuthlibInjector({ http, router, engine, dir: join(tmp, "authlib") });
    assert.equal(server.stats.requests, hits + 1, "an existing valid jar is reused (only latest.json is fetched)");
    // offline: falls back to whatever jar is already there
    await server.close();
    servers = [];
    assert.equal(await ensureAuthlibInjector({ http, router, engine, dir: join(tmp, "authlib") }), path);
    assert.equal(sha1(jar).length, 40);
  });
});
