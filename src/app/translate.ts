/**
 * Best-effort machine translation for public project summaries.
 * Youdao's public demo endpoint handles a short batch and preserves line breaks; MyMemory is the fallback.
 * Nothing here is required for the browser to work: failures simply leave the original text in place.
 */

const YOUDAO = "https://aidemo.youdao.com/trans";
const MYMEMORY = "https://api.mymemory.translated.net/get";
const CHINESE = /[\u3400-\u9fff]/;
const cache = new Map<string, string>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function translatable(value: string): boolean {
  const text = clean(value);
  return text.length >= 2 && /[a-z]/i.test(text) && !CHINESE.test(text);
}

async function getJson(url: string, timeoutMs = 12_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function youdaoBatch(texts: string[]): Promise<string[] | undefined> {
  const query = texts.join("\n");
  if (query.length > 1_000) return undefined;
  const url = `${YOUDAO}?${new URLSearchParams({ q: query, from: "en", to: "zh-CHS" })}`;
  let data = await getJson(url);
  if (data?.errorCode === "411") {
    await sleep(1_200);
    data = await getJson(url);
  }
  if (data?.errorCode !== "0" || !Array.isArray(data.translation) || !data.translation[0]) return undefined;
  const lines = String(data.translation[0]).split("\n").map((line: string) => line.trim());
  return lines.length === texts.length ? lines : undefined;
}

async function myMemoryOne(text: string): Promise<string | undefined> {
  if (text.length > 450) return undefined;
  const url = `${MYMEMORY}?${new URLSearchParams({ q: text, langpair: "en|zh-CN" })}`;
  const data = await getJson(url, 10_000);
  const translated = data?.responseData?.translatedText;
  return data?.responseStatus === 200 && typeof translated === "string" && translated.trim() ? translated.trim() : undefined;
}

function batches(texts: string[], max = 850): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const text of texts) {
    if (current.length && length + text.length + 1 > max) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(text);
    length += text.length + 1;
  }
  if (current.length) out.push(current);
  return out;
}

/** Translate the supplied summaries. Already Chinese and cached strings are returned untouched. */
export async function translateMany(values: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = clean(value);
    if (!translatable(text) || seen.has(text)) continue;
    seen.add(text);
    const cached = cache.get(text);
    if (cached) result.set(text, cached);
    else pending.push(text);
  }
  const groups = batches(pending);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    let translated = await youdaoBatch(group);
    if (!translated) {
      translated = [];
      for (let i = 0; i < group.length; i++) {
        if (i) await sleep(160);
        translated.push((await myMemoryOne(group[i])) ?? group[i]);
      }
    }
    group.forEach((source, index) => {
      const value = translated![index]?.trim();
      if (!value || value === source) return;
      cache.set(source, value);
      result.set(source, value);
    });
    if (groupIndex + 1 < groups.length) await sleep(260);
  }
  return result;
}

export function cachedTranslation(value: string): string | undefined {
  return cache.get(clean(value));
}
