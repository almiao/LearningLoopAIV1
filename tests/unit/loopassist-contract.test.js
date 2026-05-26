import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("LoopAssist prompt contract keeps process output to one interviewer message", async () => {
  const source = await readFile(`${root}/ai-service/app/loopassist/service.py`, "utf8");

  assert.match(source, /build_interviewer_prompt/);
  assert.match(source, /build_interview_plan_prompt/);
  assert.match(source, /生成一份可展示给候选人的面试大纲/);
  assert.match(source, /为什么这么安排/);
  assert.match(source, /sourceExplanation/);
  assert.match(source, /只输出下一句面试官要说的话/);
  assert.match(source, /不要输出评分、诊断、答案提示/);
  assert.match(source, /内部面试计划/);
  assert.match(source, /简历与岗位 JD 上下文/);
  assert.match(source, /不能因为上一轮回答随意跑到计划外主题/);
  assert.match(source, /输出必须是合法 JSON：\{\\\"text\\\"/);
  assert.match(source, /build_review_prompt/);
  assert.match(source, /readinessScore/);
});

test("LoopAssist interview room keeps side panel transcript-only", async () => {
  const source = await readFile(`${root}/frontend/components/loopassist-workspace.js`, "utf8");
  const transcriptAside = source.slice(source.indexOf("loopassist-history-drawer"));

  assert.match(source, /synthesizeLoopAssistSpeech/);
  assert.match(source, /createRealtimeSession/);
  assert.match(source, /mode: "assist_interviewer"/);
  assert.match(source, /createLivekitTransport\(\{ sessionId: realtimeSession\.sessionId \}\)/);
  assert.match(source, /transport\.livekitUrl/);
  assert.match(source, /transport\.participantToken/);
  assert.doesNotMatch(source, /transport\.url|transport\.token/);
  assert.match(source, /仅支持语音回答/);
  assert.match(source, /loopassist-start-answer/);
  assert.match(source, /loopassist-finish-answer/);
  assert.match(source, /loopassist-scope-toggle/);
  assert.match(source, /loopassist-scope-popover/);
  assert.match(source, /ttsStatus/);
  assert.match(source, /answerSegmentsRef/);
  assert.doesNotMatch(source, /submitVoiceAnswer\(finalText\)/);
  assert.match(source, /loopassist-resume-text/);
  assert.match(source, /loopassist-jd-text/);
  assert.match(source, /loopassist-plan/);
  assert.doesNotMatch(source, /typedAnswer|manualFallback|文字兜底|输入你的回答/);
  assert.doesNotMatch(source, /即时回答支架|本轮节奏|answerScaffold|prepGoals|loopassist-stage-list/);
  assert.match(source, /loopassist-history-drawer/);
  assert.match(source, /历史记录/);
  assert.match(transcriptAside, /turn\.role === "interviewer"/);
  assert.doesNotMatch(transcriptAside, /seedId|source|scope|diagnostic|hint/i);
});

test("LoopAssist TTS is proxied through the local worker", async () => {
  const workerSource = await readFile(`${root}/ai-service/app/loopassist/tts_worker.py`, "utf8");
  const bffSource = await readFile(`${root}/bff/src/server.js`, "utf8");
  const clientSource = await readFile(`${root}/frontend/lib/loopassist-api.js`, "utf8");
  const startScript = await readFile(`${root}/scripts/start-services.mjs`, "utf8");

  assert.match(workerSource, /@app\.post\("\/api\/tts"\)/);
  assert.match(workerSource, /@app\.post\("\/api\/warmup"\)/);
  assert.match(workerSource, /synthesize_loopassist_tts/);
  assert.match(bffSource, /TTS_SERVICE_URL/);
  assert.match(bffSource, /proxyBinary\(ttsServiceUrl, "POST", "\/api\/tts"/);
  assert.match(clientSource, /synthesizeLoopAssistSpeech/);
  assert.match(startScript, /tts-worker/);
  assert.match(startScript, /TTS_WORKER_PORT/);
});
