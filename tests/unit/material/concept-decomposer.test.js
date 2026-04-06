import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentInput } from "../../../src/ingestion/document-parser.js";
import {
  decomposeSource,
  summarizeSourceForDisplay
} from "../../../src/material/concept-decomposer.js";
import {
  aqsMarkdownDocument,
  javaCollectionsDocument
} from "../../fixtures/materials.js";

test("concept decomposer extracts source-grounded teaching units", () => {
  const source = parseDocumentInput({
    title: "Java Collections",
    content: javaCollectionsDocument
  });

  const concepts = decomposeSource(source);

  assert.ok(concepts.length >= 3);
  assert.ok(concepts.every((concept) => concept.excerpt.length > 0));
});

test("source summary is derived from the decomposed concepts", () => {
  const source = parseDocumentInput({
    title: "Java Collections",
    content: javaCollectionsDocument
  });

  const concepts = decomposeSource(source);
  const summary = summarizeSourceForDisplay(source, concepts);

  assert.equal(summary.sourceTitle, "Java Collections");
  assert.ok(summary.keyThemes.length > 0);
  assert.match(summary.framing, /材料/);
});

test("concept decomposer keeps narrow markdown sources document-local and diagnostic", () => {
  const source = parseDocumentInput({
    title: "AQS 详解",
    content: aqsMarkdownDocument
  });

  const concepts = decomposeSource(source);

  assert.ok(concepts.length >= 3 && concepts.length <= 7);
  assert.ok(concepts.some((concept) => /AQS|CLH|state|同步器/.test(concept.title)));
  assert.ok(concepts.every((concept) => !/Concurrency|Collections|HTTP/.test(concept.title)));
  assert.ok(concepts.every((concept) => !/^title:/i.test(concept.summary)));
  assert.ok(concepts.every((concept) => concept.diagnosticQuestion?.length > 0));
  assert.ok(concepts.every((concept) => !/为什么重要|容易答错/.test(concept.diagnosticQuestion)));
});
