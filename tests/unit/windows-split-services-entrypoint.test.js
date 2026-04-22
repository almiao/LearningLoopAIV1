import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("node split-services entrypoint starts the same service surface needed by the frontend", async () => {
  const startSource = await readFile(path.join(root, "scripts", "start-services.mjs"), "utf8");
  const runtimeSource = await readFile(path.join(root, "scripts", "service-runtime.mjs"), "utf8");

  assert.match(startSource, /Starting superapp service/);
  assert.match(startSource, /NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL/);
  assert.match(startSource, /superapp-service/);
  assert.match(startSource, /Starting AI service/);
  assert.match(startSource, /Starting frontend/);
  assert.doesNotMatch(startSource, /livekit-agent/);
  assert.doesNotMatch(startSource, /Starting local LiveKit server/);
  assert.match(runtimeSource, /"superapp-service"/);
  assert.match(runtimeSource, /"ai-service"/);
  assert.match(runtimeSource, /NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL/);
  assert.match(runtimeSource, /AI_PORT/);
  assert.doesNotMatch(runtimeSource, /"livekit-agent"/);
});
