import { spawn } from "node:child_process";
import { loadLocalEnv } from "./local-env.js";
import { killExistingOnPort } from "./port-utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "pipe",
    ...options,
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  return {
    child,
    readStderr() {
      return stderr;
    },
  };
}

export async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed");
  }
  return data;
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
    dataText: dataLines.join("\n"),
  };
}

export async function postEventStream(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || data.error || "Stream request failed");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseEvent(rawEvent);
      events.push({
        event: parsed.event,
        data: parsed.dataText ? JSON.parse(parsed.dataText) : {},
      });
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer);
    events.push({
      event: parsed.event,
      data: parsed.dataText ? JSON.parse(parsed.dataText) : {},
    });
  }

  return events;
}

export async function withInterviewAssistServices(t, fn, { aiPort, agentPort } = {}) {
  const localEnv = loadLocalEnv(process.cwd());
  const resolvedAiPort = aiPort || 18200;
  const resolvedAgentPort = agentPort || 14600;
  killExistingOnPort(resolvedAiPort);
  killExistingOnPort(resolvedAgentPort);

  const ai = startProcess(
    "python3",
    ["-m", "uvicorn", "app.main:app", "--port", String(resolvedAiPort), "--app-dir", "ai-service"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...localEnv,
        INTERVIEW_ASSIST_LLM_PROVIDER: "MOCK",
      },
    }
  );

  const agent = startProcess(
    "node",
    ["livekit-agent/src/server.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...localEnv,
        PORT: String(resolvedAgentPort),
        AI_SERVICE_URL: `http://127.0.0.1:${resolvedAiPort}`,
      },
    }
  );

  try {
    await waitForJson(`http://127.0.0.1:${resolvedAiPort}/api/health`);
    await waitForJson(`http://127.0.0.1:${resolvedAgentPort}/api/health`);
    await fn({
      aiBaseUrl: `http://127.0.0.1:${resolvedAiPort}`,
      agentBaseUrl: `http://127.0.0.1:${resolvedAgentPort}`,
    });
  } catch (error) {
    const aiStderr = ai.readStderr();
    const agentStderr = agent.readStderr();
    throw new Error(
      `${error.message}\nAI STDERR:\n${aiStderr || "<empty>"}\nAGENT STDERR:\n${agentStderr || "<empty>"}`
    );
  } finally {
    agent.child.kill("SIGTERM");
    ai.child.kill("SIGTERM");
  }

  if (t) {
    t.assert?.doesNotMatch?.(agent.readStderr(), /Error:|Unhandled|Traceback/i);
    t.assert?.doesNotMatch?.(ai.readStderr(), /Error:|Unhandled|Traceback/i);
  }
}
