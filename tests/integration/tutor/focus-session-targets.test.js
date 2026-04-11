import test from "node:test";
import assert from "node:assert/strict";
import { createAppService } from "../../../src/app-service.js";
import { createHeuristicTutorIntelligence } from "../../../src/tutor/tutor-intelligence.js";

test("target session can focus a selected concept and switch assessment there", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const session = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  const focused = await service.focusConcept({
    sessionId: session.sessionId,
    conceptId: "mysql-redo-undo-binlog-chain"
  });

  assert.equal(focused.currentConceptId, "mysql-redo-undo-binlog-chain");
  assert.match(focused.currentProbe, /redo|undo|binlog|日志/);
});

test("domain-scoped advance stays inside the selected domain instead of jumping globally", async () => {
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

  const advanced = await service.answer({
    sessionId: focused.sessionId,
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.notEqual(advanced.currentConceptId, "aqs-acquire-release");
  assert.match(advanced.currentProbe || "", /HTTP|TCP|幂等|TIME_WAIT|状态|握手|Keep-Alive|backlog/);
  assert.ok(
    advanced.turns.every(
      (turn) => !(turn.role === "tutor" && /我们先切到/.test(turn.content))
    )
  );
});

test("domain-scoped sessions stop when the scoped concepts are exhausted instead of auto-revisiting", async () => {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const session = await service.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced"
  });

  const focused = await service.focusDomain({
    sessionId: session.sessionId,
    domainId: "service-reliability"
  });

  const afterFirstAdvance = await service.answer({
    sessionId: focused.sessionId,
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  const afterSecondAdvance = await service.answer({
    sessionId: afterFirstAdvance.sessionId,
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.equal(afterSecondAdvance.currentProbe, "");
  assert.equal(afterSecondAdvance.latestFeedback.turnResolution.mode, "stop");
  assert.equal(
    afterSecondAdvance.turns.some(
      (turn) =>
        turn.role === "tutor" &&
        turn.kind === "question" &&
        /我们回到刚才先放下的这个点/.test(turn.content || "")
    ),
    false
  );
});
