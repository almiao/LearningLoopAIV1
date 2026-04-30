import { spawn } from "node:child_process";
import { loadLocalEnv } from "./local-env.js";
import { killExistingOnPort } from "./port-utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForJson(url, timeoutMs = 30000) {
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
    ...options
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  return {
    child,
    readStdout() {
      return stdout;
    },
    readStderr() {
      return stderr;
    }
  };
}

export async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed");
  }
  return data;
}

export async function withSplitServices(t, fn, { aiPort, bffPort } = {}) {
  const localEnv = loadLocalEnv(process.cwd());
  const resolvedAiPort = aiPort || 18100;
  const resolvedBffPort = bffPort || 14100;
  killExistingOnPort(resolvedAiPort);
  killExistingOnPort(resolvedBffPort);

  const ai = startProcess(
    "python3",
    ["-m", "uvicorn", "app.main:app", "--port", String(resolvedAiPort), "--app-dir", "ai-service"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...localEnv
      }
    }
  );

  const bff = startProcess(
    "node",
    ["bff/src/server.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...localEnv,
        PORT: String(resolvedBffPort),
        AI_SERVICE_URL: `http://127.0.0.1:${resolvedAiPort}`
      }
    }
  );

  try {
    await waitForJson(`http://127.0.0.1:${resolvedAiPort}/api/health`);
    await waitForJson(`http://127.0.0.1:${resolvedBffPort}/api/health`);
    await fn({
      aiBaseUrl: `http://127.0.0.1:${resolvedAiPort}`,
      bffBaseUrl: `http://127.0.0.1:${resolvedBffPort}`
    });
  } catch (error) {
    const aiStderr = ai.readStderr();
    const bffStderr = bff.readStderr();
    throw new Error(
      `${error.message}\nAI STDOUT:\n${ai.readStdout() || "<empty>"}\nAI STDERR:\n${aiStderr || "<empty>"}\nBFF STDOUT:\n${bff.readStdout() || "<empty>"}\nBFF STDERR:\n${bffStderr || "<empty>"}`
    );
  } finally {
    bff.child.kill("SIGTERM");
    ai.child.kill("SIGTERM");
  }

  if (t) {
    t.assert?.doesNotMatch?.(bff.readStderr(), /Error:|Unhandled|Traceback/i);
    t.assert?.doesNotMatch?.(ai.readStderr(), /Error:|Unhandled|Traceback/i);
  }
}
