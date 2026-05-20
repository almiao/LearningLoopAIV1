import test from "node:test";
import assert from "node:assert/strict";

import { buildReentryPlan } from "../../frontend/lib/reentry-actions.js";

test("re-entry planner resumes unfinished training before anything else", () => {
  const plan = buildReentryPlan({
    progressPercentage: 100,
    trainingStarted: true,
    trainingCompleted: false,
    trainingCheckpointProgressLabel: "2/5",
  });

  assert.equal(plan.intent, "resume_training");
  assert.equal(plan.stageLabel, "继续训练");
  assert.equal(plan.primaryAction.kind, "continue-training");
});

test("re-entry planner resumes reading when正文未完成", () => {
  const plan = buildReentryPlan({
    progressPercentage: 52,
    readingPreview: "Agent = LLM + Planning + Memory + Tools",
  });

  assert.equal(plan.intent, "resume_reading");
  assert.equal(plan.primaryAction.kind, "continue-reading");
  assert.match(plan.reason, /上次停在/);
});

test("re-entry planner starts training after reading completes", () => {
  const plan = buildReentryPlan({
    progressPercentage: 100,
    trainingStarted: false,
    trainingCompleted: false,
    trainingSkipped: false,
    trainingAvailability: "",
  });

  assert.equal(plan.intent, "start_training");
  assert.equal(plan.primaryAction.kind, "start-training");
});

test("re-entry planner prefers quick review after training completed", () => {
  const plan = buildReentryPlan({
    progressPercentage: 100,
    trainingStarted: true,
    trainingCompleted: true,
    assessedConceptCount: 3,
    lastActivityAt: new Date().toISOString(),
  });

  assert.equal(plan.intent, "quick_review");
  assert.equal(plan.primaryAction.kind, "quick-review");
});
