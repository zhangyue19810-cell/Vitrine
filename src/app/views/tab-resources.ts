import { rpc } from "../api";
import { guard, openFolder } from "../actions";
import { $, $$, Latest, html, onAll, setHtml } from "../dom";
import { formatBytes, formatDateTime } from "../format";
import { openMenu } from "../menu";
import { confirmDialog, promptDialog, toast } from "../modal";
import { store } from "../store";
import type { ResourcePackInfo, ScreenshotInfo, ShaderPackInfo } from "../types";
import type { TabContext, TabHandle } from "./detail-types";

type Section = "resourcepacks" | "shaderpacks" | "screenshots";

const SECTIONS: [Section, string][] = [
  ["resourcepacks", "资源包"],
  ["shaderpacks", "光影包"],
  ["screenshots", "截图"],
];

let lastSection: Section = "resourcepacks";

/** Small JPEG previews of screenshots, kept across visits to this page so scrolling back is instant. */
const thumbnails = new Map<string, string>();
const THUMB_LIMIT = 240;

const stripCodes = (text: string) => text.replace(/§[0-9a-fk-or]/gi, "").trim();

async function makeThumbnail(dataUrl: string): Promise<string> {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, 360 / image.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function mount(ctx: TabContext): TabHandle {
  const { body, signal } = ctx;
  let section: Section = lastSection;
  const latest = new Latest();
  let resourcePacks: ResourcePackInfo[] = [];
  let shaderPacks: ShaderPackInfo[] = [];
  let shots: ScreenshotInfo[] = [];
  let observer: IntersectionObserver | undefined;
  const queue: HTMLElement[] = [];
  let inflight = 0;
  let doneContent = doneCount();
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let closeLightbox: (() => void) | undefined;

  body.innerHTML = `<div class="stack" style="gap:14px">
    <div class="toolbar"><div class="seg" data-sections>${SECTIONS.map(([id, label]) => `<button data-s="${id}" aria-pressed="${id === section}">${label}</button>`).join("")}</div><span class="grow"></span><span data-f="tools" class="toolbar"></span></div>
    <div data-f="list"></div>
  </div>`;
  const f = (name: string) => $(`[data-f="${name}"]`, body);

  function doneCount() {
    return store.tasksOf(ctx.instance().id).filter((task) => task.kind === "content" && task.state === "done").length;
  }

  // ------------------------------------------------------------------------------------------ loading
  async function load() {
    const token = latest.next();
    paintTools();
    setHtml(f("list"), html`<div class="skeleton" style="height:64px;margin-bottom:6px"></div><div class="skeleton" style="height:64px"></div>`);
    const instanceId = ctx.instance().id;
    try {
      if (section === "resourcepacks") resourcePacks = await rpc("resourcepacks.list", { instanceId, icons: true }, signal);
      else if (section === "shaderpacks") shaderPacks = await rpc("shaderpacks.list", { instanceId }, signal);
      else shots = (await rpc("screenshots.list", { instanceId }, signal)).sort((a, b) => b.takenAt - a.takenAt);
      if (!latest.isCurrent(token) || signal.aborted) return;
      paintList();
    } catch (error) {
      if (signal.aborted || !latest.isCurrent(token)) return;
      setHtml(f("list"), html`<div class="empty"><b>读取失败</b><div>${(error as Error).message}</div><div><button class="btn soft" data-act="res-reload">重试</button></div></div>`);
    }
  }

  function paintTools() {
    setHtml(
      f("tools"),
      html`${section === "resourcepacks" ? html`<button class="btn sm accent" data-act="res-browse" data-kind="resourcepack">＋ 浏览资源包</button>` : section === "shaderpacks" ? html`<button class="btn sm accent" data-act="res-browse" data-kind="shader">＋ 浏览光影包</button>` : ""}<button class="btn sm soft" data-act="res-folder">打开文件夹</button>`,
    );
  }

  function paintList() {
    observer?.disconnect();
    queue.length = 0;
    if (section === "resourcepacks") return paintResourcePacks();
    if (section === "shaderpacks") return paintShaderPacks();
    return paintShots();
  }

  function paintResourcePacks() {
    ctx.setCount(undefined);
    if (!resourcePacks.length) return setHtml(f("list"), html`<div class="empty"><b>没有资源包</b><div>从 Modrinth / CurseForge 浏览安装，或把 .zip 放进 resourcepacks 文件夹。</div></div>`);
    setHtml(
      f("list"),
      html`<div class="list">${resourcePacks.map(
        (pack, index) => html`<div class="item" data-i="${index}">
          <span class="thumb lg pixel">${pack.icon && /^data:image\/png;base64,/.test(pack.icon) ? html`<img alt="" src="${pack.icon}" />` : pack.name.slice(0, 1).toUpperCase()}</span>
          <div style="min-width:0"><div class="title" title="${pack.fileName}">${pack.name || pack.fileName}</div><div class="sub wrap">${pack.problem ? `无法读取：${pack.problem}` : stripCodes(pack.description) || pack.fileName}</div>
            <div class="row-flex" style="margin-top:6px;gap:5px;flex-wrap:wrap">${pack.enabled ? html`<span class="chip accent">游戏中已启用</span>` : ""}<span class="chip">${pack.kind === "folder" ? "文件夹" : "压缩包"}</span>${pack.packFormat !== undefined ? html`<span class="chip">pack_format ${pack.packFormat}</span>` : ""}${pack.size ? html`<span class="chip">${formatBytes(pack.size)}</span>` : ""}</div></div>
          <div class="tail"><button class="btn icon sm ghost" data-more aria-haspopup="menu" title="更多">⋯</button></div>
        </div>`,
      )}</div><p class="muted" style="font-size:12px;margin:12px 0 0;line-height:1.7">启用和排序请在游戏的“选项 → 资源包”里操作。</p>`,
    );
  }

  function paintShaderPacks() {
    ctx.setCount(undefined);
    if (!shaderPacks.length) return setHtml(f("list"), html`<div class="empty"><b>没有光影包</b><div>光影需要 Iris（Fabric / Quilt / NeoForge）或 OptiFine 才能在游戏里使用。</div></div>`);
    setHtml(
      f("list"),
      html`<div class="list">${shaderPacks.map(
        (pack, index) => html`<div class="item no-lead" data-i="${index}">
          <div style="min-width:0"><div class="title" title="${pack.fileName}">${pack.fileName}</div><div class="row-flex" style="margin-top:6px;gap:5px;flex-wrap:wrap"><span class="chip">${pack.kind === "folder" ? "文件夹" : "压缩包"}</span>${pack.size ? html`<span class="chip">${formatBytes(pack.size)}</span>` : ""}${pack.valid ? "" : html`<span class="chip warn" title="没有找到 shaders 文件夹">结构异常</span>`}${pack.hasSettings ? html`<span class="chip">有自定义设置</span>` : ""}</div></div>
          <div class="tail"><button class="btn icon sm ghost" data-more aria-haspopup="menu" title="更多">⋯</button></div>
        </div>`,
      )}</div>`,
    );
  }

  function paintShots() {
    ctx.setCount(undefined);
    if (!shots.length) return setHtml(f("list"), html`<div class="empty"><b>还没有截图</b><div>游戏里按 F2 截图，会保存到这里。</div></div>`);
    setHtml(
      f("list"),
      html`<div class="shot-grid">${shots.map((shot, index) => html`<button class="shot" data-i="${index}" aria-label="查看截图 ${shot.fileName}"><span class="cap">${formatDateTime(shot.takenAt)}</span></button>`)}</div>`,
    );
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          queue.push(entry.target as HTMLElement);
        }
        pump();
      },
      { root: body, rootMargin: "200px" },
    );
    for (const element of $$(".shot", f("list"))) observer.observe(element);
  }

  const shotKey = (shot: ScreenshotInfo) => `${ctx.instance().id}/${shot.fileName}/${shot.takenAt}`;

  function pump() {
    while (inflight < 2 && queue.length) {
      const element = queue.shift()!;
      const shot = shots[Number(element.dataset.i)];
      if (!shot || !element.isConnected) continue;
      const key = shotKey(shot);
      const cached = thumbnails.get(key);
      if (cached) {
        setThumb(element, cached);
        continue;
      }
      inflight++;
      void (async () => {
        try {
          const data = await rpc("screenshots.read", { instanceId: ctx.instance().id, file: shot.fileName }, signal);
          if (!data) return void (element.dataset.failed = "true");
          const small = await makeThumbnail(data);
          if (thumbnails.size >= THUMB_LIMIT) thumbnails.delete(thumbnails.keys().next().value as string);
          thumbnails.set(key, small);
          if (element.isConnected) setThumb(element, small);
        } catch {
          element.dataset.failed = "true";
        } finally {
          inflight--;
          pump();
        }
      })();
    }
  }

  function setThumb(element: HTMLElement, src: string) {
    if (element.querySelector("img")) return;
    const image = document.createElement("img");
    image.alt = "";
    image.src = src;
    element.prepend(image);
  }

  // ------------------------------------------------------------------------------------------ lightbox
  async function openShot(start: number) {
    const stage = document.querySelector<HTMLElement>("#stage");
    if (!stage || !shots.length) return;
    let index = start;
    const box = document.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "截图");
    box.tabIndex = -1;
    box.innerHTML = html`<img alt="" /><div style="position:absolute;top:18px;right:22px;display:flex;gap:8px"><button class="btn sm" data-lb="delete">删除</button><button class="btn sm" data-lb="close">关闭 Esc</button></div><button class="btn icon" data-lb="prev" style="position:absolute;left:22px;top:50%" aria-label="上一张">←</button><button class="btn icon" data-lb="next" style="position:absolute;right:22px;top:50%" aria-label="下一张">→</button><div data-lb-cap style="position:absolute;left:0;right:0;bottom:16px;text-align:center;color:#fff;font-size:12px;letter-spacing:.5px"></div>`.value;
    stage.append(box);
    box.focus({ preventScroll: true });
    const image = box.querySelector("img")!;
    const caption = box.querySelector<HTMLElement>("[data-lb-cap]")!;
    let token = 0;
    const show = async () => {
      const mine = ++token;
      const shot = shots[index];
      caption.textContent = `${shot.fileName} · ${formatDateTime(shot.takenAt)} · ${formatBytes(shot.size)} · ${index + 1}/${shots.length}`;
      image.removeAttribute("src");
      image.style.opacity = "0.4";
      const data = await rpc("screenshots.read", { instanceId: ctx.instance().id, file: shot.fileName }, signal).catch(() => null);
      if (mine !== token) return;
      if (data && /^data:image\/(png|jpeg);base64,/.test(data)) {
        image.src = data;
        image.style.opacity = "1";
      } else caption.textContent += " · 文件太大或无法读取";
    };
    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      closeLightbox = undefined;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        close();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.stopPropagation();
        index = (index + (event.key === "ArrowRight" ? 1 : -1) + shots.length) % shots.length;
        void show();
      }
    };
    document.addEventListener("keydown", onKey, true);
    closeLightbox = close;
    box.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;
      const which = target.closest<HTMLElement>("[data-lb]")?.dataset.lb;
      if (which === "close" || target === box) return close();
      if (which === "prev" || which === "next") {
        index = (index + (which === "next" ? 1 : -1) + shots.length) % shots.length;
        return void show();
      }
      if (which === "delete") {
        const shot = shots[index];
        if (!(await confirmDialog({ title: "删除这张截图？", message: shot.fileName, confirm: "删除", danger: true }))) return;
        if (await guard(() => rpc("localfiles.remove", { instanceId: ctx.instance().id, folder: "screenshots", file: shot.fileName }).then(() => true))) {
          shots.splice(index, 1);
          thumbnails.delete(shotKey(shot));
          paintShots();
          if (!shots.length) return close();
          index = Math.min(index, shots.length - 1);
          void show();
        }
      }
    });
    void show();
  }

  // ------------------------------------------------------------------------------------------ pack rows
  async function more(button: HTMLElement, file: string, folder: "resourcepacks" | "shaderpacks") {
    const choice = await openMenu(button, [
      { id: "rename", label: "重命名文件" },
      { id: "delete", label: "删除", danger: true, divider: true },
    ]);
    const instanceId = ctx.instance().id;
    if (choice === "rename") {
      const name = await promptDialog({ title: "重命名", label: "文件名", value: file, confirm: "保存", validate: (v) => (!v ? "名称不能为空" : /[\\/:*?"<>|]/.test(v) ? "不能包含 \\ / : * ? \" < > |" : undefined) });
      if (name && name !== file && (await guard(() => rpc("localfiles.rename", { instanceId, folder, file, newName: name }).then(() => true)))) void load();
    } else if (choice === "delete") {
      const ok = await confirmDialog({ title: "删除这个文件？", message: html`<p style="margin:0;line-height:1.8"><b>${file}</b><br />会被永久删除。</p>`, confirm: "删除", danger: true });
      if (ok && (await guard(() => rpc("localfiles.remove", { instanceId, folder, file }).then(() => true)))) {
        toast("已删除", "ok");
        void load();
      }
    }
  }

  onAll(body, "click", "[data-s]", (element) => {
    section = element.dataset.s as Section;
    lastSection = section;
    for (const button of $$("[data-s]", body)) button.setAttribute("aria-pressed", String(button === element));
    void load();
  });
  onAll(body, "click", "[data-more]", (element) => {
    const index = Number(element.closest<HTMLElement>(".item")?.dataset.i);
    if (section === "resourcepacks" && resourcePacks[index]) void more(element, resourcePacks[index].fileName, "resourcepacks");
    else if (section === "shaderpacks" && shaderPacks[index]) void more(element, shaderPacks[index].fileName, "shaderpacks");
  });
  onAll(body, "click", ".shot", (element) => void openShot(Number(element.dataset.i)));
  onAll(body, "click", "[data-act]", (element) => {
    switch (element.dataset.act) {
      case "res-browse":
        return void import("../content-browse").then(({ browseContent }) => browseContent({ kind: element.dataset.kind as "resourcepack" | "shader", instanceId: ctx.instance().id }));
      case "res-folder":
        return void openFolder(ctx.instance().id, section);
      case "res-reload":
        return void load();
    }
  });

  void load();
  return {
    update() {
      const done = doneCount();
      if (done === doneContent) return;
      doneContent = done;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => section !== "screenshots" && void load(), 400);
    },
    dispose() {
      clearTimeout(reloadTimer);
      observer?.disconnect();
      queue.length = 0;
      closeLightbox?.();
    },
  };
}
