import { appendEvidence, createEvidenceLedger, summarizeLedger } from "./evidence-ledger.js";
import { detectControlIntent } from "./control-intents.js";
import { createInitialProbe, chooseNextConcept } from "./probe-engine.js";
import { buildNextSteps } from "./next-step-planner.js";
import { normalizeInteractionPreference } from "./tutor-policy.js";

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

function chooseNextUnit(session) {
  const next = session.concepts.find((concept) => {
    const conceptSession = session.conceptStates[concept.id];
    return !conceptSession.completed;
  });

  if (next) {
    return { concept: next, revisit: false };
  }

  const revisit = session.revisitQueue.find((item) => !item.done);
  if (revisit) {
    const concept = session.concepts.find((item) => item.id === revisit.conceptId);
    if (concept) {
      revisit.done = true;
      session.conceptStates[concept.id].completed = false;
      return { concept, revisit: true, revisitReason: revisit.reason };
    }
  }

  return { concept: chooseNextConcept(session), revisit: false };
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

function buildMasteryMap(session) {
  return summarizeLedger(session.ledger, session.concepts).map((item) => ({
    ...item,
    confidence: session.conceptStates[item.conceptId].judge.confidence
  }));
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

function assertValidMove(move) {
  const allowed = new Set(["probe", "affirm", "deepen", "repair", "teach", "check", "summarize", "advance", "abstain"]);

  if (!move || !allowed.has(move.moveType)) {
    throw new Error("Tutor intelligence returned an invalid tutor move.");
  }

  if (!["positive", "negative", "noise"].includes(move.signal)) {
    throw new Error("Tutor intelligence returned an invalid tutor move.");
  }

  if (!move.judge?.state || typeof move.judge.confidence !== "number") {
    throw new Error("Tutor intelligence returned an invalid tutor move.");
  }

  if (!move.visibleReply) {
    throw new Error("Tutor intelligence returned an invalid tutor move.");
  }
}

function createSessionState({ source, concepts, summary }) {
  const initialConcept = concepts[0];
  const session = {
    id: crypto.randomUUID(),
    source,
    concepts,
    ledger: createEvidenceLedger(concepts),
    conceptStates: createConceptStates(concepts),
    createdAt: Date.now(),
    summary,
    currentConceptId: initialConcept.id,
    currentProbe: createInitialProbe(initialConcept),
    burdenSignal: "normal",
    interactionPreference: "balanced",
    engagement: {
      answerCount: 0,
      controlCount: 0,
      skipCount: 0,
      teachRequestCount: 0,
      summarizeCount: 0,
      consecutiveControlCount: 0,
      lastControlIntent: ""
    },
    revisitQueue: [],
    memoryMode: "session-scoped",
    turns: [
      {
        role: "tutor",
        kind: "question",
        action: "probe",
        conceptId: initialConcept.id,
        conceptTitle: initialConcept.title,
        content: createInitialProbe(initialConcept),
        timestamp: Date.now()
      }
    ]
  };

  return {
    ...session,
    masteryMap: buildMasteryMap(session),
    nextSteps: buildNextSteps(session.concepts, session.conceptStates)
  };
}

export async function createSession({ source, intelligence, interactionPreference = "balanced" }) {
  const decomposition = await intelligence.decomposeSource({ source });
  assertValidDecomposition(decomposition);
  const session = createSessionState({
    source,
    concepts: decomposition.concepts,
    summary: decomposition.summary
  });
  session.interactionPreference = normalizeInteractionPreference(interactionPreference);
  return session;
}

export async function answerSession(
  session,
  { answer, burdenSignal = "normal", interactionPreference, intelligence }
) {
  const concept = session.concepts.find((item) => item.id === session.currentConceptId);
  const priorEvidence = session.ledger[concept.id].entries;
  if (interactionPreference) {
    session.interactionPreference = normalizeInteractionPreference(interactionPreference);
  }
  const controlIntent = detectControlIntent(answer);
  if (controlIntent) {
    return applyControlIntent(session, { concept, controlIntent, answer, burdenSignal });
  }
  session.engagement.answerCount += 1;
  session.engagement.consecutiveControlCount = 0;
  session.engagement.lastControlIntent = "";
  const move = intelligence.generateTutorMove
    ? await intelligence.generateTutorMove({
        session,
        concept,
        answer,
        burdenSignal,
        priorEvidence
      })
    : await intelligence.reviewTurn({
        session,
        concept,
        answer,
        burdenSignal,
        priorEvidence
      }).then((review) => ({
        moveType: "repair",
        signal: review.signal,
        judge: review.judge,
        visibleReply: review.feedback.explanation,
        evidenceReference: review.feedback.evidenceReference,
        teachingChunk: review.feedback.teachingChunk || "",
        nextQuestion: review.nextQuestion,
        confirmedUnderstanding: review.feedback.positiveConfirmation || "",
        remainingGap: review.feedback.gap || "",
        completeCurrentUnit: false,
        requiresResponse: true
      }));
  const tutorMove = move;
  assertValidMove(tutorMove);
  const answerTimestamp = Date.now();
  session.turns.push({
    role: "learner",
    kind: "answer",
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: answer,
    burdenSignal,
    interactionPreference: session.interactionPreference,
    timestamp: answerTimestamp
  });

  appendEvidence(session.ledger, concept.id, {
    answer,
    signal: tutorMove.signal,
    explanation: tutorMove.visibleReply,
    sourceAligned: true
  });

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
      takeaway: tutorMove.takeaway
    });
  }

  const shouldCompleteConcept =
    tutorMove.completeCurrentUnit ||
    tutorMove.judge.state === "solid" ||
    tutorMove.judge.state === "不可判" ||
    tutorMove.moveType === "advance" ||
    tutorMove.moveType === "abstain";

  if (shouldCompleteConcept) {
    session.conceptStates[concept.id].completed = true;
  }

  const nextUnit = chooseNextUnit(session);
  const nextConcept = nextUnit.concept;
  const switchedConcept = nextConcept.id !== concept.id;
  session.currentConceptId = nextConcept.id;
  session.currentProbe = switchedConcept
    ? (
        nextUnit.revisit
          ? `我们回到刚才先放下的这个点：${nextConcept.title}。先用你自己的话把这一轮最关键的结论说出来。`
          : createInitialProbe(nextConcept)
      )
    : (tutorMove.requiresResponse ? tutorMove.nextQuestion : "");
  session.turns.push({
    role: "tutor",
    kind: "feedback",
    action: tutorMove.moveType,
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: tutorMove.visibleReply,
    gap: tutorMove.remainingGap,
    evidenceReference: tutorMove.evidenceReference,
    coachingStep: tutorMove.nextQuestion,
    strength: tutorMove.confirmedUnderstanding,
    takeaway: tutorMove.takeaway,
    teachingChunk: tutorMove.teachingChunk,
    revisitReason: tutorMove.revisitReason,
    timestamp: Date.now()
  });
  if (session.currentProbe) {
    session.turns.push({
      role: "tutor",
      kind: "question",
      action: switchedConcept ? "probe" : tutorMove.moveType,
      conceptId: session.currentConceptId,
      conceptTitle: nextConcept.title,
      content: session.currentProbe,
      revisitReason: nextUnit.revisitReason || "",
      timestamp: Date.now()
    });
  }

  const masteryMap = buildMasteryMap(session);
  const nextSteps = buildNextSteps(session.concepts, session.conceptStates);

  return {
    ...session,
    masteryMap,
    nextSteps,
    latestFeedback: {
      conceptId: concept.id,
      conceptTitle: concept.title,
      signal: tutorMove.signal,
      action: tutorMove.moveType,
      explanation: tutorMove.visibleReply,
      gap: tutorMove.remainingGap,
      evidenceReference: tutorMove.evidenceReference,
      coachingStep: tutorMove.nextQuestion,
      strength: tutorMove.confirmedUnderstanding,
      takeaway: tutorMove.takeaway,
      teachingChunk: tutorMove.teachingChunk,
      revisitReason: tutorMove.revisitReason,
      judge: tutorMove.judge
    }
  };
}

function applyControlIntent(session, { concept, controlIntent, answer, burdenSignal }) {
  const now = Date.now();
  const priorTeachRequests = session.engagement.teachRequestCount;
  session.engagement.controlCount += 1;
  session.engagement.consecutiveControlCount += 1;
  session.engagement.lastControlIntent = controlIntent;
  if (controlIntent === "advance") {
    session.engagement.skipCount += 1;
  } else if (controlIntent === "teach") {
    session.engagement.teachRequestCount += 1;
  } else if (controlIntent === "summarize") {
    session.engagement.summarizeCount += 1;
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

  if (controlIntent === "teach") {
    const repeatedTeach = priorTeachRequests >= 1;
    explanation = repeatedTeach
      ? `这个点我先不给你继续展开了，你先记住一句最关键的话：${concept.summary}`
      : `好，我先不让你继续猜了。你先带走这一层就够：${concept.summary}`;
    teachingChunk = concept.summary || concept.excerpt;
    coachingStep = repeatedTeach ? "" : concept.checkQuestion || "";
    session.conceptStates[concept.id].teachCount += 1;
    session.conceptStates[concept.id].lastAction = repeatedTeach ? "summarize" : "teach";
    enqueueRevisit(session, {
      concept,
      reason: repeatedTeach ? "teach-repeated-so-deferred" : "teach-requested",
      takeaway: concept.summary
    });
    if (repeatedTeach) {
      session.conceptStates[concept.id].completed = true;
      const nextUnit = chooseNextUnit(session);
      const nextConcept = nextUnit.concept;
      session.currentConceptId = nextConcept.id;
      session.currentProbe = nextUnit.revisit
        ? `我们回到刚才先放下的这个点：${nextConcept.title}。先用你自己的话把这一轮最关键的结论说出来。`
        : createInitialProbe(nextConcept);
    } else {
      session.currentProbe = coachingStep;
    }
  } else if (controlIntent === "summarize") {
    explanation = `我先把这个点收一下：${concept.summary}`;
    teachingChunk = concept.summary || concept.excerpt;
    coachingStep = "";
    session.conceptStates[concept.id].completed = true;
    session.conceptStates[concept.id].lastAction = "summarize";
    enqueueRevisit(session, {
      concept,
      reason: "summarized-for-later",
      takeaway: concept.summary
    });
  } else {
    explanation = `好，这个点先不继续卡住你了，我们直接进下一题。`;
    session.conceptStates[concept.id].completed = true;
    session.conceptStates[concept.id].lastAction = "advance";
    enqueueRevisit(session, {
      concept,
      reason: "skipped-by-user",
      takeaway: concept.summary
    });
  }

  if (controlIntent !== "teach") {
    const nextUnit = chooseNextUnit(session);
    const nextConcept = nextUnit.concept;
    session.currentConceptId = nextConcept.id;
    session.currentProbe = nextUnit.revisit
      ? `我们回到刚才先放下的这个点：${nextConcept.title}。先用你自己的话把这一轮最关键的结论说出来。`
      : createInitialProbe(nextConcept);
  }

  session.turns.push({
    role: "tutor",
    kind: "feedback",
    action: controlIntent,
    conceptId: concept.id,
    conceptTitle: concept.title,
    content: explanation,
    teachingChunk,
    takeaway: concept.summary,
    coachingStep,
    timestamp: Date.now()
  });

  if (session.currentProbe) {
    const currentConcept = session.concepts.find((item) => item.id === session.currentConceptId);
    session.turns.push({
      role: "tutor",
      kind: "question",
      action: controlIntent === "teach" && coachingStep ? "check" : "probe",
      conceptId: currentConcept.id,
      conceptTitle: currentConcept.title,
      content: session.currentProbe,
      timestamp: Date.now()
    });
  }

  const masteryMap = buildMasteryMap(session);
  const nextSteps = buildNextSteps(session.concepts, session.conceptStates);

  return {
    ...session,
    masteryMap,
    nextSteps,
    latestFeedback: {
      conceptId: concept.id,
      conceptTitle: concept.title,
      signal: "noise",
      action: controlIntent,
      explanation,
      gap: "",
      evidenceReference: concept.excerpt,
      coachingStep,
      strength: "",
      takeaway: concept.summary,
      teachingChunk,
      judge: session.conceptStates[concept.id].judge
    }
  };
}
