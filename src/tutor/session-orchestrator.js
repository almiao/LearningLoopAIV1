import { appendEvidence, createEvidenceLedger, summarizeLedger } from "./evidence-ledger.js";
import {
  buildAbilityDomains,
  buildRemediationPlan,
  buildTargetMatch,
  buildVisibleMemoryEvents,
  createConceptStatesFromMemory,
  createMemoryProfile,
  createSessionStartMemoryEvents,
  prioritizeConcepts,
  updateMemoryProfile,
  buildAssessmentHandle
} from "./capability-memory.js";
import { detectControlIntent } from "./control-intents.js";
import { buildAnchorIdentity, buildContextPacket } from "./context-packet.js";
import { applyWritebackSuggestion } from "./memory-writeback.js";
import { createInitialProbe, chooseNextConcept } from "./probe-engine.js";
import { buildNextSteps } from "./next-step-planner.js";
import { normalizeInteractionPreference } from "./tutor-policy.js";
import {
  assertConsistentTurnEnvelope,
  assertValidTurnEnvelope,
  buildControlVerdict,
  createEmptyRuntimeMap,
  mergeRuntimeMaps,
  scoreToConfidenceLevel,
  turnEnvelopeToTutorMove
} from "./turn-envelope.js";

function enqueueRevisit(session, { concept, reason, takeaway }) {
  if (!reason) {
    return;
  }

  const existing = session.revisitQueue.find(
    (item) => item.conceptId === concept.id && item.reason === reason && !item.done
  );
  if (existing) {
    existing.takeaway = takeaway || existing.takeaway;
    return;
  }

  session.revisitQueue.push({
    conceptId: concept.id,
    conceptTitle: concept.title,
    reason,
    takeaway,
    queuedAt: new Date().toISOString(),
    done: false
  });
}

function createConceptStates(concepts) {
  return Object.fromEntries(
    concepts.map((concept) => [
      concept.id,
      {
        attempts: 0,
        completed: false,
        lastAction: "probe",
        teachCount: 0,
        judge: {
          state: "weak",
          confidence: 0,
          reasons: ["尚无足够证据"]
        }
      }
    ])
  );
}

function withProtocolizedConcepts(concepts) {
  return concepts.map((concept) => ({
    ...concept,
    anchorIdentity: concept.anchorIdentity || buildAnchorIdentity(concept)
  }));
}

function queuePendingWriteback(session, candidate) {
  session.pendingWritebacks = session.pendingWritebacks || [];
  session.pendingWritebacks.push(candidate);
}

function groomPendingWritebacks(session, { conceptId = "" } = {}) {
  if (!session.pendingWritebacks?.length || !session.memoryProfile) {
    return [];
  }

  const grouped = new Map();
  for (const candidate of session.pendingWritebacks) {
    if (conceptId && candidate.concept.id !== conceptId) {
      continue;
    }
    const key = candidate.concept.id;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(candidate);
  }

  const promotedEvents = [];
  const consumedIds = new Set();
  for (const candidates of grouped.values()) {
    const latest = candidates.at(-1);
    const hasStrongSignal = candidates.some((candidate) =>
      ["positive", "negative"].includes(candidate.runtimeMap?.turn_signal || "")
    );
    if (candidates.length < 2 && !hasStrongSignal) {
      continue;
    }

    const result = applyWritebackSuggestion(session.memoryProfile, {
      ...latest,
      suggestion: {
        ...latest.suggestion,
        should_write: true,
        mode:
          latest.suggestion.mode === "noop"
            ? "update"
            : latest.suggestion.mode,
        reason: "session_grooming_promotion"
      }
    });

    if (result.applied) {
      for (const candidate of candidates) {
        consumedIds.add(candidate.id);
      }
      promotedEvents.push({
        type: "memory_grooming_applied",
        abilityItemId: latest.concept.id,
        title: latest.concept.title,
        summary: `“${latest.concept.title}”的候选证据在本轮整理后升格进长期记忆。`,
        message: `“${latest.concept.title}”的候选证据在本轮整理后升格进长期记忆。`,
        assessmentHandle: latest.evidencePoint.assessmentHandle || "",
        evidenceReference: latest.evidencePoint.evidenceReference || "",
        timestamp: new Date(latest.timestamp || Date.now()).toISOString()
      });
    }
  }

  if (consumedIds.size) {
    session.pendingWritebacks = session.pendingWritebacks.filter((candidate) => !consumedIds.has(candidate.id));
  }

  return promotedEvents;
}

function buildMasteryMap(session) {
  return summarizeLedger(session.ledger, session.concepts).map((item) => ({
    ...item,
    confidence: session.conceptStates[item.conceptId].judge.confidence,
    domainId: session.concepts.find((concept) => concept.id === item.conceptId)?.domainId || null,
    provenanceLabel:
      session.concepts.find((concept) => concept.id === item.conceptId)?.provenanceLabel ||
      session.concepts.find((concept) => concept.id === item.conceptId)?.interviewQuestion?.label ||
      ""
  }));
}

function buildSessionViews(session) {
  return {
    masteryMap: buildMasteryMap(session),
    nextSteps: session.mode === "target"
      ? buildRemediationPlan(session.concepts, session.conceptStates)
      : buildNextSteps(session.concepts, session.conceptStates),
    abilityDomains:
      session.mode === "target"
        ? buildAbilityDomains(session.concepts, session.conceptStates, session.ledger)
        : [],
    targetMatch:
      session.mode === "target"
        ? buildTargetMatch({
            concepts: session.concepts,
            conceptStates: session.conceptStates,
            targetBaseline: session.targetBaseline,
            ledger: session.ledger
          })
        : null
  };
}

function assertValidDecomposition(decomposition) {
  if (!Array.isArray(decomposition?.concepts) || decomposition.concepts.length < 3) {
    throw new Error("Tutor intelligence returned too few teaching units.");
  }

  if (
    !decomposition.summary ||
    typeof decomposition.summary.framing !== "string" ||
    !decomposition.summary.framing.trim()
  ) {
    throw new Error("Tutor intelligence returned invalid teaching units.");
  }

  for (const concept of decomposition.concepts) {
    if (!concept?.title || !concept?.summary || !concept?.diagnosticQuestion) {
      throw new Error("Tutor intelligence returned invalid teaching units.");
    }
  }
}

function moveDebugSummary(move) {
  if (!move) {
    return "null";
  }

  return JSON.stringify({
    moveType: move.moveType,
    signal: move.signal,
    judge: move.judge,
    hasReplyText: Boolean(move.replyText),
    hasFollowUpQuestion: Boolean(move.followUpQuestion)
  });
}

function invalidMoveError(move, reason) {
  return new Error(
    `Tutor intelligence returned an invalid tutor move (${reason}). Move summary: ${moveDebugSummary(move)}`
  );
}

function assertValidMove(move) {
  const allowed = new Set(["probe", "affirm", "deepen", "repair", "teach", "check", "advance"]);
  if (!move || !allowed.has(move.moveType)) {
    throw invalidMoveError(move, "invalid moveType");
  }

  if (!["positive", "negative", "noise"].includes(move.signal)) {
    throw invalidMoveError(move, "invalid signal");
  }

  if (!move.judge?.state || typeof move.judge.confidence !== "number") {
    throw invalidMoveError(move, "invalid judge");
  }

  if (!move.replyText) {
    throw invalidMoveError(move, "missing replyText");
  }
}

function moveRequiresResponse(move) {
  return ["probe", "teach", "verify"].includes(move?.nextMove?.ui_mode || "");
}

function getMoveFollowUpQuestion(move) {
  return moveRequiresResponse(move) ? String(move?.followUpQuestion || "").trim() : "";
}

function moveTypeToUiMode(moveType = "") {
  if (moveType === "teach") {
    return "teach";
  }
  if (moveType === "advance") {
    return "advance";
  }
  if (moveType === "deepen" || moveType === "affirm" || moveType === "check") {
    return "verify";
  }
  return "probe";
}

function createQuestionMeta(concept) {
  if (concept.interviewQuestion || concept.provenance) {
    const source = concept.interviewQuestion || concept.provenance;
    return {
      type: "provenance-backed",
      label: source.label,
      company: source.company,
      stage: source.stage || "",
      questionFamily: concept.questionFamily || ""
    };
  }

  return {
    type: "system-generated",
    label: "系统生成诊断题",
    company: "",
    stage: "",
    questionFamily: concept.questionFamily || ""
  };
}

function getWorkspaceScope(session) {
  return session.workspaceScope || { type: "pack", id: session.targetBaseline?.id || session.source.kind };
}

function isConceptInScope(session, concept) {
  const scope = getWorkspaceScope(session);
  if (session.mode !== "target") {
    return true;
  }
  if (scope.type === "pack") {
    return true;
  }
  if (scope.type === "domain") {
    return (concept.abilityDomainId || concept.domainId) === scope.id;
  }
  if (scope.type === "concept") {
    return concept.id === scope.id;
  }

  return true;
}

function chooseNextUnit(session, { allowRevisit = true } = {}) {
  const next = session.concepts.find((concept) => {
    const conceptSession = session.conceptStates[concept.id];
    return !conceptSession.completed && isConceptInScope(session, concept);
  });

  if (next) {
    return { concept: next, revisit: false };
  }

  if (session.mode === "target" && getWorkspaceScope(session).type !== "pack") {
    return { concept: null, revisit: false, scopeExhausted: true };
  }

  if (allowRevisit) {
    const revisit = session.revisitQueue.find((item) => {
      if (item.done) {
        return false;
      }

      const concept = session.concepts.find((entry) => entry.id === item.conceptId);
      return Boolean(concept && isConceptInScope(session, concept));
    });
    if (revisit) {
      const concept = session.concepts.find((item) => item.id === revisit.conceptId);
      if (concept) {
        revisit.done = true;
        session.conceptStates[concept.id].completed = false;
        return { concept, revisit: true, revisitReason: revisit.reason };
      }
    }
  }

  return { concept: chooseNextConcept(session), revisit: false };
}

function resolvePromptForConcept({ session = null, concept, revisit = false }) {
  if (revisit) {
    return `我们回到刚才先放下的这个点：${concept.title}。先用你自己的话把这一轮最关键的结论说出来。`;
  }

  return createInitialProbe(concept, session);
}

function findConceptForDomain(session, domainId) {
  const candidates = session.concepts.filter(
    (concept) => (concept.abilityDomainId || concept.domainId) === domainId
  );
  if (!candidates.length) {
    return null;
  }

  const incomplete = candidates.find((concept) => !session.conceptStates[concept.id].completed);
  return incomplete || candidates[0];
}

function findConceptById(session, conceptId) {
  return session.concepts.find((concept) => concept.id === conceptId) || null;
}

function formatGuideTitles(concept, limit = 2) {
  return (concept.javaGuideSources || [])
    .slice(0, limit)
    .map((source) => source.title)
    .filter(Boolean);
}

function buildTeachExplanation(concept, repeatedTeach = false, learningCard = null) {
  if (learningCard?.visibleReply) {
    const trimmed = String(learningCard.visibleReply).trim();
    if (repeatedTeach) {
      return trimmed.startsWith("我换个角度") ? trimmed : `我换个角度再讲一次。 ${trimmed}`;
    }

    return trimmed.startsWith("好，") || trimmed.startsWith("好。") || trimmed.startsWith("好 ") || trimmed.startsWith("我们")
      ? trimmed
      : `我们先把这个点拆开讲清楚。 ${trimmed}`;
  }

  const guideTitles = formatGuideTitles(concept);
  const sourceHint = guideTitles.length
    ? `建议先读 ${guideTitles.map((title) => `《${title}》`).join("、")}。`
    : "";
  const remediationHint = concept.remediationHint ? `优先抓住：${concept.remediationHint}` : "";
  const preface = repeatedTeach
    ? "我换个角度再讲一次。"
    : "我们先把这一层拆开讲清楚。";

  return [preface, concept.summary, remediationHint, sourceHint].filter(Boolean).join(" ");
}

function buildTeachChunk(concept, learningCard = null) {
  if (learningCard?.teachingChunk) {
    return learningCard.teachingChunk;
  }

  const guideTitles = formatGuideTitles(concept);
  const materials = (concept.remediationMaterials || [])
    .slice(0, 2)
    .map((material) => material.title);

  return [
    `${concept.summary}`,
    concept.remediationHint ? `你可以先抓住这样一个理解角度：${concept.remediationHint}` : "",
    guideTitles.length ? `如果想继续顺着看，优先读 ${guideTitles.map((title) => `《${title}》`).join("、")}。` : "",
    materials.length ? `补强卡片可以先看：${materials.join("、")}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function hasLearnerTurns(session) {
  return session.turns.some((turn) => turn.role === "learner");
}

function setFocusedConcept(session, concept, actionLabel) {
  session.currentConceptId = concept.id;
  session.currentProbe = createInitialProbe(concept, session);
  session.currentQuestionMeta = createQuestionMeta(concept);

  const questionTurn = createQuestionTurn({
    concept,
    content: session.currentProbe,
    action: "probe"
  });

  if (!hasLearnerTurns(session)) {
    session.turns = [questionTurn];
    return;
  }

  session.turns.push({
    role: "system",
    kind: "workspace",
    action: actionLabel,
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: `${actionLabel}:${concept.title}`,
    timestamp: Date.now()
  });
  session.turns.push(questionTurn);
}

function createQuestionTurn({ concept, content, action = "probe", revisitReason = "" }) {
  const questionMeta = createQuestionMeta(concept);
  return {
    role: "tutor",
    kind: "question",
    action,
    conceptId: concept.id,
    conceptTitle: concept.title,
    content,
    questionMeta,
    revisitReason,
    timestamp: Date.now()
  };
}

function createSessionState({
  source,
  concepts,
  summary,
  interactionPreference = "balanced",
  mode = "source",
  learnerId = null,
  targetBaseline = null,
  availableBaselineIds = [],
  memoryProfile = null
}) {
  const resolvedMemoryProfile = memoryProfile || createMemoryProfile();
  const protocolizedConcepts = withProtocolizedConcepts(concepts);
  const orderedConcepts = mode === "target" ? prioritizeConcepts(protocolizedConcepts, resolvedMemoryProfile) : protocolizedConcepts;
  const conceptStates = mode === "target" ? createConceptStatesFromMemory(orderedConcepts, resolvedMemoryProfile) : createConceptStates(orderedConcepts);
  const seedSession = {
    conceptStates,
    memoryProfile: resolvedMemoryProfile,
    burdenSignal: "normal"
  };
  const initialConcept = orderedConcepts[0];
  const currentProbe = createInitialProbe(initialConcept, seedSession);
  const initialQuestion = createQuestionTurn({
    concept: initialConcept,
    content: currentProbe
  });
  const initialMemoryEvents =
    mode === "target"
      ? createSessionStartMemoryEvents({
          concepts: orderedConcepts,
          memoryProfile: resolvedMemoryProfile,
          targetBaseline
        })
      : [];

  const session = {
    id: crypto.randomUUID(),
    mode,
    learnerId,
    source,
    concepts: orderedConcepts,
    ledger: createEvidenceLedger(orderedConcepts),
    conceptStates,
    createdAt: Date.now(),
    summary,
    currentConceptId: initialConcept.id,
    currentProbe,
    currentQuestionMeta: initialQuestion.questionMeta,
    lastAnsweredPrompt: currentProbe,
    burdenSignal: "normal",
    interactionPreference: normalizeInteractionPreference(interactionPreference),
    engagement: {
      answerCount: 0,
      controlCount: 0,
      skipCount: 0,
      teachRequestCount: 0,
      consecutiveControlCount: 0,
      lastControlIntent: ""
    },
    revisitQueue: [],
    memoryMode: mode === "target" ? "profile-scoped" : "session-scoped",
    workspaceScope:
      mode === "target"
        ? { type: "pack", id: targetBaseline?.id || source.kind }
        : { type: "source", id: source.kind },
    targetBaseline,
    memoryProfile: resolvedMemoryProfile,
    memoryProfileId: resolvedMemoryProfile.id,
    availableBaselineIds,
    targetMatch: null,
    memoryEvents: initialMemoryEvents,
    latestMemoryEvents: initialMemoryEvents,
    runtimeMaps: Object.fromEntries(orderedConcepts.map((concept) => [concept.id, createEmptyRuntimeMap(concept.id)])),
    pendingWritebacks: [],
    latestControlVerdict: null,
    turns: [initialQuestion]
  };

  return {
    ...session,
    ...buildSessionViews(session)
  };
}

export async function createSession({
  source,
  intelligence,
  interactionPreference = "balanced",
  preparedDecomposition = null,
  mode = "source",
  learnerId = null,
  targetBaseline = null,
  availableBaselineIds = [],
  memoryProfile = null
}) {
  const decomposition = preparedDecomposition || (await intelligence.decomposeSource({ source }));
  assertValidDecomposition(decomposition);
  return createSessionState({
    source,
    concepts: decomposition.concepts,
    summary: decomposition.summary,
    interactionPreference,
    mode,
    learnerId,
    targetBaseline,
    availableBaselineIds,
    memoryProfile
  });
}

function buildLatestFeedback({ concept, tutorMove, controlVerdict = null, memoryAnchor = null }) {
  const followUpQuestion = getMoveFollowUpQuestion(tutorMove);
  return {
    conceptId: concept.id,
    conceptTitle: concept.title,
    signal: tutorMove.signal,
    action: tutorMove.moveType,
    explanation: tutorMove.replyText,
    replyStream: tutorMove.replyText,
    gap: tutorMove.nextMove?.reason || tutorMove.judge.reasons?.[0] || "",
    evidenceReference: concept.excerpt,
    coachingStep: followUpQuestion,
    candidateCoachingStep: followUpQuestion,
    strength: "",
    takeaway: "",
    teachingChunk: "",
    teachingParagraphs: [],
    revisitReason: tutorMove.revisitReason,
    judge: tutorMove.judge,
    runtimeMap: tutorMove.runtimeMap || null,
    nextMove: tutorMove.nextMove || null,
    modelNextMove: tutorMove.nextMove || null,
    writebackSuggestion: tutorMove.writebackSuggestion || null,
    controlVerdict,
    turnResolution: null,
    memoryAnchor,
    remediationMaterial: concept.remediationMaterials?.[0] || null,
    learningSources: concept.javaGuideSources || []
  };
}

function buildTurnResolution({
  concept,
  nextConcept = null,
  switchedConcept = false,
  finalPrompt = "",
  finalQuestionMeta = null,
  controlVerdict = null
}) {
  if (switchedConcept && nextConcept) {
    return {
      mode: "switch",
      reason: "concept_completed",
      finalPrompt,
      finalConceptId: nextConcept.id,
      finalConceptTitle: nextConcept.title,
      finalQuestionMeta
    };
  }

  if (finalPrompt) {
    return {
      mode: "stay",
      reason: controlVerdict?.reason || "continue_on_current_concept",
      finalPrompt,
      finalConceptId: concept.id,
      finalConceptTitle: concept.title,
      finalQuestionMeta
    };
  }

  return {
    mode: "stop",
    reason: controlVerdict?.reason || "no_followup_prompt",
    finalPrompt: "",
    finalConceptId: concept.id,
    finalConceptTitle: concept.title,
    finalQuestionMeta: null
  };
}

function createFallbackRuntimeMap(concept, tutorMove) {
  const followUpQuestion = getMoveFollowUpQuestion(tutorMove);
  return {
    ...createEmptyRuntimeMap(concept.id),
    turn_signal: tutorMove.signal,
    anchor_assessment: {
      state: tutorMove.judge.state,
      confidence_level: tutorMove.judge.confidenceLevel || scoreToConfidenceLevel(tutorMove.judge.confidence),
      reasons: tutorMove.judge.reasons || []
    },
    open_questions: followUpQuestion ? [followUpQuestion] : [],
    verification_targets: followUpQuestion
      ? [
          {
            id: `${concept.id}-legacy-verify`,
            question: followUpQuestion,
            why: tutorMove.nextMove?.reason || concept.summary
          }
        ]
      : [],
    info_gain_level: moveRequiresResponse(tutorMove) ? "medium" : "low"
  };
}

function createFallbackWritebackSuggestion(concept, tutorMove) {
  return {
    should_write: tutorMove.signal !== "noise",
    mode: tutorMove.signal === "negative" ? "append_conflict" : "update",
    reason: tutorMove.signal === "positive" ? "legacy_positive_signal" : "legacy_partial_signal",
    anchor_patch: {
      state: tutorMove.judge.state,
      confidence_level: tutorMove.judge.confidenceLevel || scoreToConfidenceLevel(tutorMove.judge.confidence),
      derived_principle: tutorMove.nextMove?.reason || concept.summary
    }
  };
}

export async function answerSession(
  session,
  { answer, intent = "", burdenSignal = "normal", interactionPreference, intelligence }
) {
  const concept = session.concepts.find((item) => item.id === session.currentConceptId);
  const priorEvidence = session.ledger[concept.id].entries;
  const previousJudge = { ...session.conceptStates[concept.id].judge };

  if (interactionPreference) {
    session.interactionPreference = normalizeInteractionPreference(interactionPreference);
  }

  session.lastAnsweredPrompt = session.currentProbe;
  const controlIntent = detectControlIntent(answer, intent);
  if (controlIntent) {
    return applyControlIntent(session, { concept, controlIntent, answer, burdenSignal, intelligence });
  }

  session.engagement.answerCount += 1;
  session.engagement.consecutiveControlCount = 0;
  session.engagement.lastControlIntent = "";

  const contextPacket = buildContextPacket({
    session,
    concept,
    answer,
    burdenSignal,
    priorEvidence
  });
  let tutorMove = null;
  let decisionEnvelope = null;
  let replyStreamText = "";

  if (intelligence.generateDecisionEnvelope || intelligence.generateReplyStream) {
    try {
      const [decisionResult, replyResult] = await Promise.all([
        intelligence.generateDecisionEnvelope
          ? intelligence.generateDecisionEnvelope({
              session,
              concept,
              answer,
              burdenSignal,
              priorEvidence,
              contextPacket
            })
          : null,
        intelligence.generateReplyStream
          ? intelligence.generateReplyStream({
              session,
              concept,
              answer,
              burdenSignal,
              priorEvidence,
              contextPacket
            })
          : ""
      ]);
      decisionEnvelope = decisionResult;
      replyStreamText = String(replyResult || "").trim();
      if (decisionEnvelope) {
        assertValidTurnEnvelope(decisionEnvelope, concept.id);
        assertConsistentTurnEnvelope(decisionEnvelope, contextPacket);
        tutorMove = turnEnvelopeToTutorMove(decisionEnvelope, { replyText: replyStreamText });
      }
    } catch (error) {
      console.warn(
        `[tutor-envelope-fallback] ${concept.id}:`,
        error instanceof Error ? error.message : String(error)
      );
      decisionEnvelope = null;
      replyStreamText = "";
    }
  }

  if (!tutorMove && intelligence.generateTurnEnvelope) {
    try {
      decisionEnvelope = await intelligence.generateTurnEnvelope({
        session,
        concept,
        answer,
        burdenSignal,
        priorEvidence,
        contextPacket
      });
      assertValidTurnEnvelope(decisionEnvelope, concept.id);
      assertConsistentTurnEnvelope(decisionEnvelope, contextPacket);
      tutorMove = turnEnvelopeToTutorMove(decisionEnvelope, { replyText: replyStreamText });
    } catch (error) {
      console.warn(
        `[tutor-envelope-legacy-fallback] ${concept.id}:`,
        error instanceof Error ? error.message : String(error)
      );
      decisionEnvelope = null;
    }
  }

  if (!replyStreamText && intelligence.generateTutorMove) {
    const legacyMove = await intelligence.generateTutorMove({
      session,
      concept,
      answer,
      burdenSignal,
      priorEvidence
    });
    if (legacyMove) {
      replyStreamText = String(legacyMove.replyText || legacyMove.visibleReply || "").trim();
      if (!tutorMove) {
        tutorMove = {
          moveType: legacyMove.moveType || "repair",
          signal: legacyMove.signal || "noise",
          judge: legacyMove.judge,
          replyText: replyStreamText,
          followUpQuestion: legacyMove.nextQuestion || "",
          shouldStop: legacyMove.requiresResponse === false,
          revisitReason: legacyMove.revisitReason || "",
          completeCurrentUnit: Boolean(legacyMove.completeCurrentUnit),
          nextMove: legacyMove.nextMove
            ? {
                ui_mode:
                  legacyMove.nextMove.ui_mode ||
                  legacyMove.nextMove.uiMode ||
                  moveTypeToUiMode(legacyMove.moveType),
                intent: legacyMove.nextMove.intent || "继续围绕当前点推进。",
                reason: legacyMove.nextMove.reason || concept.summary,
                expected_gain:
                  legacyMove.nextMove.expected_gain ||
                  legacyMove.nextMove.expectedGain ||
                  (legacyMove.requiresResponse === false ? "low" : "medium"),
                follow_up_question:
                  legacyMove.nextMove.follow_up_question ||
                  legacyMove.nextMove.followUpQuestion ||
                  legacyMove.nextQuestion ||
                  ""
              }
            : {
                ui_mode: moveTypeToUiMode(legacyMove.moveType),
                intent: legacyMove.nextQuestion ? "继续围绕当前点推进。" : "这个点先收口。",
                reason: concept.summary,
                expected_gain: legacyMove.requiresResponse === false ? "low" : "medium",
                follow_up_question: legacyMove.nextQuestion || ""
              },
          runtimeMap: legacyMove.runtimeMap || null,
          writebackSuggestion: legacyMove.writebackSuggestion || null
        };
      }
    }
  }

  if (!tutorMove) {
    const review = await intelligence.reviewTurn({
      session,
      concept,
      answer,
      burdenSignal,
      priorEvidence
    });
    replyStreamText = replyStreamText || String(review.feedback.explanation || concept.summary).trim();
    tutorMove = {
      moveType: "repair",
      signal: review.signal,
      judge: review.judge,
      replyText: replyStreamText,
      followUpQuestion: review.nextQuestion || "",
      shouldStop: false,
      revisitReason: "",
      completeCurrentUnit: false,
      nextMove: {
        ui_mode: "probe",
        intent: "继续围绕当前点收窄问题。",
        reason: review.feedback.gap || concept.summary,
        expected_gain: "medium",
        follow_up_question: review.nextQuestion || ""
      },
      runtimeMap: null,
      writebackSuggestion: null
    };
  }

  tutorMove.replyText = replyStreamText || tutorMove.replyText || concept.summary;

  tutorMove.runtimeMap = tutorMove.runtimeMap || decisionEnvelope?.runtime_map || createFallbackRuntimeMap(concept, tutorMove);
  tutorMove.runtimeMap = mergeRuntimeMaps(
    session.runtimeMaps?.[concept.id] || null,
    tutorMove.runtimeMap,
    concept.id
  );
  tutorMove.nextMove = tutorMove.nextMove || decisionEnvelope?.next_move || null;
  tutorMove.writebackSuggestion =
    tutorMove.writebackSuggestion ||
    decisionEnvelope?.writeback_suggestion ||
    createFallbackWritebackSuggestion(concept, tutorMove);
  const controlVerdict = buildControlVerdict({
    envelope: {
      runtime_map: tutorMove.runtimeMap,
      next_move:
        tutorMove.nextMove || {
          ui_mode: moveTypeToUiMode(tutorMove.moveType),
          intent: "继续围绕当前点推进。",
          reason: concept.summary,
          expected_gain: "medium",
          follow_up_question: getMoveFollowUpQuestion(tutorMove)
        }
    },
    contextPacket,
    scopeType: getWorkspaceScope(session).type
  });

  assertValidMove(tutorMove);

  session.turns.push({
    role: "learner",
    kind: "answer",
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: answer,
    burdenSignal,
    interactionPreference: session.interactionPreference,
    timestamp: Date.now()
  });
  const answerTimestamp = session.turns.at(-1).timestamp;

  appendEvidence(session.ledger, concept.id, {
    id: contextPacket.draft_evidence.id,
    prompt: contextPacket.draft_evidence.prompt,
    answer,
    signal: tutorMove.signal,
    explanation: tutorMove.replyText,
    whyJudgedThisWay: tutorMove.judge.reasons?.join("；") || "",
    sourceRefs: contextPacket.draft_evidence.sourceRefs,
    confidenceLevel:
      tutorMove.judge.confidenceLevel || tutorMove.runtimeMap?.anchor_assessment?.confidence_level || "low",
    evidenceReference: concept.excerpt,
    sourceAligned: true
  });

  session.runtimeMaps[concept.id] = tutorMove.runtimeMap;

  session.conceptStates[concept.id].attempts += 1;
  session.conceptStates[concept.id].judge = tutorMove.judge;
  session.ledger[concept.id].state = tutorMove.judge.state;
  session.ledger[concept.id].reasons = tutorMove.judge.reasons;
  session.burdenSignal = burdenSignal;
  session.conceptStates[concept.id].lastAction = tutorMove.moveType;
  if (tutorMove.moveType === "teach") {
    session.conceptStates[concept.id].teachCount += 1;
  }
  if (tutorMove.revisitReason) {
    enqueueRevisit(session, {
      concept,
      reason: tutorMove.revisitReason,
      takeaway: ""
    });
  }

  let latestMemoryEvents = [];
  let latestMemoryAnchor = null;

  const shouldCompleteConcept =
    tutorMove.completeCurrentUnit ||
    tutorMove.judge.state === "solid" ||
    tutorMove.judge.state === "不可判" ||
    tutorMove.moveType === "advance";

  if (shouldCompleteConcept) {
    session.conceptStates[concept.id].completed = true;
  }

  if (session.mode === "target") {
    const assessmentHandle = buildAssessmentHandle(session, concept);
    const writebackResult = applyWritebackSuggestion(session.memoryProfile, {
      concept,
      suggestion: tutorMove.writebackSuggestion,
      evidencePoint: {
        ...contextPacket.draft_evidence,
        answer,
        assessmentHandle,
        whyJudgedThisWay: tutorMove.judge.reasons?.join("；") || "",
        evidenceReference: concept.excerpt
      },
      explanation: tutorMove.replyText,
      runtimeMap: tutorMove.runtimeMap,
      projectedTargets: session.targetBaseline?.id ? [session.targetBaseline.id] : [],
      timestamp: answerTimestamp
    });
    if (!writebackResult.applied && tutorMove.writebackSuggestion?.should_write) {
      queuePendingWriteback(session, {
        id: `${concept.id}:${assessmentHandle}`,
        concept,
        suggestion: tutorMove.writebackSuggestion,
        evidencePoint: {
          ...contextPacket.draft_evidence,
          answer,
          assessmentHandle,
          whyJudgedThisWay: tutorMove.judge.reasons?.join("；") || "",
          evidenceReference: concept.excerpt
        },
        explanation: tutorMove.replyText,
        runtimeMap: tutorMove.runtimeMap,
        timestamp: answerTimestamp
      });
    }
    if (!writebackResult.applied && !decisionEnvelope) {
      updateMemoryProfile(session.memoryProfile, {
        concept,
        judge: tutorMove.judge,
        signal: tutorMove.signal,
        answer,
        explanation: tutorMove.replyText,
        assessmentHandle,
        evidenceReference: concept.excerpt,
        derivedPrinciple:
          tutorMove.writebackSuggestion?.anchor_patch?.derived_principle ||
          tutorMove.writebackSuggestion?.anchorPatch?.derivedPrinciple ||
          tutorMove.nextMove?.reason,
        projectedTargets: session.targetBaseline?.id ? [session.targetBaseline.id] : [],
        writebackReason: tutorMove.writebackSuggestion?.reason || "legacy_fallback_writeback",
        timestamp: answerTimestamp
      });
    }
    latestMemoryEvents = buildVisibleMemoryEvents({
      concept,
      previousJudge,
      currentJudge: tutorMove.judge,
      signal: tutorMove.signal,
      revisitReason: tutorMove.revisitReason,
      assessmentHandle,
      evidenceReference: concept.excerpt,
      timestamp: answerTimestamp
    });
    if (writebackResult.applied) {
      latestMemoryEvents.push({
        type: "memory_writeback_applied",
        abilityItemId: concept.id,
        title: concept.title,
        summary: `“${concept.title}”这轮高价值证据已写入长期记忆。`,
        message: `“${concept.title}”这轮高价值证据已写入长期记忆。`,
        assessmentHandle,
        evidenceReference: concept.excerpt,
        timestamp: new Date(answerTimestamp).toISOString()
      });
    }
    latestMemoryAnchor = session.memoryProfile?.abilityItems?.[concept.id] || null;
    session.memoryEvents.push(...latestMemoryEvents);
    session.memoryEvents = session.memoryEvents.slice(-10);
    session.latestMemoryEvents = latestMemoryEvents;
  }

  if (session.mode === "target" && shouldCompleteConcept) {
    const groomingEvents = groomPendingWritebacks(session, { conceptId: concept.id });
    if (groomingEvents.length) {
      latestMemoryEvents.push(...groomingEvents);
      latestMemoryAnchor = session.memoryProfile?.abilityItems?.[concept.id] || latestMemoryAnchor;
      session.memoryEvents.push(...groomingEvents);
      session.memoryEvents = session.memoryEvents.slice(-10);
      session.latestMemoryEvents = latestMemoryEvents;
    }
  }

  const nextUnit = chooseNextUnit(session);
  const nextConcept = nextUnit.concept;
  const switchedConcept = Boolean(nextConcept) && nextConcept.id !== concept.id;
  if (session.mode === "target" && (!nextConcept || nextUnit.scopeExhausted)) {
    const remainingGroomingEvents = groomPendingWritebacks(session);
    if (remainingGroomingEvents.length) {
      latestMemoryEvents.push(...remainingGroomingEvents);
      session.memoryEvents.push(...remainingGroomingEvents);
      session.memoryEvents = session.memoryEvents.slice(-10);
      session.latestMemoryEvents = latestMemoryEvents;
    }
  }
  session.currentConceptId = nextConcept?.id || session.currentConceptId;
  session.currentProbe = nextConcept
    ? switchedConcept
      ? resolvePromptForConcept({ session, concept: nextConcept, revisit: nextUnit.revisit })
      : getMoveFollowUpQuestion(tutorMove)
    : "";
  session.currentQuestionMeta = session.currentProbe && nextConcept ? createQuestionMeta(nextConcept) : null;
  const turnResolution = buildTurnResolution({
    concept,
    nextConcept,
    switchedConcept,
    finalPrompt: session.currentProbe,
    finalQuestionMeta: session.currentQuestionMeta,
    controlVerdict
  });
  const visibleCoachingStep = turnResolution.mode === "stay" ? getMoveFollowUpQuestion(tutorMove) : "";
  const visibleNextMove = turnResolution.mode === "stay" ? (tutorMove.nextMove || null) : null;

  session.turns.push({
    role: "tutor",
    kind: "feedback",
    action: tutorMove.moveType,
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: tutorMove.replyText,
    contentFormat: "markdown",
    evidenceReference: concept.excerpt,
    coachingStep: visibleCoachingStep,
    candidateCoachingStep: getMoveFollowUpQuestion(tutorMove),
    learningSources: concept.javaGuideSources || [],
    runtimeMap: tutorMove.runtimeMap || null,
    nextMove: visibleNextMove,
    modelNextMove: tutorMove.nextMove || null,
    writebackSuggestion: tutorMove.writebackSuggestion || null,
    controlVerdict,
    turnResolution,
    revisitReason: tutorMove.revisitReason,
    timestamp: Date.now()
  });

  if (session.currentProbe && nextConcept) {
    session.turns.push(
      createQuestionTurn({
        concept: nextConcept,
        content: session.currentProbe,
        action: switchedConcept ? "probe" : tutorMove.moveType,
        revisitReason: nextUnit.revisitReason || ""
      })
    );
  }

  const views = buildSessionViews(session);
  session.latestMemoryEvents = [];
  session.latestControlVerdict = controlVerdict;

  return {
    ...session,
    ...views,
    latestFeedback: {
      ...buildLatestFeedback({
        concept,
        tutorMove,
        controlVerdict,
        memoryAnchor: latestMemoryAnchor
      }),
      coachingStep: visibleCoachingStep,
      candidateCoachingStep: getMoveFollowUpQuestion(tutorMove),
      nextMove: visibleNextMove,
      turnResolution
    },
    latestMemoryEvents
  };
}

export function focusSessionOnDomain(session, domainId) {
  const concept = findConceptForDomain(session, domainId);
  if (!concept) {
    throw new Error("Unknown domain.");
  }

  session.workspaceScope = { type: "domain", id: domainId };

  if (session.currentConceptId === concept.id) {
    return {
      ...session,
      ...buildSessionViews(session)
    };
  }

  setFocusedConcept(session, concept, "focus-domain");

  return {
    ...session,
    ...buildSessionViews(session)
  };
}

export function focusSessionOnConcept(session, conceptId) {
  const concept = findConceptById(session, conceptId);
  if (!concept) {
    throw new Error("Unknown concept.");
  }

  session.workspaceScope = { type: "concept", id: conceptId };

  if (session.currentConceptId === concept.id) {
    return {
      ...session,
      ...buildSessionViews(session)
    };
  }

  setFocusedConcept(session, concept, "focus-concept");

  return {
    ...session,
    ...buildSessionViews(session)
  };
}

async function applyControlIntent(session, { concept, controlIntent, answer, burdenSignal, intelligence }) {
  const now = Date.now();
  const priorTeachRequests = session.conceptStates[concept.id].teachCount;

  session.engagement.controlCount += 1;
  session.engagement.consecutiveControlCount += 1;
  session.engagement.lastControlIntent = controlIntent;
  if (controlIntent === "advance") {
    session.engagement.skipCount += 1;
  } else if (controlIntent === "teach") {
    session.engagement.teachRequestCount += 1;
  }

  session.turns.push({
    role: "learner",
    kind: "control",
    action: controlIntent,
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: answer,
    burdenSignal,
    interactionPreference: session.interactionPreference,
    timestamp: now
  });

  let explanation = "";
  let coachingStep = "";
  let teachingChunk = "";
  let learningCard = null;
  let latestMemoryEvents = [];

  if (controlIntent === "teach") {
    const repeatedTeach = priorTeachRequests >= 1;
    const contextPacket = buildContextPacket({
      session,
      concept,
      answer,
      burdenSignal,
      priorEvidence: session.ledger[concept.id].entries
    });
    learningCard = intelligence?.explainConcept
      ? await intelligence.explainConcept({ session, concept, burdenSignal, contextPacket })
      : null;
    explanation = buildTeachExplanation(concept, repeatedTeach, learningCard);
    teachingChunk = buildTeachChunk(concept, learningCard);
    coachingStep = learningCard?.checkQuestion || concept.checkQuestion || concept.retryQuestion || "";
    session.conceptStates[concept.id].teachCount += 1;
    session.conceptStates[concept.id].lastAction = "teach";
  } else {
    explanation = "好，这个点先不继续卡住你了，我们直接进下一题。";
    session.conceptStates[concept.id].completed = true;
    session.conceptStates[concept.id].lastAction = "advance";
    enqueueRevisit(session, {
      concept,
      reason: "skipped-by-user",
      takeaway: ""
    });
    if (session.mode === "target") {
      latestMemoryEvents = groomPendingWritebacks(session, { conceptId: concept.id });
      if (latestMemoryEvents.length) {
        session.memoryEvents.push(...latestMemoryEvents);
        session.memoryEvents = session.memoryEvents.slice(-10);
        session.latestMemoryEvents = latestMemoryEvents;
      }
    }
  }

  if (controlIntent !== "teach" || !coachingStep) {
    const nextUnit = chooseNextUnit(session, { allowRevisit: false });
    if (nextUnit.concept) {
      session.currentConceptId = nextUnit.concept.id;
      session.currentProbe = resolvePromptForConcept({
        session,
        concept: nextUnit.concept,
        revisit: nextUnit.revisit
      });
      session.currentQuestionMeta = createQuestionMeta(nextUnit.concept);
    } else {
      session.currentProbe = "";
      session.currentQuestionMeta = null;
    }
  } else {
    session.currentProbe = coachingStep;
    session.currentQuestionMeta = createQuestionMeta(concept);
  }
  const controlTurnResolution = buildTurnResolution({
    concept,
    nextConcept: session.concepts.find((item) => item.id === session.currentConceptId) || null,
    switchedConcept: session.currentConceptId !== concept.id,
    finalPrompt: session.currentProbe,
    finalQuestionMeta: session.currentQuestionMeta,
    controlVerdict: {
      reason: controlIntent === "teach" ? "continue_on_current_concept" : "next_move_requests_stop"
    }
  });
  const visibleCoachingStep = controlTurnResolution.mode === "stay" ? coachingStep : "";

  session.turns.push({
    role: "tutor",
    kind: "feedback",
    action: controlIntent,
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: explanation,
    teachingChunk,
    teachingParagraphs: learningCard?.teachingParagraphs || [],
    learningSources: concept.javaGuideSources || [],
    takeaway: "",
    coachingStep: visibleCoachingStep,
    candidateCoachingStep: coachingStep,
    turnResolution: controlTurnResolution,
    timestamp: Date.now()
  });

  if (session.currentProbe) {
    const currentConcept = session.concepts.find((item) => item.id === session.currentConceptId);
    if (currentConcept) {
      session.turns.push(
        createQuestionTurn({
          concept: currentConcept,
          content: session.currentProbe,
          action: controlIntent === "teach" && coachingStep ? "check" : "probe"
        })
      );
    }
  }

  const views = buildSessionViews(session);
  session.latestMemoryEvents = latestMemoryEvents;

  return {
    ...session,
    ...views,
    latestFeedback: {
      conceptId: concept.id,
      conceptTitle: concept.title,
      signal: "noise",
      action: controlIntent,
      explanation,
      gap: "",
      evidenceReference: concept.excerpt,
      coachingStep: visibleCoachingStep,
      candidateCoachingStep: coachingStep,
      strength: "",
      takeaway: "",
      teachingChunk,
      teachingParagraphs: learningCard?.teachingParagraphs || [],
      judge: session.conceptStates[concept.id].judge,
      turnResolution: controlTurnResolution,
      remediationMaterial: concept.remediationMaterials?.[0] || null,
      learningSources: concept.javaGuideSources || []
    },
    latestMemoryEvents
  };
}
