import { normalizeWhitespace } from "../material/material-model.js";

const defaultLayerBudgets = {
  stable: 1800,
  dynamic: 3200,
  reference: 2200
};

function trimText(value, maxChars) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function pickRecentTurns(turns = [], maxTurns = 6, maxChars = 240) {
  return turns
    .filter((turn) => turn.role !== "system")
    .slice(-maxTurns)
    .map((turn) => ({
      role: turn.role,
      kind: turn.kind || "",
      action: turn.action || "",
      conceptId: turn.conceptId || "",
      content: trimText(turn.content, maxChars)
    }));
}

function pickRecentEvidence(entries = [], maxEntries = 4, maxChars = 180) {
  return entries.slice(-maxEntries).map((entry, index) => ({
    id: entry.id || `ev-${index + 1}`,
    signal: entry.signal || "noise",
    answer: trimText(entry.answer, maxChars),
    explanation: trimText(entry.explanation, maxChars),
    evidenceReference: trimText(entry.evidenceReference, maxChars),
    timestamp: entry.timestamp || entry.at || ""
  }));
}

function pickRecentAnchorTurns(turns = [], conceptId = "", maxTurns = 4, maxChars = 220) {
  return turns
    .filter((turn) => turn.role !== "system" && turn.conceptId === conceptId)
    .slice(-maxTurns)
    .map((turn) => ({
      role: turn.role,
      kind: turn.kind || "",
      action: turn.action || "",
      content: trimText(turn.content, maxChars),
      takeaway: trimText(turn.takeaway, 140)
    }));
}

function buildSourceReferences(concept, maxSources = 4) {
  const references = [];

  if (concept.provenanceLabel || concept.interviewQuestion?.label) {
    references.push({
      kind: "provenance",
      title: concept.provenanceLabel || concept.interviewQuestion?.label || concept.title,
      snippet: trimText(
        concept.interviewQuestion?.prompt ||
          concept.interviewQuestion?.label ||
          concept.provenanceLabel ||
          concept.summary,
        220
      ),
      url: ""
    });
  }

  for (const source of concept.javaGuideSources || []) {
    references.push({
      kind: "knowledge",
      title: trimText(source.title, 80),
      snippet: trimText(source.path || source.url || source.title, 220),
      url: source.url || ""
    });
  }

  for (const material of concept.remediationMaterials || []) {
    references.push({
      kind: "remediation",
      title: trimText(material.title, 80),
      snippet: trimText(material.description || material.summary || material.title, 220),
      url: material.url || ""
    });
  }

  return references.slice(0, maxSources);
}

function describeScope(session, concept) {
  const scope = session.workspaceScope || { type: "pack", id: session.targetBaseline?.id || session.source.kind };
  return {
    type: scope.type,
    id: scope.id,
    currentConceptId: concept.id
  };
}

export function buildAnchorIdentity(concept) {
  return {
    canonicalId: concept.id,
    stableDescription: concept.summary,
    inclusionBoundary: trimText(concept.anchorIdentity?.inclusionBoundary || concept.summary, 220),
    exclusionBoundary: trimText(
      concept.anchorIdentity?.exclusionBoundary ||
        concept.misconception ||
        `不要把“${concept.title}”泛化成整个能力域。`,
      220
    ),
    allowedEvidenceTypes: concept.anchorIdentity?.allowedEvidenceTypes || [
      "diagnostic-answer",
      "teach-back",
      "migration-answer",
      "contradiction"
    ],
    typicalMisunderstandingFamilies:
      concept.anchorIdentity?.typicalMisunderstandingFamilies ||
      (concept.misconception ? [concept.misconception] : []),
    sourceFamilies: concept.anchorIdentity?.sourceFamilies || [
      "knowledge",
      "provenance",
      "interaction"
    ]
  };
}

function createRawEvidencePoint({ session, concept, answer, sourceRefs }) {
  const attempt = (session.conceptStates?.[concept.id]?.attempts || 0) + 1;

  return {
    id: `ev-${concept.id}-${attempt}`,
    anchorId: concept.id,
    type: "learner_answer",
    prompt: trimText(session.currentProbe, 220),
    answer: trimText(answer, 320),
    sourceRefs: sourceRefs.map((source) => source.title || source.id || source.url).filter(Boolean),
    timestamp: Date.now()
  };
}

export function buildContextPacket({
  session,
  concept,
  answer,
  burdenSignal = "normal",
  priorEvidence = [],
  rawEvidencePoint = null
}) {
  const sourceRefs = buildSourceReferences(concept);
  const effectiveRawEvidencePoint =
    rawEvidencePoint ||
    createRawEvidencePoint({
      session,
      concept,
      answer,
      sourceRefs
    });
  const anchorTurns = pickRecentAnchorTurns(session.turns, concept.id);
  const stable = {
    target: {
      id: session.targetBaseline?.id || session.source.kind,
      title: session.targetBaseline?.title || session.source.title,
      mode: session.mode
    },
    scope: describeScope(session, concept),
    anchorIdentity: buildAnchorIdentity(concept),
    memoryAnchor: session.memoryProfile?.abilityItems?.[concept.id] || null
  };

  const dynamic = {
    currentQuestion: trimText(session.currentProbe, 220),
    learnerAnswer: trimText(answer, 320),
    burdenSignal,
    interactionPreference: session.interactionPreference,
    engagement: {
      ...session.engagement
    },
    previousRuntimeMap: session.runtimeMaps?.[concept.id] || null,
    recentTurns: pickRecentTurns(session.turns),
    anchorHistory: {
      recentTurns: anchorTurns,
      teachCount: session.conceptStates?.[concept.id]?.teachCount || 0,
      hasRecentTeaching: anchorTurns.some(
        (turn) => turn.role === "tutor" && (turn.action === "teach" || turn.kind === "feedback")
      ),
      recentTakeaways: anchorTurns
        .map((turn) => turn.takeaway)
        .filter(Boolean)
        .slice(-2)
    },
    recentEvidence: pickRecentEvidence(priorEvidence),
    rawEvidencePoint: effectiveRawEvidencePoint
  };

  const reference = {
    sources: sourceRefs,
    sourceSummary: {
      title: session.source.title,
      framing: trimText(session.summary?.framing, 220)
    }
  };

  const hasReferenceContent = reference.sources.length > 0;
  const effectiveBudgets = {
    ...defaultLayerBudgets,
    dynamic: hasReferenceContent
      ? defaultLayerBudgets.dynamic
      : defaultLayerBudgets.dynamic + defaultLayerBudgets.reference,
    reference: hasReferenceContent ? defaultLayerBudgets.reference : 0
  };

  const frictionSignals = {
    burden_signal: burdenSignal,
    answer_length: trimText(answer, 320).length,
    answer_is_blank: !trimText(answer, 320),
    teach_request_count: session.engagement?.teachRequestCount || 0,
    skip_count: session.engagement?.skipCount || 0,
    repeated_control_count: session.engagement?.consecutiveControlCount || 0,
    fatigue_level:
      burdenSignal === "high"
        ? "high"
        : (session.engagement?.consecutiveControlCount || 0) >= 2
          ? "medium"
          : "low"
  };

  const stopConditions = {
    probe_budget_reached:
      (session.conceptStates?.[concept.id]?.attempts || 0) >=
      ((concept.importance || "secondary") === "core" ? 3 : 2),
    teach_budget_reached: (session.conceptStates?.[concept.id]?.teachCount || 0) >= 2,
    friction_high: burdenSignal === "high",
    recent_info_gain_level: dynamic.previousRuntimeMap?.info_gain_level || "medium",
    should_discourage_more_probe:
      burdenSignal === "high" ||
      ((session.conceptStates?.[concept.id]?.attempts || 0) >=
        ((concept.importance || "secondary") === "core" ? 3 : 2)) ||
      dynamic.previousRuntimeMap?.info_gain_level === "negligible"
  };

  const budget = {
    max_probe_turns: (concept.importance || "secondary") === "core" ? 3 : 2,
    probe_turns_used: session.conceptStates?.[concept.id]?.attempts || 0,
    remaining_probe_turns: Math.max(
      0,
      ((concept.importance || "secondary") === "core" ? 3 : 2) -
        (session.conceptStates?.[concept.id]?.attempts || 0)
    ),
    max_teach_turns: 2,
    teach_turns_used: session.conceptStates?.[concept.id]?.teachCount || 0,
    remaining_teach_turns: Math.max(0, 2 - (session.conceptStates?.[concept.id]?.teachCount || 0))
  };

  return {
    stable,
    dynamic,
    reference,
    budgets: effectiveBudgets,
    topic_context: {
      concept_id: concept.id,
      concept_title: concept.title,
      current_probe: trimText(session.currentProbe, 220),
      question_meta: session.currentQuestionMeta || null,
      scope: {
        type: stable.scope.type,
        id: stable.scope.id,
        title: concept.abilityDomainTitle || concept.domainTitle || concept.title
      },
      target: stable.target
    },
    interaction_context: {
      explicit_intent: "",
      burden_signal: burdenSignal,
      interaction_preference: session.interactionPreference,
      engagement: {
        answer_count: session.engagement?.answerCount || 0,
        teach_request_count: session.engagement?.teachRequestCount || 0,
        skip_count: session.engagement?.skipCount || 0,
        repeated_control_count: session.engagement?.consecutiveControlCount || 0
      },
      friction: frictionSignals,
      should_slow_down: stopConditions.should_discourage_more_probe
    },
    teaching_context: {
      working_diagnosis: dynamic.previousRuntimeMap || null,
      anchor_history: dynamic.anchorHistory,
      anchor_summary: {
        confirmed_understanding: dynamic.anchorHistory.recentTakeaways.at(-1) || "",
        current_gap: (dynamic.previousRuntimeMap?.open_questions || [])[0] || "",
        last_teaching_point: dynamic.anchorHistory.recentTakeaways.at(-1) || "",
        last_updated_at_turn: session.turns?.length || 0
      },
      recent_evidence: dynamic.recentEvidence,
      memory_anchor_summary: stable.memoryAnchor || null
    },
    orchestration_context: {
      budget,
      stop_conditions: stopConditions,
      latest_control_verdict: session.latestControlVerdict || null,
      workspace_scope: session.workspaceScope || null
    },
    target: stable.target,
    scope: {
      type: stable.scope.type,
      id: stable.scope.id,
      current_anchor_id: concept.id,
      current_domain_id: concept.abilityDomainId || concept.domainId || "general",
      current_domain_title: concept.abilityDomainTitle || concept.domainTitle || "通用能力"
    },
    anchor: {
      canonical_id: stable.anchorIdentity.canonicalId,
      title: concept.title,
      stable_description: stable.anchorIdentity.stableDescription,
      inclusion_boundary: stable.anchorIdentity.inclusionBoundary,
      exclusion_boundary: stable.anchorIdentity.exclusionBoundary,
      allowed_evidence_types: stable.anchorIdentity.allowedEvidenceTypes,
      typical_misunderstanding_families: stable.anchorIdentity.typicalMisunderstandingFamilies,
      source_families: stable.anchorIdentity.sourceFamilies
    },
    memory_anchor_summary: stable.memoryAnchor || null,
    recent_evidence: dynamic.recentEvidence,
    recent_turns: dynamic.recentTurns,
    anchor_history: dynamic.anchorHistory,
    source_refs: reference.sources.slice(0, 2),
    runtime_understanding_map: dynamic.previousRuntimeMap,
    budget,
    friction_signals: frictionSignals,
    stop_conditions: stopConditions,
    draft_evidence: effectiveRawEvidencePoint
  };
}

export function formatContextPacketForPrompt(packet) {
  return JSON.stringify(packet, null, 2);
}
