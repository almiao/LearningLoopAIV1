import http from "node:http";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { ensureBridge } from "./bridge.js";

const port = Number(process.env.PORT || 4200);
const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const livekitAgentName = process.env.LIVEKIT_AGENT_NAME || "interview-assist-agent";
const livekitBaseUrl = process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || "";
const livekitApiKey = process.env.LIVEKIT_API_KEY || "";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "";
const livekitInferenceBaseUrl =
  process.env.LIVEKIT_INFERENCE_BASE_URL || process.env.LIVEKIT_INFERENCE_URL || "";
const livekitSttModel = process.env.LIVEKIT_STT_MODEL || "deepgram/nova-3";

function withCorsHeaders(response, statusCode = 200, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-trace-id",
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
}

function sendJson(response, statusCode, payload) {
  withCorsHeaders(response, statusCode);
  response.end(JSON.stringify(payload));
}

function withStreamHeaders(response, statusCode = 200) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-trace-id",
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
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function proxyJson(pathname, body) {
  const upstream = await fetch(`${aiServiceUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await upstream.json();
  if (!upstream.ok) {
    const error = new Error(data.detail || data.error || "Upstream request failed.");
    error.statusCode = upstream.status;
    throw error;
  }
  return data;
}

async function proxyEventStream(pathname, body, response) {
  const upstream = await fetch(`${aiServiceUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw || "Upstream stream request failed." };
    }
    const error = new Error(data.detail || data.error || "Upstream stream request failed.");
    error.statusCode = upstream.status;
    throw error;
  }

  withStreamHeaders(response, 200);
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      response.write(`${rawEvent}\n\n`);
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    response.write(`${buffer}\n\n`);
  }
  response.end();
}

function toWsUrl(url) {
  if (!url) {
    return "";
  }
  if (url.startsWith("wss://") || url.startsWith("ws://")) {
    return url;
  }
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  return `wss://${url}`;
}

function toHttpUrl(url) {
  if (!url) {
    return "";
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return url;
  }
  if (url.startsWith("wss://")) {
    return `https://${url.slice("wss://".length)}`;
  }
  if (url.startsWith("ws://")) {
    return `http://${url.slice("ws://".length)}`;
  }
  return `https://${url}`;
}

function livekitConfig() {
  const wsUrl = process.env.LIVEKIT_WS_URL || toWsUrl(livekitBaseUrl);
  const apiHost = process.env.LIVEKIT_API_HOST || toHttpUrl(livekitBaseUrl);
  const configured = Boolean(wsUrl && apiHost && livekitApiKey && livekitApiSecret);
  return {
    configured,
    wsUrl,
    apiHost,
    inferenceBaseUrl: livekitInferenceBaseUrl,
  };
}

function isLocalUrl(url) {
  return /^https?:\/\/127\.0\.0\.1|^https?:\/\/localhost|^ws:\/\/127\.0\.0\.1|^ws:\/\/localhost/.test(url || "");
}

function sttStatus(config) {
  return {
    provider: "livekit-inference",
    model: livekitSttModel,
    configured: Boolean(config.inferenceBaseUrl) || !isLocalUrl(config.apiHost),
    inferenceBaseUrl: config.inferenceBaseUrl || config.apiHost,
    note: isLocalUrl(config.apiHost) && !config.inferenceBaseUrl
      ? "Local livekit-server does not provide cloud STT inference. Configure LIVEKIT_INFERENCE_BASE_URL or use a dedicated STT provider."
      : "",
  };
}

async function createLivekitSession(aiSession) {
  const config = livekitConfig();
  if (!config.configured) {
    return {
      ...aiSession,
      transportMode: "mock",
      livekitConfigured: false,
      livekitUrl: "",
      participantToken: "",
      roomName: aiSession.roomName || `interview_assist_${aiSession.sessionId}`,
      agentName: livekitAgentName,
    };
  }

  const roomName = aiSession.roomName || `interview_assist_${aiSession.sessionId}`;
  const participantIdentity = `user_${aiSession.sessionId.slice(-8)}`;
  const roomClient = new RoomServiceClient(config.apiHost, livekitApiKey, livekitApiSecret);

  try {
    await roomClient.createRoom({
      name: roomName,
      emptyTimeout: 5 * 60,
    });
  } catch {}

  const token = new AccessToken(livekitApiKey, livekitApiSecret, {
    identity: participantIdentity,
    name: "Interview Assist User",
    metadata: JSON.stringify({
      aiSessionId: aiSession.sessionId,
      targetRole: aiSession.targetRole,
      roomName,
    }),
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  await ensureBridge({
    aiServiceUrl,
    wsUrl: config.wsUrl,
    roomName,
    sessionId: aiSession.sessionId,
    participantIdentity,
  });

  return {
    ...aiSession,
    transportMode: "livekit",
    livekitConfigured: true,
    livekitUrl: config.wsUrl,
    participantToken: await token.toJwt(),
    roomName,
    participantIdentity,
    agentName: livekitAgentName,
  };
}

function createTransportPayload(sessionId) {
  return {
    sessionId,
    targetRole: "interview-assist",
    roomName: `interview_assist_${sessionId}`,
  };
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
      const config = livekitConfig();
      sendJson(response, 200, {
        ok: true,
        aiServiceUrl,
        livekitConfigured: config.configured,
        livekitWsUrl: config.wsUrl,
        livekitAgentName,
        stt: sttStatus(config),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview-assist/session") {
      const aiSession = await proxyJson("/api/interview-assist/session", await readJsonBody(request));
      const payload = await createLivekitSession(aiSession);
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview-assist/livekit-transport") {
      const body = await readJsonBody(request);
      if (!body.sessionId) {
        sendJson(response, 400, { error: "sessionId is required." });
        return;
      }
      const payload = await createLivekitSession(createTransportPayload(body.sessionId));
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview-assist/answer-stream") {
      await proxyEventStream("/api/interview-assist/answer-stream", await readJsonBody(request), response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview-assist/first-screen-rendered") {
      const payload = await proxyJson("/api/interview-assist/first-screen-rendered", await readJsonBody(request));
      sendJson(response, 200, payload);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "Request failed" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`LiveKit session server listening on http://127.0.0.1:${port}`);
});
