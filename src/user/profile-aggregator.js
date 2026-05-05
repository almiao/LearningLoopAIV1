import { createBaselinePackDecomposition, getBaselinePackById } from "../baseline/baseline-packs.js";
import { getJavaGuideDocumentOrder } from "../knowledge/java-guide-order.js";
import {
  buildMasteryLabel,
  buildTargetLabel,
  calculateMasteryScore,
  calculateTargetReadinessScore,
  defaultScoreForState,
  average,
} from "../mastery/mastery-scoring.js";
import { buildTrainingPointsFromDecomposition } from "../training/training-model.js";
import { buildDocumentProgressView } from "./document-progress-state.js";
import { buildReadingDomainsForTarget } from "./reading-roadmap.js";

function progressLabel(progressPercentage) {
  if (progressPercentage >= 100) {
    return "已读";
  }
  if (progressPercentage >= 25) {
    return `阅读中 ${progressPercentage}%`;
  }
  if (progressPercentage > 0) {
    return "已打开";
  }
  return "未读";
}

function readDocumentProgress(readingProgress = {}, domainProgress = {}, doc = {}) {
  const stored = readingProgress.docs?.[doc.path] || {};
  const visitedDocPaths = new Set(domainProgress.visitedDocPaths || []);
  const fallbackStarted =
    visitedDocPaths.has(doc.path) ||
    readingProgress.currentDocPath === doc.path ||
    domainProgress.currentDocPath === doc.path;
  const progressPercentage = Number.isFinite(Number(stored.progressPercentage))
    ? Number(stored.progressPercentage)
    : fallbackStarted ? 10 : 0;

  return {
    progressPercentage,
    readingStatus: stored.status || (progressPercentage > 0 ? "opened" : "unread"),
    progressLabel: progressLabel(progressPercentage),
    started: progressPercentage > 0,
  };
}

function buildDocumentMasteryMap(itemViews = []) {
  const masteryMap = new Map();

  for (const item of itemViews) {
    for (const source of item.javaGuideSources || []) {
      if (!source.path) {
        continue;
      }
      if (!masteryMap.has(source.path)) {
        masteryMap.set(source.path, {
          totalConceptCount: 0,
          assessedConceptCount: 0,
          progressValues: [],
        });
      }

      const entry = masteryMap.get(source.path);
      entry.totalConceptCount += 1;
      entry.progressValues.push(item.masteryScore || 0);
      if ((item.evidenceCount || 0) > 0) {
        entry.assessedConceptCount += 1;
      }
      if (item.hasReadingProgress) {
        entry.hasReadingProgress = true;
      }
    }
  }

  return masteryMap;
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

function buildAbilityItemView(point, memoryItem = null, readingProgress = null) {
  const evidenceCount = memoryItem?.evidenceCount || 0;
  const state = memoryItem?.state || "不可判";
  const sources = normalizeGuideSources(point.javaGuideSources);
  const primarySource = sources[0] || null;
  const hasReadingProgress = Boolean(readingProgress && Number(readingProgress.progressPercentage || 0) > 0);
  const masteryScore = calculateMasteryScore({
    memoryItem,
    readingProgress,
  });
  return {
    abilityItemId: point.id,
    title: point.title,
    state,
    score: memoryItem?.score || defaultScoreForState(state),
    evidenceCount,
    progressPercentage: masteryScore,
    masteryScore,
    hasReadingProgress,
    lastUpdatedAt: memoryItem?.lastUpdatedAt || "",
    questionStatusLabel: evidenceCount > 0 ? stateLabel(state) : (hasReadingProgress ? "已阅读" : ""),
    provenanceLabel: point.provenanceLabel || "",
    derivedPrinciple: memoryItem?.derivedPrinciple || "",
    primaryDocPath: primarySource?.path || "",
    primaryDocTitle: primarySource?.title || "",
    javaGuideSources: sources,
    sourceOrder: getConceptOrder(point, point.order || 0),
  };
}

function summarizeCheckpointState(memoryItem = null) {
  if (!memoryItem || (memoryItem.evidenceCount || 0) <= 0) {
    return "不可判";
  }
  return memoryItem.state || "partial";
}

function aggregatePointMemory(point, memoryProfile) {
  const checkpointMemory = (point.checkpoints || []).map((checkpoint) => (
    memoryProfile?.abilityItems?.[checkpoint.id] || null
  ));
  const legacyPointMemory = memoryProfile?.abilityItems?.[point.id] || null;
  const evidenceCount = checkpointMemory.reduce((sum, item) => sum + (item?.evidenceCount || 0), 0) || (legacyPointMemory?.evidenceCount || 0);
  const stateValues = checkpointMemory.map((item) => summarizeCheckpointState(item));
  const derivedPrinciples = checkpointMemory.map((item) => item?.derivedPrinciple || "").filter(Boolean);
  const scores = checkpointMemory.map((item) => Number(item?.score || 0)).filter((score) => score > 0);
  const recentStrongEvidence = checkpointMemory.flatMap((item) => item?.recentStrongEvidence || []);
  const recentConflictingEvidence = checkpointMemory.flatMap((item) => item?.recentConflictingEvidence || []);
  const lastUpdatedAt = [legacyPointMemory?.lastUpdatedAt || "", ...checkpointMemory.map((item) => item?.lastUpdatedAt || "")]
    .filter(Boolean)
    .sort((left, right) => String(right).localeCompare(String(left)))[0] || "";
  const assessedCheckpointCount = checkpointMemory.filter((item) => (item?.evidenceCount || 0) > 0).length;

  let state = legacyPointMemory?.state || "不可判";
  if (checkpointMemory.length) {
    if (checkpointMemory.every((item) => (item?.evidenceCount || 0) > 0 && item?.state === "solid")) {
      state = "solid";
    } else if (checkpointMemory.some((item) => (item?.evidenceCount || 0) > 0)) {
      state = "partial";
    } else {
      state = "不可判";
    }
  }

  return {
    state,
    score: legacyPointMemory?.score || average(scores) || defaultScoreForState(state),
    evidenceCount,
    derivedPrinciple: legacyPointMemory?.derivedPrinciple || derivedPrinciples[0] || point.summary || "",
    recentStrongEvidence: legacyPointMemory?.recentStrongEvidence || recentStrongEvidence,
    recentConflictingEvidence: legacyPointMemory?.recentConflictingEvidence || recentConflictingEvidence,
    lastUpdatedAt,
    assessedCheckpointCount,
    totalCheckpointCount: (point.checkpoints || []).length,
  };
}

function buildTargetView(targetRecord, memoryProfile) {
  const pack = getBaselinePackById(targetRecord.targetBaselineId);
  const decomposition = createBaselinePackDecomposition(pack);
  const trainingPoints = buildTrainingPointsFromDecomposition(decomposition);
  const readingProgress = targetRecord.readingProgress || {};
  const readingDocMap = readingProgress.docs || {};
  const itemViews = trainingPoints.map((point) => {
    const primaryDocPath = normalizeGuideSources(point.javaGuideSources)[0]?.path || "";
    return buildAbilityItemView(
      point,
      aggregatePointMemory(point, memoryProfile),
      primaryDocPath ? readingDocMap[primaryDocPath] || null : null,
    );
  });
  const documentMasteryMap = buildDocumentMasteryMap(itemViews);
  const readingDomains = buildReadingDomainsForTarget(targetRecord.targetBaselineId).map((domain) => {
    const domainProgress = readingProgress.domains?.[domain.id] || {};
    const docs = (domain.docs || []).map((doc) => {
      const mastery = documentMasteryMap.get(doc.path) || {};
      const masteryPercentage = average(mastery.progressValues || []);
      const docReadingProgress = readDocumentProgress(readingProgress, domainProgress, doc);
      return {
        ...doc,
        ...docReadingProgress,
        masteryPercentage,
        masteryLabel: buildMasteryLabel(masteryPercentage, {
          hasEvidence: (mastery.assessedConceptCount || 0) > 0,
          hasReading: docReadingProgress.started || Boolean(mastery.hasReadingProgress),
        }),
        assessedConceptCount: mastery.assessedConceptCount || 0,
        totalConceptCount: mastery.totalConceptCount || 0,
      };
    });
    const currentDoc =
      docs.find((doc) => doc.path === domainProgress.currentDocPath) ||
      docs.find((doc) => doc.path === readingProgress.currentDocPath) ||
      docs.find((doc) => doc.progressPercentage < 100) ||
      docs[0] ||
      null;
    const currentIndex = currentDoc ? docs.findIndex((doc) => doc.path === currentDoc.path) : 0;
    const startedCount = docs.filter((doc) => doc.started).length;
    const completedCount = docs.filter((doc) => doc.progressPercentage >= 100).length;
    return {
      id: domain.id,
      title: domain.title,
      progressPercentage: average(docs.map((doc) => doc.progressPercentage)),
      currentDocPath: currentDoc?.path || "",
      currentDocTitle: domainProgress.currentDocTitle || currentDoc?.title || "",
      previewDocs: docs.slice(Math.max(0, currentIndex), Math.max(0, currentIndex) + 3),
      docs,
      totalDocCount: docs.length,
      startedDocCount: startedCount,
      completedDocCount: completedCount,
    };
  });
  const domainMap = new Map();

  for (const item of itemViews) {
    const point = trainingPoints.find((entry) => entry.id === item.abilityItemId);
    const domainId = point?.abilityDomainId || "general";
    const domainTitle = point?.abilityDomainTitle || "通用能力";
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
      masteryScore: average(orderedItems.map((item) => item.masteryScore)),
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

  const completionPercentage = calculateTargetReadinessScore(itemViews);
  return {
    targetBaselineId: targetRecord.targetBaselineId,
    title: targetRecord.title || pack.title,
    targetRole: targetRecord.targetRole || pack.targetRole,
    createdAt: targetRecord.createdAt || "",
    lastActivityAt: targetRecord.lastActivityAt || "",
    sessionsStarted: targetRecord.sessionsStarted || 0,
    completionPercentage,
    readinessScore: completionPercentage,
    completionLabel: buildTargetLabel(completionPercentage),
    assessedItemCount: itemViews.filter((item) => item.evidenceCount > 0).length,
    totalItemCount: itemViews.length,
    currentDomainId: currentDomain?.id || "",
    currentAbilityItemId: "",
    currentDocPath: readingProgress.currentDocPath || currentDomain?.currentDocPath || "",
    currentDocTitle: readingProgress.currentDocTitle || currentDomain?.currentDocTitle || "",
    readingProgress,
    trainingPoints,
    domains,
    readingDomains,
  };
}

export function buildUserProfileView({ user, memoryProfile }) {
  const targets = Object.values(user.targets || {})
    .map((target) => buildTargetView(target, memoryProfile))
    .sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")));

  const targetItems = targets.flatMap((target) => target.domains.flatMap((domain) => domain.items));
  const summarizedStates = targetItems.map((item) => summarizeState(item)).filter(Boolean);
  const documentProgress = buildDocumentProgressView({ user, memoryProfile });
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
      assessedAbilityItems: targetItems.filter((item) => (item.evidenceCount || 0) > 0).length,
      solidItems: summarizedStates.filter((state) => state === "solid").length,
      partialItems: summarizedStates.filter((state) => state === "partial").length,
      weakItems: summarizedStates.filter((state) => state === "weak").length
    },
    documentProgress,
    targets
  };
}
