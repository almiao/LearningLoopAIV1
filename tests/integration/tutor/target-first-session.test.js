import test from "node:test";
import assert from "node:assert/strict";
import { createAppService } from "../../../src/server.js";
import { createHeuristicTutorIntelligence } from "../../../src/tutor/tutor-intelligence.js";

test("target-first session starts from flagship baseline and returns visible memory state", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const baselines = service.listBaselines();
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].id, "bigtech-java-backend");

  const session = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  assert.equal(session.targetBaseline.id, "bigtech-java-backend");
  assert.equal(session.targetBaseline.title, "大厂 Java 后端面试包");
  assert.equal(session.memoryMode, "profile-scoped");
  assert.ok(session.currentProbe.length > 0);
  assert.doesNotMatch(session.currentProbe, /这是某位候选人|系统生成诊断题/);
  assert.equal(session.currentQuestionMeta?.type, "provenance-backed");
  assert.match(session.currentQuestionMeta?.label || "", /面经原题/);
  assert.ok(session.concepts.length >= 5);
  assert.ok(session.concepts.every((concept) => concept.anchorIdentity?.canonicalId || concept.anchorIdentity?.canonical_id));
  assert.ok(Array.isArray(session.summary.javaGuideSourceClusters));
  assert.ok(session.summary.javaGuideSourceClusters.length >= 3);
  assert.ok(session.targetMatch);
  assert.ok(Array.isArray(session.abilityDomains));
});

test("answering target-first session updates memory events, remediation, and later reentry context", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const firstSession = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  const answered = await service.answer({
    sessionId: firstSession.sessionId,
    answer: "AQS 很重要，就是控制线程同步。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.ok(answered.latestFeedback);
  assert.ok(answered.currentRuntimeMap);
  assert.ok(answered.currentMemoryAnchor);
  assert.ok(answered.latestControlVerdict);
  assert.ok(Array.isArray(answered.latestMemoryEvents));
  assert.ok(answered.latestMemoryEvents.length >= 1);
  assert.ok(answered.nextSteps.length >= 1);
  assert.ok(Array.isArray(answered.nextSteps[0].materials));

  const reentrySession = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced",
    memoryProfileId: firstSession.memoryProfileId
  });

  assert.equal(reentrySession.memoryProfileId, firstSession.memoryProfileId);
  assert.ok(
    reentrySession.memoryEvents.some((event) => event.type === "self_test_reentry_context")
  );
});

test("target session can focus a selected domain and switch current assessment there", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const session = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  const focused = await service.focusDomain({
    sessionId: session.sessionId,
    domainId: "network-http-tcp"
  });

  assert.equal(focused.currentConceptId, "tcp-handshake-backlog-timewait");
  assert.match(focused.currentProbe, /TCP|backlog|TIME_WAIT/);
});

test("target memory profile survives service recreation through file-backed storage", async () => {
  const firstService = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const firstSession = await firstService.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  await firstService.answer({
    sessionId: firstSession.sessionId,
    answer: "AQS 通过 state、队列和唤醒链路来协同独占获取与释放。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  const restartedService = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const restartedSession = await restartedService.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced",
    memoryProfileId: firstSession.memoryProfileId
  });

  assert.equal(restartedSession.memoryProfileId, firstSession.memoryProfileId);
  assert.ok(
    restartedSession.memoryEvents.some((event) => event.type === "self_test_reentry_context")
  );
});

test("target-first flow closes a weak-point remediation loop inside one session", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const session = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  const weakPass = await service.answer({
    sessionId: session.sessionId,
    answer: "AQS 很重要，主要就是并发里会用到。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.ok(
    weakPass.latestMemoryEvents.some((event) => event.type === "weakness_confirmed")
  );
  assert.ok(weakPass.nextSteps[0].materials.length >= 1);

  const improvedPass = await service.answer({
    sessionId: weakPass.sessionId,
    answer:
      "AQS 不是具体锁，它用 state、队列和阻塞唤醒来承接 acquire/release 语义，ReentrantLock 只是复用这套独占同步器链路。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.ok(
    improvedPass.latestMemoryEvents.some((event) => event.type === "improvement_detected")
  );
  assert.ok(improvedPass.targetMatch.percentage > 0);
});
