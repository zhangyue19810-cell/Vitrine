import { rpc } from "../api";
import { guard, launchInstance } from "../actions";
import { $, Latest, html, onAll, raw, setHtml, type Raw } from "../dom";
import { errorMessage } from "../format";
import { openMenu } from "../menu";
import { confirmDialog, openDialog, toast } from "../modal";
import { store } from "../store";
import type { ServerEntry, ServerStatus } from "../types";
import type { TabContext, TabHandle } from "./detail-types";

type Ping = { status?: ServerStatus; error?: string; pending?: boolean };

const COLOR = /^#[0-9a-f]{3,8}$/i;

/** The MOTD as the game would draw it. Colours come from the server, so only plain hex values are let through. */
export function motdHtml(status: ServerStatus): Raw {
  const parts = status.motd.map((segment) => {
    const style = [segment.color && COLOR.test(segment.color) ? `color:${segment.color}` : "", segment.bold ? "font-weight:700" : "", segment.italic ? "font-style:italic" : "", segment.underline || segment.strike ? `text-decoration:${[segment.underline ? "underline" : "", segment.strike ? "line-through" : ""].filter(Boolean).join(" ")}` : ""].filter(Boolean).join(";");
    return `<span style="${style}">${html`${segment.text}`.value}</span>`;
  });
  return raw(parts.join(""));
}

const iconUrl = (value: string | undefined) => (value && /^[A-Za-z0-9+/=]+$/.test(value) ? `data:image/png;base64,${value}` : undefined);

export function mount(ctx: TabContext): TabHandle {
  const { body, signal } = ctx;
  body.innerHTML = `<div class="stack" style="gap:14px">
    <div class="toolbar"><button class="btn sm accent" data-act="srv-add">＋ 添加服务器</button><button class="btn sm" data-act="srv-refresh">刷新状态</button><span class="muted grow" data-f="summary" style="font-size:12px;text-align:right"></span></div>
    <div data-f="notice"></div>
    <div data-f="list"><div class="skeleton" style="height:86px;margin-bottom:6px"></div><div class="skeleton" style="height:86px"></div></div>
  </div>`;
  const f = (name: string) => $(`[data-f="${name}"]`, body);
  const latest = new Latest();
  let servers: ServerEntry[] = [];
  const pings = new Map<string, Ping>();

  async function load() {
    const token = latest.next();
    try {
      const list = await rpc("servers.list", { instanceId: ctx.instance().id }, signal);
      if (!latest.isCurrent(token) || signal.aborted) return;
      servers = list;
      ctx.setCount(list.length);
      paint();
      void refreshStatus();
    } catch (error) {
      if (signal.aborted || !latest.isCurrent(token)) return;
      setHtml(f("list"), html`<div class="empty"><b>读取服务器列表失败</b><div>${errorMessage(error)}</div><div><button class="btn soft" data-act="srv-reload">重试</button></div></div>`);
    }
  }

  function paint() {
    const running = Boolean(store.gameOf(ctx.instance().id));
    setHtml(f("notice"), running ? html`<div class="notice warn">游戏正在运行：现在修改列表，游戏退出时可能被它自己的列表覆盖。</div>` : html``);
    f("summary").textContent = servers.length ? `共 ${servers.length} 个` : "";
    if (!servers.length) {
      return setHtml(f("list"), html`<div class="empty"><b>服务器列表是空的</b><div>添加后可以在这里看到在线人数和延迟，并一键启动游戏直接加入。</div></div>`);
    }
    setHtml(
      f("list"),
      html`<div class="list">${servers.map((server, index) => row(server, index))}</div>`,
    );
  }

  function row(server: ServerEntry, index: number) {
    const ping = pings.get(server.ip);
    const status = ping?.status;
    const icon = iconUrl(server.icon) ?? (status?.icon && /^data:image\/png;base64,/.test(status.icon) ? status.icon : undefined);
    return html`<div class="item" data-i="${index}">
      <span class="thumb lg pixel">${icon ? html`<img alt="" src="${icon}" />` : server.name.slice(0, 1).toUpperCase() || "?"}</span>
      <div style="min-width:0">
        <div class="title">${server.name || "Minecraft 服务器"} <span class="muted" style="font-weight:400;font-size:12px">${server.ip}</span></div>
        ${status ? html`<div class="server-motd" style="margin-top:6px;padding:6px 10px;background:#161616;color:#aaa;max-height:3.4em;overflow:hidden">${motdHtml(status)}</div>` : ping?.error ? html`<div class="sub" style="color:var(--danger)">${ping.error}</div>` : html`<div class="sub">${ping?.pending ? "正在查询…" : "尚未查询"}</div>`}
        ${status ? html`<div class="row-flex" style="margin-top:6px;gap:5px;flex-wrap:wrap"><span class="chip ok">${status.players.online} / ${status.players.max} 人</span>${status.latencyMs !== undefined ? html`<span class="chip">${status.latencyMs} ms</span>` : ""}<span class="chip">${status.version.name}</span>${status.modded ? html`<span class="chip accent">模组服</span>` : ""}</div>` : ""}
      </div>
      <div class="tail"><button class="btn sm" data-join title="启动游戏并直接加入这个服务器">加入</button><button class="btn icon sm ghost" data-more aria-haspopup="menu" title="更多">⋯</button></div>
    </div>`;
  }

  async function refreshStatus() {
    if (!servers.length) return;
    for (const server of servers) pings.set(server.ip, { pending: true });
    paint();
    try {
      const results = await rpc("servers.pingAll", { instanceId: ctx.instance().id }, signal);
      if (signal.aborted) return;
      for (const result of results) pings.set(result.ip, { status: result.status, error: result.error });
    } catch (error) {
      if (signal.aborted) return;
      for (const server of servers) pings.set(server.ip, { error: errorMessage(error) });
    }
    paint();
  }

  // ------------------------------------------------------------------------------------------ add / edit
  async function edit(index?: number) {
    const existing = index === undefined ? undefined : servers[index];
    const form = document.createElement("div");
    form.className = "stack";
    form.innerHTML = html`
      <div class="field"><label>名称</label><input class="input" data-name value="${existing?.name ?? ""}" maxlength="60" placeholder="例如：我的生存服" /></div>
      <div class="field"><label>地址</label><input class="input mono" data-ip value="${existing?.ip ?? ""}" maxlength="255" placeholder="play.example.com 或 1.2.3.4:25566" spellcheck="false" /></div>
      <div class="field"><label>服务器资源包</label><select class="select" data-textures><option value="ask" ${existing?.acceptTextures === undefined ? "selected" : ""}>每次询问</option><option value="yes" ${existing?.acceptTextures === true ? "selected" : ""}>允许下载</option><option value="no" ${existing?.acceptTextures === false ? "selected" : ""}>禁止下载</option></select></div>
      <div class="toolbar"><button class="btn sm soft" data-test type="button">测试连接</button><span class="muted" data-result style="font-size:12.5px"></span></div>`.value;
    const ip = form.querySelector<HTMLInputElement>("[data-ip]")!;
    const result = form.querySelector<HTMLElement>("[data-result]")!;
    form.querySelector("[data-test]")!.addEventListener("click", async (event) => {
      const address = ip.value.trim();
      if (!address) return void (result.textContent = "请先填写地址");
      const button = event.currentTarget as HTMLElement;
      button.setAttribute("data-busy", "true");
      result.textContent = "连接中…";
      try {
        const status = await rpc("servers.ping", { address });
        result.textContent = `在线 ${status.players.online}/${status.players.max} · ${status.latencyMs ?? "?"} ms · ${status.version.name}`;
        result.style.color = "var(--ok)";
      } catch (error) {
        result.textContent = errorMessage(error);
        result.style.color = "var(--danger)";
      } finally {
        button.removeAttribute("data-busy");
      }
    });
    const dialog = openDialog({ eyebrow: existing ? "EDIT SERVER" : "ADD SERVER", title: existing ? "编辑服务器" : "添加服务器", body: form, buttons: [{ id: "cancel", label: "取消" }, { id: "ok", label: "保存", kind: "accent" }], defaultId: "ok" });
    if ((await dialog.result) !== "ok") return;
    const name = form.querySelector<HTMLInputElement>("[data-name]")!.value.trim();
    const address = ip.value.trim();
    if (!address) return void toast("地址不能为空", "error");
    const choice = form.querySelector<HTMLSelectElement>("[data-textures]")!.value;
    const acceptTextures = choice === "yes" ? true : choice === "no" ? false : undefined;
    const instanceId = ctx.instance().id;
    const ok = existing
      ? await guard(() => rpc("servers.update", { instanceId, index: index!, patch: { name: name || "Minecraft 服务器", ip: address, acceptTextures } }).then(() => true))
      : await guard(() => rpc("servers.add", { instanceId, server: { name: name || "Minecraft 服务器", ip: address, acceptTextures } }).then(() => true));
    if (ok) void load();
  }

  async function more(button: HTMLElement, index: number) {
    const server = servers[index];
    const choice = await openMenu(button, [
      { id: "edit", label: "编辑" },
      { id: "copy", label: "复制地址" },
      { id: "up", label: "上移", disabled: index === 0, divider: true },
      { id: "down", label: "下移", disabled: index === servers.length - 1 },
      { id: "remove", label: "移除", danger: true, divider: true },
    ]);
    const instanceId = ctx.instance().id;
    if (choice === "edit") return edit(index);
    if (choice === "copy") {
      await navigator.clipboard?.writeText(server.ip).catch(() => undefined);
      return toast("已复制地址", "ok");
    }
    if (choice === "up" || choice === "down") {
      if (await guard(() => rpc("servers.move", { instanceId, from: index, to: index + (choice === "up" ? -1 : 1) }).then(() => true))) void load();
    }
    if (choice === "remove") {
      const ok = await confirmDialog({ title: `移除“${server.name}”？`, message: "只是从列表里删掉，不影响服务器本身。", confirm: "移除", danger: true });
      if (ok && (await guard(() => rpc("servers.remove", { instanceId, index }).then(() => true)))) void load();
    }
  }

  onAll(body, "click", "[data-join]", (element) => {
    const server = servers[Number(element.closest<HTMLElement>(".item")?.dataset.i)];
    if (server) void launchInstance(ctx.instance().id, { server: server.ip });
  });
  onAll(body, "click", "[data-more]", (element) => {
    const index = Number(element.closest<HTMLElement>(".item")?.dataset.i);
    if (servers[index]) void more(element, index);
  });
  onAll(body, "click", "[data-act]", (element) => {
    switch (element.dataset.act) {
      case "srv-add":
        return void edit();
      case "srv-refresh":
        return void refreshStatus();
      case "srv-reload":
        return void load();
    }
  });

  void load();
  return {
    update() {
      // Only the game starting or stopping changes what this page shows (the "running" notice).
      const running = Boolean(store.gameOf(ctx.instance().id));
      if (running !== (f("notice").childElementCount > 0)) paint();
    },
  };
}
