import test from "node:test";
import assert from "node:assert/strict";
import { createAppService } from "../../src/app-service.js";
import { createHeuristicTutorIntelligence } from "../../src/tutor/tutor-intelligence.js";
import {
  javaCollectionsDocument,
  springBootArticleHtml
} from "../fixtures/materials.js";

test("service flow goes from source submission to mastery updates", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence(),
    fetchImpl: async () =>
      new Response(springBootArticleHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      })
  });

  const documentSession = await service.analyzeSource({
    type: "document",
    title: "Java Collections",
    content: javaCollectionsDocument
  });

  assert.ok(documentSession.concepts.length >= 3);
  assert.ok(documentSession.currentProbe.length > 0);
  assert.equal(documentSession.memoryMode, "session-scoped");

  const updated = await service.answer({
    sessionId: documentSession.sessionId,
    answer:
      "HashMap supports key lookup, ConcurrentHashMap reduces contention, and CopyOnWriteArrayList fits read-heavy workloads.",
    burdenSignal: "normal"
  });

  assert.ok(updated.masteryMap.length >= 3);
  assert.ok(updated.latestFeedback.judge.state !== "solid");
  assert.ok(updated.nextSteps.length >= 3);

  const urlSession = await service.analyzeSource({
    type: "url",
    url: "https://example.com/spring"
  });

  assert.equal(urlSession.source.kind, "url");
  assert.equal(urlSession.source.url, "https://example.com/spring");
});
