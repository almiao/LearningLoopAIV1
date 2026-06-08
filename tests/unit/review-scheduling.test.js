import assert from "node:assert/strict";
import test from "node:test";

import {
  SOLID_INTERVAL_LADDER_DAYS,
  scheduleNextReview,
} from "../../src/ledger/review-scheduling.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = "2026-06-07T00:00:00.000Z";

function daysAfter(iso, days) {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

test("shaky always reschedules to +1 day and resets streak", () => {
  const r = scheduleNextReview({ state: "shaky", priorStreak: 4, now: NOW });
  assert.equal(r.streak, 0);
  assert.equal(r.intervalDays, 1);
  assert.equal(r.nextDueAt, daysAfter(NOW, 1));
});

test("first solid → 3 days, streak 1", () => {
  const r = scheduleNextReview({ state: "solid", priorStreak: 0, now: NOW });
  assert.equal(r.streak, 1);
  assert.equal(r.nextDueAt, daysAfter(NOW, 3));
});

test("consecutive solids climb the ladder", () => {
  assert.equal(scheduleNextReview({ state: "solid", priorStreak: 1, now: NOW }).nextDueAt, daysAfter(NOW, 7));
  assert.equal(scheduleNextReview({ state: "solid", priorStreak: 2, now: NOW }).nextDueAt, daysAfter(NOW, 16));
  assert.equal(scheduleNextReview({ state: "solid", priorStreak: 3, now: NOW }).nextDueAt, daysAfter(NOW, 35));
});

test("solid streak caps at the last ladder rung", () => {
  const cap = SOLID_INTERVAL_LADDER_DAYS[SOLID_INTERVAL_LADDER_DAYS.length - 1];
  const r = scheduleNextReview({ state: "solid", priorStreak: 99, now: NOW });
  assert.equal(r.intervalDays, cap);
  assert.equal(r.nextDueAt, daysAfter(NOW, cap));
});

test("deadline caps next_due (interview campaign)", () => {
  const deadline = daysAfter(NOW, 2); // 面试在 2 天后
  // solid 本来要排到 +16 天，但被 deadline 封顶。
  const r = scheduleNextReview({ state: "solid", priorStreak: 2, now: NOW, deadline });
  assert.equal(r.nextDueAt, deadline);
});

test("deadline further out than the interval does not shorten it", () => {
  const deadline = daysAfter(NOW, 90);
  const r = scheduleNextReview({ state: "solid", priorStreak: 0, now: NOW, deadline });
  assert.equal(r.nextDueAt, daysAfter(NOW, 3));
});

test("garbage now falls back without throwing", () => {
  const r = scheduleNextReview({ state: "shaky", now: "not-a-date" });
  assert.equal(r.intervalDays, 1);
  assert.ok(Date.parse(r.nextDueAt) > 0);
});
