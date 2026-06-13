import { test } from "node:test";
import assert from "node:assert/strict";

import { searchLibrary, getLibraryItem, resetCorpusCache } from "../../bff/src/lib/corpus-library.js";

// 跑在已入库的 data/corpus/*.jsonl 上（100 JD + 100 面经）。

test("searchLibrary returns paged JD summaries with role facets and no full text", () => {
  resetCorpusCache();
  const result = searchLibrary({ kind: "jd", page: 1, pageSize: 10 });
  assert.equal(result.kind, "jd");
  assert.ok(result.total >= 50, `expected a sizable JD corpus, got ${result.total}`);
  assert.equal(result.items.length, 10);
  assert.ok(result.roles.length > 1, "JD roles should offer filter facets");
  const first = result.items[0];
  assert.ok(first.id && first.title);
  assert.ok(first.excerpt.length <= 160);
  assert.equal(first.text, undefined); // 列表不带全文
});

test("searchLibrary keyword filters across title and body", () => {
  resetCorpusCache();
  const all = searchLibrary({ kind: "jd", pageSize: 50 }).total;
  const java = searchLibrary({ kind: "jd", q: "java", pageSize: 50 }).total;
  assert.ok(java > 0 && java < all, "java query should narrow the JD set");
});

test("searchLibrary role filter narrows JD results", () => {
  resetCorpusCache();
  const facet = searchLibrary({ kind: "jd" }).roles[0];
  const filtered = searchLibrary({ kind: "jd", role: facet, pageSize: 50 });
  assert.ok(filtered.total > 0);
  assert.ok(filtered.items.every((item) => item.role.toLowerCase().includes(facet.toLowerCase())));
});

test("searchLibrary interview keyword search works despite coarse roles", () => {
  resetCorpusCache();
  const result = searchLibrary({ kind: "interview", q: "rag", pageSize: 50 });
  assert.ok(result.total > 0, "expected interview reports mentioning RAG");
});

test("getLibraryItem resolves full text by id, missing id returns null", () => {
  resetCorpusCache();
  const summary = searchLibrary({ kind: "jd", pageSize: 1 }).items[0];
  const full = getLibraryItem({ kind: "jd", id: summary.id });
  assert.ok(full && full.text.length > 0, "full record should carry text");
  assert.equal(full.id, summary.id);
  assert.equal(getLibraryItem({ kind: "jd", id: "nope-missing" }), null);
});
