import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LOG_ERRORS, capErrorText } from "../../src/app/log-limit";

describe("log display limit", () => {
  it("keeps at most six failing lines and leaves normal lines alone", () => {
    const lines = ["开始下载", ...Array.from({ length: 9 }, (_, i) => `ERROR 第 ${i + 1} 个错误`), "继续执行"];
    const result = capErrorText(lines.join("\n"));
    assert.equal(result.hidden, 3);
    assert.equal(result.text.split("\n").filter((line) => line.startsWith("ERROR")).length, MAX_LOG_ERRORS);
    assert.ok(result.text.includes("开始下载"));
    assert.ok(result.text.includes("继续执行"));
    assert.ok(result.text.includes("其余 3 条报错已折叠"));
  });

  it("does not append a note when the log is inside the limit", () => {
    const result = capErrorText("ERROR one\ninfo\nException in thread main");
    assert.equal(result.hidden, 0);
    assert.equal(result.text, "ERROR one\ninfo\nException in thread main");
  });
});
