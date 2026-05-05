import test from "node:test";
import assert from "node:assert/strict";

import { buildUserProfileView } from "../../../src/user/profile-aggregator.js";
import { applyDocumentIgnored } from "../../../src/user/document-progress-state.js";
import { applyReadingProgress } from "../../../src/user/reading-progress.js";

function makeUserTarget() {
  return {
    targetBaselineId: "bigtech-java-backend",
    title: "大厂 Java 后端面试包",
    targetRole: "Java 后端工程师",
    createdAt: "2026-05-01T00:00:00.000Z",
    lastActivityAt: "2026-05-01T00:00:00.000Z",
    sessionsStarted: 0,
    readingProgress: {},
  };
}

function makeUser(targetRecord) {
  return {
    id: "user-1",
    handle: "lee",
    memoryProfileId: "mem-1",
    createdAt: "2026-05-01T00:00:00.000Z",
    lastLoginAt: "2026-05-01T00:00:00.000Z",
    lastActiveAt: "2026-05-01T00:00:00.000Z",
    targets: {
      [targetRecord.targetBaselineId]: targetRecord,
    },
  };
}

test("profile view gives reading-only documents a visible mastery score", () => {
  const targetRecord = applyReadingProgress(makeUserTarget(), {
    targetBaselineId: "bigtech-java-backend",
    docPath: "docs/system-design/framework/spring/spring-transaction.md",
    scrollRatio: 0.52,
    dwellMs: 25_000,
    timestamp: "2026-05-01T10:00:00.000Z",
  });

  const profile = buildUserProfileView({
    user: makeUser(targetRecord),
    memoryProfile: { id: "mem-1", sessionsStarted: 0, abilityItems: {} },
  });

  const target = profile.targets[0];
  const springDoc = target.readingDomains
    .find((domain) => domain.id === "spring-runtime")
    ?.docs.find((doc) => doc.path === "docs/system-design/framework/spring/spring-transaction.md");

  assert.ok(springDoc);
  assert.ok(springDoc.masteryPercentage > 0);
  assert.notEqual(springDoc.masteryLabel, "未训练");
  assert.ok(target.completionPercentage > 0);
  assert.equal(
    profile.documentProgress.docs["docs/system-design/framework/spring/spring-transaction.md"]?.learningStatusLabel,
    "未训练"
  );
  assert.equal(
    profile.documentProgress.docs["docs/system-design/framework/spring/spring-transaction.md"]?.readingLabel,
    "52%"
  );
});

test("training evidence raises mastery above reading-only progress", () => {
  const targetRecord = applyReadingProgress(makeUserTarget(), {
    targetBaselineId: "bigtech-java-backend",
    docPath: "docs/system-design/framework/spring/spring-transaction.md",
    scrollRatio: 0.95,
    dwellMs: 50_000,
    timestamp: "2026-05-01T10:00:00.000Z",
  });

  const readingOnly = buildUserProfileView({
    user: makeUser(targetRecord),
    memoryProfile: { id: "mem-1", sessionsStarted: 0, abilityItems: {} },
  });

  const withTraining = buildUserProfileView({
    user: makeUser(targetRecord),
    memoryProfile: {
      id: "mem-1",
      sessionsStarted: 1,
      abilityItems: {
        "spring-transaction-boundary-cp-1": {
          abilityItemId: "spring-transaction-boundary-cp-1",
          title: "Spring 事务边界与失效场景",
          state: "solid",
          score: 92,
          evidenceCount: 2,
          reasons: ["用户已经稳定讲清代理边界。"],
          recentStrongEvidence: [{ at: "2026-05-01T10:05:00.000Z" }, { at: "2026-05-01T10:08:00.000Z" }],
          recentConflictingEvidence: [],
          lastUpdatedAt: "2026-05-01T10:08:00.000Z",
          sourceDocPath: "docs/system-design/framework/spring/spring-transaction.md",
          sourceDocPaths: ["docs/system-design/framework/spring/spring-transaction.md"],
        },
      },
    },
  });

  const readingOnlyDoc = readingOnly.targets[0].readingDomains
    .find((domain) => domain.id === "spring-runtime")
    ?.docs.find((doc) => doc.path === "docs/system-design/framework/spring/spring-transaction.md");
  const trainedDoc = withTraining.targets[0].readingDomains
    .find((domain) => domain.id === "spring-runtime")
    ?.docs.find((doc) => doc.path === "docs/system-design/framework/spring/spring-transaction.md");
  const readingOnlyPoint = readingOnly.targets[0].domains
    .find((domain) => domain.id === "spring-runtime")
    ?.items.find((item) => item.abilityItemId === "spring-transaction-boundary");
  const trainedPoint = withTraining.targets[0].domains
    .find((domain) => domain.id === "spring-runtime")
    ?.items.find((item) => item.abilityItemId === "spring-transaction-boundary");

  assert.ok(readingOnlyDoc);
  assert.ok(trainedDoc);
  assert.ok(readingOnlyPoint);
  assert.ok(trainedPoint);
  assert.ok(trainedDoc.masteryPercentage > readingOnlyDoc.masteryPercentage);
  assert.ok(trainedPoint.masteryScore > readingOnlyPoint.masteryScore);
  assert.match(
    withTraining.documentProgress.docs["docs/system-design/framework/spring/spring-transaction.md"]?.learningStatusLabel || "",
    /训练中|已掌握/
  );
});

test("document progress remembers training start before evidence exists", () => {
  const targetRecord = applyReadingProgress(makeUserTarget(), {
    targetBaselineId: "bigtech-java-backend",
    docPath: "docs/ai/agent/mcp.md",
    scrollRatio: 0.91,
    dwellMs: 50_000,
    timestamp: "2026-05-01T10:00:00.000Z",
  });

  const profile = buildUserProfileView({
    user: {
      ...makeUser(targetRecord),
      documents: {
        currentDocPath: "docs/ai/agent/mcp.md",
        currentDocTitle: "万字拆解 MCP，附带工程实践",
        lastUpdatedAt: "2026-05-01T10:03:00.000Z",
        docs: {
          "docs/ai/agent/mcp.md": {
            docPath: "docs/ai/agent/mcp.md",
            docTitle: "万字拆解 MCP，附带工程实践",
            progressPercentage: 100,
            status: "completed",
            trainingStartedAt: "2026-05-01T10:03:00.000Z",
            trainingSessionCount: 1,
            lastTrainingStartedAt: "2026-05-01T10:03:00.000Z",
          },
        },
      },
    },
    memoryProfile: { id: "mem-1", sessionsStarted: 1, abilityItems: {} },
  });

  assert.equal(profile.documentProgress.currentDocPath, "docs/ai/agent/mcp.md");
  assert.equal(
    profile.documentProgress.docs["docs/ai/agent/mcp.md"]?.learningStatusLabel,
    "已开启训练"
  );
  assert.equal(
    profile.documentProgress.docs["docs/ai/agent/mcp.md"]?.readingLabel,
    "已读"
  );
});

test("document progress marks decomposition-failed documents as reading-only", () => {
  const profile = buildUserProfileView({
    user: {
      ...makeUser(makeUserTarget()),
      documents: {
        currentDocPath: "docs/high-availability/idempotency.md",
        currentDocTitle: "接口幂等方案总结(付费)",
        lastUpdatedAt: "2026-05-01T10:03:00.000Z",
        docs: {
          "docs/high-availability/idempotency.md": {
            docPath: "docs/high-availability/idempotency.md",
            docTitle: "接口幂等方案总结(付费)",
            progressPercentage: 100,
            trainingAvailability: "unavailable",
            trainingUnavailableReason: "当前文档缺少足够可训练内容，已保留为阅读材料。",
            sessionUpdatedAt: "2026-05-01T10:03:00.000Z",
          },
        },
      },
    },
    memoryProfile: { id: "mem-1", sessionsStarted: 0, abilityItems: {} },
  });

  assert.equal(
    profile.documentProgress.docs["docs/high-availability/idempotency.md"]?.learningStatusLabel,
    "仅阅读"
  );
  assert.equal(
    profile.documentProgress.docs["docs/high-availability/idempotency.md"]?.trainingUnavailableReason,
    "当前文档缺少足够可训练内容，已保留为阅读材料。"
  );
});

test("document progress exposes checkpoint fraction for in-progress training", () => {
  const targetRecord = applyReadingProgress(makeUserTarget(), {
    targetBaselineId: "bigtech-java-backend",
    docPath: "docs/ai/agent/mcp.md",
    scrollRatio: 0.91,
    dwellMs: 50_000,
    timestamp: "2026-05-01T10:00:00.000Z",
  });

  const profile = buildUserProfileView({
    user: {
      ...makeUser(targetRecord),
      documents: {
        currentDocPath: "docs/ai/agent/mcp.md",
        currentDocTitle: "万字拆解 MCP，附带工程实践",
        lastUpdatedAt: "2026-05-01T10:03:00.000Z",
        docs: {
          "docs/ai/agent/mcp.md": {
            docPath: "docs/ai/agent/mcp.md",
            docTitle: "万字拆解 MCP，附带工程实践",
            progressPercentage: 100,
            status: "completed",
            trainingStartedAt: "2026-05-01T10:03:00.000Z",
            trainingSessionCount: 1,
            currentTrainingPointId: "mcp-architecture",
            currentCheckpointId: "mcp-architecture-cp-2",
            decompositionSnapshot: {
              trainingPoints: [
                {
                  id: "mcp-architecture",
                  title: "MCP 架构分层",
                  checkpoints: [
                    { id: "mcp-architecture-cp-1", statement: "解释 Host / Client / Server 分工" },
                    { id: "mcp-architecture-cp-2", statement: "说明为什么要统一协议层" },
                    { id: "mcp-architecture-cp-3", statement: "说清工具发现与调用闭环" },
                  ],
                },
              ],
            },
          },
        },
      },
    },
    memoryProfile: { id: "mem-1", sessionsStarted: 1, abilityItems: {} },
  });

  assert.equal(
    profile.documentProgress.docs["docs/ai/agent/mcp.md"]?.trainingCheckpointProgressLabel,
    "2/3"
  );
});

test("document progress exposes recent document history with current marker", () => {
  const profile = buildUserProfileView({
    user: {
      ...makeUser(makeUserTarget()),
      documents: {
        currentDocPath: "docs/ai/agent/mcp.md",
        currentDocTitle: "万字拆解 MCP，附带工程实践",
        lastUpdatedAt: "2026-05-01T10:08:00.000Z",
        docs: {
          "docs/ai/agent/mcp.md": {
            docPath: "docs/ai/agent/mcp.md",
            docTitle: "万字拆解 MCP，附带工程实践",
            progressPercentage: 42,
            lastActivityAt: "2026-05-01T10:03:00.000Z",
          },
          "docs/system-design/framework/spring/spring-transaction.md": {
            docPath: "docs/system-design/framework/spring/spring-transaction.md",
            docTitle: "Spring 事务详解",
            progressPercentage: 76,
            lastActivityAt: "2026-05-01T10:08:00.000Z",
          },
        },
      },
    },
    memoryProfile: {
      id: "mem-1",
      sessionsStarted: 0,
      abilityItems: {
        "memory-only-doc": {
          abilityItemId: "memory-only-doc",
          title: "只来自记忆证据的文档",
          evidenceCount: 1,
          lastUpdatedAt: "2026-05-01T10:12:00.000Z",
          sourceDocPath: "docs/database/mysql/mysql-index.md",
        },
      },
    },
  });

  assert.deepEqual(
    profile.documentProgress.recentDocs.map((document) => document.docPath),
    [
      "docs/ai/agent/mcp.md",
      "docs/system-design/framework/spring/spring-transaction.md",
    ]
  );
  assert.equal(profile.documentProgress.recentDocs[0].isCurrent, true);
  assert.equal(profile.documentProgress.recentDocs[1].isCurrent, false);
  assert.equal(profile.documentProgress.recentDocs[0].lastActivityAt, "2026-05-01T10:03:00.000Z");
});

test("document progress hides ignored documents from current and recent views", () => {
  const user = makeUser(makeUserTarget());
  user.documents = applyDocumentIgnored({
    currentDocPath: "docs/ai/agent/mcp.md",
    currentDocTitle: "万字拆解 MCP，附带工程实践",
    docs: {
      "docs/ai/agent/mcp.md": {
        docPath: "docs/ai/agent/mcp.md",
        docTitle: "万字拆解 MCP，附带工程实践",
        progressPercentage: 42,
        lastActivityAt: "2026-05-01T10:03:00.000Z",
      },
      "docs/system-design/framework/spring/spring-transaction.md": {
        docPath: "docs/system-design/framework/spring/spring-transaction.md",
        docTitle: "Spring 事务详解",
        progressPercentage: 76,
        lastActivityAt: "2026-05-01T10:08:00.000Z",
      },
    },
  }, {
    docPath: "docs/ai/agent/mcp.md",
    docTitle: "万字拆解 MCP，附带工程实践",
    timestamp: "2026-05-01T10:10:00.000Z",
  });

  const profile = buildUserProfileView({
    user,
    memoryProfile: {
      id: "mem-1",
      sessionsStarted: 0,
      abilityItems: {
        "ignored-memory": {
          abilityItemId: "ignored-memory",
          title: "被忽略文档的记忆证据",
          evidenceCount: 1,
          lastUpdatedAt: "2026-05-01T10:12:00.000Z",
          sourceDocPath: "docs/ai/agent/mcp.md",
        },
      },
    },
  });

  assert.equal(profile.documentProgress.docs["docs/ai/agent/mcp.md"], undefined);
  assert.deepEqual(profile.documentProgress.ignoredDocPaths, ["docs/ai/agent/mcp.md"]);
  assert.deepEqual(
    profile.documentProgress.recentDocs.map((document) => document.docPath),
    ["docs/system-design/framework/spring/spring-transaction.md"]
  );
  assert.equal(profile.documentProgress.currentDocPath, "docs/system-design/framework/spring/spring-transaction.md");
});
