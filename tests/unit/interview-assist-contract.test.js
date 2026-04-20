import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("interview assist service stays independent from generic tutor session modules and old rule tables", async () => {
  const source = await readFile(`${root}/ai-service/app/interview_assist/service.py`, "utf8");

  assert.doesNotMatch(source, /session_engine/);
  assert.doesNotMatch(source, /tutor_policy/);
  assert.doesNotMatch(source, /context_packet/);
  assert.doesNotMatch(source, /topic_knowledge/);
  assert.doesNotMatch(source, /_detect_question_type/);
  assert.doesNotMatch(source, /_fallback_key_points/);
});

test("frontend interview assist page targets the independent agent base URL and stream endpoint", async () => {
  const apiSource = await readFile(`${root}/frontend/lib/interview-assist-api.js`, "utf8");
  const workspaceSource = await readFile(`${root}/frontend/components/interview-assist-workspace.js`, "utf8");
  const livekitServerSource = await readFile(`${root}/livekit-agent/src/server.js`, "utf8");

  assert.match(apiSource, /NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL/);
  assert.match(apiSource, /127\.0\.0\.1:4200/);
  assert.match(apiSource, /\/api\/interview-assist\/answer-stream/);
  assert.doesNotMatch(apiSource, /\/api\/interview-assist\/first-screen",/);
  assert.doesNotMatch(workspaceSource, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(workspaceSource, /createLocalAudioTrack/);
  assert.match(livekitServerSource, /livekit-server-sdk/);
  assert.match(livekitServerSource, /AgentDispatchClient/);
});
