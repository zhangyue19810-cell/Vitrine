import type { HttpClient } from "../net/http";
import { sleep } from "../util/async";
import { formatUuid } from "./offline";
import { AuthError, type LoginChallenge } from "./types";

export interface MicrosoftEndpoints {
  deviceCode: string;
  token: string;
  xblAuth: string;
  xstsAuth: string;
  mcLogin: string;
  mcProfile: string;
}

export const MS_ENDPOINTS: MicrosoftEndpoints = {
  deviceCode: "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode",
  token: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
  xblAuth: "https://user.auth.xboxlive.com/user/authenticate",
  xstsAuth: "https://xsts.auth.xboxlive.com/xsts/authorize",
  mcLogin: "https://api.minecraftservices.com/authentication/login_with_xbox",
  mcProfile: "https://api.minecraftservices.com/minecraft/profile",
};

export const MS_SCOPE = "XboxLive.signin offline_access";

export interface MinecraftSession {
  accessToken: string;
  /** Unix ms. */
  expiresAt: number;
  profile: { id: string; name: string; skinUrl?: string; skinVariant?: "classic" | "slim"; capeUrl?: string };
}

export interface MicrosoftTokens {
  refreshToken: string;
  /** The Azure application that issued this refresh token. */
  clientId: string;
  session: MinecraftSession;
}

interface Raw {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
}

async function send(
  http: HttpClient,
  url: string,
  options: { method?: string; body?: string; contentType?: string; bearer?: string; signal?: AbortSignal },
): Promise<Raw> {
  let response;
  try {
    response = await http.request(url, {
      method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
      body: options.body,
      signal: options.signal,
      timeoutMs: 20_000,
      headers: {
        accept: "application/json",
        ...(options.contentType ? { "content-type": options.contentType } : {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      },
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new AuthError(`无法连接到 ${new URL(url).host}：${(error as Error).message}`, "network");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

/** Microsoft texture URLs are often http; the app UI only permits https images. */
export const secureMinecraftTextureUrl = (value: string | undefined): string | undefined => value?.replace(/^http:\/\//i, "https://");

const XSTS_ERRORS: Record<number, [AuthError["reason"], string]> = {
  2148916233: ["no-xbox-account", "这个微软账户还没有 Xbox 账户。请先到 xbox.com 创建 Xbox 档案，然后再登录。"],
  2148916235: ["region-blocked", "你所在的国家或地区不提供 Xbox 服务，无法使用该账户登录。"],
  2148916236: ["adult-verification", "该账户需要先完成成人身份验证（Xbox 页面上的年龄验证）。"],
  2148916237: ["adult-verification", "该账户需要先完成成人身份验证（Xbox 页面上的年龄验证）。"],
  2148916238: ["child-account", "这是未成年人账户，需要家长在 Microsoft 家庭组中将其添加后才能登录。"],
};

export class MicrosoftAuth {
  constructor(
    private readonly http: HttpClient,
    private readonly getClientId: () => string | undefined,
    private readonly endpoints: MicrosoftEndpoints = MS_ENDPOINTS,
  ) {}

  private clientId(): string {
    const id = this.getClientId()?.trim();
    if (!id) throw new AuthError("还没有配置微软登录用的 Azure 应用（Client ID）。请先在 设置 → 账户 中填写。", "no-client-id");
    return id;
  }

  /** Step 1 of the device-code flow: ask Microsoft for a code the user enters in a browser. */
  async beginDeviceLogin(signal?: AbortSignal): Promise<{ challenge: LoginChallenge; complete: () => Promise<MicrosoftTokens> }> {
    const clientId = this.clientId();
    const start = await send(this.http, this.endpoints.deviceCode, { body: form({ client_id: clientId, scope: MS_SCOPE }), contentType: "application/x-www-form-urlencoded", signal });
    if (start.status !== 200 || !start.json?.device_code) {
      throw new AuthError(`微软登录请求失败：${start.json?.error_description ?? start.text.slice(0, 160)}`, start.json?.error === "invalid_client" ? "app-not-approved" : "unknown", start.json);
    }
    const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn, interval, message } = start.json;
    const challenge: LoginChallenge = { userCode, verificationUri, expiresIn, message };
    const complete = async (): Promise<MicrosoftTokens> => {
      const deadline = Date.now() + expiresIn * 1000;
      let wait = Number(interval) > 0 ? Number(interval) : 5;
      while (Date.now() < deadline) {
        await sleep(wait * 1000, signal);
        const poll = await send(this.http, this.endpoints.token, {
          body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode }),
          contentType: "application/x-www-form-urlencoded",
          signal,
        });
        if (poll.status === 200 && poll.json?.access_token) return this.finish(poll.json.access_token, poll.json.refresh_token, clientId, signal);
        const error = poll.json?.error as string | undefined;
        if (error === "authorization_pending") continue;
        if (error === "slow_down") {
          wait += 5;
          continue;
        }
        if (error === "authorization_declined") throw new AuthError("你在微软页面上拒绝了登录请求。", "declined");
        if (error === "expired_token" || error === "bad_verification_code") throw new AuthError("验证码已过期，请重新开始登录。", "expired");
        throw new AuthError(`微软登录失败：${poll.json?.error_description ?? poll.text.slice(0, 160)}`, "unknown", poll.json);
      }
      throw new AuthError("验证码已过期，请重新开始登录。", "expired");
    };
    return { challenge, complete };
  }

  /** Exchange a stored refresh token for a fresh Minecraft session. */
  async refresh(refreshToken: string, signal?: AbortSignal, clientIdOverride?: string): Promise<MicrosoftTokens> {
    const clientId = clientIdOverride?.trim() || this.clientId();
    const response = await send(this.http, this.endpoints.token, {
      body: form({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, scope: MS_SCOPE }),
      contentType: "application/x-www-form-urlencoded",
      signal,
    });
    if (response.status !== 200 || !response.json?.access_token) {
      const expired = ["invalid_grant", "interaction_required"].includes(response.json?.error);
      throw new AuthError(expired ? "微软登录已过期，请重新登录。" : `刷新微软登录失败：${response.json?.error_description ?? response.text.slice(0, 160)}`, expired ? "expired" : "unknown", response.json);
    }
    return this.finish(response.json.access_token, response.json.refresh_token ?? refreshToken, clientId, signal);
  }

  private async finish(msAccessToken: string, refreshToken: string, clientId: string, signal?: AbortSignal): Promise<MicrosoftTokens> {
    return { refreshToken, clientId, session: await this.sessionFromMicrosoftToken(msAccessToken, signal) };
  }

  /** Microsoft access token → Xbox Live → XSTS → Minecraft services → profile. */
  async sessionFromMicrosoftToken(msAccessToken: string, signal?: AbortSignal): Promise<MinecraftSession> {
    const json = "application/json";
    const xbl = await send(this.http, this.endpoints.xblAuth, {
      body: JSON.stringify({ Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msAccessToken}` }, RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT" }),
      contentType: json,
      signal,
    });
    if (xbl.status !== 200 || !xbl.json?.Token) throw new AuthError(`Xbox Live 登录失败（HTTP ${xbl.status}）`, "unknown", xbl.json);
    const userHash = xbl.json.DisplayClaims?.xui?.[0]?.uhs as string | undefined;

    const xsts = await send(this.http, this.endpoints.xstsAuth, {
      body: JSON.stringify({ Properties: { SandboxId: "RETAIL", UserTokens: [xbl.json.Token] }, RelyingParty: "rp://api.minecraftservices.com/", TokenType: "JWT" }),
      contentType: json,
      signal,
    });
    if (xsts.status !== 200 || !xsts.json?.Token) {
      const known = XSTS_ERRORS[Number(xsts.json?.XErr)];
      if (known) throw new AuthError(known[1], known[0], xsts.json);
      throw new AuthError(`Xbox 授权失败（HTTP ${xsts.status}）`, "unknown", xsts.json);
    }
    const hash = (xsts.json.DisplayClaims?.xui?.[0]?.uhs as string | undefined) ?? userHash;
    if (!hash) throw new AuthError("Xbox 授权响应缺少用户哈希", "unknown", xsts.json);

    const login = await send(this.http, this.endpoints.mcLogin, {
      body: JSON.stringify({ identityToken: `XBL3.0 x=${hash};${xsts.json.Token}` }),
      contentType: json,
      signal,
    });
    if (login.status !== 200 || !login.json?.access_token) {
      if (login.status === 403 && /app registration/i.test(String(login.json?.errorMessage ?? login.text))) {
        throw new AuthError("Mojang 拒绝了这个 Azure 应用（需要先通过 Mojang 的应用审核）。请换用已通过审核的 Client ID。", "app-not-approved", login.json);
      }
      throw new AuthError(`Minecraft 登录失败（HTTP ${login.status}）：${login.json?.errorMessage ?? login.text.slice(0, 120)}`, "unknown", login.json);
    }
    const accessToken = login.json.access_token as string;
    const expiresAt = Date.now() + (Number(login.json.expires_in) || 86400) * 1000 - 60_000;

    const profile = await send(this.http, this.endpoints.mcProfile, { bearer: accessToken, signal });
    if (profile.status === 404) throw new AuthError("这个微软账户还没有购买 Minecraft Java 版。", "no-game", profile.json);
    if (profile.status !== 200 || !profile.json?.id) throw new AuthError(`读取玩家档案失败（HTTP ${profile.status}）`, "unknown", profile.json);
    const skin = (profile.json.skins as { state: string; url: string; variant?: string }[] | undefined)?.find((s) => s.state === "ACTIVE");
    const cape = (profile.json.capes as { state: string; url: string }[] | undefined)?.find((c) => c.state === "ACTIVE");
    return {
      accessToken,
      expiresAt,
      profile: {
        id: formatUuid(profile.json.id),
        name: profile.json.name,
        skinUrl: secureMinecraftTextureUrl(skin?.url),
        skinVariant: skin?.variant?.toUpperCase() === "SLIM" ? "slim" : "classic",
        capeUrl: secureMinecraftTextureUrl(cape?.url),
      },
    };
  }
}
