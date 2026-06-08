import { randomUUID } from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 4100);
const bffUrl = process.env.BFF_URL || "http://127.0.0.1:4000";
const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const supportedChannels = new Set(["feishu", "wechat"]);

const reminders = new Map();
const conversations = new Map();

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
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function proxyJson(baseUrl, pathname, payload, method = "POST") {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Downstream request failed: ${pathname}`);
  }
  return data;
}

async function getReminderCandidate(userId) {
  return proxyJson(bffUrl, `/api/superapp/reminder-candidate/${encodeURIComponent(userId)}`, null, "GET");
}

async function getDemoUser() {
  return proxyJson(bffUrl, "/api/superapp/demo-user", null, "GET");
}

async function persistReminderOutcome(payload) {
  try {
    await proxyJson(bffUrl, "/api/superapp/reminder-outcome", payload, "POST");
  } catch (error) {
    console.warn("[superapp-service] reminder outcome persistence failed:", error instanceof Error ? error.message : String(error));
  }
}

function normalizeChannel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return supportedChannels.has(normalized) ? normalized : "feishu";
}

function buildOpenClawLink(reminderId, channel) {
  const base = process.env.OPENCLAW_BASE_URL || "https://openclaw.local";
  return `${base}/learning-loop/reminders/${encodeURIComponent(reminderId)}?channel=${encodeURIComponent(channel)}`;
}

async function createReminder({ userId, channel }) {
  const context = await getReminderCandidate(userId);
  const reminderId = randomUUID();
  const reminder = {
    id: reminderId,
    status: "sent",
    userId,
    channel,
    candidate: context.candidate,
    targetBaselineId: context.targetBaselineId || "",
    openClawLink: buildOpenClawLink(reminderId, channel),
    createdAt: new Date().toISOString(),
  };
  reminders.set(reminderId, reminder);
  await persistReminderOutcome({
    reminderId,
    userId: reminder.userId,
    status: "sent",
    channel: reminder.channel,
    taskId: reminder.candidate.taskId,
  });
  return reminder;
}

async function openReminder({ reminderId, openClawConversationId = "" }) {
  const reminder = reminders.get(reminderId);
  if (!reminder) {
    throw new Error("Unknown reminder.");
  }

  const firstQuestion = await proxyJson(aiServiceUrl, "/api/superapp/generate-first-question", {
    userId: reminder.userId,
    task: reminder.candidate,
  });

  const conversationId = randomUUID();
  const conversation = {
    id: conversationId,
    reminderId: reminder.id,
    userId: reminder.userId,
    channel: reminder.channel,
    status: "question_shown",
    outcomeState: "question_shown",
    task: reminder.candidate,
    currentQuestion: firstQuestion,
    turns: [],
    openClawConversationId,
    openedAt: new Date().toISOString(),
  };
  conversations.set(conversationId, conversation);
  reminder.status = "opened";
  await persistReminderOutcome({
    reminderId: reminder.id,
    userId: reminder.userId,
    status: "opened",
    channel: reminder.channel,
    conversationId,
    openedAt: conversation.openedAt,
    taskId: reminder.candidate.taskId,
  });
  return {
    reminder,
    conversation,
    firstQuestion,
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
      sendJson(response, 200, { ok: true, bffUrl, aiServiceUrl });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reminders/dispatch") {
      const body = await readJsonBody(request);
      let userId = String(body.userId || "").trim();
      const channel = normalizeChannel(body.channel);
      if (!userId) {
        userId = (await getDemoUser()).userId;
      }
      const reminder = await createReminder({ userId, channel });
      sendJson(response, 200, {
        reminderId: reminder.id,
        status: reminder.status,
        channel: reminder.channel,
        openClawLink: reminder.openClawLink,
        candidate: {
          taskId: reminder.candidate.taskId,
          category: reminder.candidate.category,
          title: reminder.candidate.title,
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reminders/opened") {
      const body = await readJsonBody(request);
      const { conversation, firstQuestion } = await openReminder({
        reminderId: body.reminderId,
        openClawConversationId: body.openClawConversationId || "",
      });
      sendJson(response, 200, {
        conversationId: conversation.id,
        firstQuestion,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tasks/start-today-task") {
      const body = await readJsonBody(request);
      let userId = String(body.userId || "").trim();
      const channel = normalizeChannel(body.channel);
      if (!userId) {
        userId = (await getDemoUser()).userId;
      }
      const reminder = await createReminder({ userId, channel });
      const { conversation, firstQuestion } = await openReminder({
        reminderId: reminder.id,
      });
      sendJson(response, 200, {
        userId,
        channel,
        reminderId: reminder.id,
        conversationId: conversation.id,
        firstQuestion,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/reply") {
      const body = await readJsonBody(request);
      const conversation = conversations.get(body.conversationId);
      if (!conversation) {
        throw new Error("Unknown conversation.");
      }
      const result = await proxyJson(aiServiceUrl, "/api/superapp/continue-private-chat", {
        conversationId: conversation.id,
        userId: conversation.userId,
        questionId: body.questionId || conversation.currentQuestion?.questionId || "",
        question: conversation.currentQuestion?.content || "",
        answer: body.answer || "",
      });

      conversation.turns.push({
        role: "user",
        content: body.answer || "",
        at: new Date().toISOString(),
      });
      conversation.turns.push({
        role: "assistant",
        content: result.content || "",
        mode: result.mode || "",
        at: new Date().toISOString(),
      });
      conversation.status = result.loopState || "first_reply_processed";
      conversation.outcomeState = result.loopState || "first_reply_processed";
      await persistReminderOutcome({
        reminderId: conversation.reminderId,
        userId: conversation.userId,
        status: "first_reply_received",
        channel: conversation.channel,
        conversationId: conversation.id,
        taskId: conversation.task.taskId,
      });
      sendJson(response, 200, {
        conversationId: conversation.id,
        resolution: result.resolution || "continue",
        reply: {
          mode: result.mode || "",
          content: result.content || "",
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/ask") {
      const body = await readJsonBody(request);
      const question = String(body.question || "").trim();
      if (!question) {
        throw new Error("question is required.");
      }
      const channel = normalizeChannel(body.channel);
      const result = await proxyJson(aiServiceUrl, "/api/superapp/answer-knowledge-question", {
        userId: body.userId || "",
        question,
        context: body.context || "",
      });
      const conversationId = randomUUID();
      conversations.set(conversationId, {
        id: conversationId,
        reminderId: "",
        userId: body.userId || "",
        channel,
        status: "knowledge_answered",
        outcomeState: "knowledge_answered",
        task: null,
        currentQuestion: {
          questionId: `${conversationId}:direct`,
          content: question,
          background: body.context || "",
        },
        turns: [
          {
            role: "user",
            content: question,
            at: new Date().toISOString(),
          },
          {
            role: "assistant",
            content: result.content || "",
            mode: result.mode || "knowledge_qa",
            at: new Date().toISOString(),
          },
        ],
        openClawConversationId: body.openClawConversationId || "",
        openedAt: new Date().toISOString(),
      });
      sendJson(response, 200, {
        conversationId,
        channel,
        answer: {
          mode: result.mode || "knowledge_qa",
          content: result.content || "",
          suggestedFollowUp: result.suggestedFollowUp || "",
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
      const conversationId = url.pathname.split("/").at(-1);
      const conversation = conversations.get(conversationId);
      if (!conversation) {
        throw new Error("Unknown conversation.");
      }
      sendJson(response, 200, {
        conversationId: conversation.id,
        userId: conversation.userId,
        channel: conversation.channel,
        status: conversation.status,
        reminderId: conversation.reminderId,
        currentQuestionId: conversation.currentQuestion?.questionId || "",
        outcomeState: conversation.outcomeState,
      });
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Unknown error." });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`Learning Loop Superapp service listening on http://localhost:${port}`);
  });
}

export { server };
