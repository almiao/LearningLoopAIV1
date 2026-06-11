import { defaultBaselinePackId, getBaselinePackById } from "../../../src/baseline/baseline-packs.js";
import { applyDocumentIgnored, applyDocumentReadingEvent, applyDocumentRecommendationSnooze, applyDocumentTrainingSkipped, applyDocumentUnignored } from "../../../src/user/document-progress-state.js";
import { buildUserProfileView } from "../../../src/user/profile-aggregator.js";
import { applyReadingProgress } from "../../../src/user/reading-progress.js";
import { ensureResumeVersionLibrary, saveResumeVersion } from "../../../src/user/resume-version-store.js";
import { interactionPreferenceRule } from "../../../src/user/user-rules-store.js";
import { memoryProfileStore, sessionSummariesStore, userProfileStore, userRulesStore } from "./stores.js";

export async function getUserProfile(userId) {
  return userProfileStore.getById(userId);
}

export async function getMemoryProfile(memoryProfileId) {
  return memoryProfileStore.getOrCreate(memoryProfileId);
}

export async function buildProfilePayload(user) {
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  const [userRules, sessionSummaries] = await Promise.all([
    userRulesStore.list(user.id),
    sessionSummariesStore.list(user.id),
  ]);
  return buildUserProfileView({
    user,
    memoryProfile,
    userRules,
    sessionSummaries,
  });
}

export function buildResumeLibraryPayload(user = {}) {
  const library = ensureResumeVersionLibrary(user.resumeLibrary);
  return {
    latestVersionId: library.latestVersionId,
    versions: library.versions.map((item) => ({
      id: item.id,
      fileName: item.fileName,
      createdAt: item.createdAt,
      charCount: item.charCount,
      text: item.text,
    })),
  };
}

export async function persistInteractionPreferenceRule(userId = "", interactionPreference = "") {
  if (!userId) {
    return;
  }
  const normalized = String(interactionPreference || "").trim();
  if (!normalized) {
    return;
  }
  await userRulesStore.upsert(userId, interactionPreferenceRule(normalized));
}

export async function handleListResumeVersions(userId = "") {
  if (!userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(userId);
  return buildResumeLibraryPayload(user);
}

export async function handleSaveResumeVersion(body = {}) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  const text = String(body.text || "").trim();
  if (!text) {
    throw new Error("resume text is required.");
  }
  const user = await getUserProfile(body.userId);
  const nextLibrary = saveResumeVersion(user.resumeLibrary, {
    text,
    fileName: body.fileName || body.filename || "",
  });
  user.resumeLibrary = {
    latestVersionId: nextLibrary.latestVersionId,
    versions: nextLibrary.versions,
  };
  user.lastActiveAt = new Date().toISOString();
  await userProfileStore.save(user);
  return {
    ...buildResumeLibraryPayload(user),
    savedVersionId: nextLibrary.savedVersion.id,
  };
}

export async function handleReadingProgress(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(body.userId);
  const targetBaselineId = body.targetBaselineId || defaultBaselinePackId;
  const baselinePack = getBaselinePackById(targetBaselineId);
  const previous = user.targets[targetBaselineId] || {
    targetBaselineId: baselinePack.id,
    title: baselinePack.title,
    targetRole: baselinePack.targetRole,
    createdAt: new Date().toISOString(),
    lastActivityAt: "",
    sessionsStarted: 0,
    readingProgress: {},
  };

  const timestamp = new Date().toISOString();
  user.targets[targetBaselineId] = applyReadingProgress(previous, {
    targetBaselineId,
    domainId: body.domainId,
    conceptId: body.conceptId,
    docPath: body.docPath,
    docTitle: body.docTitle,
    scrollRatio: body.scrollRatio,
    dwellMs: body.dwellMs,
    readingPreview: body.readingPreview,
    readingChapter: body.readingChapter,
    timestamp,
  });
  user.documents = applyDocumentReadingEvent(user.documents || {}, {
    docPath: body.docPath,
    docTitle: body.docTitle || user.targets[targetBaselineId]?.readingProgress?.currentDocTitle || "",
    scrollRatio: body.scrollRatio,
    dwellMs: body.dwellMs,
    readingPreview: body.readingPreview,
    readingChapter: body.readingChapter,
    timestamp,
  });
  user.targets[targetBaselineId].lastActivityAt = timestamp;
  user.lastActiveAt = user.targets[targetBaselineId].lastActivityAt;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

export async function handleIgnoredDocument(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  if (!body.docPath) {
    throw new Error("docPath is required.");
  }
  const user = await getUserProfile(body.userId);
  const timestamp = new Date().toISOString();
  user.documents = body.ignored === false
    ? applyDocumentUnignored(user.documents || {}, {
        docPath: body.docPath,
        timestamp,
      })
    : applyDocumentIgnored(user.documents || {}, {
        docPath: body.docPath,
        docTitle: body.docTitle || "",
        timestamp,
      });
  user.lastActiveAt = timestamp;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

export async function handleSkippedTraining(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  if (!body.docPath) {
    throw new Error("docPath is required.");
  }
  const user = await getUserProfile(body.userId);
  const timestamp = new Date().toISOString();
  user.documents = applyDocumentTrainingSkipped(user.documents || {}, {
    docPath: body.docPath,
    docTitle: body.docTitle || "",
    timestamp,
  });
  user.lastActiveAt = timestamp;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

export async function handleRecommendationSnooze(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  if (!body.docPath) {
    throw new Error("docPath is required.");
  }
  const user = await getUserProfile(body.userId);
  const timestamp = new Date().toISOString();
  const hours = Math.max(1, Math.min(24, Number(body.hours || 12)));
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  user.documents = applyDocumentRecommendationSnooze(user.documents || {}, {
    docPath: body.docPath,
    docTitle: body.docTitle || "",
    until,
    timestamp,
  });
  user.lastActiveAt = timestamp;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}
