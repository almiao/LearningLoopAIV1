import { createBaselinePackDecomposition, getBaselinePackById } from "../baseline/baseline-packs.js";

const progressScore = {
  "不可判": 0,
  weak: 28,
  partial: 66,
  solid: 94
};

function scoreState(state = "不可判", evidenceCount = 0) {
  if (evidenceCount <= 0) {
    return 0;
  }
  return progressScore[state] ?? progressScore.weak;
}

function average(values = []) {
  if (!values.length) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function buildTargetLabel(percentage) {
  if (percentage >= 80) {
    return "接近完成";
  }
  if (percentage >= 55) {
    return "持续推进中";
  }
  if (percentage > 0) {
    return "刚刚起步";
  }
  return "尚未建立证据";
}

function buildAbilityItemView(concept, memoryItem = null) {
  const evidenceCount = memoryItem?.evidenceCount || 0;
  const state = memoryItem?.state || "不可判";
  return {
    abilityItemId: concept.id,
    title: concept.title,
    state,
    confidenceLevel: memoryItem?.confidenceLevel || "low",
    confidence: memoryItem?.confidence || 0,
    evidenceCount,
    progressPercentage: scoreState(state, evidenceCount),
    lastUpdatedAt: memoryItem?.lastUpdatedAt || "",
    provenanceLabel: concept.provenanceLabel || "",
    derivedPrinciple: memoryItem?.derivedPrinciple || ""
  };
}

function buildTargetView(targetRecord, memoryProfile) {
  const pack = getBaselinePackById(targetRecord.targetBaselineId);
  const decomposition = createBaselinePackDecomposition(pack);
  const itemViews = decomposition.concepts.map((concept) =>
    buildAbilityItemView(concept, memoryProfile?.abilityItems?.[concept.id] || null)
  );
  const domainMap = new Map();

  for (const item of itemViews) {
    const concept = decomposition.concepts.find((entry) => entry.id === item.abilityItemId);
    const domainId = concept?.abilityDomainId || concept?.domainId || "general";
    const domainTitle = concept?.abilityDomainTitle || concept?.domainTitle || "通用能力";
    if (!domainMap.has(domainId)) {
      domainMap.set(domainId, {
        id: domainId,
        title: domainTitle,
        items: []
      });
    }
    domainMap.get(domainId).items.push(item);
  }

  const domains = [...domainMap.values()].map((domain) => ({
    ...domain,
    progressPercentage: average(domain.items.map((item) => item.progressPercentage)),
    assessedItemCount: domain.items.filter((item) => item.evidenceCount > 0).length,
    totalItemCount: domain.items.length
  }));

  const completionPercentage = average(itemViews.map((item) => item.progressPercentage));
  return {
    targetBaselineId: targetRecord.targetBaselineId,
    title: targetRecord.title || pack.title,
    targetRole: targetRecord.targetRole || pack.targetRole,
    createdAt: targetRecord.createdAt || "",
    lastActivityAt: targetRecord.lastActivityAt || "",
    sessionsStarted: targetRecord.sessionsStarted || 0,
    completionPercentage,
    completionLabel: buildTargetLabel(completionPercentage),
    assessedItemCount: itemViews.filter((item) => item.evidenceCount > 0).length,
    totalItemCount: itemViews.length,
    domains
  };
}

export function buildUserProfileView({ user, memoryProfile }) {
  const targets = Object.values(user.targets || {})
    .map((target) => buildTargetView(target, memoryProfile))
    .sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")));

  const memoryItems = Object.values(memoryProfile?.abilityItems || {});
  return {
    user: {
      id: user.id,
      handle: user.handle,
      memoryProfileId: user.memoryProfileId,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      lastActiveAt: user.lastActiveAt
    },
    summary: {
      totalTargets: targets.length,
      sessionsStarted: memoryProfile?.sessionsStarted || 0,
      assessedAbilityItems: memoryItems.filter((item) => (item.evidenceCount || 0) > 0).length,
      solidItems: memoryItems.filter((item) => item.state === "solid").length,
      partialItems: memoryItems.filter((item) => item.state === "partial").length,
      weakItems: memoryItems.filter((item) => item.state === "weak").length
    },
    targets
  };
}
