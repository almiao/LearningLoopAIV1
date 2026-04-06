import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentInput } from "../../../src/ingestion/document-parser.js";
import { fetchSubmittedPage } from "../../../src/ingestion/url-fetcher.js";
import {
  javaCollectionsDocument,
  springBootArticleHtml
} from "../../fixtures/materials.js";

test("document and url inputs normalize into comparable source models", async () => {
  const documentSource = parseDocumentInput({
    title: "Java Collections",
    content: javaCollectionsDocument
  });
  const urlSource = await fetchSubmittedPage("https://example.com/spring", {
    fetchImpl: async () =>
      new Response(springBootArticleHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      })
  });

  assert.equal(documentSource.paragraphs.length > 0, true);
  assert.equal(urlSource.paragraphs.length > 0, true);
  assert.equal(urlSource.metadata.submittedPageOnly, true);
});
