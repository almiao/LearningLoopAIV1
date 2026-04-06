import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import { parseDocumentInput } from "./ingestion/document-parser.js";
import { fetchSubmittedPage } from "./ingestion/url-fetcher.js";
import { createSession, answerSession } from "./tutor/session-orchestrator.js";
import { recordSessionCase } from "./tutor/case-recorder.js";
import { createTutorIntelligence } from "./tutor/tutor-intelligence.js";

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
    source: {
      title: session.source.title,
      kind: session.source.kind,
      url: session.source.url
    },
    summary: session.summary,
    concepts: session.concepts,
    currentConceptId: session.currentConceptId,
    currentProbe: session.currentProbe,
    masteryMap: session.masteryMap,
    nextSteps: session.nextSteps,
    turns: session.turns,
    engagement: session.engagement,
    revisitQueue: session.revisitQueue,
    burdenSignal: session.burdenSignal,
    interactionPreference: session.interactionPreference,
    memoryMode: session.memoryMode
  };
}

export function createAppService({ fetchImpl = globalThis.fetch, intelligence } = {}) {
  const sessions = new Map();
  const tutorIntelligence = intelligence ?? createTutorIntelligence({ fetchImpl });

  return {
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
        burdenSignal: body.burdenSignal ?? "normal",
        interactionPreference: body.interactionPreference,
        intelligence: tutorIntelligence
      });
      sessions.set(updated.id, updated);
      await recordSessionCase(updated);
      return {
        ...projectSession(updated),
        latestFeedback: updated.latestFeedback
      };
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

      if (request.method === "POST" && url.pathname === "/api/session/answer") {
        const body = await readJsonBody(request);
        const payload = await service.answer(body);
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
