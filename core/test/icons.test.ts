import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ICON_MAX_BYTES, createIconFetcher, iconUrlAllowed, sniffImage } from "../src/content/icons";
import { HttpClient } from "../src/net/http";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let server: http.Server;
let base = "";
const hits = new Map<string, number>();

before(async () => {
  server = http.createServer((request, response) => {
    hits.set(request.url!, (hits.get(request.url!) ?? 0) + 1);
    if (request.url === "/ok.png") return void response.writeHead(200, { "content-type": "image/png" }).end(PNG);
    if (request.url === "/text.png") return void response.writeHead(200).end("<html>not an image</html>");
    if (request.url === "/huge.png") return void response.writeHead(200).end(Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES + 10)]));
    if (request.url === "/missing.png") return void response.writeHead(404).end("no");
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe("project icons", () => {
  it("only fetches known CDN hosts over https, or loopback over http", () => {
    assert.equal(iconUrlAllowed("https://cdn.modrinth.com/data/AANobbMI/icon.png"), true);
    assert.equal(iconUrlAllowed("https://media.forgecdn.net/avatars/1/2/3.png"), true);
    assert.equal(iconUrlAllowed("https://modrinth.com/x.png"), true);
    assert.equal(iconUrlAllowed("http://cdn.modrinth.com/x.png"), false);
    assert.equal(iconUrlAllowed("https://evil.example.com/x.png"), false);
    assert.equal(iconUrlAllowed("https://cdn.modrinth.com.evil.example/x.png"), false);
    assert.equal(iconUrlAllowed("https://user:pw@cdn.modrinth.com/x.png"), false);
    assert.equal(iconUrlAllowed("http://127.0.0.1:8080/x.png"), true);
    assert.equal(iconUrlAllowed("http://192.168.1.5/x.png"), false);
    assert.equal(iconUrlAllowed("file:///etc/passwd"), false);
    assert.equal(iconUrlAllowed("not a url"), false);
  });

  it("recognises images by their first bytes", () => {
    assert.equal(sniffImage(PNG), "image/png");
    assert.equal(sniffImage(Buffer.from("ffd8ffe0", "hex")), "image/jpeg");
    assert.equal(sniffImage(Buffer.from("GIF89a")), "image/gif");
    assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImage(Buffer.from("<svg xmlns=...")), undefined);
    assert.equal(sniffImage(Buffer.alloc(0)), undefined);
  });

  it("returns a data URL, caches it, and refuses non-images, oversized files and errors", async () => {
    const client = new HttpClient({ userAgent: "test" });
    const fetchIcon = createIconFetcher(client);
    try {
      const first = await fetchIcon(`${base}/ok.png`);
      assert.equal(first, `data:image/png;base64,${PNG.toString("base64")}`);
      await fetchIcon(`${base}/ok.png`);
      assert.equal(hits.get("/ok.png"), 1, "the second call is served from the cache");
      assert.equal(await fetchIcon(`${base}/text.png`), null);
      assert.equal(await fetchIcon(`${base}/huge.png`), null);
      assert.equal(await fetchIcon(`${base}/missing.png`), null);
      await fetchIcon(`${base}/missing.png`);
      assert.equal(hits.get("/missing.png"), 2, "a failure is retried, not remembered");
      assert.equal(await fetchIcon("https://evil.example.com/a.png"), null);
      assert.equal(hits.has("/a.png"), false);
    } finally {
      client.destroy();
    }
  });
});
