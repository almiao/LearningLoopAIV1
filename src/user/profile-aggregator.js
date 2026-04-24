import { createBaselinePackDecomposition, getBaselinePackById } from "../baseline/baseline-packs.js";
import { getJavaGuideDocumentOrder } from "../knowledge/java-guide-order.js";
import { buildReadingDomainsForTarget } from "./reading-roadmap.js";

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

function stateLabel(state = "") {
  if (state === "solid") {
    return "已掌握";
  }
  if (state === "partial") {
    return "持续推进";
  }
  if (state === "weak") {
    return "待补强";
  }
  return "";
}

function summarizeState(item = {}) {
  if ((item.evidenceCount || 0) <= 0) {
    return "";
  }
  if (item.state === "solid" || item.state === "partial" || item.state === "weak") {
    return item.state;
  }
  return "partial";
}

function normalizeGuideSources(sources = []) {
  return (sources || []).map((source) => (
    typeof source === "string"
      ? { path: source, title: "" }
      : {
          path: source.path || "",
          title: source.title || "",
        }
  ));
}

function getConceptOrder(concept, fallbackOrder = Number.MAX_SAFE_INTEGER) {
  const orders = normalizeGuideSources(concept.javaGuideSources)
    .map((source) => getJavaGuideDocumentOrder(source.path))
    .filter((value) => Number.isFinite(value) && value < Number.MAX_SAFE_INTEGER);
  return orders.length ? Math.min(...orders) : fallbackOrder;
}

function buildAbilityItemView(concept, memoryItem = null) {
  const evidenceCount = memoryItem?.evidenceCount || 0;
  const state = memoryItem?.state || "不可判";
  const sources = normalizeGuideSources(concept.javaGuideSources);
  const primarySource = sources[0] || null;
  return {
    abilityItemId: concept.id,
    title: concept.title,
    state,
    confidenceLevel: memoryItem?.confidenceLevel || "low",
    confidence: memoryItem?.confidence || 0,
    evidenceCount,
    progressPercentage: scoreState(state, evidenceCount),
    lastUpdatedAt: memoryItem?.lastUpdatedAt || "",
    questionStatusLabel: evidenceCount > 0 ? stateLabel(state) : "",
    provenanceLabel: concept.provenanceLabel || "",
    derivedPrinciple: memoryItem?.derivedPrinciple || "",
    primaryDocPath: primarySource?.path || "",
    primaryDocTitle: primarySource?.title || "",
    javaGuideSources: sources,
    sourceOrder: getConceptOrder(concept, concept.order || 0),
  };
}

function buildTargetView(targetRecord, memoryProfile) {
  const pack = getBaselinePackById(targetRecord.targetBaselineId);
  const decomposition = createBaselinePackDecomposition(pack);
  const readingProgress = targetRecord.readingProgress || {};
  const readingDomains = buildReadingDomainsForTarget(targetRecord.targetBaselineId).map((domain) => {
    const domainProgress = readingProgress.domains?.[domain.id] || {};
    const visitedDocPaths = new Set(domainProgress.visitedDocPaths || []);
    const docs = (domain.docs || []).map((doc) => ({
      ...doc,
      started:
        visitedDocPaths.has(doc.path) ||
        readingProgress.currentDocPath === doc.path ||
        domainProgress.currentDocPath === doc.path,
    }));
    const currentDoc =
      docs.find((doc) => doc.path === domainProgress.currentDocPath) ||
      docs.find((doc) => doc.path === readingProgress.currentDocPath) ||
      docs.find((doc) => !doc.started) ||
      docs[0] ||
      null;
    const currentIndex = currentDoc ? docs.findIndex((doc) => doc.path === currentDoc.path) : 0;
    const startedCount = docs.filter((doc) => doc.started).length;
    return {
      id: domain.id,
      title: domain.title,
      progressPercentage: docs.length ? Math.round((startedCount / docs.length) * 100) : 0,
      currentDocPath: currentDoc?.path || "",
      currentDocTitle: domainProgress.currentDocTitle || currentDoc?.title || "",
      previewDocs: docs.slice(Math.max(0, currentIndex), Math.max(0, currentIndex) + 3),
      docs,
      totalDocCount: docs.length,
      startedDocCount: startedCount,
    };
  });
  const itemViews = decomposition.concepts.map((concept, index) =>
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

  const domains = [...domainMap.values()].map((domain) => {
    const domainProgress = readingProgress.domains?.[domain.id] || {};
    const visitedConceptIds = new Set(domainProgress.visitedConceptIds || []);
    const visitedDocPaths = new Set(domainProgress.visitedDocPaths || []);
    const orderedItems = [...domain.items]
      .map((item, index) => ({
        ...item,
        displayOrder: Number.isFinite(item.sourceOrder) ? item.sourceOrder : index,
        started:
          item.evidenceCount > 0 ||
          visitedConceptIds.has(item.abilityItemId) ||
          (item.primaryDocPath ? visitedDocPaths.has(item.primaryDocPath) : false),
      }))
      .sort((left, right) => {
        if (left.displayOrder !== right.displayOrder) {
          return left.displayOrder - right.displayOrder;
        }
        return left.title.localeCompare(right.title);
      });

    const currentItem =
      orderedItems.find((item) => item.abilityItemId === domainProgress.currentConceptId) ||
      orderedItems.find((item) => !item.started) ||
      orderedItems[0] ||
      null;
    const currentIndex = currentItem
      ? Math.max(0, orderedItems.findIndex((item) => item.abilityItemId === currentItem.abilityItemId))
      : 0;
    const latestItem =
      orderedItems.find((item) => item.abilityItemId === domainProgress.currentConceptId) ||
      [...orderedItems]
        .filter((item) => item.started)
        .sort((left, right) => String(right.lastUpdatedAt || "").localeCompare(String(left.lastUpdatedAt || "")))[0] ||
      currentItem;

    return {
      ...domain,
      items: orderedItems,
      progressPercentage: average(orderedItems.map((item) => item.progressPercentage)),
      assessedItemCount: orderedItems.filter((item) => item.evidenceCount > 0).length,
      totalItemCount: orderedItems.length,
      currentAbilityItemId: currentItem?.abilityItemId || "",
      currentDocPath: domainProgress.currentDocPath || currentItem?.primaryDocPath || "",
      currentDocTitle: domainProgress.currentDocTitle || currentItem?.primaryDocTitle || "",
      latestTitle: latestItem?.title || "",
      previewItems: orderedItems.slice(currentIndex, currentIndex + 3).map((item) => ({
        abilityItemId: item.abilityItemId,
        title: item.title,
        questionStatusLabel: item.questionStatusLabel,
        started: item.started,
      })),
      lastVisitedAt: domainProgress.lastUpdatedAt || latestItem?.lastUpdatedAt || "",
    };
  });

  const currentDomain =
    readingDomains.find((domain) => domain.id === readingProgress.currentDomainId) ||
    readingDomains.find((domain) => (domain.previewDocs || []).some((doc) => !doc.started)) ||
    readingDomains[0] ||
    null;

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
    currentDomainId: currentDomain?.id || "",
    currentAbilityItemId: "",
    currentDocPath: readingProgress.currentDocPath || currentDomain?.currentDocPath || "",
    currentDocTitle: readingProgress.currentDocTitle || currentDomain?.currentDocTitle || "",
    readingProgress,
    domains,
    readingDomains,
  };
}

export function buildUserProfileView({ user, memoryProfile }) {
  const targets = Object.values(user.targets || {})
    .map((target) => buildTargetView(target, memoryProfile))
    .sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")));

  const memoryItems = Object.values(memoryProfile?.abilityItems || {});
  const summarizedStates = memoryItems
    .map((item) => summarizeState(item))
    .filter(Boolean);
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
      solidItems: summarizedStates.filter((state) => state === "solid").length,
      partialItems: summarizedStates.filter((state) => state === "partial").length,
      weakItems: summarizedStates.filter((state) => state === "weak").length
    },
    targets
  };
}
