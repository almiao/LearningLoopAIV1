import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentInput } from "../../../src/ingestion/document-parser.js";
import { createAppService } from "../../../src/app-service.js";
import { createSession } from "../../../src/tutor/session-orchestrator.js";
import { createHeuristicTutorIntelligence, parseProviderJsonText } from "../../../src/tutor/tutor-intelligence.js";
import { javaCollectionsDocument } from "../../fixtures/materials.js";

test("app service requires explicit tutor intelligence on the local node path", async () => {
  assert.throws(
    () => createAppService(),
    /LLM tutor intelligence is required/i
  );
});

test("app service accepts an explicit test-double tutor intelligence", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence(),
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });

  const session = await service.analyzeSource({
    type: "document",
    title: "Java Collections",
    content: javaCollectionsDocument
  });

  assert.ok(session.currentProbe.length > 0);
});

test("JS heuristic tutor intelligence is blocked outside test runtime", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.LLAI_ENABLE_JS_HEURISTIC_TEST_DOUBLE;
  delete process.env.NODE_ENV;
  delete process.env.LLAI_ENABLE_JS_HEURISTIC_TEST_DOUBLE;
  try {
    assert.throws(
      () => createHeuristicTutorIntelligence(),
      /test-only/i
    );
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousFlag === undefined) {
      delete process.env.LLAI_ENABLE_JS_HEURISTIC_TEST_DOUBLE;
    } else {
      process.env.LLAI_ENABLE_JS_HEURISTIC_TEST_DOUBLE = previousFlag;
    }
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
