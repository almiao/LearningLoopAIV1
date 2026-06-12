import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createReviewItemStore } from "../../src/ledger/review-item-store.js";
import {
  createReviewDrillDomain,
  getDocumentPathFromSourceRef,
  parseReviewDrillPath,
} from "../../bff/src/lib/review-drill-domain.js";

async function withDomain(run, { proxy, readDocument, now } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "review-drill-"));
  const store = createReviewItemStore({ ledgerDir: dir });
  const calls = [];
  const domain = createReviewDrillDomain({
    store,
    proxy: async (method, pathname, payload) => {
      calls.push({ method, pathname, payload });
      return proxy(method, pathname, payload);
    },
    readDocument,
    now: now || (() => "2026-06-08T00:00:00.000Z"),
  });
  try {
    await run({ store, domain, calls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("review drill path helpers parse id and source refs", () => {
  assert.equal(parseReviewDrillPath("/api/review/item%201/drill"), "item 1");
  assert.equal(parseReviewDrillPath("/api/review/item%201"), "");
  assert.equal(getDocumentPathFromSourceRef("docs/java/concurrency.md#aqs"), "docs/java/concurrency.md");
  assert.equal(getDocumentPathFromSourceRef("demo://loopassist/question-1"), "");
});

test("start seeds ai-service with the review item evidence without requiring source_ref", async () => {
  await withDomain(
    async ({ store, domain, calls }) => {
      const item = await store.recordMiss({
        handle: "讲清 AQS 的队列与唤醒",
        evidence: {
          question: "AQS 失败入队后怎么被唤醒？",
          missedAnchors: ["释放时唤醒后继节点"],
        },
        now: "2026-06-07T00:00:00.000Z",
      });

      const started = await domain.start({ id: item.id });

      assert.equal(started.question, "换个场景解释 AQS 释放锁时如何推进等待队列？");
      assert.equal(started.source.available, false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].pathname, "/api/review/generate-question");
      assert.equal(calls[0].payload.reviewItem.handle, "讲清 AQS 的队列与唤醒");
      assert.deepEqual(calls[0].payload.reviewItem.evidence.missedAnchors, ["释放时唤醒后继节点"]);
    },
    {
      proxy: async () => ({
        data: {
          question: "换个场景解释 AQS 释放锁时如何推进等待队列？",
          intent: "review_item_revisit",
        },
        traceId: "trace-question",
      }),
    },
  );
});

test("passing a review drill marks the ledger item solid and skips rescue", async () => {
  await withDomain(
    async ({ store, domain, calls }) => {
      const item = await store.recordMiss({
        handle: "讲清 synchronized 锁升级边界",
        now: "2026-06-07T00:00:00.000Z",
      });

      const result = await domain.answer({
        id: item.id,
        question: "解释 synchronized 从偏向锁到重量级锁的触发边界。",
        answer: "先看竞争程度，轻量级 CAS 失败并膨胀后会进入重量级锁，还要结合撤销和阻塞唤醒成本讲取舍。",
      });

      assert.equal(result.passed, true);
      assert.equal(result.outcome, "solid");
      assert.equal(result.rescue, null);
      assert.equal(result.reviewItem.state, "solid");
      assert.equal((await store.get(item.id)).state, "solid");
      assert.deepEqual(calls.map((call) => call.pathname), ["/api/anchor-judge"]);
    },
    {
      proxy: async () => ({
        data: {
          verdict: "pass",
          misses: [],
          hits: ["竞争程度", "膨胀边界"],
          confidence: 0.9,
        },
        traceId: "trace-judge",
      }),
    },
  );
});

test("failed review drill marks the item shaky and returns targeted rescue material", async () => {
  await withDomain(
    async ({ store, domain, calls }) => {
      const item = await store.recordMiss({
        handle: "讲清 ReentrantLock 可中断获取",
        now: "2026-06-07T00:00:00.000Z",
      });
      await store.updateState({ id: item.id, state: "solid", now: "2026-06-08T00:00:00.000Z" });

      const result = await domain.answer({
        id: item.id,
        question: "lockInterruptibly 解决了哪类等待问题？",
        answer: "就是 lock 的另一种写法。",
      });

      assert.equal(result.passed, false);
      assert.equal(result.outcome, "shaky");
      assert.equal(result.reviewItem.state, "shaky");
      assert.match(result.rescue.markdown, /lockInterruptibly/);
      assert.equal((await store.get(item.id)).state, "shaky");
      assert.deepEqual(calls.map((call) => call.pathname), [
        "/api/anchor-judge",
        "/api/loopassist/rescue-material",
      ]);
      assert.deepEqual(calls[1].payload.gap.misses, ["可中断等待的适用场景"]);
    },
    {
      proxy: async (_method, pathname) => {
        if (pathname === "/api/anchor-judge") {
          return {
            data: {
              verdict: "fail",
              misses: ["可中断等待的适用场景"],
              hits: [],
              confidence: 0.8,
            },
            traceId: "trace-judge",
          };
        }
        return {
          data: {
            markdown: "### lockInterruptibly 补讲\n\n它处理等待锁期间需要响应中断的场景。",
          },
          traceId: "trace-rescue",
        };
      },
    },
  );
});
