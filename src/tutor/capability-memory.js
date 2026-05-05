import {
  calculateMasteryScore,
  calculateTargetReadinessScore,
  rankState,
  buildTargetLabel,
  defaultScoreForState,
  scoreToState,
} from "../mastery/mastery-scoring.js";

function rank(state) {
  return rankState(state);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultJudge() {
  return {
    state: "不可判",
    score: 0,
    reasons: ["当前还没有足够证据，先保持保守判断"]
  };
}

function createEvent({
  type,
  abilityItemId,
  title,
  summary,
  assessmentHandle = "",
  evidenceReference = "",
  timestamp = Date.now()
}) {
  const normalized = {
    type,
    abilityItemId,
    title,
    summary,
    message: summary,
    assessmentHandle,
    evidenceReference,
    timestamp: new Date(timestamp).toISOString()
  };

  return normalized;
}

function getPreviousMemory(memoryProfile, conceptId) {
  return memoryProfile?.abilityItems?.[conceptId] || null;
}

function getEvidenceCount(ledger, conceptId) {
  return Array.isArray(ledger?.[conceptId]?.entries) ? ledger[conceptId].entries.length : 0;
}

export function createMemoryProfile(id = crypto.randomUUID()) {
  return {
    id,
    sessionsStarted: 0,
    abilityItems: {}
  };
}

export function prioritizeConcepts(concepts, memoryProfile = createMemoryProfile()) {
  return [...concepts].sort((left, right) => {
    const leftMemory = getPreviousMemory(memoryProfile, left.id);
    const rightMemory = getPreviousMemory(memoryProfile, right.id);
    const leftRank = rank(leftMemory?.state || "weak");
    const rightRank = rank(rightMemory?.state || "weak");
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const leftScore = leftMemory?.score ?? 0;
    const rightScore = rightMemory?.score ?? 0;
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }

    return (left.order || 0) - (right.order || 0);
  });
}

export function createConceptStatesFromMemory(concepts, memoryProfile = createMemoryProfile()) {
  return Object.fromEntries(
    concepts.map((concept) => {
      const remembered = getPreviousMemory(memoryProfile, concept.id);
      return [
        concept.id,
        {
          attempts: 0,
          completed: false,
          lastAction: "probe",
          teachCount: 0,
          judge: remembered
            ? {
                state: remembered.state || scoreToState(remembered.score || 0),
                score: typeof remembered.score === "number" ? remembered.score : defaultScoreForState(remembered.state),
                reasons: remembered.reasons?.length ? remembered.reasons : [`沿用上次对“${concept.title}”的记忆`]
              }
            : createDefaultJudge()
        }
      ];
    })
  );
}

export function createSessionStartMemoryEvents({
  concepts,
  memoryProfile = createMemoryProfile(),
  targetBaseline = null
}) {
  const weakItems = concepts
    .filter((concept) => rank(getPreviousMemory(memoryProfile, concept.id)?.state || "solid") <= rank("partial"))
    .slice(0, 2);

  if (!weakItems.length || !targetBaseline) {
    return [];
  }

  return [
    createEvent({
      type: "self_test_reentry_context",
      abilityItemId: weakItems[0].id,
      title: "记忆已接入",
      summary: `开始新一轮 ${targetBaseline.title} 自测：系统先带你回到 ${weakItems
        .map((item) => `“${item.title}”`)
        .join("、")} 这些还不稳的点。`
    })
  ];
}

export function buildAssessmentHandle(session, concept) {
  return `${session.targetBaseline?.id || session.source.kind}:${concept.id}:${session.conceptStates[concept.id].attempts}`;
}

export function buildVisibleMemoryEvents({
  concept,
  previousJudge,
  currentJudge,
  revisitReason = "",
  signal = "noise",
  assessmentHandle = "",
  evidenceReference = "",
  timestamp = Date.now()
}) {
  const events = [
    createEvent({
      type: "attempt_recorded",
      abilityItemId: concept.id,
      title: concept.title,
      summary: `已记录你在“${concept.title}”上的一次作答证据。`,
      assessmentHandle,
      evidenceReference,
      timestamp
    })
  ];

  const previousRank = rank(previousJudge?.state || "weak");
  const currentRank = rank(currentJudge?.state || "weak");
  const previousScore = previousJudge?.score ?? 0;
  const currentScore = currentJudge?.score ?? 0;
  const effectiveSignal =
    signal === "noise" && (currentRank > previousRank || currentScore > previousScore)
      ? "positive"
      : signal;

  if (
    effectiveSignal === "positive" &&
    previousJudge?.state !== "不可判" &&
    currentJudge?.state !== "不可判" &&
    (currentRank > previousRank || currentScore >= previousScore)
  ) {
    events.push(
      createEvent({
        type: "improvement_detected",
        abilityItemId: concept.id,
        title: concept.title,
        summary: `“${concept.title}”这轮更稳了，系统会把这次提升记进长期记忆。`,
        assessmentHandle,
        evidenceReference,
        timestamp
      })
    );
  }

  if (currentRank < previousRank || (previousRank >= rank("partial") && currentJudge?.state === "weak")) {
    events.push(
      createEvent({
        type: "contradiction_detected",
        abilityItemId: concept.id,
        title: concept.title,
        summary: `“${concept.title}”出现了和旧判断不一致的新证据，匹配度会先保守回落。`,
        assessmentHandle,
        evidenceReference,
        timestamp
      })
    );
  }

  if (effectiveSignal !== "positive" && currentRank <= rank("partial")) {
    events.push(
      createEvent({
        type: "weakness_confirmed",
        abilityItemId: concept.id,
        title: concept.title,
        summary: `系统确认“${concept.title}”目前还是弱点，后续会继续优先补这个点。`,
        assessmentHandle,
        evidenceReference,
        timestamp
      })
    );
  }

  if (revisitReason) {
    events.push(
      createEvent({
        type: "revisit_queued",
        abilityItemId: concept.id,
        title: concept.title,
        summary: `“${concept.title}”已加入后续回访队列。`,
        assessmentHandle,
        evidenceReference,
        timestamp
      })
    );
  }

  return events;
}

export function updateMemoryProfile(memoryProfile, {
  concept,
  judge,
  signal,
  answer,
  explanation,
  assessmentHandle,
  evidenceReference,
  derivedPrinciple = "",
  projectedTargets = [],
  writebackReason = "",
  timestamp = Date.now()
}) {
  if (!memoryProfile) {
    return;
  }

  const previous = getPreviousMemory(memoryProfile, concept.id);
  const snapshot = {
    signal,
    answer,
    explanation,
    evidenceReference,
    assessmentHandle,
    writebackReason,
    at: new Date(timestamp).toISOString()
  };

  const recentStrongEvidence =
    signal === "positive" || judge.state === "solid"
      ? [...(previous?.recentStrongEvidence || []).slice(-2), snapshot]
      : previous?.recentStrongEvidence || [];
  const recentConflictingEvidence =
    previous && previous.state && previous.state !== judge.state
      ? [...(previous?.recentConflictingEvidence || []).slice(-2), snapshot]
      : previous?.recentConflictingEvidence || [];

  memoryProfile.abilityItems[concept.id] = {
    abilityItemId: concept.id,
    title: concept.title,
    abilityDomainId: concept.abilityDomainId || concept.domainId || "general",
    abilityDomainTitle: concept.abilityDomainTitle || concept.domainTitle || "通用能力",
    state: judge.state,
    score: judge.score || defaultScoreForState(judge.state),
    reasons: judge.reasons,
    derivedPrinciple: derivedPrinciple || previous?.derivedPrinciple || concept.summary,
    evidenceCount: (previous?.evidenceCount || 0) + 1,
    evidence: [...(previous?.evidence || []).slice(-4), snapshot],
    recentStrongEvidence,
    recentConflictingEvidence,
    lastUpdatedAt: snapshot.at,
    lastAssessmentHandle: assessmentHandle,
    remediationMaterials: concept.remediationMaterials || [],
    questionFamily: concept.questionFamily || "",
    provenanceLabel: concept.provenanceLabel || "",
    projectedTargets: [...new Set([...(previous?.projectedTargets || []), ...projectedTargets])].slice(0, 6)
  };
}

export function buildAbilityDomains(concepts, conceptStates, ledger = {}) {
  const domains = new Map();

  for (const concept of concepts) {
    const domainId = concept.abilityDomainId || concept.domainId || "general";
    const domainTitle = concept.abilityDomainTitle || concept.domainTitle || "通用能力";
    if (!domains.has(domainId)) {
      domains.set(domainId, {
        id: domainId,
        title: domainTitle,
        items: []
      });
    }

    domains.get(domainId).items.push({
      abilityItemId: concept.id,
      title: concept.title,
      state: conceptStates[concept.id]?.judge?.state || "weak",
      score: conceptStates[concept.id]?.judge?.score || 0,
      evidenceCount: getEvidenceCount(ledger, concept.id)
    });
  }

  return [...domains.values()];
}

export function buildTargetMatch({ concepts, conceptStates, targetBaseline, ledger = {} }) {
  const conceptScores = concepts.map((concept) => ({
    title: concept.title,
    masteryScore: calculateMasteryScore({
      memoryItem: {
        state: conceptStates[concept.id]?.judge?.state || "不可判",
        score: conceptStates[concept.id]?.judge?.score || 0,
        evidenceCount: getEvidenceCount(ledger, concept.id),
      },
    }),
  }));
  const strongest = [...concepts]
    .sort((left, right) => (conceptScores.find((item) => item.title === right.title)?.masteryScore || 0) - (conceptScores.find((item) => item.title === left.title)?.masteryScore || 0))
    .slice(0, 2)
    .map((concept) => concept.title);
  const weakest = [...concepts]
    .sort((left, right) => (conceptScores.find((item) => item.title === left.title)?.masteryScore || 0) - (conceptScores.find((item) => item.title === right.title)?.masteryScore || 0))
    .slice(0, 2)
    .map((concept) => concept.title);
  const coveredCount = concepts.filter((concept) => getEvidenceCount(ledger, concept.id) > 0).length;
  const coverageRatio = coveredCount / Math.max(concepts.length, 1);
  const percentage = calculateTargetReadinessScore(conceptScores);

  return {
    percentage,
    percent: percentage,
    readinessScore: percentage,
    label: buildTargetLabel(percentage),
    targetLabel: targetBaseline?.title || targetBaseline?.targetRole || "当前目标",
    explanation:
      coverageRatio < 0.35
        ? `当前证据还比较少，这个匹配度更像方向判断。最影响当前估计的是 ${weakest.join("、")}。`
        : `当前估计主要受 ${weakest.join("、")} 影响；更稳的部分是 ${strongest.join("、")}。`,
    strongestItems: strongest,
    weakestItems: weakest
  };
}

export function buildRemediationPlan(concepts, conceptStates) {
  return concepts
    .map((concept) => ({
      concept,
      state: conceptStates[concept.id]?.judge?.state || "weak"
    }))
    .filter((item) => rank(item.state) <= rank("partial"))
    .sort((left, right) => rank(left.state) - rank(right.state))
    .slice(0, 3)
    .map(({ concept, state }, index) => ({
      order: index + 1,
      abilityItemId: concept.id,
      abilityDomainId: concept.abilityDomainId || concept.domainId || "",
      domainId: concept.abilityDomainId || concept.domainId || "",
      title: concept.title,
      state,
      recommendation:
        concept.remediationMaterials?.[0]?.summary ||
        `先补齐 ${concept.title} 的关键机制，再回来复测。`,
      relatedInterviewPrompt: concept.interviewQuestion?.label || concept.provenanceLabel || "系统生成诊断题",
      materials: (concept.remediationMaterials || []).map((material) => ({
        ...clonePlain(material),
        description: material.description || material.summary || ""
      }))
    }));
}
