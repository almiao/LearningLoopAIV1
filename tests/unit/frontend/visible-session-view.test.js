import test from "node:test";
import assert from "node:assert/strict";

import { buildVisibleSessionView } from "../../../src/view/visible-session-view.js";

test("visible session view compresses improvement memory events into one user-facing summary", () => {
  const view = buildVisibleSessionView({
    latestFeedback: {
      conceptTitle: "AI Agent 定义与核心公式",
      scoreSummary: {
        keyClaim: "用户知道 Agent 包括环境执行与结果反馈链路。"
      }
    },
    latestMemoryEvents: [
      { type: "attempt_recorded", title: "AI Agent 定义与核心公式" },
      { type: "improvement_detected", title: "AI Agent 定义与核心公式" },
      { type: "memory_writeback_applied", title: "AI Agent 定义与核心公式" },
    ],
  });

  assert.equal(
    view.latestMemorySummary,
    "已记住：你已经知道 Agent 包括环境执行与结果反馈链路；后续会在这个基础上继续追问。"
  );
});

test("visible session view explains weak memory states in user language", () => {
  const view = buildVisibleSessionView({
    latestFeedback: {
      conceptTitle: "Planning 和 Memory 的作用",
    },
    latestMemoryEvents: [
      { type: "weakness_confirmed", title: "Planning 和 Memory 的作用" },
      { type: "revisit_queued", title: "Planning 和 Memory 的作用" },
    ],
  });

  assert.equal(
    view.latestMemorySummary,
    "已记住：你在“Planning 和 Memory 的作用”这个点还不稳；后续会优先回顾。"
  );
});

test("visible session view explains contradictions as recheck prompts", () => {
  const view = buildVisibleSessionView({
    latestFeedback: {
      conceptTitle: "接口幂等判断",
    },
    latestMemoryEvents: [
      { type: "contradiction_detected", title: "接口幂等判断" },
    ],
  });

  assert.equal(
    view.latestMemorySummary,
    "已记住：你在“接口幂等判断”这个点前后回答不一致；后续会先复核这个知识点。"
  );
});
