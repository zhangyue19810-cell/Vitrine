import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMcmodSearch } from "../src/content/mcmod";

const sample = `<!doctype html><html><body>
<div class="search-result">
  <p class="info">找到约 12 条结果，共约 1 页。</p>
  <div class="search-result-list">
    <div class="result-item">
      <div class="head">
        <div class="class-category"><ul><li><a class="c_24" href="//www.mcmod.cn/class/category/24-1.html"></a></li></ul></div>
        <a target="_blank" href="https://www.mcmod.cn/class/2785.html">钠 (<em>Sodium</em>)</a>
      </div>
      <div class="body">[h1=📖 概述]<em>Sodium</em> 是一个渲染优化模组&nbsp;&amp; 性能增强。</div>
      <div class="foot"><span class="info"><span class="value">2026-11-06</span></span></div>
    </div>
    <div class="result-item">
      <div class="head"><a target="_blank" href="https://www.mcmod.cn/modpack/644.html"><em>Sodium</em> Plus</a></div>
      <div class="body">一个客户端整合包。</div>
    </div>
  </div>
</div></body></html>`;

describe("MC百科 search parser", () => {
  it("extracts Chinese titles, English names, summaries and safe page URLs", () => {
    const result = parseMcmodSearch(sample, "mod", 0, 30);
    assert.equal(result.total, 12);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].title, "钠 (Sodium)");
    assert.equal(result.items[0].titleEn, "Sodium");
    assert.equal(result.items[0].url, "https://www.mcmod.cn/class/2785.html");
    assert.equal(result.items[0].kind, "mod");
    assert.match(result.items[0].summary, /渲染优化模组/);
    assert.doesNotMatch(result.items[0].summary, /\[h1=/);
    assert.match(result.items[0].summary, /&/);
    assert.equal(result.items[1].url, "https://www.mcmod.cn/modpack/644.html");
    assert.equal(result.items[1].kind, "modpack");
  });

  it("returns an empty result for a query without hits", () => {
    const result = parseMcmodSearch('<div class="search-result"><p class="warning">没有找到有关的内容。</p></div>', "modpack", 2, 30);
    assert.equal(result.items.length, 0);
    assert.equal(result.total, 0);
    assert.equal(result.page, 2);
    assert.equal(result.pageSize, 30);
    assert.equal(result.filter, "modpack");
  });
});
