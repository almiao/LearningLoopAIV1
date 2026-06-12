#!/usr/bin/env node
// 真·端到端测试 (full §8 MVP chain through BFF):
//   登录 → start-target → answer → ledger write → /api/review/today
//
// 关键:走 BFF /api/interview/answer,触发 handleAnswer 里的 extractLastPracticeRound +
// practicePassthrough。这才是真实用户路径,不是绕开 BFF 的 unit smoke。
//
// 跑法 (前提:npm start 跑着):  node scripts/e2e-ledger-loop.mjs
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ledgerPath = path.resolve(path.dirname(__filename), "../.omx/review-ledger/ledger.json");
const aiLogPath = path.resolve(path.dirname(__filename), "../.omx/logs/split-services/ai-service.log");
const bff = process.env.BFF_URL || "http://127.0.0.1:4000";

const log = (s, m) => console.log(`[${s}] ${m}`);
const fail = (s, m) => { console.error(`[${s}] FAIL: ${m}`); process.exit(1); };

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}: ${text.slice(0, 240)}`);
  return data;
}

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// Clean ledger so we observe a genuine new write.
try { await rm(ledgerPath, { force: true }); log("setup", "cleared old ledger"); } catch {}

// Record where ai-service.log currently ends, so we only diff new lines.
let logCursor = 0;
try { logCursor = (await readFile(aiLogPath, "utf8")).length; } catch {}
log("setup", `ai-service.log cursor at ${logCursor} bytes`);

// 1. Login (auto-creates user). Use a deterministic handle so re-runs reuse the same user.
const loginRes = await post(`${bff}/api/auth/login`, {
  handle: "e2e-ledger-smoke",
  pin: "0000",
}).catch((e) => fail("1", e.message));
const userId = loginRes?.profile?.user?.id;
if (!userId) fail("1", `no userId in login response: ${JSON.stringify(loginRes).slice(0,200)}`);
log("1", `ok: userId=${userId}${loginRes.created ? " (newly created)" : " (existing)"}`);

// 2. start-target with a real doc — this is the true user path (open a doc in /learn,
//    answer questions). Without docPath the source is baseline-pack only, source_ref
//    ends up empty, and the resulting review item is unanchored (correct behavior, but
//    not a useful E2E target). We pick a known JavaGuide doc.
const docPath = "docs/ai/agent/agent-basis.md";
const start = await post(`${bff}/api/interview/start-target`, {
  userId,
  docPath,
  targetBaselineId: "bigtech-java-backend",
  forceNewSession: true,
  interactionPreference: "balanced",
}).catch((e) => fail("2", e.message));

const sessionId = start?.sessionId;
const firstQuestion = start?.currentProbe || (start?.turns || []).find?.((t) => t?.role === "tutor" && t?.kind === "question")?.content;
if (!sessionId || !firstQuestion) {
  fail("2", `missing sessionId or first question. keys: ${Object.keys(start || {}).join(",")}`);
}
log("2", `ok: sessionId=${sessionId}`);
log("2", `   first question: ${String(firstQuestion).slice(0,100)}...`);

// 3. Answer with a deliberately weak answer (we want the judge to fail it).
const weakAnswer = "不太确定,大概就是那个意思吧,具体我也说不清楚,看场景。";
log("3", `submitting weak answer (${weakAnswer.length} chars)`);
const ans = await post(`${bff}/api/interview/answer`, {
  sessionId,
  answer: weakAnswer,
  burdenSignal: "normal",
}).catch((e) => fail("3", e.message));
log("3", `ok: answer accepted, traceId=${ans?.traceId || "?"}`);

// Give the detached passthrough a moment to write (it's `await`ed but DNS/LLM round-trip).
await new Promise((r) => setTimeout(r, 1500));

// 4. Verify ai-service.log shows the anchor-judge call (proves passthrough fired through HTTP path).
let logTail = "";
try { logTail = (await readFile(aiLogPath, "utf8")).slice(logCursor); } catch {}
const judgeHit = /anchor-judge|anchor_judge/i.test(logTail);
if (!judgeHit) {
  console.error("[4] FAIL: no anchor-judge call appears in ai-service.log since this run.");
  console.error("   Last 1500 bytes of new log:");
  console.error(logTail.slice(-1500));
  process.exit(1);
}
log("4", "ok: ai-service.log shows anchor-judge call during this run");

// 5. Verify ledger file got a new item.
let ledger;
try { ledger = JSON.parse(await readFile(ledgerPath, "utf8")); } catch (e) {
  fail("5", `ledger not on disk: ${e.message}`);
}
if (!Array.isArray(ledger?.items) || ledger.items.length === 0) fail("5", "ledger has no items");
const last = ledger.items[ledger.items.length - 1];
log("5", `ok: ledger has ${ledger.items.length} item(s), latest:`);
log("5", `    handle:     ${last.handle}`);
log("5", `    source_ref: ${last.source_ref || "(empty — practice was unsourced)"}`);
log("5", `    state:      ${last.state}, missed anchors: ${last.evidence.missedAnchors.length}`);
log("5", `    next_due_at: ${last.next_due_at}`);

// The source_ref should match the docPath we sent — this is the integration point
// that the home page uses to decide whether the row is clickable.
if (last.source_ref !== docPath) {
  fail("5", `source_ref mismatch — expected ${docPath}, got "${last.source_ref}". Re-practice click will not work.`);
}
log("5", `ok: source_ref matches docPath — re-practice click from home will land at /learn?doc=${docPath}`);

// 6. /api/review/today — only items due by `now` should appear. A fresh shaky item is +1d.
const today = await get(`${bff}/api/review/today`);
log("6", `GET /api/review/today → count=${today.count} (fresh shaky items are next_due_at = +1d; 0 here is correct)`);

console.log("\n✅ FULL E2E LOOP VERIFIED through BFF.");
console.log("   /learn practice → BFF handleAnswer → anchor-judge LLM → ledger write → /api/review/today");
console.log("   Item will appear on home page tomorrow (correct interval-review behavior).");
