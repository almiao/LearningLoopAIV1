import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import {
  createBaselinePackDecomposition,
  createBaselinePackSource,
  getBaselinePackById,
  listBaselinePacks
} from "./baseline/baseline-packs.js";
import { parseDocumentInput } from "./ingestion/document-parser.js";
import { fetchSubmittedPage } from "./ingestion/url-fetcher.js";
import { createSession, answerSession, focusSessionOnDomain, focusSessionOnConcept } from "./tutor/session-orchestrator.js";
import { createMemoryProfileStore } from "./tutor/memory-profile-store.js";
import { recordSessionCase } from "./tutor/case-recorder.js";
import { createHeuristicTutorIntelligence } from "./tutor/tutor-intelligence.js";
import { createUserProfileStore } from "./user/user-profile-store.js";
import { buildUserProfileView } from "./user/profile-aggregator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "content-type": contentType
  });
  response.end(payload);
}

function serveStatic(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.join(publicDir, normalizedPath);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) {
    sendText(response, 404, "Not found");
    return;
  }

  const contentType = filePath.endsWith(".html")
    ? "text/html; charset=utf-8"
    : filePath.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "application/javascript; charset=utf-8";

  sendText(response, 200, fs.readFileSync(filePath, "utf8"), contentType);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

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
          sessionsStarted: (previous.sessionsStarted || 0) + 1
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
          sessionsStarted: previous.sessionsStarted || 0
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

export function createAppServer(options = {}) {
  const service = createAppService(options);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/source/analyze") {
        const body = await readJsonBody(request);
        const payload = await service.analyzeSource(body);
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJsonBody(request);
        const payload = await service.login(body);
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/baselines") {
        sendJson(response, 200, { baselines: service.listBaselines() });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/profile/")) {
        const userId = url.pathname.split("/").at(-1);
        const payload = await service.getProfile(userId);
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/start-target") {
        const body = await readJsonBody(request);
        const payload = await service.startTargetSession(body);
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/answer") {
        const body = await readJsonBody(request);
        const payload = await service.answer(body);
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/focus-domain") {
        const body = await readJsonBody(request);
        const payload = await service.focusDomain(body);
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/focus-concept") {
        const body = await readJsonBody(request);
        const payload = await service.focusConcept(body);
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/session/")) {
        const sessionId = url.pathname.split("/").at(-1);
        sendJson(response, 200, service.getSession(sessionId));
        return;
      }

      if (request.method === "GET") {
        serveStatic(url.pathname, response);
        return;
      }

      sendJson(response, 405, { error: "Method not allowed." });
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ${request.method} ${request.url} failed`,
        error instanceof Error ? error.stack || error.message : error
      );
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });
}

const server = createAppServer();
const port = Number(process.env.PORT || 3000);
const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (process.env.NODE_ENV !== "test" && isDirectExecution) {
  server.listen(port, () => {
    console.log(`Learning Loop AI listening on http://localhost:${port}`);
  });
}

export { server };
