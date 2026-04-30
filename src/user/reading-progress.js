import { findReadingDomainForDoc } from "./reading-roadmap.js";

function normalizeDocPath(docPath = "") {
  const normalized = String(docPath || "").trim().replace(/^\/+/, "");
  if (!normalized) {
    return "";
  }
  return normalized.startsWith("docs/") ? normalized : `docs/${normalized}`;
}

function toUniqueList(values = [], nextValue = "") {
  const list = [...values];
  if (nextValue && !list.includes(nextValue)) {
    list.push(nextValue);
  }
  return list.slice(-24);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeScrollRatio(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return clamp(numericValue, 0, 1);
}

function normalizeDwellMs(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return Math.max(0, Math.round(numericValue));
}

function statusForProgress(progressPercentage) {
  if (progressPercentage >= 100) {
    return "completed";
  }
  if (progressPercentage >= 25) {
    return "reading";
  }
  if (progressPercentage > 0) {
    return "opened";
  }
  return "unread";
}

function buildDocumentProgress(previousDocument = {}, {
  docPath = "",
  docTitle = "",
  scrollRatio,
  dwellMs,
  timestamp,
} = {}) {
  if (!docPath) {
    return previousDocument;
  }

  const nextScrollRatio = normalizeScrollRatio(scrollRatio);
  const nextDwellMs = normalizeDwellMs(dwellMs);
  const maxScrollRatio = Math.max(
    Number(previousDocument.maxScrollRatio || 0),
    nextScrollRatio ?? 0
  );
  const maxDwellMs = Math.max(
    Number(previousDocument.dwellMs || 0),
    nextDwellMs ?? 0
  );
  const previousProgress = Number(previousDocument.progressPercentage || 0);
  const scrollProgress = maxScrollRatio > 0 ? Math.round(maxScrollRatio * 100) : 0;
  const isComplete = maxScrollRatio >= 0.9 && maxDwellMs >= 45_000;
  const measuredProgress = isComplete ? 100 : Math.min(90, scrollProgress);
  const progressPercentage = clamp(Math.max(previousProgress, 10, measuredProgress), 0, 100);

  return {
    docPath,
    docTitle: docTitle || previousDocument.docTitle || "",
    progressPercentage,
    status: statusForProgress(progressPercentage),
    maxScrollRatio,
    dwellMs: maxDwellMs,
    openedAt: previousDocument.openedAt || timestamp,
    lastReadAt: timestamp,
    completedAt: progressPercentage >= 100 ? previousDocument.completedAt || timestamp : previousDocument.completedAt || "",
  };
}

function resolveReadingCursor(targetBaselineId, { domainId = "", conceptId = "", docPath = "", docTitle = "" } = {}) {
  const normalizedDocPath = normalizeDocPath(docPath);
  const matched = findReadingDomainForDoc(targetBaselineId, normalizedDocPath);

  return {
    domainId: domainId || matched?.domainId || "",
    conceptId: conceptId || "",
    docPath: normalizedDocPath || matched?.doc?.path || "",
    docTitle: String(docTitle || "").trim() || matched?.doc?.title || "",
  };
}

export function applyReadingProgress(targetRecord = {}, {
  targetBaselineId = "",
  domainId = "",
  conceptId = "",
  docPath = "",
  docTitle = "",
  scrollRatio,
  dwellMs,
  timestamp = new Date().toISOString(),
} = {}) {
  if (!targetBaselineId) {
    return targetRecord;
  }

  const resolved = resolveReadingCursor(targetBaselineId, {
    domainId,
    conceptId,
    docPath,
    docTitle,
  });

  if (!resolved.domainId && !resolved.conceptId && !resolved.docPath) {
    return targetRecord;
  }

  const previous = targetRecord.readingProgress || {};
  const previousDomain = previous.domains?.[resolved.domainId] || {};
  const previousDocuments = previous.docs || {};
  const documentProgress = buildDocumentProgress(previousDocuments[resolved.docPath] || {}, {
    docPath: resolved.docPath,
    docTitle: resolved.docTitle,
    scrollRatio,
    dwellMs,
    timestamp,
  });

  return {
    ...targetRecord,
    readingProgress: {
      currentDomainId: resolved.domainId || previous.currentDomainId || "",
      currentConceptId: resolved.conceptId || previous.currentConceptId || "",
      currentDocPath: resolved.docPath || previous.currentDocPath || "",
      currentDocTitle: resolved.docTitle || previous.currentDocTitle || "",
      lastUpdatedAt: timestamp,
      docs: {
        ...previousDocuments,
        ...(resolved.docPath ? { [resolved.docPath]: documentProgress } : {}),
      },
      domains: {
        ...(previous.domains || {}),
        ...(resolved.domainId
          ? {
              [resolved.domainId]: {
                domainId: resolved.domainId,
                currentConceptId: resolved.conceptId || previousDomain.currentConceptId || "",
                currentDocPath: resolved.docPath || previousDomain.currentDocPath || "",
                currentDocTitle: resolved.docTitle || previousDomain.currentDocTitle || "",
                lastUpdatedAt: timestamp,
                visitedConceptIds: toUniqueList(previousDomain.visitedConceptIds || [], resolved.conceptId),
                visitedDocPaths: toUniqueList(previousDomain.visitedDocPaths || [], resolved.docPath),
              },
            }
          : {}),
      },
    },
  };
}
