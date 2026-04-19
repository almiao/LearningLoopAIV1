#!/usr/bin/env node

import {
  loadRuntimeEnv,
  resolveNodeRuntime,
  rootDir,
  runNodeCommand,
} from "./service-runtime.mjs";

const testFiles = [
  "tests/e2e/split-services.spec.js",
  "tests/integration/ai-service/parity-flow.test.js",
  "tests/integration/ai-service/observability-flow.test.js",
  "tests/integration/ai-service/automated-eval-module.test.js",
  "tests/integration/user/profile-flow.test.js",
  "tests/unit/split-entrypoints.test.js",
];

async function main() {
  const runtimeEnv = loadRuntimeEnv();
  const nodeRuntime = resolveNodeRuntime(runtimeEnv);

  console.log(`Using Node.js ${nodeRuntime.version} from ${nodeRuntime.command}`);
  await runNodeCommand(nodeRuntime, ["--test", ...testFiles], {
    cwd: rootDir,
    env: runtimeEnv,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
