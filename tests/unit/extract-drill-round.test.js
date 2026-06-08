import assert from "node:assert/strict";
import test from "node:test";

import { extractLastDrillRound } from "../../src/ledger/extract-drill-round.js";

test("extracts the last tutor question + learner answer pair", () => {
  const turns = [
    { role: "tutor", kind: "question", content: "什么是 ReentrantLock？", conceptTitle: "ReentrantLock", conceptId: "c1" },
    { role: "learner", content: "一个可重入的锁。" },
    { role: "tutor", kind: "question", content: "它和 synchronized 的取舍是什么？", conceptTitle: "锁取舍", conceptId: "c2" },
    { role: "learner", content: "ReentrantLock 可中断、可定时、可公平。" },
  ];
  const round = extractLastDrillRound(turns);
  assert.equal(round.question, "它和 synchronized 的取舍是什么？");
  assert.equal(round.answer, "ReentrantLock 可中断、可定时、可公平。");
  assert.equal(round.handle, "锁取舍");
  assert.equal(round.conceptId, "c2");
});

test("skips learner control turns (请求讲解 / 切题), not real answers", () => {
  const turns = [
    { role: "tutor", kind: "question", content: "Q1", conceptTitle: "T1" },
    { role: "learner", content: "我的回答" },
    { role: "learner", kind: "control", action: "advance", content: "" },
  ];
  const round = extractLastDrillRound(turns);
  assert.equal(round.answer, "我的回答");
  assert.equal(round.question, "Q1");
});

test("returns null when there is no answered question yet", () => {
  assert.equal(extractLastDrillRound([{ role: "tutor", kind: "question", content: "Q1" }]), null);
  assert.equal(extractLastDrillRound([{ role: "learner", content: "answer with no question before it" }]), null);
});

test("tolerates empty / missing input", () => {
  assert.equal(extractLastDrillRound(), null);
  assert.equal(extractLastDrillRound([]), null);
  assert.equal(extractLastDrillRound(null), null);
});

test("ignores tutor non-question turns when finding the question", () => {
  const turns = [
    { role: "tutor", kind: "question", content: "真正的问题", conceptTitle: "T" },
    { role: "tutor", kind: "message", content: "一段讲解，不是问题" },
    { role: "learner", content: "我的回答" },
  ];
  const round = extractLastDrillRound(turns);
  assert.equal(round.question, "真正的问题");
});
