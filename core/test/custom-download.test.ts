import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downloadCandidates, safeFilename } from "../src/net/custom-download";

describe("custom downloads", () => {
  it("offers the GitHub mirror family only for GitHub URLs", () => {
    const github = downloadCandidates("https://github.com/owner/repo/releases/download/v1/app.zip", "auto");
    assert.equal(github[0].name, "GitHub 直连");
    assert.ok(github.some((entry) => entry.name.includes("阿里云")));
    assert.ok(github.some((entry) => entry.name.includes("华清云")));
    assert.ok(github.some((entry) => entry.url.startsWith("https://ghfast.top/https://github.com/")));
    assert.ok(github.every((entry) => entry.url.includes("owner/repo") || entry.url.includes("github.com")));

    const plain = downloadCandidates("https://example.com/files/app.zip", "auto");
    assert.deepEqual(plain, [{ name: "原始地址", url: "https://example.com/files/app.zip" }]);
    assert.deepEqual(downloadCandidates("https://github.com/o/r/archive/main.zip", "direct").map((entry) => entry.name), ["GitHub 直连"]);
  });

  it("rejects non-web URLs and credentials", () => {
    assert.throws(() => downloadCandidates("file:///etc/passwd"), /http/);
    assert.throws(() => downloadCandidates("https://user:pass@example.com/a.zip"), /用户名或密码/);
    assert.throws(() => downloadCandidates("not a url"), /有效的网址/);
  });

  it("keeps the final filename inside the chosen folder", () => {
    assert.equal(safeFilename("../../evil?.zip"), "_.._evil_.zip");
    assert.equal(safeFilename("   "), "download.bin");
    assert.equal(safeFilename("正常文件.zip"), "正常文件.zip");
    assert.equal(safeFilename("CON"), "CON");
  });
});
