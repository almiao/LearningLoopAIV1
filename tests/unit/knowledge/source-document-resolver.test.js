import test from "node:test";
import assert from "node:assert/strict";

import {
  listSourceDocuments,
  readSourceDocument,
  saveCustomMaterial,
} from "../../../src/knowledge/source-document-resolver.js";

test("source document resolver reads built-in and custom documents through one contract", async () => {
  const builtIn = await readSourceDocument("docs/java/concurrent/aqs.md");
  assert.equal(builtIn.path, "docs/java/concurrent/aqs.md");
  assert.equal(builtIn.provider, "built-in-corpus");
  assert.equal(builtIn.primaryFormat, "markdown");
  assert.equal(builtIn.render.format, "markdown");
  assert.match(builtIn.learning.text, /AQS|同步器|队列/i);
  assert.equal(builtIn.sourceRefs[0].path, builtIn.path);

  const material = await saveCustomMaterial({
    userId: "resolver_user",
    title: "Custom Redis Notes",
    markdown: "# Custom Redis Notes\n\nRedis persistence and replication have different reliability tradeoffs for backend systems.",
    sourceType: "uploaded-file",
    originalFilename: "redis.md",
    originalMimeType: "text/markdown",
    originalBytes: Buffer.from("redis"),
  });
  const loadedMaterial = await readSourceDocument(material.path, { userId: "resolver_user" });

  assert.equal(loadedMaterial.path, material.path);
  assert.equal(loadedMaterial.provider, "user-material");
  assert.equal(loadedMaterial.primaryFormat, "markdown");
  assert.equal(loadedMaterial.render.format, "markdown");
  assert.match(loadedMaterial.learning.text, /Redis persistence and replication/);
  assert.equal(loadedMaterial.sourceRefs[0].path, material.path);

  const documents = await listSourceDocuments({ userId: "resolver_user" });
  assert.ok(documents.some((document) => document.path === material.path));
  assert.ok(documents.some((document) => document.path === "docs/java/concurrent/aqs.md"));
});

test("source document resolver requires owner for custom material paths", async () => {
  await assert.rejects(() => readSourceDocument("materials/00000000-0000-4000-8000-000000000000"), /userId is required/i);
  await assert.rejects(() => readSourceDocument("../materials/00000000-0000-4000-8000-000000000000"), /invalid|outside/i);
});
