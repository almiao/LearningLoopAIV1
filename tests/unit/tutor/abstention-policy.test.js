import test from "node:test";
import assert from "node:assert/strict";
import { detectNoise, evaluateAbstention } from "../../../src/tutor/abstention-policy.js";

test("detectNoise flags short or vague answers", () => {
  assert.equal(detectNoise("不知道"), true);
  assert.equal(detectNoise("I think maybe"), true);
  assert.equal(detectNoise("HashMap relies on hashCode and equals stability in lookup paths."), false);
});

test("evaluateAbstention returns stop when information gain is exhausted", () => {
  const result = evaluateAbstention({
    sourceAligned: true,
    promptContaminated: false,
    informationGain: 0,
    entry: {
      entries: [
        { signal: "positive" },
        { signal: "negative" }
      ]
    }
  });

  assert.equal(result.status, "stop");
  assert.match(result.label, /不可判/);
});

test("evaluateAbstention returns partial when evidence is single-dimensional", () => {
  const result = evaluateAbstention({
    sourceAligned: true,
    promptContaminated: false,
    informationGain: 1,
    entry: {
      entries: [{ signal: "positive" }]
    }
  });

  assert.equal(result.status, "partial");
  assert.match(result.label, /部分可判/);
});
