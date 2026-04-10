import { confidenceLevelToScore } from "./turn-envelope.js";

const stateRank = {
  "不可判": 0,
  weak: 1,
  partial: 2,
  solid: 3
};

function rank(state) {
  return stateRank[state] ?? stateRank.weak;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function shouldAdmitSuggestion({ suggestion, evidencePoint, previous }) {
  if (!suggestion?.should_write || suggestion.mode === "noop") {
    return false;
  }

  if (!evidencePoint?.answer || !String(evidencePoint.answer).trim()) {
    return false;
  }

  if (!Array.isArray(evidencePoint.sourceRefs) || evidencePoint.sourceRefs.length === 0) {
    return false;
  }

  if (suggestion.reason === "low_value_repeat") {
    return false;
  }

  if (previous?.lastAssessmentHandle && previous.lastAssessmentHandle === evidencePoint.assessmentHandle) {
    return false;
  }

  return true;
}

function buildSnapshot({ evidencePoint, explanation, suggestion, timestamp, runtimeMap }) {
  return {
    signal: runtimeMap?.turn_signal || "noise",
    answer: evidencePoint.answer,
    prompt: evidencePoint.prompt,
    explanation,
    whyJudgedThisWay: evidencePoint.whyJudgedThisWay || "",
    evidenceReference: evidencePoint.evidenceReference || "",
    sourceRefs: evidencePoint.sourceRefs || [],
    assessmentHandle: evidencePoint.assessmentHandle || "",
    writeReason: suggestion.reason,
    at: new Date(timestamp).toISOString()
  };
}

export function applyWritebackSuggestion(memoryProfile, {
  concept,
  suggestion,
  evidencePoint,
  explanation,
  runtimeMap,
  projectedTargets = [],
  timestamp = Date.now()
}) {
  if (!memoryProfile || !concept || !suggestion) {
    return { applied: false, reason: "missing_inputs" };
  }

  const previous = memoryProfile.abilityItems[concept.id];
  if (!shouldAdmitSuggestion({ suggestion, evidencePoint, previous })) {
    return { applied: false, reason: "admission_rejected" };
  }

  const snapshot = buildSnapshot({
    evidencePoint,
    explanation,
    suggestion,
    timestamp,
    runtimeMap
  });
  const nextState = suggestion.anchor_patch?.state || runtimeMap?.anchor_assessment?.state || previous?.state || "不可判";
  const nextConfidenceLevel =
    suggestion.anchor_patch?.confidence_level ||
    runtimeMap?.anchor_assessment?.confidence_level ||
    previous?.confidenceLevel ||
    "low";
  const baseRecord = {
    abilityItemId: concept.id,
    title: concept.title,
    abilityDomainId: concept.abilityDomainId || concept.domainId || "general",
    abilityDomainTitle: concept.abilityDomainTitle || concept.domainTitle || "通用能力",
    state: nextState,
    confidence: confidenceLevelToScore(nextConfidenceLevel),
    confidenceLevel: nextConfidenceLevel,
    reasons:
      runtimeMap?.anchor_assessment?.reasons?.length
        ? runtimeMap.anchor_assessment.reasons
        : previous?.reasons || [],
    derivedPrinciple:
      suggestion.anchor_patch?.derived_principle ||
      suggestion.anchor_patch?.derivedPrinciple ||
      previous?.derivedPrinciple ||
      concept.summary,
    evidenceCount: (previous?.evidenceCount || 0) + 1,
    evidence: [...(previous?.evidence || []).slice(-3), snapshot],
    recentStrongEvidence:
      runtimeMap?.turn_signal === "positive" || nextState === "solid"
        ? [...(previous?.recentStrongEvidence || []).slice(-2), snapshot]
        : previous?.recentStrongEvidence || [],
    recentConflictingEvidence: [...(previous?.recentConflictingEvidence || []).slice(-2)],
    conflictingEvidence: [...(previous?.conflictingEvidence || [])],
    lastUpdatedAt: snapshot.at,
    lastAssessmentHandle: evidencePoint.assessmentHandle || "",
    remediationMaterials: concept.remediationMaterials || [],
    questionFamily: concept.questionFamily || "",
    provenanceLabel: concept.provenanceLabel || "",
    sourceFamilies: clonePlain(concept.javaGuideSources || []),
    projectedTargets: [...new Set([...(previous?.projectedTargets || []), ...projectedTargets])].slice(0, 6)
  };

  if (
    previous &&
    rank(nextState) < rank(previous.state || "weak") &&
    (suggestion.mode === "append_conflict" || runtimeMap?.turn_signal === "negative")
  ) {
    baseRecord.recentConflictingEvidence = [
      ...(previous?.recentConflictingEvidence || []).slice(-2),
      snapshot
    ];
    baseRecord.conflictingEvidence = [
      ...(previous?.conflictingEvidence || []).slice(-2),
      snapshot
    ];
  }

  memoryProfile.abilityItems[concept.id] = baseRecord;

  return {
    applied: true,
    reason: suggestion.reason,
    state: nextState,
    confidenceLevel: nextConfidenceLevel
  };
}
