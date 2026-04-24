import {
  createBaselinePackDecomposition,
  createBaselinePackSource,
  getBaselinePackById,
  listBaselinePacks
} from "./baseline/baseline-packs.js";
import { parseDocumentInput } from "./ingestion/document-parser.js";
import { fetchSubmittedPage } from "./ingestion/url-fetcher.js";
import {
  answerSession,
  createSession,
  focusSessionOnConcept,
  focusSessionOnDomain
} from "./tutor/session-orchestrator.js";
import { createMemoryProfileStore } from "./tutor/memory-profile-store.js";
import { recordSessionCase } from "./tutor/case-recorder.js";
import { createHeuristicTutorIntelligence } from "./tutor/tutor-intelligence.js";
import { applyReadingProgress } from "./user/reading-progress.js";
import { createUserProfileStore } from "./user/user-profile-store.js";
import { buildUserProfileView } from "./user/profile-aggregator.js";

function projectSession(session) {
  return {
    sessionId: session.id,
    userId: session.userId || "",
    source: {
      title: session.source.title,
      kind: session.source.kind,
      url: session.source.url
    },
    summary: session.summary,
    concepts: session.concepts,
    currentConceptId: session.currentConceptId,
    currentProbe: session.currentProbe,
    currentQuestionMeta: session.currentQuestionMeta,
    masteryMap: session.masteryMap,
    nextSteps: session.nextSteps,
    turns: session.turns,
    engagement: session.engagement,
    revisitQueue: session.revisitQueue,
    burdenSignal: session.burdenSignal,
    interactionPreference: session.interactionPreference,
    memoryMode: session.memoryMode,
    workspaceScope: session.workspaceScope,
    currentRuntimeMap: session.runtimeMaps?.[session.currentConceptId] || null,
    currentMemoryAnchor: session.memoryProfile?.abilityItems?.[session.currentConceptId] || null,
    latestControlVerdict: session.latestControlVerdict || null,
    targetBaseline: session.targetBaseline,
    memoryProfileId: session.memoryProfileId,
    targetMatch: session.targetMatch,
    abilityDomains: session.abilityDomains,
    memoryEvents: session.memoryEvents,
    latestMemoryEvents: session.latestMemoryEvents
  };
}

export function createAppService({ fetchImpl = globalThis.fetch, intelligence } = {}) {
  const sessions = new Map();
  const memoryProfiles = new Map();
  const memoryProfileStore = createMemoryProfileStore();
  const userProfileStore = createUserProfileStore();
  const tutorIntelligence = intelligence ?? createHeuristicTutorIntelligence();

  async function getOrCreateMemoryProfile(memoryProfileId) {
    if (memoryProfileId && memoryProfiles.has(memoryProfileId)) {
      return memoryProfiles.get(memoryProfileId);
    }

    const profile = await memoryProfileStore.getOrCreate(memoryProfileId);
    memoryProfiles.set(profile.id, profile);
    return profile;
  }

  async function getUserProfile(userId) {
    if (!userId) {
      throw new Error("User id is required.");
    }
    return userProfileStore.getById(userId);
  }

  async function buildProfilePayload(user) {
    const memoryProfile = await getOrCreateMemoryProfile(user.memoryProfileId);
    return buildUserProfileView({
      user,
      memoryProfile
    });
  }

  async function saveUser(user) {
    await userProfileStore.save(user);
  }

  return {
    listBaselines() {
      return listBaselinePacks();
    },

    async login(body) {
      const { user, created } = await userProfileStore.loginOrCreate({
        handle: body.handle,
        pin: body.pin
      });
      const payload = await buildProfilePayload(user);
      return {
        created,
        profile: payload
      };
    },

    async getProfile(userId) {
      const user = await getUserProfile(userId);
      return buildProfilePayload(user);
    },

    async startTargetSession(body) {
      const baselinePack = getBaselinePackById(body.targetBaselineId);
      const user = body.userId ? await getUserProfile(body.userId) : null;
      const memoryProfile = await getOrCreateMemoryProfile(user?.memoryProfileId || body.memoryProfileId);
      memoryProfile.sessionsStarted += 1;
      await memoryProfileStore.save(memoryProfile);
      if (user) {
        const now = new Date().toISOString();
        const previous = user.targets[baselinePack.id] || {};
        user.targets[baselinePack.id] = {
          targetBaselineId: baselinePack.id,
          title: baselinePack.title,
          targetRole: baselinePack.targetRole,
          createdAt: previous.createdAt || now,
          lastActivityAt: now,
          sessionsStarted: (previous.sessionsStarted || 0) + 1,
          readingProgress: previous.readingProgress || {}
        };
        user.lastActiveAt = now;
        await saveUser(user);
      }
      const session = await createSession({
        source: createBaselinePackSource(baselinePack),
        intelligence: tutorIntelligence,
        interactionPreference: body.interactionPreference ?? "balanced",
        preparedDecomposition: createBaselinePackDecomposition(baselinePack),
        targetBaseline: {
          id: baselinePack.id,
          title: baselinePack.title,
          targetRole: baselinePack.targetRole,
          flagship: baselinePack.flagship
        },
        memoryProfile,
        mode: "target",
        learnerId: user?.id || memoryProfile.id,
        availableBaselineIds: listBaselinePacks().map((baseline) => baseline.id)
      });
      session.userId = user?.id || "";
      sessions.set(session.id, session);
      memoryProfiles.set(memoryProfile.id, memoryProfile);
      await recordSessionCase(session);
      return projectSession(session);
    },

    async analyzeSource(body) {
      const source =
        body.type === "url"
          ? await fetchSubmittedPage(body.url, { fetchImpl })
          : parseDocumentInput({
              title: body.title,
              content: body.content
            });

      const session = await createSession({
        source,
        intelligence: tutorIntelligence,
        interactionPreference: body.interactionPreference ?? "balanced"
      });
      sessions.set(session.id, session);
      await recordSessionCase(session);
      return projectSession(session);
    },

    async answer(body) {
      const session = sessions.get(body.sessionId);
      if (!session) {
        throw new Error("Unknown session.");
      }

      const updated = await answerSession(session, {
        answer: body.answer,
        intent: body.intent,
        burdenSignal: body.burdenSignal ?? "normal",
        interactionPreference: body.interactionPreference,
        intelligence: tutorIntelligence
      });
      sessions.set(updated.id, updated);
      if (updated.memoryProfile) {
        memoryProfiles.set(updated.memoryProfile.id, updated.memoryProfile);
        await memoryProfileStore.save(updated.memoryProfile);
      }
      if (updated.userId && updated.targetBaseline?.id) {
        const user = await getUserProfile(updated.userId);
        const previous = user.targets[updated.targetBaseline.id] || {};
        user.targets[updated.targetBaseline.id] = {
          targetBaselineId: updated.targetBaseline.id,
          title: updated.targetBaseline.title,
          targetRole: updated.targetBaseline.targetRole || "",
          createdAt: previous.createdAt || new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          sessionsStarted: previous.sessionsStarted || 0,
          readingProgress: previous.readingProgress || {}
        };
        user.lastActiveAt = user.targets[updated.targetBaseline.id].lastActivityAt;
        await saveUser(user);
      }
      await recordSessionCase(updated);
      return {
        ...projectSession(updated),
        latestFeedback: updated.latestFeedback
      };
    },

    async rememberReadingProgress(body) {
      const user = await getUserProfile(body.userId);
      const baselinePack = getBaselinePackById(body.targetBaselineId);
      const previous = user.targets[body.targetBaselineId] || {
        targetBaselineId: baselinePack.id,
        title: baselinePack.title,
        targetRole: baselinePack.targetRole,
        createdAt: new Date().toISOString(),
        lastActivityAt: "",
        sessionsStarted: 0,
        readingProgress: {},
      };

      user.targets[body.targetBaselineId] = applyReadingProgress(previous, {
        targetBaselineId: body.targetBaselineId,
        domainId: body.domainId,
        conceptId: body.conceptId,
        docPath: body.docPath,
        docTitle: body.docTitle,
        timestamp: new Date().toISOString(),
      });
      user.lastActiveAt = new Date().toISOString();
      await saveUser(user);
      return buildProfilePayload(user);
    },

    async focusDomain(body) {
      const session = sessions.get(body.sessionId);
      if (!session) {
        throw new Error("Unknown session.");
      }

      const updated = focusSessionOnDomain(session, body.domainId);
      sessions.set(updated.id, updated);
      await recordSessionCase(updated);
      return projectSession(updated);
    },

    async focusConcept(body) {
      const session = sessions.get(body.sessionId);
      if (!session) {
        throw new Error("Unknown session.");
      }

      const updated = focusSessionOnConcept(session, body.conceptId);
      sessions.set(updated.id, updated);
      await recordSessionCase(updated);
      return projectSession(updated);
    },

    getSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("Unknown session.");
      }

      return projectSession(session);
    }
  };
}
