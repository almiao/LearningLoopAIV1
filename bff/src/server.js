import http from "node:http";
import { createBaselinePackDecomposition, createBaselinePackSource, getBaselinePackById, listBaselinePacks } from "./lib/baseline/baseline-packs.js";
import { createMemoryProfileStore } from "./lib/tutor/memory-profile-store.js";
import { createUserProfileStore } from "./lib/user/user-profile-store.js";
import { buildUserProfileView } from "./lib/user/profile-aggregator.js";

const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const port = Number(process.env.PORT || 4000);
const memoryProfileStore = createMemoryProfileStore();
const userProfileStore = createUserProfileStore();

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
  return data;
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
  };
  user.lastActiveAt = now;
  await userProfileStore.save(user);

  const aiPayload = {
    userId: user.id,
    source: createBaselinePackSource(baselinePack),
    decomposition: createBaselinePackDecomposition(baselinePack),
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship,
    },
    memoryProfile,
    interactionPreference: body.interactionPreference || "balanced",
  };

  const result = await proxyJson("POST", "/api/interview/start-target", aiPayload);
  delete result.memoryProfileSnapshot;
  return result;
}

async function handleAnswer(body) {
  const result = await proxyJson("POST", "/api/interview/answer", body);
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
    };
    user.lastActiveAt = user.targets[result.targetBaseline.id].lastActivityAt;
    await userProfileStore.save(user);
  }
  delete result.memoryProfileSnapshot;
  return result;
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

    if (request.method === "GET" && url.pathname === "/api/baselines") {
      sendJson(response, 200, { baselines: listBaselinePacks() });
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

    if (request.method === "POST" && url.pathname === "/api/interview/focus-domain") {
      sendJson(response, 200, await proxyJson("POST", "/api/interview/focus-domain", await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-concept") {
      sendJson(response, 200, await proxyJson("POST", "/api/interview/focus-concept", await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/interview/")) {
      const result = await proxyJson("GET", url.pathname);
      delete result.memoryProfileSnapshot;
      sendJson(response, 200, result);
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
