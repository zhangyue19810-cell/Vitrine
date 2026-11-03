import { randomUUID } from "node:crypto";
import { readJsonOr, writeJsonAtomic } from "../util/fsx";
import type { LaunchAccount } from "../mc/launch-args";
import type { SecretStore } from "./secrets";
import { MicrosoftAuth, type MicrosoftTokens } from "./microsoft";
import { isUuid, offlineUuid, validatePlayerName, formatUuid } from "./offline";
import { AuthError, type AccountRecord, type LoginChallenge, type PublicAccount } from "./types";
import { YggdrasilClient, type YggProfile } from "./yggdrasil";

interface AccountFile {
  version: 1;
  selected?: string;
  accounts: AccountRecord[];
}

export interface PreparedAccount {
  record: AccountRecord;
  launch: LaunchAccount;
  /** Authlib-injector needs its agent jar; the caller resolves the path and adds the JVM args. */
  authlib?: { root: string; prefetched?: string };
}

export interface AccountManagerOptions {
  file: string;
  secrets: SecretStore;
  microsoft: MicrosoftAuth;
  yggdrasil: YggdrasilClient;
  /** The user's own ID, offered as the default UUID for offline accounts. */
  ownerUuid?: () => string | undefined;
  now?: () => number;
}

export class AccountManager {
  private data?: AccountFile;
  private refreshing = new Map<string, Promise<PreparedAccount>>();
  private readonly now: () => number;

  constructor(private readonly options: AccountManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  private async load(): Promise<AccountFile> {
    if (!this.data) {
      const stored = await readJsonOr<Partial<AccountFile>>(this.options.file, {});
      this.data = { version: 1, selected: stored.selected, accounts: stored.accounts ?? [] };
    }
    return this.data;
  }

  private async save() {
    await writeJsonAtomic(this.options.file, this.data);
  }

  private async toPublic(record: AccountRecord): Promise<PublicAccount> {
    const key = record.type === "microsoft" ? `ms:${record.id}:refresh` : record.type === "authlib" ? `authlib:${record.id}:access` : undefined;
    return {
      id: record.id,
      type: record.type,
      name: record.name,
      uuid: record.uuid,
      server: record.server,
      serverName: record.serverName,
      skinUrl: record.skinUrl,
      lastUsed: record.lastUsed,
      signedIn: key ? (await this.options.secrets.get(key)) !== undefined : true,
    };
  }

  async list(): Promise<PublicAccount[]> {
    const { accounts } = await this.load();
    return Promise.all(accounts.map((record) => this.toPublic(record)));
  }

  async selectedId(): Promise<string | undefined> {
    const data = await this.load();
    if (data.selected && data.accounts.some((a) => a.id === data.selected)) return data.selected;
    return data.accounts[0]?.id;
  }

  async select(id: string): Promise<void> {
    const data = await this.load();
    if (!data.accounts.some((a) => a.id === id)) throw new Error("账户不存在");
    data.selected = id;
    await this.save();
  }

  async get(id: string): Promise<AccountRecord | undefined> {
    return (await this.load()).accounts.find((a) => a.id === id);
  }

  private async upsert(record: AccountRecord, select = true): Promise<AccountRecord> {
    const data = await this.load();
    const index = data.accounts.findIndex((a) => a.type === record.type && a.uuid === record.uuid && (record.type !== "authlib" || a.server === record.server));
    if (index >= 0) {
      record = { ...data.accounts[index], ...record, id: data.accounts[index].id, createdAt: data.accounts[index].createdAt };
      data.accounts[index] = record;
    } else data.accounts.push(record);
    if (select || !data.selected) data.selected = record.id;
    await this.save();
    return record;
  }

  // ------------------------------------------------------------- offline

  /** `uuid` may be omitted (standard offline UUID for the name) or a custom one such as the player's own ID. */
  async addOffline(name: string, options: { uuid?: string; useOwnerUuid?: boolean } = {}): Promise<PublicAccount> {
    const problem = validatePlayerName(name);
    if (problem) throw new Error(problem);
    let uuid: string;
    if (options.uuid) {
      if (!isUuid(options.uuid)) throw new Error("UUID 格式不正确，应为 32 位十六进制（可带连字符）");
      uuid = formatUuid(options.uuid);
    } else if (options.useOwnerUuid && this.options.ownerUuid?.()) {
      uuid = formatUuid(this.options.ownerUuid()!);
    } else uuid = offlineUuid(name);
    const record = await this.upsert({ id: randomUUID(), type: "offline", name, uuid, createdAt: this.now() });
    return this.toPublic(record);
  }

  // ------------------------------------------------------------- microsoft

  async beginMicrosoft(signal?: AbortSignal): Promise<{ challenge: LoginChallenge; done: Promise<PublicAccount> }> {
    const { challenge, complete } = await this.options.microsoft.beginDeviceLogin(signal);
    const done = complete().then(async (tokens) => {
      const record = await this.storeMicrosoft(tokens);
      return this.toPublic(record);
    });
    // The caller may never await `done` if the user closes the dialog; avoid an unhandled rejection.
    done.catch(() => {});
    return { challenge, done };
  }

  private async storeMicrosoft(tokens: MicrosoftTokens, id?: string): Promise<AccountRecord> {
    const { profile } = tokens.session;
    const record = await this.upsert(
      {
        id: id ?? randomUUID(),
        type: "microsoft",
        name: profile.name,
        uuid: profile.id,
        skinUrl: profile.skinUrl,
        skinVariant: profile.skinVariant,
        capeUrl: profile.capeUrl,
        expiresAt: tokens.session.expiresAt,
        createdAt: this.now(),
      },
      id === undefined,
    );
    await this.options.secrets.set(`ms:${record.id}:refresh`, tokens.refreshToken);
    await this.options.secrets.set(`ms:${record.id}:access`, tokens.session.accessToken);
    return record;
  }

  // ------------------------------------------------------------- authlib-injector / Yggdrasil

  /**
   * Log in to a Yggdrasil server. When the account owns several profiles and none is pre-selected,
   * the profiles are returned so the UI can ask; call again with `profileId`.
   */
  async loginAuthlib(
    serverInput: string,
    username: string,
    password: string,
    options: { profileId?: string; signal?: AbortSignal } = {},
  ): Promise<{ account?: PublicAccount; profiles?: YggProfile[] }> {
    const meta = await this.options.yggdrasil.fetchMeta(serverInput, options.signal);
    const clientToken = randomUUID().replace(/-/g, "");
    let session = await this.options.yggdrasil.authenticate(meta.root, username, password, clientToken, options.signal);
    let selected = session.selected;
    if (!selected) {
      if (session.profiles.length === 1) selected = session.profiles[0];
      else if (options.profileId) selected = session.profiles.find((p) => p.id === formatUuid(options.profileId!));
      if (!selected) {
        if (!session.profiles.length) throw new AuthError("这个账号下没有任何角色。", "unknown");
        return { profiles: session.profiles };
      }
      session = await this.options.yggdrasil.refresh(meta.root, session.accessToken, session.clientToken, selected, options.signal);
      selected = session.selected ?? selected;
    }
    const record = await this.upsert({
      id: randomUUID(),
      type: "authlib",
      name: selected.name,
      uuid: selected.id,
      server: meta.root,
      serverName: meta.serverName,
      prefetched: meta.prefetched,
      login: username,
      createdAt: this.now(),
    });
    await this.options.secrets.set(`authlib:${record.id}:access`, session.accessToken);
    await this.options.secrets.set(`authlib:${record.id}:client`, session.clientToken);
    return { account: await this.toPublic(record) };
  }

  // ------------------------------------------------------------- shared

  async remove(id: string): Promise<void> {
    const data = await this.load();
    const record = data.accounts.find((a) => a.id === id);
    if (!record) return;
    data.accounts = data.accounts.filter((a) => a.id !== id);
    if (data.selected === id) data.selected = data.accounts[0]?.id;
    await this.save();
    for (const key of [`ms:${id}:refresh`, `ms:${id}:access`, `authlib:${id}:access`, `authlib:${id}:client`]) await this.options.secrets.delete(key);
  }

  /** Make an account ready for a launch, refreshing tokens when needed. Concurrent calls share one refresh. */
  async prepareLaunch(id?: string, signal?: AbortSignal): Promise<PreparedAccount> {
    const target = id ?? (await this.selectedId());
    if (!target) throw new Error("还没有添加任何账户。请先在 账户 页面添加一个。");
    const running = this.refreshing.get(target);
    if (running) return running;
    const promise = this.prepare(target, signal).finally(() => this.refreshing.delete(target));
    this.refreshing.set(target, promise);
    return promise;
  }

  private async prepare(id: string, signal?: AbortSignal): Promise<PreparedAccount> {
    const data = await this.load();
    let record = data.accounts.find((a) => a.id === id);
    if (!record) throw new Error("账户不存在");
    const stamp = async (r: AccountRecord) => {
      r.lastUsed = this.now();
      await this.save();
      return r;
    };
    if (record.type === "offline") {
      record = await stamp(record);
      return { record, launch: { name: record.name, uuid: record.uuid, accessToken: "0", userType: "legacy" } };
    }
    if (record.type === "microsoft") {
      let access = await this.options.secrets.get(`ms:${id}:access`);
      if (!access || !record.expiresAt || record.expiresAt <= this.now() + 120_000) {
        const refresh = await this.options.secrets.get(`ms:${id}:refresh`);
        if (!refresh) throw new AuthError("这个微软账户需要重新登录。", "expired");
        const tokens = await this.options.microsoft.refresh(refresh, signal);
        record = await this.storeMicrosoft(tokens, id);
        access = tokens.session.accessToken;
      }
      record = await stamp(record);
      return { record, launch: { name: record.name, uuid: record.uuid, accessToken: access, userType: "msa", xuid: record.xuid } };
    }
    // authlib
    const root = record.server!;
    let access = await this.options.secrets.get(`authlib:${id}:access`);
    const client = await this.options.secrets.get(`authlib:${id}:client`);
    if (!access || !client) throw new AuthError("这个外置登录账户需要重新登录。", "invalid-credentials");
    if (!(await this.options.yggdrasil.validate(root, access, client, signal))) {
      const session = await this.options.yggdrasil.refresh(root, access, client, { id: record.uuid, name: record.name }, signal);
      access = session.accessToken;
      await this.options.secrets.set(`authlib:${id}:access`, session.accessToken);
      await this.options.secrets.set(`authlib:${id}:client`, session.clientToken);
    }
    record = await stamp(record);
    return {
      record,
      launch: { name: record.name, uuid: record.uuid, accessToken: access, userType: "mojang" },
      authlib: { root, prefetched: record.prefetched },
    };
  }
}
