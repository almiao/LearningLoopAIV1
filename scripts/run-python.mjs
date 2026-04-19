#!/usr/bin/env node

import { spawn } from "node:child_process";
import { loadRuntimeEnv, resolvePythonCommand } from "./service-runtime.mjs";

const runtimeEnv = loadRuntimeEnv();
const pythonSpec = resolvePythonCommand(runtimeEnv);
const child = spawn(
  pythonSpec.command,
  [...pythonSpec.prefixArgs, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    windowsHide: true,
    env: runtimeEnv,
  }
);

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
