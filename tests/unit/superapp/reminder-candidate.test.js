import test from "node:test";
import assert from "node:assert/strict";

import { buildReminderCandidate } from "../../../src/superapp/reminder-candidate.js";

test("buildReminderCandidate prefers recent weak concepts as yesterday-gap follow-up", () => {
  const user = {
    id: "user-1",
    targets: {
      primary: {
        targetBaselineId: "bigtech-java-backend",
        lastActivityAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      },
    },
  };
  const memoryProfile = {
    abilityItems: {
      "aqs-acquire-release": {
        state: "weak",
        evidenceCount: 1,
      },
    },
  };

  const candidate = buildReminderCandidate({ user, memoryProfile });

  assert.equal(candidate.userId, "user-1");
  assert.equal(candidate.candidate.category, "yesterday_gap_followup");
  assert.equal(candidate.candidate.conceptId, "aqs-acquire-release");
  assert.match(candidate.candidate.reason, /还没讲稳/);
});

test("buildReminderCandidate falls back to interrupted-learning recovery without recent evidence", () => {
  const user = {
    id: "user-2",
    targets: {
      primary: {
        targetBaselineId: "bigtech-java-backend",
        lastActivityAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      },
    },
  };
  const memoryProfile = {
    abilityItems: {},
  };

  const candidate = buildReminderCandidate({ user, memoryProfile });

  assert.equal(candidate.candidate.category, "interrupted_learning_recovery");
  assert.ok(candidate.candidate.title.length > 0);
  assert.ok(candidate.candidate.diagnosticQuestion.length > 0);
});
