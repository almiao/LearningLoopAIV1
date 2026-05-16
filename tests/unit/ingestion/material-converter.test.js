import test from "node:test";
import assert from "node:assert/strict";

import {
  convertRemoteMaterialUrl,
  convertUploadedMaterial,
  maxUploadBytes,
  validateRemoteMaterialUrl,
} from "../../../src/ingestion/material-converter.js";

test("material converter rejects unsafe remote URLs", () => {
  for (const value of [
    "file:///etc/passwd",
    "ftp://example.com/a.txt",
    "javascript:alert(1)",
    "http://localhost/a",
    "http://127.0.0.1/a",
    "http://10.0.0.1/a",
    "http://172.16.0.1/a",
    "http://192.168.1.1/a",
    "http://169.254.169.254/latest/meta-data",
  ]) {
    assert.throws(() => validateRemoteMaterialUrl(value), /资料地址|内网|支持|格式|metadata|元数据/i);
  }
});

test("material converter accepts public YouTube hosts but does not create unsupported video docs", async () => {
  assert.equal(validateRemoteMaterialUrl("https://youtu.be/abc").isVideo, true);
  await assert.rejects(() => convertRemoteMaterialUrl("https://youtu.be/abc"), /视频地址|文本/i);
});

test("material converter turns html remote pages into multi-format document payload", async () => {
  const html = `
    <html><head><title>Redis Notes</title></head>
    <body><article><h1>Redis</h1><p>Redis persists data using RDB snapshots and AOF logs. These mechanisms serve different recovery and performance goals.</p><p>Replication improves availability, while sentinel and cluster modes change failover behavior.</p></article></body></html>
  `;
  const result = await convertRemoteMaterialUrl("https://example.com/redis", {
    fetchImpl: async () => new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  });

  assert.equal(result.title, "Redis Notes");
  assert.equal(result.primaryFormat, "html");
  assert.match(result.markdown, /^# Redis Notes/);
  assert.match(result.learning.text, /Redis persists data using RDB snapshots and AOF logs/);
  assert.equal(result.render.format, "html");
  assert.equal(result.render.viewMode, "sanitized-html");
  assert.ok(result.renderSnapshotHtml.includes("<article>"));
  assert.ok(Buffer.isBuffer(result.originalBytes));
  assert.equal(result.sourceType, "remote-document");
});

test("material converter handles uploaded text and enforces size cap", async () => {
  const content = "MyBatis dynamic SQL uses tags such as if, where, choose, and foreach to assemble SQL safely for different parameter combinations.";
  const result = await convertUploadedMaterial({
    filename: "mybatis.txt",
    mimeType: "text/plain",
    contentBase64: Buffer.from(content).toString("base64"),
  });
  assert.equal(result.title, "mybatis");
  assert.equal(result.primaryFormat, "text");
  assert.match(result.markdown, /MyBatis dynamic SQL/);
  assert.match(result.learning.text, /MyBatis dynamic SQL/);
  assert.equal(result.render.format, "text");

  await assert.rejects(() => convertUploadedMaterial({
    filename: "too-big.txt",
    mimeType: "text/plain",
    contentBase64: Buffer.alloc(maxUploadBytes + 1).toString("base64"),
  }), /15MB/);
});

test("material converter keeps uploaded pdf as readable material when markitdown extraction fails", async () => {
  const result = await convertUploadedMaterial({
    filename: "redis-design.pdf",
    mimeType: "application/pdf",
    contentBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
    markItDownConverter: async () => {
      throw new Error("MarkItDown 未能提取足够内容。");
    },
  });

  assert.equal(result.title, "redis-design");
  assert.equal(result.primaryFormat, "pdf");
  assert.equal(result.render.format, "pdf");
  assert.equal(result.learning.text, "");
  assert.equal(result.learning.sufficientForQa, false);
  assert.equal(result.learning.sufficientForTraining, false);
  assert.equal(result.learning.extractionStatus, "failed");
  assert.match(result.learning.extractionNotes, /MarkItDown 未能提取足够内容/);
  assert.match(result.markdown, /redis-design/);
});

test("material converter keeps remote binary docs when markitdown is unavailable", async () => {
  const result = await convertRemoteMaterialUrl("https://example.com/redis-guide.pdf", {
    fetchImpl: async () => new Response(Buffer.from("%PDF-1.4 fake"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }),
    markItDownConverter: async () => {
      throw new Error("当前环境未安装 MarkItDown，无法转换该格式。");
    },
  });

  assert.equal(result.title, "redis-guide");
  assert.equal(result.primaryFormat, "pdf");
  assert.equal(result.render.format, "pdf");
  assert.equal(result.learning.text, "");
  assert.equal(result.learning.sufficientForQa, false);
  assert.equal(result.learning.sufficientForTraining, false);
  assert.equal(result.learning.extractionStatus, "failed");
  assert.match(result.learning.extractionNotes, /未安装 MarkItDown/);
});
