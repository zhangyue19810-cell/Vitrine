import type { StageItem } from "../archive-stage";
import { html } from "./dom";
import type { ProjectPayload } from "./faces";

/**
 * A flat, DOM-only version of the archive row. The normal download view is drawn by the 3D stage; if WebGL is missing or
 * the scene was released while a game is running, this keeps the same search controls, project actions and keyboard
 * navigation available without falling back to the old browse sheet.
 */
export interface FlatDownloadCallbacks {
  select(index: number): void;
  activate(index: number): void;
  action(id: string, index: number): void;
  more(): void;
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

export class FlatDownloadStage {
  readonly element: HTMLElement;
  private readonly track: HTMLElement;
  private items: StageItem[] = [];
  private index = 0;
  private lastMore = 0;

  constructor(mount: HTMLElement, private readonly callbacks: FlatDownloadCallbacks) {
    this.element = document.createElement("div");
    this.element.className = "dl-flat";
    this.element.hidden = true;
    this.element.innerHTML = '<div class="dl-flat-track" data-f="flat-track" role="list"></div>';
    this.track = this.element.firstElementChild as HTMLElement;
    mount.prepend(this.element);

    this.element.addEventListener("click", (event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-flat-action], [data-flat-more], [data-flat-index]");
      if (!target) return;
      if (target.dataset.flatAction) {
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.action(target.dataset.flatAction, Number(target.dataset.flatIndex));
        return;
      }
      if (target.dataset.flatMore !== undefined) {
        event.preventDefault();
        this.callbacks.more();
        return;
      }
      if (target.dataset.flatIndex !== undefined) this.select(Number(target.dataset.flatIndex));
    });
    this.element.addEventListener("dblclick", (event) => {
      if ((event.target as Element | null)?.closest("[data-flat-action], [data-flat-more]")) return;
      const card = (event.target as Element | null)?.closest<HTMLElement>("[data-flat-index]");
      if (card) this.callbacks.activate(Number(card.dataset.flatIndex));
    });
    this.track.addEventListener(
      "wheel",
      (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        this.track.scrollLeft += event.deltaY;
      },
      { passive: false },
    );
    this.track.addEventListener(
      "scroll",
      () => {
        const now = Date.now();
        if (now - this.lastMore < 700) return;
        if (this.track.scrollLeft + this.track.clientWidth < this.track.scrollWidth - 360) return;
        this.lastMore = now;
        this.callbacks.more();
      },
      { passive: true },
    );
  }

  get selectedItem(): number {
    return this.index;
  }

  show(items: StageItem[], selected = 0) {
    this.items = items.slice();
    this.index = clamp(selected, Math.max(0, this.items.length - 1));
    this.element.hidden = false;
    this.element.dataset.loading = "false";
    this.render(false);
  }

  replace(items: StageItem[]) {
    this.items = items.slice();
    this.index = clamp(this.index, Math.max(0, this.items.length - 1));
    this.element.dataset.loading = "false";
    this.render(true);
  }

  swap(items: StageItem[] | null) {
    if (!items) {
      this.element.dataset.loading = "true";
      return;
    }
    this.replace(items);
  }

  append(items: StageItem[]) {
    if (!items.length) return;
    this.items = this.items.concat(items);
    this.render(true);
  }

  update(index: number, item: StageItem) {
    if (index < 0 || index >= this.items.length) return;
    this.items[index] = item;
    this.render(true);
  }

  select(index: number, notify = false) {
    if (!this.items.length) return;
    const next = clamp(index, this.items.length - 1);
    if (next === this.index && !notify) return;
    this.index = next;
    for (const card of this.track.querySelectorAll<HTMLElement>("[data-flat-index]")) {
      const on = Number(card.dataset.flatIndex) === next;
      card.dataset.selected = String(on);
      card.setAttribute("aria-selected", String(on));
    }
    this.reveal(next);
    if (notify) this.callbacks.select(next);
  }

  step(direction: number) {
    if (!this.items.length) return;
    const next = this.index + direction;
    if (next >= this.items.length) this.callbacks.more();
    this.select(clamp(next, this.items.length - 1), true);
  }

  hide() {
    this.element.hidden = true;
    this.element.dataset.loading = "false";
  }

  private reveal(index: number) {
    const card = this.track.querySelector<HTMLElement>(`[data-flat-index="${index}"]`);
    if (!card) return;
    const left = card.offsetLeft;
    const right = left + card.offsetWidth;
    if (left < this.track.scrollLeft + 12) this.track.scrollLeft = Math.max(0, left - 12);
    else if (right > this.track.scrollLeft + this.track.clientWidth - 12) this.track.scrollLeft = right - this.track.clientWidth + 12;
  }

  private render(keepScroll: boolean) {
    const scroll = keepScroll ? this.track.scrollLeft : 0;
    this.track.innerHTML = html`${this.items.map((item, index) => this.card(item, index))}${
      this.items.length ? html`<button class="dl-flat-more" data-flat-more type="button"><span>继续加载</span><small>滚轮或 → 查看后面的项目</small></button>` : ""
    }`.value;
    this.attachIcons();
    this.track.scrollLeft = scroll;
    const selected = this.track.querySelector<HTMLElement>(`[data-flat-index="${this.index}"]`);
    selected?.setAttribute("data-selected", "true");
    selected?.setAttribute("aria-selected", "true");
  }

  private card(item: StageItem, index: number) {
    const payload = item.payload as ProjectPayload | undefined;
    if (!payload || payload.kind !== "project") return html``;
    return this.projectCard(payload, index);
  }

  private projectCard(project: ProjectPayload, index: number) {
    const loading = project.title === "正在加载…";
    const selected = index === this.index;
    const icon = project.icon;
    const glyph = project.title.slice(0, 1).toUpperCase() || "?";
    const actions = loading
      ? html``
      : html`<div class="dl-flat-actions">
          <button class="btn sm accent" data-flat-action="install" data-flat-index="${index}" type="button">${project.installLabel}</button>
          <button class="btn sm soft" data-flat-action="versions" data-flat-index="${index}" type="button">版本…</button>
          <button class="btn sm ghost" data-flat-action="mcmod" data-flat-index="${index}" type="button">百科</button>
          <button class="btn sm ghost" data-flat-action="page" data-flat-index="${index}" type="button" title="在浏览器中打开">↗</button>
        </div>`;
    return html`<article class="dl-flat-card" data-flat-index="${index}" data-selected="${selected}" aria-selected="${selected}" role="listitem" data-loading="${loading}">
      <div class="dl-flat-head">
        <div class="dl-flat-icon" data-flat-icon="${index}">${icon ? "" : glyph}</div>
        <div class="dl-flat-heading">
          <div class="dl-flat-kicker">${project.source}${project.kindLabel ? ` · ${project.kindLabel}` : ""}</div>
          <h3 title="${project.title}">${project.title}</h3>
          <div class="dl-flat-by">${project.author ? `${project.author} · ` : ""}↓ ${project.downloads}${project.updated ? ` · 更新 ${project.updated}` : ""}</div>
        </div>
      </div>
      <p class="dl-flat-summary" title="${project.summary}">${project.summary || "正在读取项目简介…"}</p>
      <div class="dl-flat-tags">${project.categories.slice(0, 4).map((category) => html`<span class="chip">${category}</span>`)}${project.sides.map((side) => html`<span class="chip accent">${side}</span>`)}</div>
      <div class="grow"></div>
      ${actions}
    </article>`;
  }

  private attachIcons() {
    for (const [index, item] of this.items.entries()) {
      const payload = item.payload as ProjectPayload | undefined;
      if (!payload || payload.kind !== "project" || !(payload.icon instanceof HTMLImageElement)) continue;
      const slot = this.track.querySelector<HTMLElement>(`[data-flat-icon="${index}"]`);
      if (!slot) continue;
      slot.textContent = "";
      const image = payload.icon.cloneNode(true) as HTMLImageElement;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      slot.append(image);
    }
  }
}
