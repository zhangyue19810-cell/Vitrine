import type { HttpClient } from "../net/http";
import { isAbort, sleep } from "../util/async";
import type { ScopedLog } from "../util/log";

export type McmodFilter = "all" | "mod" | "modpack";
export type McmodItemKind = "mod" | "modpack" | "other";

export interface McmodItem {
  title: string;
  /** English name in parentheses when the page exposes one; useful for a follow-up Modrinth/CurseForge search. */
  titleEn?: string;
  summary: string;
  url: string;
  kind: McmodItemKind;
}

export interface McmodSearchResult {
  items: McmodItem[];
  total: number;
  page: number;
  pageSize: number;
  filter: McmodFilter;
}

const SEARCH_ENDPOINT = "https://search.mcmod.cn/s";
const PAGE_SIZE = 30;
const CACHE_TTL_MS = 5 * 60_000;
const FILTER_VALUE: Record<McmodFilter, number> = { all: 0, mod: 1, modpack: 2 };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", middot: "·", times: "×",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function stripInline(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function stripMarkup(value: string): string {
  return decodeEntities(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSummary(value: string): string {
  const text = stripMarkup(value)
    .replace(/\[[^\]\n]{0,80}\]/g, " ")
    .replace(/\[[^\]]*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 260 ? `${text.slice(0, 260).trimEnd()}…` : text;
}

function absoluteMcmodUrl(raw: string): { url: string; kind: McmodItemKind } | undefined {
  const url = raw.startsWith("//") ? `https:${raw}` : raw.replace(/^http:\/\//i, "https://");
  const match = /^https:\/\/(?:www\.)?mcmod\.cn\/(class|modpack)\/(\d+)\.html$/i.exec(url);
  if (!match) return undefined;
  return { url: `https://www.mcmod.cn/${match[1].toLowerCase()}/${match[2]}.html`, kind: match[1].toLowerCase() === "modpack" ? "modpack" : "mod" };
}

function englishName(title: string): string | undefined {
  const parenthesized = title.match(/[（(]([^()（）]*[A-Za-z][^()（）]*)[)）]\s*$/);
  if (parenthesized) return parenthesized[1].trim();
  return /[\u3400-\u9fff]/.test(title) ? undefined : title;
}

/** Parse the public MC百科 search page. Kept separate from the network client so it is easy to test. */
export function parseMcmodSearch(html: string, filter: McmodFilter, page = 0, pageSize = PAGE_SIZE): McmodSearchResult {
  const items: McmodItem[] = [];
  const blocks = html.split('<div class="result-item">').slice(1);
  for (const block of blocks) {
    const link = block.match(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
      ?.map((anchor) => {
        const href = /href="([^"]+)"/i.exec(anchor)?.[1];
        const label = /^<a\s+[^>]*>([\s\S]*?)<\/a>$/i.exec(anchor)?.[1] ?? "";
        return href ? { href, text: stripInline(label) } : undefined;
      })
      .find((entry): entry is { href: string; text: string } => Boolean(entry && entry.text && absoluteMcmodUrl(entry.href)));
    if (!link) continue;
    const target = absoluteMcmodUrl(link.href);
    if (!target || !link.text) continue;
    const body = /<div class="body">([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? "";
    items.push({ title: link.text, titleEn: englishName(link.text), summary: cleanSummary(body) || "MC百科暂未提供简介。", url: target.url, kind: target.kind });
  }
  const totalMatch = /找到约\s*([\d,]+)\s*条结果/.exec(html);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : items.length;
  return { items, total, page: Math.max(0, page), pageSize, filter };
}

interface CacheEntry {
  at: number;
  value: McmodSearchResult;
}

/** Small, polite client for the public MC百科 search page. Results are cached to avoid repeat requests. */
export class McmodClient {
  private readonly cache = new Map<string, CacheEntry>();
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly log?: ScopedLog,
  ) {}

  /** Serialize requests and leave a small gap so fast typing does not look like a crawler. */
  private requestPage(url: string, signal?: AbortSignal): Promise<string> {
    const run = this.queue.then(async () => {
      const wait = Math.max(0, 1_000 - (Date.now() - this.lastRequestAt));
      if (wait) await sleep(wait, signal);
      this.lastRequestAt = Date.now();
      return this.http.getText(url, {
        signal,
        timeoutMs: 20_000,
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9" },
      });
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async search(query: string, options: { filter?: McmodFilter; page?: number; signal?: AbortSignal } = {}): Promise<McmodSearchResult> {
    const text = query.trim().slice(0, 120);
    const filter = options.filter ?? "all";
    const page = Math.max(0, Math.min(options.page ?? 0, 200));
    if (!text) return { items: [], total: 0, page, pageSize: PAGE_SIZE, filter };
    const key = `${filter}\u0000${page}\u0000${text.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set("key", text);
    url.searchParams.set("filter", String(FILTER_VALUE[filter]));
    url.searchParams.set("mold", "0");
    url.searchParams.set("page", String(page + 1));
    this.log?.info(`searching MC百科 for "${text}" (${filter}, page ${page + 1})`);
    const fetchPage = async () => {
      try {
        return await this.requestPage(url.toString(), options.signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new Error("连接 MC百科失败，请检查网络或稍后重试。");
      }
    };
    let html = await fetchPage();
    if (!html.includes("search-result") && !html.includes("result-item")) throw new Error("MC百科返回了无法识别的页面，可能触发访问限制或站点改版。");
    let result = parseMcmodSearch(html, filter, page, PAGE_SIZE);
    // The public search endpoint occasionally serves an empty shell before its index catches up.
    // Tell a genuine "no hits" page apart and retry once instead of presenting a false empty result.
    if (!result.items.length && !html.includes("没有找到")) {
      await sleep(1_200, options.signal);
      html = await fetchPage();
      result = parseMcmodSearch(html, filter, page, PAGE_SIZE);
    }
    if (!result.items.length && !html.includes("没有找到") && !html.includes("没有找到与")) throw new Error("MC百科暂时没有返回搜索结果，请稍后重试。");
    if (this.cache.size >= 120) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.cache.set(key, { at: Date.now(), value: result });
    return result;
  }
}
