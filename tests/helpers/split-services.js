import { spawn } from "node:child_process";
import {
  loadRuntimeEnv,
  resolveNodeRuntime,
  resolvePythonCommand,
  rootDir
} from "../../scripts/service-runtime.mjs";

const runtimeEnv = loadRuntimeEnv();
const nodeRuntime = resolveNodeRuntime(runtimeEnv);
const pythonRuntime = resolvePythonCommand(runtimeEnv);

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

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  return {
    child,
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
  const resolvedAiPort = aiPort || (18000 + Math.floor(Math.random() * 1000));
  const resolvedBffPort = bffPort || (14000 + Math.floor(Math.random() * 1000));

  const ai = startProcess(
    pythonRuntime.command,
    [...pythonRuntime.prefixArgs, "-m", "uvicorn", "app.main:app", "--port", String(resolvedAiPort), "--app-dir", "ai-service"],
    {
      cwd: rootDir,
      env: runtimeEnv
    }
  );

  const bff = startProcess(
    nodeRuntime.command,
    ["bff/src/server.js"],
    {
      cwd: rootDir,
      env: {
        ...runtimeEnv,
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
  } finally {
    bff.child.kill("SIGTERM");
    ai.child.kill("SIGTERM");
  }

  if (t) {
    t.assert?.doesNotMatch?.(bff.readStderr(), /Error:|Unhandled|Traceback/i);
    t.assert?.doesNotMatch?.(ai.readStderr(), /Error:|Unhandled|Traceback/i);
  }
}
