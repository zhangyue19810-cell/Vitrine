import { join } from "node:path";
import type { DownloadEngine } from "../net/download";
import type { HttpClient } from "../net/http";
import type { SourceRouter } from "../net/sources";
import { ensureDir, exists, hashFile } from "../util/fsx";
import { formatUuid } from "./offline";
import { AuthError } from "./types";

export interface YggProfile {
  id: string;
  name: string;
}

export interface YggMeta {
  /** Normalised API root (no trailing slash). */
  root: string;
  serverName: string;
  /** Raw metadata response, base64, for authlib-injector's prefetch option. */
  prefetched: string;
}

export interface YggSession {
  accessToken: string;
  clientToken: string;
  selected?: YggProfile;
  profiles: YggProfile[];
}

export function nide8Root(serverId: string): string {
  return `https://auth.mc-user.com:233/${serverId.trim()}`;
}

async function readText(response: { body: AsyncIterable<unknown> }): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export class YggdrasilClient {
  constructor(private readonly http: HttpClient) {}

  /** Resolve an API root (following the authlib-injector API location header) and fetch its metadata. */
  async fetchMeta(input: string, signal?: AbortSignal): Promise<YggMeta> {
    let url = input.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let response;
    try {
      response = await this.http.request(url, { signal, timeoutMs: 15_000 });
    } catch (error) {
      throw new AuthError(`无法连接认证服务器：${(error as Error).message}`, "network");
    }
    let text = await readText(response);
    const location = response.headers["x-authlib-injector-api-location"];
    let root = url;
    if (location) {
      root = new URL(Array.isArray(location) ? location[0] : location, url).toString();
      if (root !== url) {
        const second = await this.http.request(root, { signal, timeoutMs: 15_000 }).catch((error) => {
          throw new AuthError(`无法连接认证服务器：${(error as Error).message}`, "network");
        });
        text = await readText(second);
      }
    }
    root = root.replace(/\/+$/, "");
    let meta: { meta?: { serverName?: string } };
    try {
      meta = JSON.parse(text);
    } catch {
      throw new AuthError("这个地址不是有效的 Yggdrasil（外置登录）API。", "unknown");
    }
    return { root, serverName: meta.meta?.serverName ?? new URL(root).host, prefetched: Buffer.from(text, "utf8").toString("base64") };
  }

  private async post(root: string, path: string, payload: unknown, signal?: AbortSignal) {
    let response;
    try {
      response = await this.http.request(`${root}${path}`, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json", accept: "application/json" },
        signal,
        timeoutMs: 20_000,
      });
    } catch (error) {
      throw new AuthError(`无法连接认证服务器：${(error as Error).message}`, "network");
    }
    const text = await readText(response);
    let json: Record<string, unknown> | undefined;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  }

  private static parseSession(json: Record<string, unknown>, clientToken: string): YggSession {
    const norm = (p?: { id?: string; name?: string }): YggProfile | undefined => (p?.id && p.name ? { id: formatUuid(p.id), name: p.name } : undefined);
    const profiles = ((json.availableProfiles as { id: string; name: string }[] | undefined) ?? []).map((p) => norm(p)!).filter(Boolean);
    return { accessToken: String(json.accessToken), clientToken: String(json.clientToken ?? clientToken), selected: norm(json.selectedProfile as { id: string; name: string } | undefined), profiles };
  }

  async authenticate(root: string, username: string, password: string, clientToken: string, signal?: AbortSignal): Promise<YggSession> {
    const result = await this.post(root, "/authserver/authenticate", { agent: { name: "Minecraft", version: 1 }, username, password, clientToken, requestUser: true }, signal);
    if (result.status !== 200 || !result.json?.accessToken) {
      const message = String(result.json?.errorMessage ?? result.text.slice(0, 120));
      throw new AuthError(result.status === 403 ? "账号或密码错误。" : `登录失败（HTTP ${result.status}）：${message}`, result.status === 403 ? "invalid-credentials" : "unknown", result.json);
    }
    return YggdrasilClient.parseSession(result.json, clientToken);
  }

  async refresh(root: string, accessToken: string, clientToken: string, selected?: YggProfile, signal?: AbortSignal): Promise<YggSession> {
    const payload: Record<string, unknown> = { accessToken, clientToken, requestUser: true };
    if (selected) payload.selectedProfile = { id: selected.id.replace(/-/g, ""), name: selected.name };
    const result = await this.post(root, "/authserver/refresh", payload, signal);
    if (result.status !== 200 || !result.json?.accessToken) {
      throw new AuthError("外置登录已过期，请重新登录。", "invalid-credentials", result.json);
    }
    const session = YggdrasilClient.parseSession(result.json, clientToken);
    return { ...session, selected: session.selected ?? selected };
  }

  async validate(root: string, accessToken: string, clientToken: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.post(root, "/authserver/validate", { accessToken, clientToken }, signal);
    return result.status === 204 || result.status === 200;
  }
}

export interface InjectorDeps {
  http: HttpClient;
  router: SourceRouter;
  engine: DownloadEngine;
  dir: string;
}

interface LatestJson {
  build_number: number;
  version: string;
  download_url: string;
  checksums?: { sha256?: string };
}

const LATEST = "https://authlib-injector.yushi.moe/artifact/latest.json";

/** Download (or find) the authlib-injector agent jar. */
export async function ensureAuthlibInjector(deps: InjectorDeps, signal?: AbortSignal): Promise<string> {
  await ensureDir(deps.dir);
  let latest: LatestJson | undefined;
  for (const url of deps.router.candidates(LATEST)) {
    try {
      latest = await deps.http.getJson<LatestJson>(url, { signal, timeoutMs: 15_000 });
      if (latest?.download_url) break;
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
    }
  }
  if (latest?.download_url) {
    const dest = join(deps.dir, `authlib-injector-${latest.version}.jar`);
    const sha256 = latest.checksums?.sha256;
    if (!(await exists(dest)) || (sha256 && (await hashFile(dest, "sha256")) !== sha256.toLowerCase())) {
      const result = await deps.engine.run([{ urls: deps.router.candidates(latest.download_url), dest, hash: sha256 ? { sha256 } : undefined, label: "authlib-injector", group: "authlib" }], { signal });
      if (!result.ok) throw new AuthError(`无法下载 authlib-injector：${result.failed[0]?.error}`, "network");
    }
    return dest;
  }
  const { readdir } = await import("node:fs/promises");
  const existing = (await readdir(deps.dir).catch(() => [])).filter((name) => /^authlib-injector-.*\.jar$/.test(name)).sort().reverse();
  if (existing.length) return join(deps.dir, existing[0]);
  throw new AuthError("无法获取 authlib-injector（外置登录需要它）。请检查网络。", "network");
}
