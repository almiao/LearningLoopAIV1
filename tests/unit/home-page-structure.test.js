import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("home page browses the full static knowledge catalog without recommendation state", async () => {
  const source = await readFile(`${root}/frontend/components/home-page.js`, "utf8");

  assert.match(source, /learning-browser-card/);
  assert.match(source, /api\/knowledge\/docs/);
  assert.match(source, /buildKnowledgeTree/);
  assert.match(source, /JavaGuide 全量目录/);
  assert.doesNotMatch(source, /getBaselinePackById/);
  assert.doesNotMatch(source, /继续本章/);
  assert.doesNotMatch(source, /当前章节/);
  assert.doesNotMatch(source, /autostart/);
  assert.doesNotMatch(source, /当前最大短板/);
  assert.doesNotMatch(source, /沿着上次阅读的位置继续，切换成本最低/);
});
