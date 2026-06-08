#!/usr/bin/env node
// npm run eval:judge — anchor-judge calibration regression.
//
// Loads .env.local (so LLM keys are present), then runs the Python eval. Pure
// pass-through of exit code:
//   0 = within targets
//   1 = calibration breached (lenient leak, overstrict, etc.)
//   2 = invalid (upstream errors prevented measurement; no key, etc.)
//
// To force the heuristic double (no LLM call), set APP_ENV=test.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const envPath = path.join(repoRoot, ".env.local");
const aiServiceDir = path.join(repoRoot, "ai-service");

const env = { ...process.env };
try {
  const raw = await readFile(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    // Don't clobber values already present in the process env.
    if (!(key in env)) env[key] = value;
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  console.warn("(no .env.local; assuming env vars already in shell)");
}

const child = spawn("python3", ["evals/run_anchor_judge_eval.py"], {
  cwd: aiServiceDir,
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
