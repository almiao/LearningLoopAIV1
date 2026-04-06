import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentInput } from "../../../src/ingestion/document-parser.js";
import { createAppService } from "../../../src/server.js";
import { createSession } from "../../../src/tutor/session-orchestrator.js";
import { parseProviderJsonText } from "../../../src/tutor/tutor-intelligence.js";
import { javaCollectionsDocument } from "../../fixtures/materials.js";

test("app service fails closed when AI tutor provider is unavailable", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const service = createAppService({
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });

  await assert.rejects(
    () =>
      service.analyzeSource({
        type: "document",
        title: "Java Collections",
        content: javaCollectionsDocument
      }),
    /OPENAI_API_KEY is required/i
  );

  if (originalKey) {
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("session creation rejects invalid tutor intelligence output", async () => {
  const source = parseDocumentInput({
    title: "Java Collections",
    content: javaCollectionsDocument
  });

  await assert.rejects(
    () =>
      createSession({
        source,
        intelligence: {
          async decomposeSource() {
            return {
              concepts: [
                {
                  id: "bad-1",
                  title: "Bad",
                  summary: "",
                  excerpt: "",
                  keywords: [],
                  sourceAnchors: [],
                  diagnosticQuestion: ""
                }
              ],
              summary: {
                sourceTitle: source.title,
                keyThemes: [],
                framing: ""
              }
            };
          }
        }
      }),
    /too few teaching units|invalid teaching units/i
  );
});

test("parseProviderJsonText accepts fenced and wrapped JSON", () => {
  assert.deepEqual(parseProviderJsonText('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(parseProviderJsonText('noise before {"ok":true} noise after'), { ok: true });
});
