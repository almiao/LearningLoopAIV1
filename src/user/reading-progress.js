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

  return {
    ...targetRecord,
    readingProgress: {
      currentDomainId: resolved.domainId || previous.currentDomainId || "",
      currentConceptId: resolved.conceptId || previous.currentConceptId || "",
      currentDocPath: resolved.docPath || previous.currentDocPath || "",
      currentDocTitle: resolved.docTitle || previous.currentDocTitle || "",
      lastUpdatedAt: timestamp,
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
