import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMarkdownHeadings,
  getAssetMimeType,
  readJavaGuideDocument,
  slugifyHeading
} from "../../../src/knowledge/java-guide-doc-service.js";

test("slugifyHeading keeps readable anchor ids for mixed Chinese headings", () => {
  assert.equal(slugifyHeading("AQS 的作用是什么？"), "aqs-的作用是什么");
  assert.equal(slugifyHeading("  waitStatus / SIGNAL  "), "waitstatus-signal");
});

test("extractMarkdownHeadings skips fenced code blocks", () => {
  const headings = extractMarkdownHeadings(`
## 第一节

\`\`\`md
## 不应该进目录
\`\`\`

### 第二节
`);

  assert.deepEqual(headings, [
    { id: "第一节", level: 2, text: "第一节" },
    { id: "第二节", level: 3, text: "第二节" },
  ]);
});

test("readJavaGuideDocument returns rewritten markdown for internal docs and assets", async () => {
  const document = await readJavaGuideDocument("docs/java/concurrent/aqs.md", {
    serviceBaseUrl: "http://127.0.0.1:4000",
  });

  assert.equal(document.path, "docs/java/concurrent/aqs.md");
  assert.equal(document.title, "AQS 详解");
  assert.ok(document.headings.length > 5);
  assert.match(document.markdown, /http:\/\/127\.0\.0\.1:4000\/api\/knowledge\/asset\?url=/);
  assert.match(document.markdown, /\/learn\?doc=docs%2Fjava%2Fconcurrent%2Freentrantlock\.md/);
  assert.doesNotMatch(document.markdown, /^---$/m);
});

test("getAssetMimeType recognizes common JavaGuide image assets", () => {
  assert.equal(getAssetMimeType("docs/database/mysql/images/redo-log.png"), "image/png");
  assert.equal(getAssetMimeType("docs/java/concurrent/diagram.svg"), "image/svg+xml");
});
