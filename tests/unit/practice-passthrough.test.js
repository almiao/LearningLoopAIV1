import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createReviewItemStore } from "../../src/ledger/review-item-store.js";
import { createPracticePassthrough } from "../../src/ledger/practice-passthrough.js";

async function withPassthrough(judgeFn, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "passthrough-"));
  const store = createReviewItemStore({ ledgerDir: dir });
  const calls = [];
  const judge = async (args) => {
    calls.push(args);
    return judgeFn(args);
  };
  const silent = { warn() {} };
  const record = createPracticePassthrough({ store, judge, logger: silent });
  try {
    await run({ record, store, calls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("failed round with misses writes one review item (failure-driven)", async () => {
  await withPassthrough(
    () => ({ verdict: "fail", misses: ["行动失败时的回退依据"], hits: ["推理/行动交替"] }),
    async ({ record, store }) => {
      const item = await record({
        handle: "讲清 ReAct 的回退机制",
        question: "ReAct 某步行动失败时靠什么决定回退？",
        answer: "就是边想边做。",
        sourceRef: "react.md#loop",
      });
      assert.ok(item, "should create a review item");
      assert.equal(item.handle, "讲清 ReAct 的回退机制");
      assert.equal(item.source_ref, "react.md#loop");
      assert.deepEqual(item.evidence.missedAnchors, ["行动失败时的回退依据"]);
      assert.equal(item.state, "shaky");
      assert.equal((await store.list()).length, 1);
    },
  );
});

test("passing round writes nothing (练过不留痕)", async () => {
  await withPassthrough(
    () => ({ verdict: "pass", misses: [], hits: ["a", "b"] }),
    async ({ record, store }) => {
      const item = await record({ question: "q", answer: "a long enough answer here" });
      assert.equal(item, null);
      assert.equal((await store.list()).length, 0);
    },
  );
});

test("fail verdict but empty misses writes nothing", async () => {
  await withPassthrough(
    () => ({ verdict: "fail", misses: [] }),
    async ({ record, store }) => {
      assert.equal(await record({ question: "q", answer: "a" }), null);
      assert.equal((await store.list()).length, 0);
    },
  );
});

test("missing question or answer short-circuits without judging", async () => {
  await withPassthrough(
    () => ({ verdict: "fail", misses: ["x"] }),
    async ({ record, store, calls }) => {
      assert.equal(await record({ question: "", answer: "a" }), null);
      assert.equal(await record({ question: "q", answer: "  " }), null);
      assert.equal(calls.length, 0, "judge should not be called without both fields");
      assert.equal((await store.list()).length, 0);
    },
  );
});

test("judge errors never throw and never write (bypass, best-effort)", async () => {
  await withPassthrough(
    () => { throw new Error("ai-service down"); },
    async ({ record, store }) => {
      const result = await record({ question: "q", answer: "an answer" });
      assert.equal(result, null, "should swallow the error");
      assert.equal((await store.list()).length, 0);
    },
  );
});

test("derives a handle from the question when none is provided", async () => {
  await withPassthrough(
    () => ({ verdict: "fail", misses: ["边界"] }),
    async ({ record }) => {
      const item = await record({ question: "索引为什么会失效？", answer: "不太清楚" });
      assert.equal(item.handle, "索引为什么会失效");
    },
  );
});
