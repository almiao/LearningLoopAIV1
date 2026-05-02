import test from "node:test";
import assert from "node:assert/strict";

import { buildUserProfileView } from "../../../src/user/profile-aggregator.js";
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
          confidence: 0.86,
          confidenceLevel: "high",
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
