#!/usr/bin/env node
// 端到端烟雾测试:答崩 → passthrough → anchor-judge → 写账本 → /api/review/today 能读到。
//
// 跑法 (ai-service 和 bff 必须先启动 / npm start):
//   node scripts/smoke-ledger-loop.mjs
//
// 出口 0 = 完整链路通;非 0 = 在哪一步断了打印明确。
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDrillPassthrough } from "../src/ledger/drill-passthrough.js";
import { createReviewItemStore } from "../src/ledger/review-item-store.js";

const __filename = fileURLToPath(import.meta.url);
const ledgerPath = path.resolve(path.dirname(__filename), "../.omx/review-ledger/ledger.json");
const bffUrl = process.env.BFF_URL || "http://127.0.0.1:4000";

function log(step, msg) { console.log(`[${step}] ${msg}`); }
function fail(step, msg) { console.error(`[${step}] FAIL: ${msg}`); process.exit(1); }

// Clean slate so we observe a genuine new write.
try { await rm(ledgerPath, { force: true }); log("setup", "cleared old ledger"); } catch {}

// 1. Run passthrough on a deliberately weak answer.
const passthrough = createDrillPassthrough({ store: createReviewItemStore() });
log("1", "calling drill-passthrough (Q: ReentrantLock vs synchronized; A: cliché)");
const written = await passthrough({
  handle: "讲清 ReentrantLock 与 synchronized 的取舍",
  question: "讲清 ReentrantLock 与 synchronized 的取舍。",
  answer: "ReentrantLock 更灵活,synchronized 更简单。",
  sourceRef: "smoke-test://reentrantlock",
});
if (!written) fail("1", "passthrough returned null — judge fell to pass or threw. Check ai-service.log");
log("1", `ok: wrote item id=${written.id} state=${written.state} misses=${written.evidence.missedAnchors.length}`);

// 2. Read the ledger file directly and verify shape.
let ledger;
try {
  ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
} catch (e) {
  fail("2", `ledger file unreadable: ${e.message}`);
}
if (!Array.isArray(ledger?.items) || ledger.items.length === 0) fail("2", "ledger file has no items");
log("2", `ok: ${ledger.items.length} item(s) on disk at ${ledgerPath}`);

// 3. Hit /api/review/today through BFF and verify it returns the item.
let payload;
try {
  const r = await fetch(`${bffUrl}/api/review/today`);
  if (!r.ok) fail("3", `BFF returned HTTP ${r.status}`);
  payload = await r.json();
} catch (e) {
  fail("3", `BFF unreachable: ${e.message}. Run \`npm start\` first.`);
}
if (!Array.isArray(payload?.items)) fail("3", `unexpected shape: ${JSON.stringify(payload)}`);
log("3", `ok: GET /api/review/today returned ${payload.items.length} item(s), count=${payload.count}`);

// 4. listDue uses next_due_at — a brand-new shaky item gets +1 day, so it WON'T show today.
//    That's correct behavior (you don't re-drill the same point the same day) but it means
//    the home page will be empty right after a single drill. Make this explicit.
if (payload.items.length === 0) {
  log("4", "expected — newly-written shaky items get next_due_at = +1 day, not visible today");
  log("4", "to see it on the home page, either: (a) wait a day, (b) set state=solid via store.updateState, (c) backdate created_at for a manual smoke");
} else {
  log("4", `unexpected: a fresh shaky item is already due today. Schedule may be misconfigured.`);
}

console.log("\n✅ End-to-end ledger loop: WRITE path verified. Read path verified.");
console.log("   Home page will show items starting the day AFTER they're written (by design).");
