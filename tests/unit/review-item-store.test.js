import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createReviewItemStore } from "../../src/ledger/review-item-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "review-ledger-"));
  try {
    await run(createReviewItemStore({ ledgerDir: dir }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("recordMiss is failure-driven: empty ledger until a miss is recorded", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.list(), []);

    const now = "2026-06-07T00:00:00.000Z";
    const item = await store.recordMiss({
      handle: "讲清 ReentrantLock 与 synchronized 的区别与取舍",
      source_ref: "java-concurrency.md#reentrantlock",
      evidence: {
        question: "可中断具体指哪个方法？",
        missedAnchors: ["lockInterruptibly 的用途", "  ", "公平锁取舍"],
      },
      now,
    });

    // §4 的 5 字段都在，state 默认 shaky。
    assert.equal(item.handle, "讲清 ReentrantLock 与 synchronized 的区别与取舍");
    assert.equal(item.source_ref, "java-concurrency.md#reentrantlock");
    assert.equal(item.state, "shaky");
    assert.equal(item.evidence.question, "可中断具体指哪个方法？");
    assert.deepEqual(item.evidence.missedAnchors, ["lockInterruptibly 的用途", "公平锁取舍"]);
    assert.ok(item.id, "item should get an id");

    // 占位调度：shaky → +1 天。
    assert.equal(item.next_due_at, new Date(Date.parse(now) + DAY_MS).toISOString());

    const all = await store.list();
    assert.equal(all.length, 1);
  });
});

test("recordMiss requires a handle", async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.recordMiss({ handle: "   " }), /handle is required/);
  });
});

test("listDue returns only due items, sorted by next_due_at", async () => {
  await withStore(async (store) => {
    const t0 = "2026-06-07T00:00:00.000Z";
    await store.recordMiss({ handle: "due now A", now: t0 });
    await store.recordMiss({ handle: "due now B", now: "2026-06-06T00:00:00.000Z" });

    // 还没到期的（now 设在未来 → next_due 也在更远的未来）。
    await store.recordMiss({ handle: "not yet", now: "2026-06-20T00:00:00.000Z" });

    const due = await store.listDue({ now: "2026-06-08T12:00:00.000Z" });
    assert.deepEqual(due.map((it) => it.handle), ["due now B", "due now A"]);
  });
});

test("listDue prioritizes active campaign gaps ahead of plain due order", async () => {
  await withStore(async (store) => {
    const t0 = "2026-06-07T00:00:00.000Z";
    await store.recordMiss({ handle: "普通到期项", now: "2026-06-06T00:00:00.000Z" });
    await store.recordMiss({ handle: "Redis 缓存一致性", now: t0 });

    const due = await store.listDue({
      now: "2026-06-08T12:00:00.000Z",
      campaign: {
        readiness: {
          daysLeft: 2,
          gaps: [
            { topicId: "redis", topic: "Redis 缓存一致性", coverage: "shaky", priority: 0.9 },
          ],
        },
      },
    });

    assert.deepEqual(due.map((it) => it.handle), ["Redis 缓存一致性", "普通到期项"]);
    assert.equal(due[0].campaign_topic_id, "redis");
  });
});

test("updateState to solid reschedules to +3 days and bumps last_seen", async () => {
  await withStore(async (store) => {
    const created = await store.recordMiss({ handle: "索引失效的典型场景", now: "2026-06-07T00:00:00.000Z" });

    const seenAt = "2026-06-08T09:00:00.000Z";
    const updated = await store.updateState({ id: created.id, state: "solid", now: seenAt });

    assert.equal(updated.state, "solid");
    assert.equal(updated.last_seen_at, seenAt);
    assert.equal(updated.next_due_at, new Date(Date.parse(seenAt) + 3 * DAY_MS).toISOString());
  });
});

test("recordMiss reuses an existing handle instead of creating duplicate rows", async () => {
  await withStore(async (store) => {
    const first = await store.recordMiss({
      handle: "Redis 缓存一致性",
      evidence: { question: "第一次", missedAnchors: ["旁路缓存"] },
      now: "2026-06-07T00:00:00.000Z",
    });

    const second = await store.recordMiss({
      handle: "Redis 缓存一致性",
      evidence: { question: "第二次", missedAnchors: ["双删"] },
      now: "2026-06-08T00:00:00.000Z",
    });

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(second.id, first.id);
    assert.equal(all[0].evidence.question, "第二次");
    assert.deepEqual(all[0].evidence.missedAnchors, ["双删"]);
  });
});

test("updateState rejects unknown state and missing id", async () => {
  await withStore(async (store) => {
    const item = await store.recordMiss({ handle: "x" });
    await assert.rejects(() => store.updateState({ id: item.id, state: "mastered" }), /invalid review item state/);
    await assert.rejects(() => store.updateState({ id: "nope", state: "solid" }), /not found/);
  });
});

test("ledger persists to disk and reloads in a fresh store instance", async () => {
  await withStore(async (store, dir) => {
    const item = await store.recordMiss({ handle: "HTTP/2 队头阻塞" });

    const reopened = createReviewItemStore({ ledgerDir: dir });
    const loaded = await reopened.get(item.id);
    assert.ok(loaded, "item should survive a reload");
    assert.equal(loaded.handle, "HTTP/2 队头阻塞");
  });
});

test("concurrent recordMiss calls do not clobber each other", async () => {
  await withStore(async (store) => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.recordMiss({ handle: `concurrent item ${i}` })),
    );
    const all = await store.list();
    assert.equal(all.length, 12, "all concurrent writes should land");
    assert.equal(new Set(all.map((it) => it.id)).size, 12, "ids should be unique");
  });
});
