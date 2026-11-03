import { rpc } from "../api";
import { awaitTask, guard, launchInstance, openFolder, pickPath, withBusy } from "../actions";
import { $, $$, Latest, html, onAll, setHtml } from "../dom";
import { compareVersions, formatBytes, formatDateTime, relativeTime } from "../format";
import { openMenu } from "../menu";
import { confirmDialog, promptDialog, toast } from "../modal";
import type { SaveInfo } from "../types";
import type { TabContext, TabHandle } from "./detail-types";
import { openDownloads } from "./downloads";

const GAME_TYPE: Record<string, string> = { survival: "生存", creative: "创造", adventure: "冒险", spectator: "旁观" };
const DIFFICULTY: Record<string, string> = { peaceful: "和平", easy: "简单", normal: "普通", hard: "困难" };

/** Joining a world straight from the launcher needs "quick play", which exists from Minecraft 1.20 (23w14a) on. */
function supportsQuickPlayWorld(version: string | undefined): boolean {
  if (!version) return false;
  const snapshot = /^(\d{2})w\d+/.exec(version);
  if (snapshot) return Number(snapshot[1]) >= 23;
  return /^\d/.test(version) && compareVersions(version, "1.20") >= 0;
}

export function mount(ctx: TabContext): TabHandle {
  const { body, signal } = ctx;
  body.innerHTML = `<div class="stack" style="gap:14px">
    <div class="toolbar"><button class="btn sm accent" data-act="worlds-import">导入存档（.zip）</button><button class="btn sm soft" data-act="worlds-folder">打开存档文件夹</button><span class="muted grow" data-f="summary" style="font-size:12px;text-align:right"></span></div>
    <div data-f="list"><div class="skeleton" style="height:70px;margin-bottom:6px"></div><div class="skeleton" style="height:70px"></div></div>
  </div>`;
  const f = (name: string) => $(`[data-f="${name}"]`, body);
  const latest = new Latest();
  let worlds: SaveInfo[] = [];
  const sizes = new Map<string, number>();
  const icons = new Map<string, string | null>();
  const queue: { kind: "size" | "icon"; element: HTMLElement }[] = [];
  let inflight = 0;
  let observer: IntersectionObserver | undefined;

  async function load() {
    const token = latest.next();
    try {
      const list = await rpc("worlds.list", { instanceId: ctx.instance().id }, signal);
      if (!latest.isCurrent(token) || signal.aborted) return;
      worlds = list;
      ctx.setCount(list.length);
      paint();
    } catch (error) {
      if (signal.aborted || !latest.isCurrent(token)) return;
      setHtml(f("list"), html`<div class="empty"><b>读取存档失败</b><div>${(error as Error).message}</div><div><button class="btn soft" data-act="worlds-reload">重试</button></div></div>`);
    }
  }

  function paint() {
    observer?.disconnect();
    queue.length = 0;
    const instance = ctx.instance();
    const canJoin = supportsQuickPlayWorld(instance.mcVersion);
    f("summary").textContent = worlds.length ? `共 ${worlds.length} 个存档` : "";
    if (!worlds.length) {
      return setHtml(f("list"), html`<div class="empty"><b>这个实例还没有存档</b><div>${instance.isolated ? "进入游戏创建世界后会出现在这里。" : "这个实例与其他实例共用游戏目录，存档保存在共享的 saves 文件夹里。"}也可以导入别人分享的存档压缩包。</div></div>`);
    }
    setHtml(
      f("list"),
      html`<div class="list">${worlds.map((world, index) => {
        const meta = [GAME_TYPE[world.gameType ?? ""], world.hardcore ? "极限" : DIFFICULTY[world.difficulty ?? ""], world.version, world.lastPlayed ? relativeTime(world.lastPlayed) : "从未游玩"].filter(Boolean).join(" · ");
        return html`<div class="item" data-i="${index}">
          <span class="thumb lg pixel" data-icon="${world.folder}" data-has="${world.hasIcon}">${(world.name || world.folder).slice(0, 1).toUpperCase()}</span>
          <div style="min-width:0"><div class="title" title="${world.name}">${world.name}</div><div class="sub" title="${world.folder}">${world.folder !== world.name ? `${world.folder} · ` : ""}${meta}</div>
            <div class="row-flex" style="margin-top:6px;gap:5px;flex-wrap:wrap">${world.cheats ? html`<span class="chip">允许作弊</span>` : ""}${world.datapacks.length ? html`<span class="chip">${world.datapacks.length} 个数据包</span>` : ""}${world.problem ? html`<span class="chip danger" title="${world.problem}">无法读取</span>` : ""}</div></div>
          <div class="tail"><span class="muted tnum" data-size style="font-size:12px;min-width:56px;text-align:right" title="${world.lastPlayed ? formatDateTime(world.lastPlayed) : ""}">${sizes.has(world.folder) ? formatBytes(sizes.get(world.folder)!) : ""}</span><button class="btn sm" data-play ${canJoin && !world.problem ? "" : "disabled"} title="${canJoin ? "启动游戏并直接进入这个世界" : "直接进入世界需要 Minecraft 1.20 及以上"}">进入</button><button class="btn icon sm ghost" data-more aria-haspopup="menu" title="更多">⋯</button></div>
        </div>`;
      })}</div>`,
    );
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          const element = entry.target as HTMLElement;
          const world = worlds[Number(element.dataset.i)];
          if (!world) continue;
          if (!sizes.has(world.folder)) queue.push({ kind: "size", element });
          if (world.hasIcon && !icons.has(world.folder)) queue.push({ kind: "icon", element });
          else if (icons.get(world.folder)) showIcon(element, icons.get(world.folder)!);
        }
        pump();
      },
      { root: body, rootMargin: "100px" },
    );
    for (const element of $$(".item", f("list"))) observer.observe(element);
  }

  function showIcon(row: HTMLElement, data: string) {
    const thumb = row.querySelector<HTMLElement>("[data-icon]");
    if (!thumb || !/^data:image\/(png|jpeg|webp);base64,/.test(data) || thumb.querySelector("img")) return;
    thumb.textContent = "";
    const image = document.createElement("img");
    image.alt = "";
    image.src = data;
    thumb.append(image);
  }

  function pump() {
    while (inflight < 2 && queue.length) {
      const job = queue.shift()!;
      if (!job.element.isConnected) continue;
      const world = worlds[Number(job.element.dataset.i)];
      if (!world) continue;
      inflight++;
      void (async () => {
        try {
          const instanceId = ctx.instance().id;
          if (job.kind === "size") {
            const size = await rpc("worlds.size", { instanceId, folder: world.folder }, signal);
            sizes.set(world.folder, size);
            const cell = job.element.querySelector<HTMLElement>("[data-size]");
            if (cell) cell.textContent = formatBytes(size);
          } else {
            const icon = (await rpc("worlds.icon", { instanceId, folder: world.folder }, signal)) ?? null;
            icons.set(world.folder, icon);
            if (icon) showIcon(job.element, icon);
          }
        } catch {
          /* a size or icon that cannot be read is simply not shown */
        } finally {
          inflight--;
          pump();
        }
      })();
    }
  }

  // ------------------------------------------------------------------------------------------ actions
  async function importWorld(button: HTMLElement) {
    const file = await pickPath("file", { title: "选择存档压缩包", filters: [{ name: "存档", extensions: ["zip"] }], hint: "选择一个包含世界文件夹（level.dat）的 .zip 文件。当前不是桌面版，请粘贴完整路径。" });
    if (!file) return;
    const started = await withBusy(button, () => guard(() => rpc("worlds.import", { instanceId: ctx.instance().id, file })));
    if (!started) return;
    toast("正在导入存档…", "info");
    openDownloads(started.taskId);
    void awaitTask(started.taskId, signal).then(
      () => {
        toast("存档已导入", "ok");
        void load();
      },
      () => undefined,
    );
  }

  async function more(button: HTMLElement, world: SaveInfo) {
    const instanceId = ctx.instance().id;
    const choice = await openMenu(button, [
      { id: "rename", label: "修改世界名称" },
      { id: "folder", label: "修改文件夹名称" },
      { id: "duplicate", label: "复制存档" },
      { id: "export", label: "导出为 .zip" },
      { id: "datapack", label: "安装数据包…", divider: true },
      { id: "delete", label: "删除存档", danger: true, divider: true },
    ]);
    if (!choice) return;
    if (choice === "rename") {
      const name = await promptDialog({ title: "世界名称", label: "在游戏里显示的名称", value: world.name, confirm: "保存", validate: (v) => (v ? undefined : "名称不能为空") });
      if (name !== undefined && (await guard(() => rpc("worlds.rename", { instanceId, folder: world.folder, name }).then(() => true)))) void load();
    } else if (choice === "folder") {
      const folder = await promptDialog({ title: "文件夹名称", label: "saves 里的文件夹名", value: world.folder, confirm: "保存", message: "只改文件夹名；游戏里显示的名称不变。", validate: (v) => (!v ? "名称不能为空" : /[\\/:*?"<>|]/.test(v) ? "不能包含 \\ / : * ? \" < > |" : worlds.some((w) => w.folder === v && v !== world.folder) ? "已经有同名的存档" : undefined) });
      if (folder && folder !== world.folder && (await guard(() => rpc("worlds.renameFolder", { instanceId, folder: world.folder, newFolder: folder }).then(() => true)))) void load();
    } else if (choice === "duplicate") {
      if (await guard(() => rpc("worlds.duplicate", { instanceId, folder: world.folder }).then(() => true))) {
        toast("已复制存档", "ok");
        void load();
      }
    } else if (choice === "export") {
      const dest = await pickPath("save", { title: "导出存档", defaultPath: `${world.folder}.zip`, filters: [{ name: "存档", extensions: ["zip"] }] });
      if (!dest) return;
      const started = await guard(() => rpc("worlds.export", { instanceId, folder: world.folder, dest }));
      if (started) {
        toast("正在导出存档…", "info");
        openDownloads(started.taskId);
      }
    } else if (choice === "datapack") {
      const { openBrowse } = await import("./browse");
      openBrowse({ kind: "datapack", instanceId });
    } else if (choice === "delete") {
      const size = sizes.get(world.folder);
      const ok = await confirmDialog({
        eyebrow: "DELETE WORLD",
        title: `删除“${world.name}”？`,
        message: html`<p style="margin:0;line-height:1.8">存档文件夹 <b>${world.folder}</b>${size ? `（${formatBytes(size)}）` : ""}会被永久删除，<b>无法恢复</b>。<br />如果舍不得，先“导出为 .zip”备份一份。</p>`,
        confirm: "永久删除",
        danger: true,
      });
      if (ok && (await guard(() => rpc("worlds.delete", { instanceId, folder: world.folder }).then(() => true)))) {
        toast("已删除存档", "ok");
        void load();
      }
    }
  }

  onAll(body, "click", "[data-play]", (element) => {
    const world = worlds[Number(element.closest<HTMLElement>(".item")?.dataset.i)];
    if (world) void launchInstance(ctx.instance().id, { world: world.folder });
  });
  onAll(body, "click", "[data-more]", (element) => {
    const world = worlds[Number(element.closest<HTMLElement>(".item")?.dataset.i)];
    if (world) void more(element, world);
  });
  onAll(body, "click", "[data-act]", (element) => {
    switch (element.dataset.act) {
      case "worlds-import":
        return void importWorld(element);
      case "worlds-folder":
        return void openFolder(ctx.instance().id, "saves");
      case "worlds-reload":
        return void load();
    }
  });

  void load();
  return {
    dispose() {
      observer?.disconnect();
      queue.length = 0;
    },
  };
}
