import { escapeHtml } from "../html";

/**
 * Markup helpers. Everything interpolated into `html` is escaped unless it was produced by `html` itself (or marked
 * with `raw`), so text that comes from a server — project titles, MOTDs, mod descriptions — can never become markup.
 */

export class Raw {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (value: string) => new Raw(value);

function render(value: unknown): string {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false || value === true) return "";
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

export function setHtml(element: Element, content: Raw | string) {
  element.innerHTML = typeof content === "string" ? content : content.value;
}

/** http(s) links and image data URLs only: anything else (javascript:, file:) becomes an empty string. */
export function safeUrl(value: string | undefined): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  return "";
}

export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing element ${selector}`);
  return found;
}

export function $maybe<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function $$<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; html?: Raw; attrs?: Record<string, string> } = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html) node.innerHTML = props.html.value;
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

// ---------------------------------------------------------------------------------------------- actions

type ActionHandler = (element: HTMLElement, event: Event) => void | Promise<void>;
const actions = new Map<string, ActionHandler>();
let wired = false;

/** Register a handler for every element carrying `data-act="name"`. */
export function action(name: string, handler: ActionHandler) {
  actions.set(name, handler);
  if (wired) return;
  wired = true;
  document.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-act]");
    if (!target || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return;
    const handler = actions.get(target.dataset.act ?? "");
    if (!handler) return;
    const result = handler(target, event);
    if (result instanceof Promise) result.catch((error) => console.error(`action ${target.dataset.act} failed`, error));
  });
}

export function onAll(root: ParentNode, event: string, selector: string, handler: (element: HTMLElement, event: Event) => void, options?: AddEventListenerOptions) {
  root.addEventListener(
    event,
    (e) => {
      const target = (e.target as Element | null)?.closest<HTMLElement>(selector);
      if (target && root.contains(target)) handler(target, e);
    },
    options,
  );
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Latest-wins guard for async loads triggered by fast input (search boxes, tab switches). */
export class Latest {
  private n = 0;
  next() {
    return ++this.n;
  }
  isCurrent(token: number) {
    return token === this.n;
  }
}
