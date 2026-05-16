import test from "node:test";
import assert from "node:assert/strict";

import { buildTrainingPointsFromDecomposition } from "../../../src/training/training-model.js";

test("training model emits sourceRefs for new decomposition payloads", () => {
  const points = buildTrainingPointsFromDecomposition({
    trainingPoints: [{
      id: "redis-persistence",
      title: "Redis 持久化",
      sourceRefs: [{ path: "materials/abc", title: "Redis 设计与实现" }],
      checkpoints: [{ id: "cp1", statement: "解释 RDB/AOF", successCriteria: "能比较取舍" }],
    }],
  });

  assert.equal(points[0].sourceRefs[0].path, "materials/abc");
  assert.equal("javaGuideSources" in points[0], false);
});

test("training model normalizes legacy source payloads into sourceRefs", () => {
  const points = buildTrainingPointsFromDecomposition({
    concepts: [{
      id: "legacy",
      title: "Legacy Source",
      javaGuideSources: [{ path: "docs/java/concurrent/aqs.md", title: "AQS 详解" }],
    }],
  });

  assert.equal(points[0].sourceRefs[0].path, "docs/java/concurrent/aqs.md");
  assert.equal(points[0].sourceRefs[0].provider, undefined);
  assert.equal("javaGuideSources" in points[0], false);
});
