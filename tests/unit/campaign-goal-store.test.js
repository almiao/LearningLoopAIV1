import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCampaignGoalStore } from "../../src/goals/campaign-goal-store.js";

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "campaign-goals-"));
  const store = createCampaignGoalStore({ goalsDir: dir });
  try {
    await run(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create persists a campaign with normalized topics", async () => {
  await withStore(async (store) => {
    const campaign = await store.create({
      company: "Acme",
      role: "Java 后端",
      deadline: "2026-06-20",
      jdText: "负责高并发服务端……",
      topics: [
        { topic: "线程池参数与拒绝策略", importance: "core" },
        { topic: "Redis 缓存一致性", importance: "secondary", source: "resume-claim", source_id: "resume-1" },
        { topic: "  ", importance: "core" },
      ],
      now: "2026-06-12T00:00:00.000Z",
    });

    assert.ok(campaign.id);
    assert.equal(campaign.topics.length, 2);
    assert.equal(campaign.topics[0].coverage, "uncovered");
    assert.equal(campaign.topics[1].importance, "secondary");
    assert.equal(campaign.topics[0].source, "jd-topic");
    assert.equal(campaign.topics[1].source, "resume-claim");
    assert.equal(campaign.topics[1].source_id, "resume-1");
    assert.equal(campaign.archived_at, "");

    const loaded = await store.get(campaign.id);
    assert.equal(loaded.role, "Java 后端");
    assert.equal(loaded.deadline, "2026-06-20");
  });
});

test("create rejects missing role, bad deadline, and empty topics", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => store.create({ role: "", deadline: "2026-06-20", topics: [{ topic: "x" }] }),
      /role is required/,
    );
    await assert.rejects(
      () => store.create({ role: "后端", deadline: "下周三", topics: [{ topic: "x" }] }),
      /deadline/,
    );
    await assert.rejects(
      () => store.create({ role: "后端", deadline: "2026-06-20", topics: [] }),
      /at least one topic/,
    );
  });
});

test("create allows omitting the deadline (interview date not set yet)", async () => {
  await withStore(async (store) => {
    const campaign = await store.create({
      role: "后端",
      topics: [{ topic: "MySQL 索引" }],
    });
    assert.equal(campaign.deadline, "");
    assert.equal((await store.get(campaign.id)).deadline, "");
  });
});

test("updateTopicCoverage flips coverage and stamps last_practiced_at", async () => {
  await withStore(async (store) => {
    const campaign = await store.create({
      role: "后端",
      deadline: "2026-06-20",
      topics: [{ topic: "MySQL 事务隔离级别" }],
    });

    const afterFail = await store.updateTopicCoverage({
      id: campaign.id,
      topicId: campaign.topics[0].id,
      coverage: "shaky",
      now: "2026-06-12T08:00:00.000Z",
    });
    assert.equal(afterFail.topics[0].coverage, "shaky");
    assert.equal(afterFail.topics[0].last_practiced_at, "2026-06-12T08:00:00.000Z");

    const afterPass = await store.updateTopicCoverage({
      id: campaign.id,
      topicId: campaign.topics[0].id,
      coverage: "solid",
    });
    assert.equal(afterPass.topics[0].coverage, "solid");

    await assert.rejects(
      () => store.updateTopicCoverage({ id: campaign.id, topicId: "missing", coverage: "solid" }),
      /topic not found/,
    );
  });
});

test("archive hides the campaign from the default list but keeps it on disk", async () => {
  await withStore(async (store) => {
    const campaign = await store.create({
      role: "后端",
      deadline: "2026-06-20",
      topics: [{ topic: "Kafka 重平衡" }],
    });

    const archived = await store.archive({ id: campaign.id, outcome: "offer" });
    assert.ok(archived.archived_at);
    assert.equal(archived.outcome, "offer");

    assert.equal((await store.list()).length, 0);
    assert.equal((await store.list({ includeArchived: true })).length, 1);
  });
});
