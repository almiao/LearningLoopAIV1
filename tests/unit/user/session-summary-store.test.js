import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { createSessionSummariesStore } from "../../../src/user/session-summary-store.js";

test("session summaries store upserts by session id and keeps the latest summary", async () => {
  const summariesDir = await mkdtemp(path.join(os.tmpdir(), "llai-session-summaries-"));
  const store = createSessionSummariesStore({ summariesDir });

  await store.upsert("user_1", {
    sessionId: "sess-1",
    docPath: "docs/ai/agent/mcp.md",
    endedAt: "2026-05-18T10:00:00.000Z",
    weakCheckpointIds: ["cp-1"],
    solidifiedCheckpointIds: [],
    practicedCheckpointIds: ["cp-1"],
    oneParagraphSummary: "第一次训练暴露了一个还没讲稳的知识点。",
    recommendedNextCheckpointId: "cp-1",
    recommendedNextAction: "quick_review",
  });

  await store.upsert("user_1", {
    sessionId: "sess-1",
    docPath: "docs/ai/agent/mcp.md",
    endedAt: "2026-05-18T11:00:00.000Z",
    weakCheckpointIds: [],
    solidifiedCheckpointIds: ["cp-1"],
    practicedCheckpointIds: ["cp-1"],
    oneParagraphSummary: "第二次训练已经把这个知识点讲稳了。",
    recommendedNextCheckpointId: "",
    recommendedNextAction: "reference_lookup",
  });

  const summaries = await store.list("user_1");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].recommendedNextAction, "reference_lookup");
  assert.equal(summaries[0].oneParagraphSummary, "第二次训练已经把这个知识点讲稳了。");
});

