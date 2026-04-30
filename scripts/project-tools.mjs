#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAutomatedEval } from "../tests/eval/automated-eval.js";
import {
  buildFrontend,
  ensureFrontendDependencies,
  loadRuntimeEnv,
  resolveNodeRuntime,
  resolvePythonCommand,
  rootDir,
  runCommand,
  runNodeCommand,
} from "./service-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pythonFiles = [
  "ai-service/app/main.py",
  "ai-service/app/core/config.py",
  "ai-service/app/core/tracing.py",
  "ai-service/app/observability/events.py",
  "ai-service/app/observability/logger.py",
  "ai-service/app/infra/llm/snapshot.py",
  "ai-service/app/infra/llm/client.py",
  "ai-service/app/domain/interview/parsers.py",
  "ai-service/app/domain/interview/validators.py",
  "ai-service/app/engine/control_intents.py",
  "ai-service/app/engine/context_packet.py",
  "ai-service/app/engine/turn_envelope.py",
  "ai-service/app/engine/tutor_intelligence.py",
  "ai-service/app/engine/session_engine.py",
  "ai-service/app/interview_assist/__init__.py",
  "ai-service/app/interview_assist/service.py",
  "ai-service/app/interview_assist/aliyun_realtime_asr.py",
  "ai-service/tests/test_tutor_provider_config.py",
];

const nodeCheckFiles = [
  "bff/src/server.js",
  "superapp-service/src/server.js",
  "scripts/service-runtime.mjs",
  "scripts/start-services.mjs",
  "scripts/stop-services.mjs",
  "scripts/project-tools.mjs",
];

const testFiles = [
  "tests/e2e/split-services.spec.js",
  "tests/integration/ai-service/parity-flow.test.js",
  "tests/integration/ai-service/observability-flow.test.js",
  "tests/integration/ai-service/automated-eval-module.test.js",
  "tests/integration/user/profile-flow.test.js",
  "tests/integration/interview-assist/flow.test.js",
  "tests/unit/split-entrypoints.test.js",
  "tests/unit/interview-assist-contract.test.js",
  "tests/unit/superapp/reminder-candidate.test.js",
];

const requiredCaseKeys = [
  "id",
  "topic",
  "source",
  "user_goal",
  "transcript",
  "observed_problems",
  "desired_behavior",
  "success_signals",
];

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"];
    }),
  );
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/project-tools.mjs <command> [--key=value]",
      "",
      "Commands:",
      "  build            Run the repo build checks used by restart:full",
      "  test             Run the repo Node test suite",
      "  smoke:split      Run the split-services smoke check",
      "  validate:cases   Validate tests/cases JSON documents",
      "  eval:auto        Run automated persona evaluations",
    ].join("\n"),
  );
}

async function runBuild() {
  const runtimeEnv = loadRuntimeEnv();
  const nodeRuntime = resolveNodeRuntime(runtimeEnv);
  const pythonSpec = resolvePythonCommand(runtimeEnv);
  const bffPort = parsePort(runtimeEnv.BFF_PORT, 4000);
  const aiPort = parsePort(runtimeEnv.AI_PORT, 8000);

  console.log(`Using Node.js ${nodeRuntime.version} from ${nodeRuntime.command}`);

  for (const file of nodeCheckFiles) {
    await runNodeCommand(nodeRuntime, ["--check", file], {
      cwd: rootDir,
      env: runtimeEnv,
    });
  }

  await runCommand(
    pythonSpec.command,
    [...pythonSpec.prefixArgs, "-m", "py_compile", ...pythonFiles],
    {
      cwd: rootDir,
      env: runtimeEnv,
    },
  );

  await ensureFrontendDependencies(runtimeEnv, nodeRuntime);
  await buildFrontend(runtimeEnv, bffPort, aiPort, nodeRuntime);
  await runCommand("bash", ["-n", "start-dev.sh"], {
    cwd: rootDir,
    env: runtimeEnv,
  });
}

async function runTests() {
  const runtimeEnv = loadRuntimeEnv();
  const nodeRuntime = resolveNodeRuntime(runtimeEnv);

  console.log(`Using Node.js ${nodeRuntime.version} from ${nodeRuntime.command}`);
  for (const testFile of testFiles) {
    await runNodeCommand(nodeRuntime, ["--test", "--test-timeout=120000", testFile], {
      cwd: rootDir,
      env: {
        ...runtimeEnv,
        APP_ENV: "test",
        LLAI_LLM_ENABLED: "false",
        LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE: "1",
      },
    });
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${url} -> ${data.error || data.detail || response.status}`);
  }
  return data;
}

async function runSplitSmoke() {
  const bffBaseUrl = process.env.BFF_BASE_URL || "http://127.0.0.1:4000";
  const frontendBaseUrl = process.env.FRONTEND_BASE_URL || "http://127.0.0.1:3000";

  const login = await fetchJson(`${bffBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handle: `smoke_${Date.now()}`,
      pin: "1234",
    }),
  });

  const baselines = await fetchJson(`${bffBaseUrl}/api/baselines`);
  const targetBaselineId = baselines.baselines?.[0]?.id;
  if (!targetBaselineId) {
    throw new Error("No baseline available for smoke test.");
  }

  const session = await fetchJson(`${bffBaseUrl}/api/interview/start-target`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: login.profile.user.id,
      targetBaselineId,
      interactionPreference: "balanced",
    }),
  });

  const answered = await fetchJson(`${bffBaseUrl}/api/interview/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      answer: "AQS 通过同步状态、队列和阻塞唤醒来承接独占获取释放。",
      burdenSignal: "normal",
      interactionPreference: "balanced",
    }),
  });

  const profile = await fetchJson(`${bffBaseUrl}/api/profile/${login.profile.user.id}`);
  const frontendHome = await fetch(frontendBaseUrl);
  const frontendHtml = await frontendHome.text();
  if (!frontendHome.ok) {
    throw new Error(`Frontend smoke failed with status ${frontendHome.status}`);
  }
  if (!/Learning Loop AI/.test(frontendHtml)) {
    throw new Error("Frontend smoke failed: homepage copy missing.");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        userId: login.profile.user.id,
        sessionId: session.sessionId,
        currentProbe: answered.currentProbe,
        targetCount: profile.summary.totalTargets,
        frontendTitleMatched: true,
      },
      null,
      2,
    ),
  );
}

function validateCaseShape(data) {
  for (const key of requiredCaseKeys) {
    if (!(key in data)) {
      throw new Error(`missing key: ${key}`);
    }
  }

  if (!Array.isArray(data.transcript) || data.transcript.length < 2) {
    throw new Error("transcript must have at least 2 turns");
  }
  if (!Array.isArray(data.observed_problems) || data.observed_problems.length === 0) {
    throw new Error("observed_problems must be non-empty");
  }
  if (!Array.isArray(data.desired_behavior) || data.desired_behavior.length === 0) {
    throw new Error("desired_behavior must be non-empty");
  }
  if (!Array.isArray(data.success_signals) || data.success_signals.length === 0) {
    throw new Error("success_signals must be non-empty");
  }
}

async function validateCases() {
  const casesDir = path.resolve(__dirname, "../tests/cases");
  const files = (await readdir(casesDir))
    .filter((file) => file.endsWith("-user-case.json"))
    .sort();

  const results = [];
  const topicStats = {};

  for (const file of files) {
    const raw = await readFile(path.join(casesDir, file), "utf8");
    const data = JSON.parse(raw);
    validateCaseShape(data);
    topicStats[data.topic] = {
      transcriptTurns: data.transcript.length,
      observedProblems: data.observed_problems.length,
      desiredBehavior: data.desired_behavior.length,
      successSignals: data.success_signals.length,
    };
    results.push({
      file,
      id: data.id,
      topic: data.topic,
      transcriptTurns: data.transcript.length,
      observedProblems: data.observed_problems.length,
    });
  }

  console.log(
    JSON.stringify(
      {
        caseCount: results.length,
        cases: results,
        topics: topicStats,
      },
      null,
      2,
    ),
  );
}

async function runAutomatedEvalCommand(args) {
  const runs = Number(args.runs || 1);
  const rounds = Number(args.rounds || 8);
  const seed = args.seed || Date.now();
  const bffBaseUrl = args.url || "http://127.0.0.1:4000";
  const outputDir = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.resolve(__dirname, "../.omx/automated-evals", String(Date.now()));
  const personasDir = args.personas
    ? path.resolve(process.cwd(), args.personas)
    : path.resolve(__dirname, "../tests/personas");
  const interactionPreference = args.preference || "balanced";
  const targetBaselineId = args.baseline || "";
  const learnerMode = args.mode || "heuristic-random";

  const result = await runAutomatedEval({
    bffBaseUrl,
    runs,
    rounds,
    outputDir,
    seed,
    personasDir,
    interactionPreference,
    targetBaselineId,
    learnerMode,
  });

  console.log(JSON.stringify(result, null, 2));
}

const commands = {
  build: () => runBuild(),
  test: () => runTests(),
  "smoke:split": () => runSplitSmoke(),
  "validate:cases": () => validateCases(),
  "eval:auto": (args) => runAutomatedEvalCommand(args),
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  const runner = commands[command];
  if (!runner) {
    printHelp();
    throw new Error(`Unknown command: ${command}`);
  }

  await runner(parseArgs(rest));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
