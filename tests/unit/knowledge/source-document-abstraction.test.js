import test from "node:test";
import assert from "node:assert/strict";

import {
  listSourceDocuments,
  readSourceDocument,
} from "../../../src/knowledge/source-document-resolver.js";
import { getSourceRefs, normalizeSourceRefs } from "../../../src/knowledge/source-refs.js";

test("built-in corpus is exposed through generic source document contract", async () => {
  const documents = await listSourceDocuments();
  const document = documents.find((item) => item.path === "docs/java/concurrent/aqs.md");

  assert.ok(document);
  assert.equal(document.provider, "built-in-corpus");
  assert.equal(document.sourceType, "built-in-document");

  const loaded = await readSourceDocument(document.path, {
    serviceBaseUrl: "http://127.0.0.1:4000",
  });
  assert.equal(loaded.path, document.path);
  assert.equal(loaded.sourceRefs[0].path, document.path);
  assert.equal("javaGuideSources" in loaded, false);
});

test("source refs normalize legacy source snapshots without re-emitting aliases", () => {
  const refs = normalizeSourceRefs([{ path: "docs/a.md", title: "A" }], [{ path: "docs/a.md", title: "duplicate" }]);
  assert.deepEqual(refs, [{
    path: "docs/a.md",
    title: "A",
    sourceType: "built-in-document",
    provider: "built-in-corpus",
  }]);

  const projected = getSourceRefs({
    javaGuideSources: [{ path: "docs/legacy.md", title: "Legacy" }],
  });
  assert.equal(projected[0].path, "docs/legacy.md");
  assert.equal(projected[0].provider, "built-in-corpus");
});
