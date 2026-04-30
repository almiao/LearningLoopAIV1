function normalizeSources(sources = []) {
  return (sources || []).map((source) => (
    typeof source === "string"
      ? { path: source, title: "" }
      : {
          path: source.path || "",
          title: source.title || "",
        }
  ));
}

function buildLegacyCheckpoints(concept = {}) {
  const discriminators = (concept.discriminators || []).filter(Boolean);
  const commonMistakes = (concept.misconceptionAnchors || []).filter(Boolean);
  if (discriminators.length) {
    return discriminators.map((statement, index) => ({
      id: `${concept.id}-cp-${index + 1}`,
      statement,
      successCriteria: statement,
      evidenceSnippets: [concept.evidenceSnippet || concept.summary || ""].filter(Boolean),
      commonMistakes,
      maxTurns: concept.maxTurns || 3,
      order: index + 1,
      diagnosticQuestion: index === 0 ? (concept.diagnosticQuestion || "") : "",
      checkQuestion: index === 0 ? (concept.checkQuestion || concept.retryQuestion || "") : "",
    }));
  }

  return [{
    id: `${concept.id}-cp-1`,
    statement: concept.summary || concept.title || "核心检查项",
    successCriteria: concept.summary || concept.title || "说明当前训练点的核心作用",
    evidenceSnippets: [concept.evidenceSnippet || concept.summary || ""].filter(Boolean),
    commonMistakes,
    maxTurns: concept.maxTurns || 3,
    order: 1,
    diagnosticQuestion: concept.diagnosticQuestion || "",
    checkQuestion: concept.checkQuestion || concept.retryQuestion || "",
  }];
}

export function buildTrainingPointsFromDecomposition(decomposition = {}) {
  if (Array.isArray(decomposition.trainingPoints) && decomposition.trainingPoints.length) {
    return decomposition.trainingPoints.map((point, pointIndex) => ({
      id: point.id,
      title: point.title,
      summary: point.summary || point.title || "",
      importance: point.importance || "secondary",
      abilityDomainId: point.abilityDomainId || point.domainId || "general",
      abilityDomainTitle: point.abilityDomainTitle || point.domainTitle || "通用能力",
      javaGuideSources: normalizeSources(point.javaGuideSources),
      remediationMaterials: point.remediationMaterials || [],
      remediationHint: point.remediationHint || "",
      order: point.order || pointIndex + 1,
      checkpoints: (point.checkpoints || []).map((checkpoint, checkpointIndex) => ({
        id: checkpoint.id,
        statement: checkpoint.statement || `Checkpoint ${checkpointIndex + 1}`,
        successCriteria: checkpoint.successCriteria || checkpoint.statement || "",
        evidenceSnippets: (checkpoint.evidenceSnippets || []).filter(Boolean),
        commonMistakes: (checkpoint.commonMistakes || []).filter(Boolean),
        maxTurns: checkpoint.maxTurns || 3,
        order: checkpoint.order || checkpointIndex + 1,
        diagnosticQuestion: checkpoint.diagnosticQuestion || "",
        checkQuestion: checkpoint.checkQuestion || "",
      })),
    }));
  }

  return (decomposition.concepts || []).map((concept, index) => ({
    id: concept.id,
    title: concept.title,
    summary: concept.summary || concept.title || "",
    importance: concept.importance || "secondary",
    abilityDomainId: concept.abilityDomainId || concept.domainId || "general",
    abilityDomainTitle: concept.abilityDomainTitle || concept.domainTitle || "通用能力",
    javaGuideSources: normalizeSources(concept.javaGuideSources),
    remediationMaterials: concept.remediationMaterials || [],
    remediationHint: concept.remediationHint || "",
    order: concept.order || index + 1,
    checkpoints: buildLegacyCheckpoints(concept),
  }));
}
