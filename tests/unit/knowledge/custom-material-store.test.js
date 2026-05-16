import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createCustomMaterialStore, normalizeMaterialPath } from "../../../src/knowledge/custom-material-store.js";

test("custom material store saves markdown, metadata, and original bytes by owner", async () => {
  const materialsRoot = await mkdtemp(path.join(tmpdir(), "llai-material-store-"));
  try {
    const store = createCustomMaterialStore({ materialsRoot });
    const document = await store.saveMaterial({
      userId: "user_1",
      title: "Redis 设计与实现",
      markdown: "# Redis\n\nRedis uses data structures to model storage behavior.",
      sourceType: "uploaded-file",
      originalFilename: "redis.pdf",
      originalMimeType: "application/pdf",
      originalBytes: Buffer.from("original"),
    });

    assert.match(document.path, /^materials\/[a-f0-9-]{36}$/i);
    assert.equal(document.provider, "user-material");
    assert.equal(document.sourceRefs[0].path, document.path);

    const listed = await store.listMaterials("user_1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, document.path);
    assert.equal(listed[0].primaryFormat, "pdf");

    const reloaded = await store.readMaterial("user_1", document.path);
    assert.equal(reloaded.markdown, document.markdown);
    assert.equal(reloaded.render.format, "pdf");
    assert.match(reloaded.learning.text, /Redis uses data structures/);

    await assert.rejects(() => store.readMaterial("user_2", document.path), /not found|ENOENT|mismatch/i);
    const original = await store.readOriginal("user_1", document.path);
    assert.equal(original.body.toString("utf8"), "original");
  } finally {
    await rm(materialsRoot, { recursive: true, force: true });
  }
});

test("custom material path rejects traversal", () => {
  assert.throws(() => normalizeMaterialPath("../materials/abc"), /must start|invalid/i);
  assert.throws(() => normalizeMaterialPath("materials/../abc"), /must start|invalid/i);
  assert.throws(() => normalizeMaterialPath("/etc/passwd"), /must start/i);
});

test("custom material store reads rendered html snapshot for html materials", async () => {
  const materialsRoot = await mkdtemp(path.join(tmpdir(), "llai-material-render-"));
  try {
    const store = createCustomMaterialStore({ materialsRoot });
    const document = await store.saveMaterial({
      userId: "user_html",
      title: "Redis HTML",
      primaryFormat: "html",
      sourceType: "remote-document",
      originalFilename: "redis-notes.html",
      originalMimeType: "text/html",
      originalBytes: Buffer.from("<html><body><h1>Redis</h1></body></html>"),
      renderSnapshotHtml: "<html><body><article><h1>Redis</h1></article></body></html>",
      learning: {
        text: "Redis",
        markdown: "# Redis",
        outline: [{ id: "redis", label: "Redis", level: 1 }],
        sufficientForQa: false,
        sufficientForTraining: false,
        extractionStatus: "ready",
      },
    });

    const rendered = await store.readRender("user_html", document.path);
    assert.match(rendered.body.toString("utf8"), /<article><h1>Redis<\/h1><\/article>/);
  } finally {
    await rm(materialsRoot, { recursive: true, force: true });
  }
});
