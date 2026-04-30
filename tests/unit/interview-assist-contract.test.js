import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("interview assist service stays independent from generic tutor session modules and old rule tables", async () => {
  const source = await readFile(`${root}/ai-service/app/interview_assist/service.py`, "utf8");

  assert.doesNotMatch(source, /session_engine/);
  assert.doesNotMatch(source, /context_packet/);
  assert.doesNotMatch(source, /topic_knowledge/);
  assert.doesNotMatch(source, /_detect_question_type/);
  assert.doesNotMatch(source, /_fallback_key_points/);
});

test("frontend interview assist page targets the independent agent base URL and stream endpoint", async () => {
  const apiSource = await readFile(`${root}/frontend/lib/interview-assist-api.js`, "utf8");
  const workspaceSource = await readFile(`${root}/frontend/components/interview-assist-workspace.js`, "utf8");

  assert.match(apiSource, /NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL/);
  assert.match(apiSource, /127\.0\.0\.1:8000/);
  assert.match(apiSource, /127\.0\.0\.1:4200/);
  assert.match(apiSource, /\/api\/interview-assist\/realtime-session/);
  assert.match(apiSource, /\/api\/interview-assist\/livekit-transport/);
  assert.match(apiSource, /\/api\/interview-assist\/voice-demo/);
  assert.doesNotMatch(workspaceSource, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(workspaceSource, /new Room\(\)/);
  assert.match(workspaceSource, /RoomEvent\.DataReceived/);
  assert.match(workspaceSource, /setMicrophoneEnabled\(true\)/);
  assert.match(workspaceSource, /uploadVoiceDemo/);
  assert.match(workspaceSource, /useState\("interviewer"\)/);
  assert.match(workspaceSource, /useState\("assist_candidate"\)/);
  assert.match(workspaceSource, /assist-settings-panel/);
  assert.match(workspaceSource, /renderMarkdownContent/);
  assert.match(workspaceSource, /coreMarkdown/);
  assert.doesNotMatch(workspaceSource, /dangerouslySetInnerHTML/);
});

test("interview assist transport keeps a minimal livekit dependency surface", async () => {
  const frontendPackage = JSON.parse(await readFile(`${root}/frontend/package.json`, "utf8"));
  const livekitAgentPackage = JSON.parse(await readFile(`${root}/livekit-agent/package.json`, "utf8"));

  assert.equal(frontendPackage.dependencies["livekit-client"], "^2.18.2");
  assert.equal(frontendPackage.dependencies["@livekit/components-react"], undefined);
  assert.equal(frontendPackage.dependencies["@livekit/components-styles"], undefined);

  assert.equal(livekitAgentPackage.scripts.start, "node src/server.js");
  assert.equal(livekitAgentPackage.scripts["start:server"], "node src/server.js");
  assert.equal(livekitAgentPackage.scripts["start:worker"], undefined);
  assert.equal(livekitAgentPackage.dependencies["@livekit/agents"], undefined);
  assert.equal(livekitAgentPackage.dependencies["@livekit/agents-plugin-livekit"], undefined);
  assert.equal(livekitAgentPackage.dependencies["@livekit/agents-plugin-silero"], undefined);
  assert.equal(livekitAgentPackage.dependencies["@livekit/protocol"], undefined);
  assert.equal(typeof livekitAgentPackage.dependencies["@livekit/rtc-node"], "string");
  assert.equal(typeof livekitAgentPackage.dependencies["livekit-server-sdk"], "string");
});

test("interview assist code keeps a single markdown-based realtime flow without debug side channels", async () => {
  const apiSource = await readFile(`${root}/frontend/lib/interview-assist-api.js`, "utf8");
  const workspaceSource = await readFile(`${root}/frontend/components/interview-assist-workspace.js`, "utf8");
  const bridgeSource = await readFile(`${root}/livekit-agent/src/bridge.js`, "utf8");
  const transportServerSource = await readFile(`${root}/livekit-agent/src/server.js`, "utf8");
  const assistServiceSource = await readFile(`${root}/ai-service/app/interview_assist/service.py`, "utf8");

  assert.doesNotMatch(apiSource, /livekit-room-debug/);
  assert.doesNotMatch(workspaceSource, /getLivekitRoomDebug/);
  assert.doesNotMatch(workspaceSource, /roomDebugSnapshot/);
  assert.doesNotMatch(workspaceSource, /NO_VALID_AUDIO_ERROR/);
  assert.doesNotMatch(workspaceSource, /framework_delta|framework_done/);
  assert.doesNotMatch(workspaceSource, /frameworkPoints|detailBlocks/);
  assert.doesNotMatch(bridgeSource, /persistCapturedAudioCase|INTERVIEW_ASSIST_CAPTURE_DIR|bridge_audio_case/);
  assert.doesNotMatch(transportServerSource, /livekit-room-debug/);
  assert.doesNotMatch(assistServiceSource, /frameworkPoints|detailBlocks/);
});
