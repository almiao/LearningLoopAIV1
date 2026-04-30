import http from "node:http";
import {
  createBaselinePackDecomposition,
  createBaselinePackSource,
  getBaselinePackById,
  listBaselinePacks
} from "../../src/baseline/baseline-packs.js";
import {
  readJavaGuideAsset,
  readJavaGuideDocument,
  listKnowledgeDocuments
} from "../../src/knowledge/java-guide-doc-service.js";
import { buildReminderCandidate } from "../../src/superapp/reminder-candidate.js";
import { createMemoryProfileStore } from "../../src/tutor/memory-profile-store.js";
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

async function handleStartTarget(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(body.userId);
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  memoryProfile.sessionsStarted += 1;
  await memoryProfileStore.save(memoryProfile);

  const baselinePack = getBaselinePackById(body.targetBaselineId);
  const now = new Date().toISOString();
  const previous = user.targets[baselinePack.id] || {};
  user.targets[baselinePack.id] = {
    targetBaselineId: baselinePack.id,
    title: baselinePack.title,
    targetRole: baselinePack.targetRole,
    createdAt: previous.createdAt || now,
    lastActivityAt: now,
    sessionsStarted: (previous.sessionsStarted || 0) + 1,
    readingProgress: previous.readingProgress || {},
  };
  user.lastActiveAt = now;
  await userProfileStore.save(user);

  const activeDocument = body.docPath
    ? await readJavaGuideDocument(body.docPath)
    : null;
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
    decomposition: activeDocument ? undefined : createBaselinePackDecomposition(baselinePack),
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship,
    },
    memoryProfile,
    interactionPreference: body.interactionPreference || "balanced",
  };

  const { data: result, traceId } = await proxyJson("POST", "/api/interview/start-target", aiPayload);
  delete result.memoryProfileSnapshot;
  return {
    ...result,
    traceId
  };
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
    user.targets[result.targetBaseline.id] = {
      targetBaselineId: result.targetBaseline.id,
      title: result.targetBaseline.title,
      targetRole: result.targetBaseline.targetRole || "",
      createdAt: previous.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      sessionsStarted: previous.sessionsStarted || 0,
      readingProgress: previous.readingProgress || {},
    };
    user.lastActiveAt = user.targets[result.targetBaseline.id].lastActivityAt;
    await userProfileStore.save(user);
  }
  delete result.memoryProfileSnapshot;
  return {
    ...result,
    traceId
  };
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
  if (!body.targetBaselineId) {
    throw new Error("targetBaselineId is required.");
  }

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
    scrollRatio: body.scrollRatio,
    dwellMs: body.dwellMs,
    timestamp: new Date().toISOString(),
  });
  user.targets[body.targetBaselineId].lastActivityAt = new Date().toISOString();
  user.lastActiveAt = user.targets[body.targetBaselineId].lastActivityAt;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
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
    user.targets[result.targetBaseline.id] = {
      targetBaselineId: result.targetBaseline.id,
      title: result.targetBaseline.title,
      targetRole: result.targetBaseline.targetRole || "",
      createdAt: previous.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      sessionsStarted: previous.sessionsStarted || 0,
      readingProgress: previous.readingProgress || {},
    };
    user.lastActiveAt = user.targets[result.targetBaseline.id].lastActivityAt;
    await userProfileStore.save(user);
  }
  delete result.memoryProfileSnapshot;
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
        response.write(serializeSseEvent("turn_result", { ...data, traceId }));
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

    if (request.method === "GET" && url.pathname === "/api/baselines") {
      sendJson(response, 200, { baselines: listBaselinePacks() });
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
        const asset = await readJavaGuideAsset(assetPath);
        sendBuffer(response, 200, asset.body, {
          "cache-control": "public, max-age=3600",
          "content-type": asset.mimeType,
        });
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
      const { data, traceId } = await proxyJson("POST", "/api/interview/focus-domain", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-concept") {
      const { data, traceId } = await proxyJson("POST", "/api/interview/focus-concept", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/interview/")) {
      const { data: result, traceId } = await proxyJson("GET", url.pathname);
      delete result.memoryProfileSnapshot;
      sendJson(response, 200, { ...result, traceId });
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
