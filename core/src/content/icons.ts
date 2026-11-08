import type { HttpClient } from "../net/http";

/**
 * Icons of online projects, fetched by the core and handed to the interface as `data:` URLs.
 *
 * The 3D interface prints the icon onto an archive, which needs pixels the page is allowed to read; a plain `<img>` from
 * another origin is not (no CORS headers on most CDNs). Going through the core also gives the icons the same proxy,
 * timeouts and retry behaviour as every other download. Only known CDN hosts are fetched, and only small images.
 */

const ALLOWED_SUFFIXES = [".modrinth.com", ".forgecdn.net", ".curseforge.com", ".mcimirror.top", ".githubusercontent.com"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const ICON_MAX_BYTES = 600_000;
const CACHE_LIMIT = 500;

/** Whether `raw` may be fetched: https on a known CDN, or plain http on the loopback interface (the offline demo). */
export function iconUrlAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:") return LOOPBACK.has(host);
  if (url.protocol !== "https:") return false;
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/** MIME type from the first bytes, or undefined when the data is not a PNG, JPEG, GIF or WebP image. */
export function sniffImage(data: Uint8Array): string | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image/gif";
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
  return undefined;
}

export type IconFetcher = (url: string, signal?: AbortSignal) => Promise<string | null>;

/** A fetcher with a small in-memory cache; concurrent requests for one URL share a single download. */
export function createIconFetcher(http: Pick<HttpClient, "request">): IconFetcher {
  const cache = new Map<string, Promise<string | null>>();
  const fetchOne = async (url: string, signal?: AbortSignal): Promise<string | null> => {
    const response = await http.request(url, { signal, timeoutMs: 8000, maxRedirects: 2, headers: { accept: "image/png,image/*;q=0.8" } });
    try {
      if (response.status < 200 || response.status >= 300 || !iconUrlAllowed(response.url)) return null;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += (chunk as Buffer).length;
        if (size > ICON_MAX_BYTES) return null;
        chunks.push(chunk as Buffer);
      }
      const data = Buffer.concat(chunks);
      const mime = sniffImage(data);
      return mime ? `data:${mime};base64,${data.toString("base64")}` : null;
    } finally {
      response.body.destroy();
    }
  };
  return (url, signal) => {
    if (!iconUrlAllowed(url)) return Promise.resolve(null);
    const known = cache.get(url);
    if (known) return known;
    const job = fetchOne(url, signal).catch(() => null);
    cache.set(url, job);
    // A failure is not remembered (the network may come back); successes are, up to a limit.
    void job.then((value) => {
      if (value === null) cache.delete(url);
    });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return job;
  };
}
