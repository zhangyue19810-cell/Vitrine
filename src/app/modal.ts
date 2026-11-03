import { action, el, html, raw, type Raw } from "./dom";
import { sound } from "./sound";

/**
 * Sheets are full pages that slide over the shelf (settings, downloads, browsing…); because they are opaque the 3D scene
 * stops drawing while one is open. Dialogs are small cards over a translucent scrim (confirmations, forms).
 * Escape closes the top-most; the background goes `inert` so focus cannot wander behind it.
 */

export interface ModalHandle {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly tools: HTMLElement;
  readonly closed: Promise<void>;
  close(): void;
  setTitle(eyebrow: string, title: string): void;
}

interface Entry {
  kind: "sheet" | "dialog";
  root: HTMLElement;
  scrim?: HTMLElement;
  opener: Element | null;
  onClose?: () => void;
  beforeClose?: () => boolean | Promise<boolean>;
  done: () => void;
  closing: boolean;
}

const stack: Entry[] = [];
const listeners = new Set<() => void>();

function rootElement(): HTMLElement {
  return document.querySelector<HTMLElement>("#modal-root")!;
}

function notify() {
  const root = rootElement();
  stack.forEach((entry, index) => {
    const top = index === stack.length - 1;
    entry.root.toggleAttribute("inert", !top);
    entry.root.setAttribute("aria-hidden", String(!top));
    if (entry.scrim) entry.scrim.toggleAttribute("inert", !top);
  });
  root.dataset.open = String(stack.length > 0);
  for (const listener of [...listeners]) listener();
}

export const modals = {
  /** Something is open (the shelf behind it cannot be used). */
  get open() {
    return stack.some((entry) => !entry.closing);
  },
  /** An opaque sheet covers the 3D scene. */
  get coversScene() {
    return stack.some((entry) => entry.kind === "sheet" && !entry.closing);
  },
  get depth() {
    return stack.filter((entry) => !entry.closing).length;
  },
  onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Close everything (a game started, the core went away…). */
  closeAll() {
    for (const entry of [...stack].reverse()) void finish(entry);
  },
};

async function finish(entry: Entry, force = true) {
  if (entry.closing) return;
  if (!force && entry.beforeClose && !(await entry.beforeClose())) return;
  entry.closing = true;
  notify();
  entry.root.classList.add("leaving");
  entry.scrim?.classList.add("leaving");
  sound.play("close");
  await new Promise<void>((resolve) => {
    let settled = false;
    const end = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    entry.root.addEventListener("animationend", end, { once: true });
    setTimeout(end, 320);
  });
  entry.root.remove();
  entry.scrim?.remove();
  const index = stack.indexOf(entry);
  if (index >= 0) stack.splice(index, 1);
  notify();
  const opener = entry.opener;
  if (opener instanceof HTMLElement && opener.isConnected && !modals.open) opener.focus({ preventScroll: true });
  entry.onClose?.();
  entry.done();
}

function focusFirst(root: HTMLElement) {
  const target = root.querySelector<HTMLElement>("[autofocus], input:not([type=hidden]):not([disabled]), textarea, select") ?? root.querySelector<HTMLElement>(".btn.primary, .btn.accent") ?? root;
  if (!target.hasAttribute("tabindex") && target === root) root.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function register(entry: Omit<Entry, "done" | "closing">, root: HTMLElement): { entry: Entry; closed: Promise<void> } {
  let done!: () => void;
  const closed = new Promise<void>((resolve) => (done = resolve));
  const full: Entry = { ...entry, done, closing: false };
  stack.push(full);
  notify();
  sound.play("open");
  queueMicrotask(() => focusFirst(root));
  return { entry: full, closed };
}

export interface SheetOptions {
  eyebrow: string;
  title: string;
  /** Extra markup for the right side of the header (before the close button). */
  tools?: Raw;
  /** Scroll the body instead of letting the content manage its own panes. */
  scroll?: boolean;
  onClose?: () => void;
  /** Return false to keep the sheet open (unsaved input). */
  beforeClose?: () => boolean | Promise<boolean>;
}

export function openSheet(options: SheetOptions): ModalHandle {
  const root = el("section", { class: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": options.title } });
  root.innerHTML = html`
    <header class="sheet-head">
      <div class="sheet-title"><div class="micro" data-slot="eyebrow">${options.eyebrow}</div><h2 data-slot="title">${options.title}</h2></div>
      <div class="sheet-tools" data-slot="tools">${options.tools ?? ""}</div>
      <button class="btn icon ghost" data-act="modal-close" aria-label="关闭" title="关闭 (Esc)">✕</button>
    </header>
    <div class="sheet-body${options.scroll ? " scroll" : ""}" data-slot="body"></div>`.value;
  rootElement().append(root);
  const { entry, closed } = register({ kind: "sheet", root, opener: document.activeElement, onClose: options.onClose, beforeClose: options.beforeClose }, root);
  return {
    root,
    body: root.querySelector<HTMLElement>('[data-slot="body"]')!,
    tools: root.querySelector<HTMLElement>('[data-slot="tools"]')!,
    closed,
    close: () => void finish(entry, false),
    setTitle(eyebrow, title) {
      root.querySelector('[data-slot="eyebrow"]')!.textContent = eyebrow;
      root.querySelector('[data-slot="title"]')!.textContent = title;
      root.setAttribute("aria-label", title);
    },
  };
}

export interface DialogButton {
  id: string;
  label: string;
  kind?: "primary" | "accent" | "danger" | "ghost" | "";
  /** Keep the dialog open when clicked (the caller decides). */
  keepOpen?: boolean;
}

export interface DialogOptions {
  eyebrow?: string;
  title: string;
  body?: Raw | HTMLElement | string;
  size?: "narrow" | "normal" | "wide";
  buttons?: DialogButton[];
  /** Id used when Escape or the scrim is pressed. */
  cancelId?: string;
  /** Enter presses this button (when focus is not in a textarea or on another button). */
  defaultId?: string;
  dismissOnScrim?: boolean;
  onButton?: (id: string, handle: DialogHandle) => void | boolean | Promise<void | boolean>;
}

export interface DialogHandle extends ModalHandle {
  /** Resolves with the id of the button that closed the dialog (or the cancel id). */
  readonly result: Promise<string>;
  button(id: string): HTMLButtonElement | null;
  finishWith(id: string): void;
}

export function openDialog(options: DialogOptions): DialogHandle {
  const scrim = el("div", { class: "scrim" });
  const root = el("section", { class: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-label": options.title } });
  if (options.size && options.size !== "normal") root.dataset.size = options.size;
  const buttons = options.buttons ?? [{ id: "ok", label: "好", kind: "primary" as const }];
  root.innerHTML = html`
    <header class="dialog-head">
      <div style="min-width:0">${options.eyebrow ? html`<div class="micro" data-slot="eyebrow">${options.eyebrow}</div>` : ""}<h3 data-slot="title">${options.title}</h3></div>
      <button class="btn icon ghost sm" data-act="modal-close" aria-label="关闭">✕</button>
    </header>
    <div class="dialog-body" data-slot="body"></div>
    ${buttons.length ? html`<footer class="dialog-foot">${buttons.map((b) => html`<button class="btn ${b.kind ?? ""}" data-dialog-button="${b.id}">${b.label}</button>`)}</footer>` : ""}`.value;
  const body = root.querySelector<HTMLElement>('[data-slot="body"]')!;
  if (options.body instanceof HTMLElement) body.append(options.body);
  else if (options.body !== undefined) body.innerHTML = typeof options.body === "string" ? html`${options.body}`.value : options.body.value;
  const modalRoot = rootElement();
  modalRoot.append(scrim, root);

  let resolveResult!: (id: string) => void;
  const result = new Promise<string>((resolve) => (resolveResult = resolve));
  const cancelId = options.cancelId ?? "cancel";
  let chosen = cancelId;
  const registered = register({ kind: "dialog", root, scrim, opener: document.activeElement, onClose: () => resolveResult(chosen) }, root);
  const handle: DialogHandle = {
    root,
    body,
    tools: root,
    closed: registered.closed,
    result,
    close: () => void finish(registered.entry),
    finishWith(id) {
      chosen = id;
      void finish(registered.entry);
    },
    button: (id) => root.querySelector<HTMLButtonElement>(`[data-dialog-button="${id}"]`),
    setTitle(eyebrow, title) {
      const e = root.querySelector('[data-slot="eyebrow"]');
      if (e) e.textContent = eyebrow;
      root.querySelector('[data-slot="title"]')!.textContent = title;
    },
  };
  root.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-dialog-button]");
    if (!target) return;
    const id = target.dataset.dialogButton!;
    const spec = buttons.find((b) => b.id === id);
    if (options.onButton) {
      target.setAttribute("data-busy", "true");
      try {
        const keep = await options.onButton(id, handle);
        if (keep === false) return;
      } finally {
        target.removeAttribute("data-busy");
      }
    }
    if (spec?.keepOpen) return;
    handle.finishWith(id);
  });
  if (options.dismissOnScrim !== false) scrim.addEventListener("click", () => handle.finishWith(cancelId));
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "BUTTON" || target.tagName === "SELECT") return;
    const id = options.defaultId ?? buttons.find((b) => b.kind === "primary" || b.kind === "accent" || b.kind === "danger")?.id;
    if (id) {
      event.preventDefault();
      root.querySelector<HTMLButtonElement>(`[data-dialog-button="${id}"]`)?.click();
    }
  });
  return handle;
}

export async function confirmDialog(options: { title: string; message?: Raw | string; confirm?: string; cancel?: string; danger?: boolean; eyebrow?: string }): Promise<boolean> {
  const dialog = openDialog({
    eyebrow: options.eyebrow ?? "CONFIRM",
    title: options.title,
    size: "narrow",
    body: options.message === undefined ? undefined : typeof options.message === "string" ? raw(`<p style="margin:0">${html`${options.message}`.value}</p>`) : options.message,
    buttons: [
      { id: "cancel", label: options.cancel ?? "取消", kind: "" },
      { id: "ok", label: options.confirm ?? "确定", kind: options.danger ? "danger" : "primary" },
    ],
  });
  return (await dialog.result) === "ok";
}

export async function alertDialog(options: { title: string; message?: Raw | string; eyebrow?: string; label?: string }): Promise<void> {
  const dialog = openDialog({
    eyebrow: options.eyebrow ?? "NOTICE",
    title: options.title,
    body: options.message === undefined ? undefined : typeof options.message === "string" ? raw(`<p style="margin:0;white-space:pre-wrap">${html`${options.message}`.value}</p>`) : options.message,
    buttons: [{ id: "ok", label: options.label ?? "知道了", kind: "primary" }],
    cancelId: "ok",
  });
  await dialog.result;
}

export async function promptDialog(options: {
  title: string;
  label?: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirm?: string;
  multiline?: boolean;
  validate?: (value: string) => string | undefined | Promise<string | undefined>;
}): Promise<string | undefined> {
  const body = el("div", { class: "stack" });
  body.innerHTML = html`
    ${options.message ? html`<div class="muted" style="font-size:13px">${options.message}</div>` : ""}
    <div class="field">
      ${options.label ? html`<label>${options.label}</label>` : ""}
      ${options.multiline ? html`<textarea class="textarea" data-field autofocus placeholder="${options.placeholder ?? ""}"></textarea>` : html`<input class="input" data-field autofocus autocomplete="off" spellcheck="false" placeholder="${options.placeholder ?? ""}" />`}
      <div class="hint-text" data-error style="color:var(--danger)" hidden></div>
    </div>`.value;
  const input = body.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-field]")!;
  input.value = options.value ?? "";
  const error = body.querySelector<HTMLElement>("[data-error]")!;
  let value: string | undefined;
  const dialog = openDialog({
    eyebrow: "INPUT",
    title: options.title,
    body,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "ok", label: options.confirm ?? "确定", kind: "primary" },
    ],
    onButton: async (id) => {
      if (id !== "ok") return;
      const text = input.value.trim();
      const problem = await options.validate?.(text);
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus({ preventScroll: true });
        return false;
      }
      value = text;
    },
  });
  queueMicrotask(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
  await dialog.result;
  return value;
}

// ---------------------------------------------------------------------------------------------- toasts

export type ToastKind = "info" | "ok" | "error";

export function toast(message: string, kind: ToastKind = "info", ms = kind === "error" ? 6000 : 3400) {
  const root = document.querySelector<HTMLElement>("#toast-root");
  if (!root) return;
  const item = el("div", { class: "toast", text: message, attrs: { "data-kind": kind, role: kind === "error" ? "alert" : "status" } });
  root.append(item);
  while (root.children.length > 3) root.firstElementChild?.remove();
  if (kind === "error") sound.play("error");
  const remove = () => {
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 240);
  };
  const timer = setTimeout(remove, ms);
  item.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
}

// ---------------------------------------------------------------------------------------------- keys and buttons

let wired = false;
export function wireModals() {
  if (wired) return;
  wired = true;
  action("modal-close", (target) => {
    const root = target.closest<HTMLElement>(".sheet, .dialog");
    const entry = stack.find((e) => e.root === root) ?? stack[stack.length - 1];
    if (entry) void finish(entry, false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const top = [...stack].reverse().find((entry) => !entry.closing);
    if (!top) return;
    // A menu or the lightbox inside the modal gets the first Escape.
    const open = top.root.querySelector<HTMLElement>(".menu, .lightbox");
    if (open) return;
    event.preventDefault();
    if (top.kind === "dialog") {
      const cancel = top.root.querySelector<HTMLButtonElement>('[data-dialog-button="cancel"]');
      if (cancel) cancel.click();
      else void finish(top, false);
    } else void finish(top, false);
  });
}
