import test from "node:test";
import assert from "node:assert/strict";
import { judgeConcept } from "../../../src/tutor/mastery-judge.js";

function createEntry(entries) {
  return {
    entries
  };
}

test("mastery judge does not mark solid from a single shallow response", () => {
  const result = judgeConcept({
    entry: createEntry([{ signal: "positive", answer: "short", explanation: "partial" }]),
    sourceAligned: true,
    promptContaminated: false,
    informationGain: 1
  });

  assert.notEqual(result.state, "solid");
});

test("mastery judge marks solid after multiple positive signals", () => {
  const result = judgeConcept({
    entry: createEntry([
      { signal: "positive", answer: "first", explanation: "good" },
      { signal: "positive", answer: "second", explanation: "stable" }
    ]),
    sourceAligned: true,
    promptContaminated: false,
    informationGain: 1
  });

  assert.equal(result.state, "solid");
});
