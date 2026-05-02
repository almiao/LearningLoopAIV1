import http from "node:http";
import {
  createBaselinePackDecomposition,
  createBaselinePackSource,
  defaultBaselinePackId,
  getBaselinePackById
} from "../../src/baseline/baseline-packs.js";
import {
  readJavaGuideAsset,
  readJavaGuideDocument,
  listKnowledgeDocuments
} from "../../src/knowledge/java-guide-doc-service.js";
import { buildReminderCandidate } from "../../src/superapp/reminder-candidate.js";
import { createMemoryProfileStore } from "../../src/tutor/memory-profile-store.js";
import {
  applyDocumentReadingEvent,
  applyDocumentTrainingAnswered,
  applyDocumentTrainingSession,
  applyDocumentTrainingStarted,
  readDocumentTrainingSession,
} from "../../src/user/document-progress-state.js";
import { applyReadingProgress } from "../../src/user/reading-progress.js";
import { createUserProfileStore } from "../../src/user/user-profile-store.js";
import { buildUserProfileView } from "../../src/user/profile-aggregator.js";

const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const port = Number(process.env.PORT || 4000);
const memoryProfileStore = createMemoryProfileStore();
const userProfileStore = createUserProfileStore();
const superappDemoHandle = process.env.SUPERAPP_DEMO_HANDLE || "learningloop_superapp_demo";
const superappDemoPin = process.env.SUPERAPP_DEMO_PIN || "1234";

function withCorsHeaders(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
}

function sendJson(response, statusCode, payload) {
  withCorsHeaders(response, statusCode);
  response.end(JSON.stringify(payload));
}

function sendBuffer(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    ...extraHeaders,
  });
  response.end(body);
}

function buildMissingAssetPlaceholder(assetPath = "") {
  const label = String(assetPath || "knowledge asset")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join(" / ")
    .replace(/[<>&"]/g, "");
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420" role="img" aria-label="Image unavailable">
  <rect width="960" height="420" fill="#f8fafc"/>
  <rect x="28" y="28" width="904" height="364" rx="18" fill="#ffffff" stroke="#d8dee8" stroke-width="2" stroke-dasharray="10 10"/>
  <text x="480" y="190" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#475569">Image unavailable</text>
  <text x="480" y="238" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#64748b">${label || "missing source asset"}</text>
</svg>`.trim());
}

function withStreamHeaders(response, statusCode) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

async function getUserProfile(userId) {
  return userProfileStore.getById(userId);
}

async function getMemoryProfile(memoryProfileId) {
  return memoryProfileStore.getOrCreate(memoryProfileId);
}

async function buildProfilePayload(user) {
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  return buildUserProfileView({
    user,
    memoryProfile,
  });
}

async function proxyJson(method, pathname, payload) {
  const response = await fetch(`${aiServiceUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { error: rawText || "Downstream AI service returned invalid JSON." };
  }
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Downstream AI service request failed.");
  }
  return {
    data,
    traceId: response.headers.get("x-trace-id") || ""
  };
}

function stripSessionPayload(session = {}) {
  const nextSession = {
    ...session,
  };
  delete nextSession.memoryProfileSnapshot;
  delete nextSession.sessionSnapshot;
  return nextSession;
}

function buildDecompositionSnapshot(session = {}) {
  return {
    summary: session.summary || {},
    trainingPoints: session.trainingPoints || [],
    concepts: session.concepts || [],
  };
}

function isResumableDocumentSession(session = {}, { userId = "", docPath = "" } = {}) {
  return Boolean(
    session?.sessionId
    && session.userId === userId
    && session.source?.metadata?.docPath === docPath
  );
}

async function tryReadLiveSession(sessionId = "") {
  if (!sessionId) {
    return null;
  }
  try {
    const { data, traceId } = await proxyJson("GET", `/api/interview/${sessionId}`);
    return {
      ...data,
      traceId,
    };
  } catch {
    return null;
  }
}

async function tryRestoreSessionSnapshot(sessionSnapshot = null) {
  if (!sessionSnapshot || typeof sessionSnapshot !== "object") {
    return null;
  }
  try {
    const { data, traceId } = await proxyJson("POST", "/api/interview/restore-session", {
      sessionSnapshot,
    });
    return {
      ...data,
      traceId,
    };
  } catch {
    return null;
  }
}

function touchUserTarget(user, baselinePack, timestamp, { incrementSessionsStarted = false } = {}) {
  const previous = user.targets[baselinePack.id] || {};
  user.targets[baselinePack.id] = {
    targetBaselineId: baselinePack.id,
    title: baselinePack.title,
    targetRole: baselinePack.targetRole,
    createdAt: previous.createdAt || timestamp,
    lastActivityAt: timestamp,
    sessionsStarted: (previous.sessionsStarted || 0) + (incrementSessionsStarted ? 1 : 0),
    readingProgress: previous.readingProgress || {},
  };
}

function persistDocumentSessionState(user, session, timestamp) {
  const docPath = session?.source?.metadata?.docPath || "";
  if (!docPath) {
    return;
  }
  user.documents = applyDocumentTrainingSession(user.documents || {}, {
    docPath,
    docTitle: session.source?.title || session.source?.metadata?.docTitle || "",
    sessionId: session.sessionId || "",
    sessionSnapshot: session.sessionSnapshot || null,
    decompositionSnapshot: buildDecompositionSnapshot(session),
    currentTrainingPointId: session.currentTrainingPointId || "",
    currentCheckpointId: session.currentCheckpointId || "",
    timestamp,
  });
}

async function handleStartTarget(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(body.userId);
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  const activeDocument = body.docPath
    ? await readJavaGuideDocument(body.docPath)
    : null;

  const targetBaselineId = body.targetBaselineId || defaultBaselinePackId;
  const baselinePack = getBaselinePackById(targetBaselineId);
  const now = new Date().toISOString();
  const previousTarget = user.targets[baselinePack.id] || {};
  const storedSession = activeDocument
    ? readDocumentTrainingSession(user.documents || {}, activeDocument.path)
    : null;
  const liveSession = await tryReadLiveSession(storedSession?.activeSessionId || "");
  const resumableLiveSession = isResumableDocumentSession(liveSession, {
    userId: user.id,
    docPath: activeDocument?.path || "",
  }) ? liveSession : null;
  const restoredSession = resumableLiveSession
    ? null
    : await tryRestoreSessionSnapshot(storedSession?.activeSessionSnapshot || null);
  const resumableRestoredSession = isResumableDocumentSession(restoredSession, {
    userId: user.id,
    docPath: activeDocument?.path || "",
  }) ? restoredSession : null;

  if (resumableLiveSession || resumableRestoredSession) {
    const resumedSession = resumableLiveSession || resumableRestoredSession;
    touchUserTarget(user, baselinePack, now);
    persistDocumentSessionState(user, resumedSession, now);
    user.lastActiveAt = now;
    await userProfileStore.save(user);
    return stripSessionPayload(resumedSession);
  }

  memoryProfile.sessionsStarted += 1;
  await memoryProfileStore.save(memoryProfile);
  touchUserTarget(user, baselinePack, now, { incrementSessionsStarted: true });
  user.documents = applyDocumentTrainingStarted(user.documents || {}, {
    docPath: activeDocument?.path || body.docPath || "",
    docTitle: activeDocument?.title || "",
    timestamp: now,
  });
  user.lastActiveAt = now;
  await userProfileStore.save(user);
  const source = activeDocument
    ? {
        kind: "knowledge-document",
        title: activeDocument.title,
        content: activeDocument.markdown,
        metadata: {
          baselinePackId: baselinePack.id,
          targetRole: baselinePack.targetRole,
          docPath: activeDocument.path,
        },
      }
    : createBaselinePackSource(baselinePack);

  const aiPayload = {
    userId: user.id,
    source,
    decomposition: activeDocument
      ? (storedSession?.decompositionSnapshot || undefined)
      : createBaselinePackDecomposition(baselinePack),
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship,
    },
    targetProgress: previousTarget,
    memoryProfile,
    interactionPreference: body.interactionPreference || "balanced",
  };

  const { data: result, traceId } = await proxyJson("POST", "/api/interview/start-target", aiPayload);
  const nextResult = {
    ...result,
    traceId,
  };
  persistDocumentSessionState(user, nextResult, now);
  await userProfileStore.save(user);
  return stripSessionPayload(nextResult);
}

async function handleAnswer(body) {
  const { data: result, traceId } = await proxyJson("POST", "/api/interview/answer", body);
  const memoryProfileSnapshot = result.memoryProfileSnapshot;
  if (memoryProfileSnapshot?.id) {
    await memoryProfileStore.save(memoryProfileSnapshot);
  }
  if (result.userId && result.targetBaseline?.id) {
    const user = await getUserProfile(result.userId);
    const previous = user.targets[result.targetBaseline.id] || {};
    const timestamp = new Date().toISOString();
    user.targets[result.targetBaseline.id] = {
      targetBaselineId: result.targetBaseline.id,
      title: result.targetBaseline.title,
      targetRole: result.targetBaseline.targetRole || "",
      createdAt: previous.createdAt || timestamp,
      lastActivityAt: timestamp,
      sessionsStarted: previous.sessionsStarted || 0,
      readingProgress: previous.readingProgress || {},
    };
    user.documents = applyDocumentTrainingAnswered(user.documents || {}, {
      docPath: result.source?.metadata?.docPath || "",
      docTitle: result.source?.title || result.source?.metadata?.docTitle || "",
      timestamp,
    });
    persistDocumentSessionState(user, result, timestamp);
    user.lastActiveAt = user.targets[result.targetBaseline.id].lastActivityAt;
    await userProfileStore.save(user);
  }
  return stripSessionPayload({
    ...result,
    traceId,
  });
}

async function handleReminderCandidate(userId) {
  if (!userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(userId);
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  const candidate = buildReminderCandidate({ user, memoryProfile });
  if (!candidate) {
    throw new Error("No reminder candidate available.");
  }
  return candidate;
}

async function handleReadingProgress(body) {
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
    timestamp,
  });
  user.documents = applyDocumentReadingEvent(user.documents || {}, {
    docPath: body.docPath,
    docTitle: body.docTitle || user.targets[targetBaselineId]?.readingProgress?.currentDocTitle || "",
    scrollRatio: body.scrollRatio,
    dwellMs: body.dwellMs,
    timestamp,
  });
  user.targets[targetBaselineId].lastActivityAt = timestamp;
  user.lastActiveAt = user.targets[targetBaselineId].lastActivityAt;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

function buildFallbackKnowledgeAnswer(question = "", document = {}) {
  const lines = String(document.markdown || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, "").replace(/^[-*]\s*/, ""))
    .filter((line) => line && !line.startsWith("!"));
  const headings = lines.filter((line) => line.length <= 48).slice(0, 8);
  const paragraphs = lines.filter((line) => line.length > 18).slice(0, 6);
  if (/总结|概括|3\s*句|三句/.test(question)) {
    return (paragraphs.length ? paragraphs : headings).slice(0, 3).map((line, index) => `${index + 1}. ${line}`).join("\n");
  }
  if (/面试|追问|问题/.test(question)) {
    return (headings.length ? headings : paragraphs).slice(0, 5).map((line, index) => `${index + 1}. 面试官可能会追问：${line} 的核心机制和边界是什么？`).join("\n");
  }
  const seeds = (paragraphs.length ? paragraphs : headings).slice(0, 2);
  return seeds.length ? `基于《${document.title || "当前文档"}》，${seeds.join("；")}` : "这篇材料里没有足够内容回答这个问题。";
}

async function handleKnowledgeAnswer(body) {
  const question = String(body.question || "").trim();
  const docPath = String(body.docPath || "").trim();
  if (!question) {
    throw new Error("question is required.");
  }
  if (!docPath) {
    throw new Error("docPath is required.");
  }

  const document = await readJavaGuideDocument(docPath);
  try {
    const { data, traceId } = await proxyJson("POST", "/api/superapp/answer-knowledge-question", {
      userId: body.userId || "",
      question,
      title: document.title,
      context: document.markdown,
    });
    return {
      ...data,
      traceId,
      source: {
        title: document.title,
        path: document.path,
      },
    };
  } catch (error) {
    return {
      mode: "knowledge_qa",
      content: buildFallbackKnowledgeAnswer(question, document),
      suggestedFollowUp: "把这个点出成一道快答题",
      source: {
        title: document.title,
        path: document.path,
      },
      fallbackReason: error.message,
    };
  }
}

async function ensureSuperappDemoUser() {
  const { user, created } = await userProfileStore.loginOrCreate({
    handle: superappDemoHandle,
    pin: superappDemoPin,
  });
  const profile = await buildProfilePayload(user);
  return {
    userId: user.id,
    handle: user.handle,
    created,
    profile,
  };
}

function parseSseEvent(rawEvent) {
  const lines = String(rawEvent || "").split(/\r?\n/);
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  return {
    event,
    dataText: dataLines.join("\n")
  };
}

function serializeSseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildServiceBaseUrl(request) {
  const host = request.headers.host || `127.0.0.1:${port}`;
  const protocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  return `${protocol}://${host}`;
}

async function persistAnswerSideEffects(result) {
  const memoryProfileSnapshot = result.memoryProfileSnapshot;
  if (memoryProfileSnapshot?.id) {
    await memoryProfileStore.save(memoryProfileSnapshot);
  }
  if (result.userId && result.targetBaseline?.id) {
    const user = await getUserProfile(result.userId);
    const previous = user.targets[result.targetBaseline.id] || {};
    const timestamp = new Date().toISOString();
    user.targets[result.targetBaseline.id] = {
      targetBaselineId: result.targetBaseline.id,
      title: result.targetBaseline.title,
      targetRole: result.targetBaseline.targetRole || "",
      createdAt: previous.createdAt || timestamp,
      lastActivityAt: timestamp,
      sessionsStarted: previous.sessionsStarted || 0,
      readingProgress: previous.readingProgress || {},
    };
    user.documents = applyDocumentTrainingAnswered(user.documents || {}, {
      docPath: result.source?.metadata?.docPath || "",
      docTitle: result.source?.title || result.source?.metadata?.docTitle || "",
      timestamp,
    });
    persistDocumentSessionState(user, result, timestamp);
    user.lastActiveAt = user.targets[result.targetBaseline.id].lastActivityAt;
    await userProfileStore.save(user);
  }
}

async function handleFocusDomain(body) {
  const { data, traceId } = await proxyJson("POST", "/api/interview/focus-domain", body);
  if (data.userId && data.targetBaseline?.id) {
    const user = await getUserProfile(data.userId);
    const baselinePack = getBaselinePackById(data.targetBaseline.id);
    const timestamp = new Date().toISOString();
    touchUserTarget(user, baselinePack, timestamp);
    persistDocumentSessionState(user, data, timestamp);
    user.lastActiveAt = timestamp;
    await userProfileStore.save(user);
  }
  return stripSessionPayload({
    ...data,
    traceId,
  });
}

async function handleFocusConcept(body) {
  const { data, traceId } = await proxyJson("POST", "/api/interview/focus-concept", body);
  if (data.userId && data.targetBaseline?.id) {
    const user = await getUserProfile(data.userId);
    const baselinePack = getBaselinePackById(data.targetBaseline.id);
    const timestamp = new Date().toISOString();
    touchUserTarget(user, baselinePack, timestamp);
    persistDocumentSessionState(user, data, timestamp);
    user.lastActiveAt = timestamp;
    await userProfileStore.save(user);
  }
  return stripSessionPayload({
    ...data,
    traceId,
  });
}

async function handleAnswerStream(body, response) {
  const upstream = await fetch(`${aiServiceUrl}/api/interview/answer-stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const rawText = await upstream.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { error: rawText || "Downstream AI service stream failed." };
    }
    throw new Error(data.detail || data.error || "Downstream AI service stream failed.");
  }

  withStreamHeaders(response, 200);
  const traceId = upstream.headers.get("x-trace-id") || "";
  if (traceId) {
    response.write(serializeSseEvent("trace", { traceId }));
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed.event === "turn_result" || parsed.event === "session") {
        const data = parsed.dataText ? JSON.parse(parsed.dataText) : {};
        await persistAnswerSideEffects(data);
        response.write(serializeSseEvent("turn_result", stripSessionPayload({ ...data, traceId })));
      } else {
        response.write(`${rawEvent}\n\n`);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    response.write(`${buffer}\n\n`);
  }
  response.end();
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "OPTIONS") {
      withCorsHeaders(response, 204, { "content-type": "text/plain; charset=utf-8" });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, aiServiceUrl });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      const { user, created } = await userProfileStore.loginOrCreate({
        handle: body.handle,
        pin: body.pin,
      });
      sendJson(response, 200, {
        created,
        profile: await buildProfilePayload(user),
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/profile/")) {
      const userId = url.pathname.split("/").at(-1);
      sendJson(response, 200, await buildProfilePayload(await getUserProfile(userId)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/reading-progress") {
      sendJson(response, 200, await handleReadingProgress(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/knowledge/answer") {
      sendJson(response, 200, await handleKnowledgeAnswer(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/superapp/reminder-candidate/")) {
      const userId = url.pathname.split("/").at(-1);
      sendJson(response, 200, await handleReminderCandidate(userId));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/superapp/demo-user") {
      sendJson(response, 200, await ensureSuperappDemoUser());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/superapp/reminder-outcome") {
      const body = await readJsonBody(request);
      sendJson(response, 200, { ok: true, recordedAt: new Date().toISOString(), ...body });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/doc") {
      const docPath = url.searchParams.get("path") || "";
      const document = await readJavaGuideDocument(docPath, {
        serviceBaseUrl: buildServiceBaseUrl(request),
      });
      sendJson(response, 200, document);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/docs") {
      sendJson(response, 200, { documents: await listKnowledgeDocuments() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/asset") {
      const assetPath = url.searchParams.get("path");
      const remoteUrl = url.searchParams.get("url");

      if (assetPath) {
        try {
          const asset = await readJavaGuideAsset(assetPath);
          sendBuffer(response, 200, asset.body, {
            "cache-control": "public, max-age=3600",
            "content-type": asset.mimeType,
          });
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
          sendBuffer(response, 200, buildMissingAssetPlaceholder(assetPath), {
            "cache-control": "public, max-age=300",
            "content-type": "image/svg+xml; charset=utf-8",
          });
        }
        return;
      }

      if (remoteUrl) {
        const upstream = await fetch(remoteUrl);
        if (!upstream.ok) {
          throw new Error("Remote asset request failed.");
        }
        sendBuffer(response, 200, Buffer.from(await upstream.arrayBuffer()), {
          "cache-control": "public, max-age=3600",
          "content-type": upstream.headers.get("content-type") || "application/octet-stream",
        });
        return;
      }

      throw new Error("knowledge asset path is required.");
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/redirect") {
      const remoteUrl = url.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(remoteUrl)) {
        throw new Error("knowledge redirect url is invalid.");
      }
      response.writeHead(302, {
        "access-control-allow-origin": "*",
        location: remoteUrl,
      });
      response.end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/start-target") {
      sendJson(response, 200, await handleStartTarget(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/answer") {
      sendJson(response, 200, await handleAnswer(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/answer-stream") {
      await handleAnswerStream(await readJsonBody(request), response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-domain") {
      sendJson(response, 200, await handleFocusDomain(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-concept") {
      sendJson(response, 200, await handleFocusConcept(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/interview/")) {
      const { data: result, traceId } = await proxyJson("GET", url.pathname);
      sendJson(response, 200, stripSessionPayload({ ...result, traceId }));
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`Learning Loop BFF listening on http://localhost:${port}`);
  });
}

export { server };
