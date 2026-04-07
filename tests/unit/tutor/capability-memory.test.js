import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTargetMatch,
  buildVisibleMemoryEvents
} from "../../../src/tutor/capability-memory.js";

test("target match estimate stays bounded and explanation-backed", () => {
  const concepts = [
    { id: "a", title: "A", importance: "core" },
    { id: "b", title: "B", importance: "secondary" }
  ];
  const conceptStates = {
    a: { judge: { state: "solid", confidence: 0.85 } },
    b: { judge: { state: "partial", confidence: 0.6 } }
  };

  const result = buildTargetMatch({
    concepts,
    conceptStates,
    targetBaseline: { title: "大厂 Java 后端面试包" }
  });

  assert.ok(result.percentage > 0 && result.percentage <= 100);
  assert.ok(result.label.length > 0);
  assert.ok(result.explanation.length > 0);
  assert.equal(result.targetLabel, "大厂 Java 后端面试包");
});

test("visible memory events emit improvement and weakness states from judge transitions", () => {
  const concept = {
    id: "aqs-acquire-release",
    abilityItemId: "aqs-acquire-release",
    title: "AQS acquire/release 语义"
  };

  const improving = buildVisibleMemoryEvents({
    concept,
    previousJudge: { state: "weak", confidence: 0.25, reasons: [] },
    currentJudge: { state: "partial", confidence: 0.6, reasons: [] },
    revisitReason: ""
  });
  assert.ok(improving.some((event) => event.type === "attempt_recorded"));
  assert.ok(improving.some((event) => event.type === "improvement_detected"));

  const weakening = buildVisibleMemoryEvents({
    concept,
    previousJudge: { state: "partial", confidence: 0.6, reasons: [] },
    currentJudge: { state: "weak", confidence: 0.25, reasons: [] },
    revisitReason: "需要后续回访"
  });
  assert.ok(weakening.some((event) => event.type === "contradiction_detected"));
  assert.ok(weakening.some((event) => event.type === "weakness_confirmed"));
  assert.ok(weakening.some((event) => event.type === "revisit_queued"));
});
