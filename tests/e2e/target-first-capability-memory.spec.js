import test from "node:test";
import assert from "node:assert/strict";
import { createAppService } from "../../src/server.js";
import { createHeuristicTutorIntelligence } from "../../src/tutor/tutor-intelligence.js";

test("target-first capability-memory flow supports flagship session and conservative sibling reprojection", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const flagship = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  assert.equal(flagship.targetBaseline.title, "大厂 Java 后端面试包");
  assert.match(flagship.currentProbe, /字节|美团|阿里|滴滴|系统生成/);

  const updated = await service.answer({
    sessionId: flagship.sessionId,
    answer:
      "AQS 不是具体锁，它把获取失败后的排队、阻塞和唤醒逻辑抽成了同步器底座，ReentrantLock 是在这个框架上实现独占获取释放的。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.ok(updated.targetMatch);
  assert.ok(updated.targetMatch.percentage > 0);
  assert.ok(updated.latestMemoryEvents.length >= 1);

  const sibling = await service.startTargetSession({
    targetBaselineId: "java-backend-generalist",
    interactionPreference: "balanced",
    memoryProfileId: flagship.memoryProfileId
  });

  assert.equal(sibling.targetBaseline.id, "java-backend-generalist");
  assert.ok(
    sibling.memoryEvents.some((event) => event.type === "self_test_reentry_context")
  );
  assert.ok(sibling.targetMatch.percentage <= 100);
  assert.ok(sibling.targetMatch.explanation.length > 0);
});
