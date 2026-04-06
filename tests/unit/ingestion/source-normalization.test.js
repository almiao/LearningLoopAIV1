import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentInput } from "../../../src/ingestion/document-parser.js";
import {
  fetchSubmittedPage,
  normalizeHtmlToText
} from "../../../src/ingestion/url-fetcher.js";
import {
  aqsMarkdownDocument,
  javaCollectionsDocument,
  springBootArticleHtml
} from "../../fixtures/materials.js";

test("document parser rejects short content", () => {
  assert.throws(
    () =>
      parseDocumentInput({
        title: "Short",
        content: "too short"
      }),
    /too short/i
  );
});

test("url fetcher normalizes html into source content", async () => {
  const source = await fetchSubmittedPage("https://example.com/spring", {
    fetchImpl: async () =>
      new Response(springBootArticleHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      })
  });

  assert.equal(source.kind, "url");
  assert.equal(source.metadata.submittedPageOnly, true);
  assert.match(source.title, /Spring Boot/);
  assert.match(source.content, /application context/i);
});

test("html normalization strips tags and keeps text", () => {
  const normalized = normalizeHtmlToText(`<div>Hello</div><p>${javaCollectionsDocument}</p>`);
  assert.match(normalized, /Java collections/i);
  assert.doesNotMatch(normalized, /<div>/);
});

test("document parser strips frontmatter and metadata noise from markdown sources", () => {
  const source = parseDocumentInput({
    title: "AQS 详解",
    content: aqsMarkdownDocument
  });

  assert.doesNotMatch(source.content, /^title:/im);
  assert.doesNotMatch(source.content, /^description:/im);
  assert.doesNotMatch(source.content, /^tag:/im);
  assert.match(source.content, /AQS 的作用是什么/);
});
