import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpClient, isUnsafeRedirectHostname, unsafeRedirectReason } from "../src/net/http";
import { startMock } from "./helpers/mock-server";

describe("HTTP redirect safety", () => {
  it("identifies loopback, private-name and IP redirect destinations", () => {
    for (const host of ["127.0.0.1", "10.0.0.8", "192.168.1.2", "169.254.169.254", "[::1]", "localhost", "printer.local", "metadata.google.internal"]) {
      assert.equal(isUnsafeRedirectHostname(host), true, host);
    }
    for (const host of ["cdn.modrinth.com", "raw.githubusercontent.com", "mediafilez.forgecdn.net", "8.8.8.8.example.com"]) {
      assert.equal(isUnsafeRedirectHostname(host), false, host);
    }
  });

  it("refuses HTTPS downgrades, credentials and private destinations", () => {
    assert.equal(unsafeRedirectReason("https://github.com/a", "http://github.com/b"), "HTTPS downgrade");
    assert.equal(unsafeRedirectReason("https://github.com/a", "https://user:pass@github.com/b"), "URL credentials");
    assert.equal(unsafeRedirectReason("https://github.com/a", "https://127.0.0.1/b"), "loopback/private/IP destination");
    assert.equal(unsafeRedirectReason("https://github.com/a", "file:///etc/passwd"), "unsupported protocol");
    assert.equal(unsafeRedirectReason("https://github.com/a", "https://cdn.modrinth.com/b"), undefined);
  });

  it("does not follow a redirect into the local machine", async () => {
    const server = await startMock((_req, res) => {
      res.writeHead(302, { location: "https://127.0.0.1/secret" });
      res.end();
    });
    const http = new HttpClient({ userAgent: "vitrine-test" });
    try {
      await assert.rejects(http.request(`${server.url}/redirect`), (error: Error & { code?: string }) => error.code === "ERR_UNSAFE_REDIRECT");
    } finally {
      http.destroy();
      await server.close();
    }
  });
});
