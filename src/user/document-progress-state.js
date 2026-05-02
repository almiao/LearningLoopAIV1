import {
  average,
  buildMasteryLabel,
  calculateMasteryScore,
} from "../mastery/mastery-scoring.js";
import {
  buildDocumentProgress,
  normalizeReadingDocPath,
} from "./reading-progress.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareIsoTimestamp(left = "", right = "") {
  return String(left || "").localeCompare(String(right || ""));
}

function maxIsoTimestamp(...values) {
  return values
    .filter(Boolean)
    .sort((left, right) => compareIsoTimestamp(right, left))[0] || "";
}

function progressLabel(progressPercentage = 0) {
  if (progressPercentage >= 100) {
    return "已读";
  }
  if (progressPercentage >= 25) {
    return `${progressPercentage}%`;
  }
  if (progressPercentage > 0) {
    return "已打开";
  }
  return "未读";
}

function ensureDocumentsState(documents = {}) {
  const safeDocs = isPlainObject(documents.docs) ? documents.docs : {};
  return {
    currentDocPath: documents.currentDocPath || "",
    currentDocTitle: documents.currentDocTitle || "",
    lastUpdatedAt: documents.lastUpdatedAt || "",
    docs: safeDocs,
  };
}

function ensureDocumentEntry(previous = {}, { docPath = "", docTitle = "" } = {}) {
  return {
    ...previous,
    docPath,
    docTitle: docTitle || previous.docTitle || "",
  };
}

function getMemoryDocPaths(memoryItem = {}) {
  const candidates = [];

  if (Array.isArray(memoryItem.sourceDocPaths)) {
    candidates.push(...memoryItem.sourceDocPaths);
  }
  if (memoryItem.sourceDocPath) {
    candidates.push(memoryItem.sourceDocPath);
  }
  for (const evidence of memoryItem.evidence || []) {
    if (Array.isArray(evidence.sourceDocPaths)) {
      candidates.push(...evidence.sourceDocPaths);
    }
    if (evidence.sourceDocPath) {
      candidates.push(evidence.sourceDocPath);
    }
  }

  return [...new Set(
    candidates
      .map((value) => normalizeReadingDocPath(value))
      .filter(Boolean)
  )];
}

function mergeReadingEntry(target = {}, source = {}) {
  const merged = {
    ...target,
    ...source,
    docPath: source.docPath || target.docPath || "",
    docTitle: source.docTitle || target.docTitle || "",
  };
  merged.lastActivityAt = maxIsoTimestamp(
    target.lastActivityAt,
    source.lastActivityAt,
    source.lastReadAt,
    source.lastTrainingAt,
    source.lastTrainingStartedAt
  );
  return merged;
}

function buildLearningStatusLabel(entry = {}) {
  if ((entry.assessedConceptCount || 0) > 0) {
    if ((entry.masteryPercentage || 0) >= 75) {
      return "已掌握";
    }
    return "训练中";
  }
  if (entry.trainingStarted) {
    return "已开启训练";
  }
  return "未训练";
}

export function applyDocumentReadingEvent(documents = {}, {
  docPath = "",
  docTitle = "",
  scrollRatio,
  dwellMs,
  timestamp = new Date().toISOString(),
} = {}) {
  const normalizedDocPath = normalizeReadingDocPath(docPath);
  if (!normalizedDocPath) {
    return documents;
  }

  const state = ensureDocumentsState(documents);
  const previousEntry = ensureDocumentEntry(state.docs[normalizedDocPath] || {}, {
    docPath: normalizedDocPath,
    docTitle,
  });
  const nextEntry = {
    ...previousEntry,
    ...buildDocumentProgress(previousEntry, {
      docPath: normalizedDocPath,
      docTitle,
      scrollRatio,
      dwellMs,
      timestamp,
    }),
    lastActivityAt: timestamp,
  };

  return {
    ...state,
    currentDocPath: normalizedDocPath,
    currentDocTitle: docTitle || nextEntry.docTitle || state.currentDocTitle || "",
    lastUpdatedAt: timestamp,
    docs: {
      ...state.docs,
      [normalizedDocPath]: nextEntry,
    },
  };
}

export function applyDocumentTrainingStarted(documents = {}, {
  docPath = "",
  docTitle = "",
  timestamp = new Date().toISOString(),
} = {}) {
  const normalizedDocPath = normalizeReadingDocPath(docPath);
  if (!normalizedDocPath) {
    return documents;
  }

  const state = ensureDocumentsState(documents);
  const previousEntry = ensureDocumentEntry(state.docs[normalizedDocPath] || {}, {
    docPath: normalizedDocPath,
    docTitle,
  });
  const nextEntry = {
    ...previousEntry,
    trainingStartedAt: previousEntry.trainingStartedAt || timestamp,
    trainingSessionCount: Number(previousEntry.trainingSessionCount || 0) + 1,
    lastTrainingStartedAt: timestamp,
    lastActivityAt: timestamp,
  };

  return {
    ...state,
    currentDocPath: normalizedDocPath,
    currentDocTitle: docTitle || nextEntry.docTitle || state.currentDocTitle || "",
    lastUpdatedAt: timestamp,
    docs: {
      ...state.docs,
      [normalizedDocPath]: nextEntry,
    },
  };
}

export function applyDocumentTrainingAnswered(documents = {}, {
  docPath = "",
  docTitle = "",
  timestamp = new Date().toISOString(),
} = {}) {
  const normalizedDocPath = normalizeReadingDocPath(docPath);
  if (!normalizedDocPath) {
    return documents;
  }

  const state = ensureDocumentsState(documents);
  const previousEntry = ensureDocumentEntry(state.docs[normalizedDocPath] || {}, {
    docPath: normalizedDocPath,
    docTitle,
  });
  const nextEntry = {
    ...previousEntry,
    trainingStartedAt: previousEntry.trainingStartedAt || timestamp,
    trainingAnswerCount: Number(previousEntry.trainingAnswerCount || 0) + 1,
    lastTrainingAt: timestamp,
    lastActivityAt: timestamp,
  };

  return {
    ...state,
    currentDocPath: normalizedDocPath,
    currentDocTitle: docTitle || nextEntry.docTitle || state.currentDocTitle || "",
    lastUpdatedAt: timestamp,
    docs: {
      ...state.docs,
      [normalizedDocPath]: nextEntry,
    },
  };
}

export function buildDocumentProgressView({ user = {}, memoryProfile = {} } = {}) {
  const docsByPath = new Map();

  for (const targetRecord of Object.values(user.targets || {})) {
    const readingProgress = targetRecord.readingProgress || {};
    for (const [docPath, stored] of Object.entries(readingProgress.docs || {})) {
      const normalizedDocPath = normalizeReadingDocPath(docPath);
      if (!normalizedDocPath) {
        continue;
      }
      const current = docsByPath.get(normalizedDocPath) || {};
      docsByPath.set(normalizedDocPath, mergeReadingEntry(current, {
        ...stored,
        docPath: normalizedDocPath,
        docTitle: stored.docTitle || "",
        lastActivityAt: targetRecord.lastActivityAt || stored.lastReadAt || "",
      }));
    }
  }

  const storedDocuments = ensureDocumentsState(user.documents);
  for (const [docPath, stored] of Object.entries(storedDocuments.docs || {})) {
    const normalizedDocPath = normalizeReadingDocPath(docPath);
    if (!normalizedDocPath) {
      continue;
    }
    const current = docsByPath.get(normalizedDocPath) || {};
    docsByPath.set(normalizedDocPath, mergeReadingEntry(current, {
      ...stored,
      docPath: normalizedDocPath,
    }));
  }

  const memoryByDocPath = new Map();
  for (const memoryItem of Object.values(memoryProfile.abilityItems || {})) {
    const docPaths = getMemoryDocPaths(memoryItem);
    for (const docPath of docPaths) {
      if (!memoryByDocPath.has(docPath)) {
        memoryByDocPath.set(docPath, {
          assessedConceptCount: 0,
          totalConceptCount: 0,
          progressValues: [],
          evidenceCount: 0,
          lastEvidenceAt: "",
        });
      }
      const readingEntry = docsByPath.get(docPath) || {};
      const memoryEntry = memoryByDocPath.get(docPath);
      memoryEntry.totalConceptCount += 1;
      memoryEntry.evidenceCount += Number(memoryItem.evidenceCount || 0);
      if (Number(memoryItem.evidenceCount || 0) > 0) {
        memoryEntry.assessedConceptCount += 1;
      }
      memoryEntry.progressValues.push(calculateMasteryScore({
        readingProgress: readingEntry,
        memoryItem,
      }));
      memoryEntry.lastEvidenceAt = maxIsoTimestamp(memoryEntry.lastEvidenceAt, memoryItem.lastUpdatedAt || "");
    }
  }

  const currentDocPath = normalizeReadingDocPath(
    storedDocuments.currentDocPath
    || [...docsByPath.values()]
      .sort((left, right) => compareIsoTimestamp(right.lastActivityAt || "", left.lastActivityAt || ""))[0]?.docPath
    || ""
  );
  const currentDocTitle = storedDocuments.currentDocTitle
    || (currentDocPath ? (docsByPath.get(currentDocPath)?.docTitle || "") : "");

  const documentEntries = Object.fromEntries(
    [...new Set([
      ...docsByPath.keys(),
      ...memoryByDocPath.keys(),
    ])]
      .sort((left, right) => left.localeCompare(right))
      .map((docPath) => {
        const readingEntry = docsByPath.get(docPath) || {};
        const memoryEntry = memoryByDocPath.get(docPath) || {};
        const progressPercentage = Number(readingEntry.progressPercentage || 0);
        const masteryPercentage = average(memoryEntry.progressValues || []);
        const trainingStarted = Boolean(
          readingEntry.trainingStartedAt
          || Number(readingEntry.trainingSessionCount || 0) > 0
          || Number(readingEntry.trainingAnswerCount || 0) > 0
          || Number(memoryEntry.assessedConceptCount || 0) > 0
        );
        const masteryLabel = buildMasteryLabel(masteryPercentage, {
          hasEvidence: Number(memoryEntry.assessedConceptCount || 0) > 0,
          hasReading: progressPercentage > 0,
        });
        const entry = {
          docPath,
          docTitle: readingEntry.docTitle || "",
          progressPercentage,
          readingStatus: readingEntry.status || (progressPercentage > 0 ? "opened" : "unread"),
          readingLabel: progressLabel(progressPercentage),
          completedReadCount: Number(readingEntry.completedReadCount || 0),
          trainingStarted,
          trainingStartedAt: readingEntry.trainingStartedAt || "",
          trainingSessionCount: Number(readingEntry.trainingSessionCount || 0),
          trainingAnswerCount: Number(readingEntry.trainingAnswerCount || 0),
          assessedConceptCount: Number(memoryEntry.assessedConceptCount || 0),
          totalConceptCount: Number(memoryEntry.totalConceptCount || 0),
          evidenceCount: Number(memoryEntry.evidenceCount || 0),
          masteryPercentage,
          masteryLabel,
          learningStatusLabel: "",
          lastActivityAt: maxIsoTimestamp(
            readingEntry.lastActivityAt || "",
            readingEntry.lastReadAt || "",
            readingEntry.lastTrainingAt || "",
            readingEntry.lastTrainingStartedAt || "",
            memoryEntry.lastEvidenceAt || ""
          ),
          isCurrent: currentDocPath === docPath,
        };
        entry.learningStatusLabel = buildLearningStatusLabel(entry);
        return [docPath, entry];
      })
  );

  const docList = Object.values(documentEntries);
  return {
    currentDocPath,
    currentDocTitle,
    docs: documentEntries,
    stats: {
      startedReadingCount: docList.filter((item) => item.progressPercentage > 0).length,
      completedReadingCount: docList.filter((item) => item.progressPercentage >= 100).length,
      startedTrainingCount: docList.filter((item) => item.trainingStarted).length,
      assessedTrainingCount: docList.filter((item) => item.assessedConceptCount > 0).length,
    },
  };
}
