import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptForAction,
  chooseNextAction,
  normalizeInteractionPreference
} from "../../../src/tutor/tutor-policy.js";

function createConcept(overrides = {}) {
  return {
    title: "AQS 的作用是什么？",
    importance: "core",
    coverage: "high",
    retryQuestion: "先只回答一个点：AQS 替同步器隐藏了哪类底层线程协调逻辑？",
    stretchQuestion: "继续深入：AQS 为什么能复用到多种同步器上？",
    checkQuestion: "现在用自己的话复述一下：AQS 为什么不是具体锁，而是同步器底座？",
    ...overrides
  };
}

function createReview(overrides = {}) {
  return {
    signal: "negative",
    judge: {
      state: "partial",
      confidence: 0.4
    },
    nextQuestion: "先只回答一个点：AQS 替同步器隐藏了哪类底层线程协调逻辑？",
    ...overrides
  };
}

test("normalizeInteractionPreference falls back to balanced", () => {
  assert.equal(normalizeInteractionPreference("probe-heavy"), "probe-heavy");
  assert.equal(normalizeInteractionPreference("weird"), "balanced");
});

test("policy chooses teach when learner prefers explain-first and is stuck", () => {
  const decision = chooseNextAction({
    concept: createConcept(),
    conceptState: {
      attempts: 1
    },
    review: createReview(),
    burdenSignal: "normal",
    interactionPreference: "explain-first"
  });

  assert.equal(decision.action, "teach");
});

test("policy can advance low-importance units under high burden", () => {
  const decision = chooseNextAction({
    concept: createConcept({
      importance: "optional",
      coverage: "low"
    }),
    conceptState: {
      attempts: 1
    },
    review: createReview({
      signal: "positive",
      judge: {
        state: "partial",
        confidence: 0.65
      }
    }),
    burdenSignal: "high",
    interactionPreference: "balanced"
  });

  assert.equal(decision.action, "advance");
});

test("buildPromptForAction uses check question for teach mode", () => {
  const prompt = buildPromptForAction({
    action: "teach",
    concept: createConcept(),
    review: createReview()
  });

  assert.match(prompt, /复述|底座/);
});
