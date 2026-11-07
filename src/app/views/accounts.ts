import { rpc } from "../api";
import { guard, openLink, withBusy } from "../actions";
import { $, html, onAll, setHtml } from "../dom";
import { formatDuration, relativeTime } from "../format";
import { confirmDialog, openDialog, openSheet, toast, type ModalHandle } from "../modal";
import { store, type LoginEvent } from "../store";
import { ACCOUNT_TYPE_LABEL, avatar } from "../ui-bits";
import type { PublicAccount } from "../types";
import { sound } from "../sound";

/** Accounts: the list on the left, three ways to add one on the right (Microsoft device code, offline, authlib server). */

type Tab = "microsoft" | "offline" | "authlib";

let open: ModalHandle | undefined;

export function openAccounts(tab: Tab = "microsoft") {
  if (open) return;
  const sheet = openSheet({ eyebrow: "ACCOUNTS", title: "账号", onClose: () => (open = undefined) });
  open = sheet;
  let current: Tab = tab;
  sheet.body.innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:40px;flex:1;min-height:0">
    <div data-f="list" style="overflow:auto;min-height:0"></div>
    <div style="display:flex;flex-direction:column;min-height:0;overflow:auto">
      <div class="tabs" role="tablist" data-f="tabs"></div>
      <div data-f="panel" style="padding-top:18px"></div>
    </div>
  </div>`;
  const list = $("[data-f='list']", sheet.body);
  const tabs = $("[data-f='tabs']", sheet.body);
  const panel = $("[data-f='panel']", sheet.body);

  const renderList = () => {
    const accounts = store.accounts;
    if (!accounts.length) {
      setHtml(list, html`<div class="empty" style="min-height:260px"><b>还没有账号</b>在右侧添加一个账号才能启动游戏。<br />没有正版账号也可以先添加“离线账号”。</div>`);
      return;
    }
    setHtml(
      list,
      html`<div class="section-title">已添加的账号</div><div class="list">${accounts.map((account) => accountRow(account, account.id === store.account?.id))}</div>`,
    );
  };
  const renderTabs = () => {
    setHtml(
      tabs,
      html`${(["microsoft", "offline", "authlib"] as Tab[]).map((id) => html`<button role="tab" data-tab="${id}" aria-selected="${id === current}">${{ microsoft: "微软账号", offline: "离线账号", authlib: "外置登录" }[id]}</button>`)}`,
    );
  };
  const renderPanel = () => {
    panel.textContent = "";
    if (current === "microsoft") buildMicrosoft(panel);
    else if (current === "offline") buildOffline(panel);
    else buildAuthlib(panel);
  };
  renderList();
  renderTabs();
  renderPanel();

  onAll(sheet.body, "click", "[data-tab]", (element) => {
    current = element.dataset.tab as Tab;
    renderTabs();
    renderPanel();
  });
  onAll(list, "click", "[data-use]", async (element) => {
    await guard(() => rpc("accounts.select", { id: element.dataset.use! }));
    sound.play("confirm");
  });
  onAll(list, "click", "[data-remove]", async (element) => {
    const account = store.accounts.find((entry) => entry.id === element.dataset.remove);
    if (!account) return;
    if (await confirmDialog({ title: `移除账号“${account.name}”？`, message: "只会从启动器里移除这个账号的登录信息，不会删除游戏存档。", confirm: "移除", danger: true })) await guard(() => rpc("accounts.remove", { id: account.id }));
  });
  const off = [store.on("accounts", renderList), store.on("settings", () => current === "microsoft" && renderPanel())];
  void sheet.closed.then(() => off.forEach((fn) => fn()));
}

function accountRow(account: PublicAccount, selected: boolean) {
  const sub =
    account.type === "authlib"
      ? `${account.serverName ?? account.server ?? "外置登录"}`
      : account.type === "microsoft"
        ? account.signedIn
          ? "微软正版账号"
          : "需要重新登录"
        : "离线账号";
  return html`<div class="item" data-selected="${selected}">
    ${avatar(account, true)}
    <div style="min-width:0"><div class="title">${account.name}</div><div class="sub">${sub} · ${account.uuid}${account.lastUsed ? ` · ${relativeTime(account.lastUsed)}使用` : ""}</div></div>
    <div class="tail">
      <span class="chip ${account.type === "microsoft" ? "accent" : ""}">${ACCOUNT_TYPE_LABEL[account.type] ?? account.type}</span>
      ${selected ? html`<span class="chip solid">当前使用</span>` : html`<button class="btn sm soft" data-use="${account.id}">使用</button>`}
      <button class="btn sm ghost" data-remove="${account.id}" title="移除">✕</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------- Microsoft

function buildMicrosoft(panel: HTMLElement) {
  if (!store.system.hasMicrosoftClientId) {
    setHtml(
      panel,
      html`<div class="notice warn" style="flex-direction:column"><b>当前构建未启用微软登录</b>
        <div>这个版本没有内置可用的微软登录配置，因此暂时不能添加微软账号。</div></div>
        <div class="muted" style="margin-top:14px;font-size:12.5px;line-height:1.8">离线账号和外置登录不受影响。</div>`,
    );
    return;
  }
  const pending = store.pendingLogin;
  if (pending) return showChallenge(panel, pending.loginId, pending.challenge, pending.startedAt);
  setHtml(
    panel,
    html`<div class="muted" style="font-size:13px;line-height:1.8">点击下面的按钮后会得到一个设备代码，在浏览器中打开微软登录页并输入代码，授权完成后账号会自动添加。</div>
    <div style="margin-top:16px"><button class="btn accent lg" data-ms-login>登录微软账号<span class="arrow">→</span></button></div>`,
  );
  panel.querySelector<HTMLElement>("[data-ms-login]")!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLElement;
    const started = await withBusy(button, () => guard(() => rpc("accounts.loginMicrosoft")));
    if (!started) return;
    store.pendingLogin = { loginId: started.loginId, challenge: started.challenge, startedAt: Date.now() };
    showChallenge(panel, started.loginId, started.challenge, Date.now());
  });
}

function showChallenge(panel: HTMLElement, loginId: string, challenge: { userCode: string; verificationUri: string; expiresIn: number }, startedAt: number) {
  setHtml(
    panel,
    html`<div class="stack">
      <div class="micro">第 1 步</div>
      <div><button class="btn soft" data-open-page>打开微软登录页 ↗</button> <span class="muted mono" style="font-size:12px">${challenge.verificationUri}</span></div>
      <div class="micro" style="margin-top:6px">第 2 步 · 输入这个代码</div>
      <div class="login-code" data-code>${challenge.userCode}</div>
      <div class="row-flex"><button class="btn sm soft" data-copy>复制代码</button><span class="grow"></span><span class="muted tnum" data-left style="font-size:12px"></span></div>
      <div class="row-flex muted" style="font-size:12.5px"><span class="spinner"></span>等待你在浏览器里完成授权…</div>
      <div><button class="btn sm ghost" data-cancel-login>取消</button></div>
    </div>`,
  );
  const left = panel.querySelector<HTMLElement>("[data-left]")!;
  const tick = () => {
    const remaining = challenge.expiresIn - (Date.now() - startedAt) / 1000;
    left.textContent = remaining > 0 ? `代码 ${formatDuration(remaining)} 后过期` : "代码已过期，请重新登录";
  };
  tick();
  const timer = setInterval(() => {
    if (!panel.isConnected) return clearInterval(timer);
    tick();
  }, 1000);
  panel.querySelector("[data-open-page]")!.addEventListener("click", () => void openLink(challenge.verificationUri));
  panel.querySelector("[data-copy]")!.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(challenge.userCode);
      toast("代码已复制", "ok");
    } catch {
      toast("无法访问剪贴板，请手动选中代码复制", "error");
    }
  });
  panel.querySelector("[data-cancel-login]")!.addEventListener("click", async () => {
    clearInterval(timer);
    store.pendingLogin = undefined;
    await guard(() => rpc("accounts.cancelLogin", { loginId }));
    buildMicrosoft(panel);
  });
  const stop = store.on<LoginEvent>("login", (event) => {
    if (event.loginId !== loginId) return;
    stop();
    clearInterval(timer);
    store.pendingLogin = undefined;
    if (!panel.isConnected) return;
    if (event.status === "done") {
      toast(`已添加账号 ${event.account?.name ?? ""}`, "ok");
      sound.play("done");
    } else if (event.status === "error") toast(event.error ?? "登录失败", "error");
    buildMicrosoft(panel);
  });
}

// ---------------------------------------------------------------------------------------------- offline

function buildOffline(panel: HTMLElement) {
  const owner = store.settings.accounts.ownerUuid;
  setHtml(
    panel,
    html`<div class="stack">
      <div class="field"><label>玩家名</label><input class="input" data-name maxlength="16" placeholder="3–16 位字母、数字或下划线" autocomplete="off" spellcheck="false" /><div class="hint-text" data-hint></div></div>
      <div class="field"><label>UUID</label>
        <label class="check"><input type="radio" name="uuid" value="owner" ${owner ? raw_checked() : ""} ${owner ? "" : "disabled"} />使用我的默认 UUID <span class="muted mono" style="font-size:11.5px">${owner || "（设置里未填写）"}</span></label>
        <label class="check"><input type="radio" name="uuid" value="auto" ${owner ? "" : raw_checked()} />按玩家名自动生成（离线标准算法）</label>
        <label class="check"><input type="radio" name="uuid" value="custom" />自定义</label>
        <input class="input mono" data-uuid placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" hidden />
        <div class="hint-text">UUID 决定存档里的背包、位置和权限属于谁。想让不同启动器里的存档互通，请保持同一个 UUID。</div>
      </div>
      <div><button class="btn accent" data-add>添加离线账号</button></div>
    </div>`,
  );
  const name = panel.querySelector<HTMLInputElement>("[data-name]")!;
  const hint = panel.querySelector<HTMLElement>("[data-hint]")!;
  const uuid = panel.querySelector<HTMLInputElement>("[data-uuid]")!;
  const validate = () => {
    const value = name.value.trim();
    const bad = value.length > 0 && !/^[A-Za-z0-9_]{3,16}$/.test(value);
    hint.textContent = bad ? "玩家名需要是 3–16 位的字母、数字或下划线（其他名字可能无法进入服务器）" : "";
    hint.style.color = bad ? "var(--warn)" : "";
    return !bad;
  };
  name.addEventListener("input", validate);
  panel.addEventListener("change", () => {
    uuid.hidden = panel.querySelector<HTMLInputElement>("input[name='uuid']:checked")?.value !== "custom";
  });
  panel.querySelector("[data-add]")!.addEventListener("click", async (event) => {
    const value = name.value.trim();
    if (!value) return void name.focus({ preventScroll: true });
    const mode = panel.querySelector<HTMLInputElement>("input[name='uuid']:checked")?.value ?? "auto";
    const params: { name: string; uuid?: string; useOwnerUuid?: boolean } = { name: value };
    if (mode === "owner") params.useOwnerUuid = true;
    if (mode === "custom") params.uuid = uuid.value.trim();
    const account = await withBusy(event.currentTarget as HTMLElement, () => guard(() => rpc("accounts.addOffline", params)));
    if (account) {
      toast(`已添加离线账号 ${account.name}`, "ok");
      name.value = "";
    }
  });
}

const raw_checked = () => "checked";

// ---------------------------------------------------------------------------------------------- authlib

function buildAuthlib(panel: HTMLElement) {
  setHtml(
    panel,
    html`<div class="stack">
      <div class="muted" style="font-size:12.5px;line-height:1.8">适用于 LittleSkin 等 Yggdrasil 外置登录服务，以及“统一通行证”(Nide8)。启动时会自动注入 authlib-injector。</div>
      <div class="field"><label>认证服务器</label><input class="input mono" data-server placeholder="https://littleskin.cn/api/yggdrasil" autocomplete="off" spellcheck="false" /></div>
      <label class="check"><input type="checkbox" data-nide8 />这是统一通行证（填写服务器 ID）</label>
      <div class="field"><label>邮箱 / 用户名</label><input class="input" data-user autocomplete="username" /></div>
      <div class="field"><label>密码</label><input class="input" type="password" data-pass autocomplete="current-password" /><div class="hint-text">密码只用于换取令牌，不会被保存。</div></div>
      <div><button class="btn accent" data-login>登录</button></div>
    </div>`,
  );
  const server = panel.querySelector<HTMLInputElement>("[data-server]")!;
  const nide8 = panel.querySelector<HTMLInputElement>("[data-nide8]")!;
  nide8.addEventListener("change", () => {
    server.placeholder = nide8.checked ? "服务器 ID，例如 1a2b3c4d5e6f7g8h" : "https://littleskin.cn/api/yggdrasil";
  });
  const attempt = async (button: HTMLElement, profileId?: string) => {
    const serverValue = nide8.checked ? `https://auth.mc-user.com:233/${server.value.trim()}` : server.value.trim();
    const username = panel.querySelector<HTMLInputElement>("[data-user]")!.value.trim();
    const password = panel.querySelector<HTMLInputElement>("[data-pass]")!.value;
    if (!serverValue || !username || !password) return toast("请填写服务器、用户名和密码", "error");
    const result = await withBusy(button, () => guard(() => rpc("accounts.loginAuthlib", { server: serverValue, username, password, profileId })));
    if (!result) return;
    if (result.account) {
      toast(`已添加账号 ${result.account.name}`, "ok");
      panel.querySelector<HTMLInputElement>("[data-pass]")!.value = "";
    } else if (result.profiles?.length) {
      const dialog = openDialog({
        eyebrow: "CHOOSE PROFILE",
        title: "选择角色",
        size: "narrow",
        body: html`<div class="list">${result.profiles.map((p) => html`<button class="pick" data-profile="${p.id}">${p.name}</button>`)}</div>`,
        buttons: [{ id: "cancel", label: "取消" }],
      });
      dialog.root.addEventListener("click", (event) => {
        const pick = (event.target as HTMLElement).closest<HTMLElement>("[data-profile]");
        if (!pick) return;
        dialog.finishWith("picked");
        void attempt(button, pick.dataset.profile);
      });
    }
  };
  panel.querySelector("[data-login]")!.addEventListener("click", (event) => void attempt(event.currentTarget as HTMLElement));
}
