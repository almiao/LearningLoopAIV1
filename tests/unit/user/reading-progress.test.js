import test from "node:test";
import assert from "node:assert/strict";

import { applyReadingProgress } from "../../../src/user/reading-progress.js";

test("reading progress counts repeated full reads for the same document", () => {
  const targetBaselineId = "bigtech-java-backend";
  const docPath = "docs/system-design/framework/spring/spring-transaction.md";

  const first = applyReadingProgress(
    {
      targetBaselineId,
      title: "大厂 Java 后端面试包",
      targetRole: "Java 后端工程师",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastActivityAt: "",
      sessionsStarted: 0,
      readingProgress: {},
    },
    {
      targetBaselineId,
      docPath,
      scrollRatio: 0.96,
      dwellMs: 50_000,
      timestamp: "2026-05-01T08:00:00.000Z",
    }
  );

  assert.equal(first.readingProgress.docs[docPath].progressPercentage, 100);
  assert.equal(first.readingProgress.docs[docPath].completedReadCount, 1);

  const second = applyReadingProgress(first, {
    targetBaselineId,
    docPath,
    scrollRatio: 0.98,
    dwellMs: 60_000,
    timestamp: "2026-05-02T09:30:00.000Z",
  });

  assert.equal(second.readingProgress.docs[docPath].progressPercentage, 100);
  assert.equal(second.readingProgress.docs[docPath].completedReadCount, 2);
});
