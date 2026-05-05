import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  loadRuntimeEnv,
  resolveNodeRuntime,
  resolvePythonCommand,
  rootDir
} from "../../../scripts/service-runtime.mjs";

const runtimeEnv = loadRuntimeEnv();
const nodeRuntime = resolveNodeRuntime(runtimeEnv);
const pythonRuntime = resolvePythonCommand(runtimeEnv);

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
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
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

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { error: rawText || "Request failed" };
  }
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed");
  }
  return data;
}

function writeDeepSeekChatResponse(response, content) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(content)
          }
        }
      ]
    })
  );
}

function createTurnDiagnosisPayload() {
  return {
    input_type: "answer",
    key_claim: "用户知道 AQS 负责 acquire/release 的排队、阻塞和唤醒。",
    confirmed_understanding: "已经抓到 acquire/release 主链。",
    judgment_reason: "你已经抓到 acquire/release 主链，但还没有展开阻塞和唤醒之间的完整协作。",
    has_misconception: false,
    misconception_detail: ""
  };
}

function handleMockProviderRequest(request, response, envelopePayload) {
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    response.writeHead(404);
    response.end();
    return;
  }

  let rawBody = "";
  request.on("data", (chunk) => {
    rawBody += chunk.toString("utf8");
  });
  request.on("end", () => {
    const payload = rawBody.includes("Generate exactly one learner-facing question")
      ? {
          question: "动态诊断：如果 ReentrantLock 建在 AQS 之上，独占 acquire/release 主链路你会怎么解释？",
          intent: "验证用户是否能把 state、入队、阻塞和 release 唤醒串起来。"
        }
      : rawBody.includes("learning diagnosis engine")
        ? createTurnDiagnosisPayload()
        : envelopePayload;
    writeDeepSeekChatResponse(response, payload);
  });
}

test("ai-service observability flow emits traceable logs and snapshot bundles", async (t) => {
  const repoRoot = rootDir;
  const snapshotRoot = path.join(repoRoot, ".omx/tmp-test-snapshots");
  fs.rmSync(snapshotRoot, { recursive: true, force: true });

  const mockProvider = http.createServer((request, response) => {
    handleMockProviderRequest(request, response, {
      runtime_map: {
        anchor_id: "aqs-acquire-release",
        turn_signal: "positive",
        anchor_assessment: {
          state: "partial",
          score: 72,
          reasons: ["用户已经抓到 acquire/release 主链。"]
        },
        hypotheses: [
          {
            id: "aqs-mainline",
            status: "supported",
            evidence_refs: ["ev-aqs-1"],
            note: "已经提到排队、阻塞与唤醒。"
          }
        ],
        misunderstandings: [],
        open_questions: ["那你再补充一下 AQS 为什么是同步器底座？"],
        verification_targets: [
          {
            id: "verify-aqs",
            question: "那你再补充一下 AQS 为什么是同步器底座？",
            why: "验证是否理解框架角色。"
          }
        ],
        info_gain_level: "medium"
      },
      next_move: {
        intent: "继续围绕当前点推进。",
        reason: "用户已经有方向，可以继续压实表述。",
        expected_gain: "medium",
        ui_mode: "verify",
        follow_up_question: "那你再补充一下，为什么它是同步器底座而不是一把锁？"
      },
      writeback_suggestion: {
        should_write: true,
        mode: "update",
        reason: "new_high_value_partial_signal",
        anchor_patch: {
          state: "partial",
          score: 72,
          derived_principle: "AQS 负责同步器通用获取/释放框架。"
        }
      }
    });
  });

  await new Promise((resolve) => mockProvider.listen(0, "127.0.0.1", resolve));
  const providerPort = mockProvider.address().port;
  const aiPort = 18210;
  const bffPort = 14210;

  const ai = startProcess(
    pythonRuntime.command,
    [...pythonRuntime.prefixArgs, "-m", "uvicorn", "app.main:app", "--port", String(aiPort), "--app-dir", "ai-service"],
    {
      cwd: repoRoot,
      env: {
        ...runtimeEnv,
        APP_ENV: "test",
        LLAI_LLM_ENABLED: "true",
        LLAI_LLM_PROVIDER: "DEEPSEEK",
        LLAI_DEEPSEEK_API_KEY: "dummy-key",
        LLAI_DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}`,
        LLAI_DEEPSEEK_MODEL: "deepseek-chat",
        LLAI_SNAPSHOT_ROOT: ".omx/tmp-test-snapshots"
      }
    }
  );

  const bff = startProcess(
    nodeRuntime.command,
    ["bff/src/server.js"],
    {
      cwd: repoRoot,
      env: {
        ...runtimeEnv,
        PORT: String(bffPort),
        AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`
      }
    }
  );

  t.after(async () => {
    bff.child.kill("SIGTERM");
    ai.child.kill("SIGTERM");
    await new Promise((resolve) => mockProvider.close(resolve));
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  });

  await waitForJson(`http://127.0.0.1:${aiPort}/api/health`);
  await waitForJson(`http://127.0.0.1:${bffPort}/api/health`);

  const login = await postJson(`http://127.0.0.1:${bffPort}/api/auth/login`, {
    handle: `obs_${Date.now()}`,
    pin: "1234"
  });
  const session = await postJson(`http://127.0.0.1:${bffPort}/api/interview/start-target`, {
    userId: login.profile.user.id,
    interactionPreference: "balanced"
  });
  await postJson(`http://127.0.0.1:${bffPort}/api/interview/answer`, {
    sessionId: session.sessionId,
    answer: "AQS 负责 acquire/release 的排队、阻塞和唤醒。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  let logLines = [];
  let requestStarted = null;
  let llmCompleted = null;
  let businessResult = null;
  let traceId = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshotDirs = fs.existsSync(snapshotRoot)
      ? fs.readdirSync(snapshotRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    traceId = snapshotDirs.at(-1)?.name || traceId;
    logLines = ai.readStdout()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (traceId) {
      requestStarted = logLines.find((entry) => entry.event === "request_started" && entry.path === "/api/interview/answer" && entry.trace_id === traceId) || null;
      llmCompleted = logLines.find((entry) => entry.event === "llm_call_completed" && entry.request_path === "/api/interview/answer" && entry.trace_id === traceId) || null;
      businessResult = logLines.find((entry) => entry.event === "business_result_generated" && entry.request_path === "/api/interview/answer" && entry.trace_id === traceId) || null;
    }
    if (traceId && requestStarted && llmCompleted && businessResult) {
      break;
    }
    await sleep(150);
  }

  assert.ok(traceId);

  const snapshotDir = path.join(snapshotRoot, traceId);
  const snapshotFile = path.join(snapshotDir, "debug_bundle.json");
  for (let attempt = 0; attempt < 20 && !fs.existsSync(snapshotFile); attempt += 1) {
    await sleep(100);
  }
  assert.equal(fs.existsSync(snapshotFile), true);

  const bundle = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  assert.equal(bundle.trace_id, traceId);
  assert.ok(Array.isArray(bundle.messages));
  assert.ok(typeof bundle.raw_response === "string" && bundle.raw_response.length > 0);
  assert.ok(bundle.parsed);
  assert.ok(bundle.versions);
  assert.match(bundle.raw_response, /runtime_map/);

  assert.doesNotMatch(ai.readStderr(), /Traceback|SyntaxError/i);
  assert.doesNotMatch(bff.readStderr(), /Error:|Unhandled/i);
});

test("ai-service normalizes provider aliases for state and signal before orchestration", async (t) => {
  const repoRoot = rootDir;
  const mockProvider = http.createServer((request, response) => {
    handleMockProviderRequest(request, response, {
      runtime_map: {
        anchor_id: "aqs-acquire-release",
        turn_signal: "正向",
        anchor_assessment: {
          state: "部分掌握",
          score: 72,
          reasons: ["用户已经碰到 acquire/release 主链，但解释还不够完整。"]
        },
        hypotheses: [],
        misunderstandings: [],
        open_questions: ["那你再补一句，它为什么是同步器底座？"],
        verification_targets: [],
        info_gain_level: "medium"
      },
      next_move: {
        intent: "先接住用户已经说对的部分，再补一个更窄的验证问题。",
        reason: "当前缺口主要在框架角色和抽象边界。",
        expected_gain: "medium",
        ui_mode: "verify",
        follow_up_question: "那你再补一句，为什么它是同步器底座而不是一把具体锁？"
      },
      writeback_suggestion: {
        should_write: true,
        mode: "update",
        reason: "new_high_value_partial_signal",
        anchor_patch: {
          state: "部分掌握",
          score: 72,
          derived_principle: "用户已经知道 AQS 负责通用同步器协调框架。"
        }
      }
    });
  });

  await new Promise((resolve) => mockProvider.listen(0, "127.0.0.1", resolve));
  const providerPort = mockProvider.address().port;
  const aiPort = 18211;
  const bffPort = 14211;

  const ai = startProcess(
    pythonRuntime.command,
    [...pythonRuntime.prefixArgs, "-m", "uvicorn", "app.main:app", "--port", String(aiPort), "--app-dir", "ai-service"],
    {
      cwd: repoRoot,
      env: {
        ...runtimeEnv,
        APP_ENV: "test",
        LLAI_LLM_ENABLED: "true",
        LLAI_LLM_PROVIDER: "DEEPSEEK",
        LLAI_DEEPSEEK_API_KEY: "dummy-key",
        LLAI_DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}`,
        LLAI_DEEPSEEK_MODEL: "deepseek-chat"
      }
    }
  );

  const bff = startProcess(
    nodeRuntime.command,
    ["bff/src/server.js"],
    {
      cwd: repoRoot,
      env: {
        ...runtimeEnv,
        PORT: String(bffPort),
        AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`
      }
    }
  );

  t.after(async () => {
    bff.child.kill("SIGTERM");
    ai.child.kill("SIGTERM");
    await new Promise((resolve) => mockProvider.close(resolve));
  });

  await waitForJson(`http://127.0.0.1:${aiPort}/api/health`);
  await waitForJson(`http://127.0.0.1:${bffPort}/api/health`);

  const login = await postJson(`http://127.0.0.1:${bffPort}/api/auth/login`, {
    handle: `obs_alias_${Date.now()}`,
    pin: "1234"
  });
  const session = await postJson(`http://127.0.0.1:${bffPort}/api/interview/start-target`, {
    userId: login.profile.user.id,
    interactionPreference: "balanced"
  });
  const answered = await postJson(`http://127.0.0.1:${bffPort}/api/interview/answer`, {
    sessionId: session.sessionId,
    answer: "AQS 负责 acquire/release 的排队、阻塞和唤醒。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.equal(answered.latestFeedback.judge.state, "partial");
  assert.equal(answered.latestFeedback.signal, "positive");
  assert.equal(answered.latestFeedback.action, "deepen");
  assert.ok((answered.currentProbe || "").length > 0);
});
