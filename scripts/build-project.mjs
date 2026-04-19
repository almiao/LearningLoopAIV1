#!/usr/bin/env node

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
  "ai-service/app/engine/tutor_policy.py",
  "ai-service/app/engine/context_packet.py",
  "ai-service/app/engine/java_guide_source_reader.py",
  "ai-service/app/engine/turn_envelope.py",
  "ai-service/app/engine/tutor_intelligence.py",
  "ai-service/app/engine/session_engine.py",
];

const nodeCheckFiles = [
  "bff/src/server.js",
  "scripts/service-runtime.mjs",
  "scripts/start-services.mjs",
  "scripts/stop-services.mjs",
  "scripts/run-python.mjs",
  "scripts/build-project.mjs",
];

async function main() {
  const runtimeEnv = loadRuntimeEnv();
  const nodeRuntime = resolveNodeRuntime(runtimeEnv);
  const pythonSpec = resolvePythonCommand(runtimeEnv);

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
    }
  );

  await ensureFrontendDependencies(runtimeEnv, nodeRuntime);
  await buildFrontend(runtimeEnv, 4000, nodeRuntime);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
