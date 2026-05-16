import test from "node:test";
import assert from "node:assert/strict";

import {
  getAssetMimeType,
  listBuiltInDocuments,
  readBuiltInDocument,
} from "../../../src/knowledge/built-in-document-provider.js";

test("generated source manifest exposes document title, path, and directory labels", async () => {
  const documents = await listBuiltInDocuments();
  const document = documents.find((item) => item.path === "docs/java/concurrent/aqs.md");

  assert.ok(documents.length > 0);
  assert.equal(document.title, "AQS 详解");
  assert.deepEqual(document.folderSegments, ["java", "concurrent"]);
  assert.deepEqual(document.folderLabels, ["Java", "并发"]);
});

test("readBuiltInDocument reads generated markdown without heading metadata", async () => {
  const document = await readBuiltInDocument("docs/java/concurrent/aqs.md", {
    serviceBaseUrl: "http://127.0.0.1:4000",
  });

  assert.equal(document.path, "docs/java/concurrent/aqs.md");
  assert.equal(document.title, "AQS 详解");
  assert.equal("headings" in document, false);
  assert.match(document.markdown, /http:\/\/127\.0\.0\.1:4000\/api\/knowledge\/asset\?url=/);
  assert.match(document.markdown, /\/learn\?doc=docs%2Fjava%2Fconcurrent%2Freentrantlock\.md/);
  assert.doesNotMatch(document.markdown, /^---$/m);
});

test("getAssetMimeType recognizes generated source image assets", () => {
  assert.equal(getAssetMimeType("docs/database/mysql/images/redo-log.png"), "image/png");
  assert.equal(getAssetMimeType("docs/java/concurrent/diagram.svg"), "image/svg+xml");
});
