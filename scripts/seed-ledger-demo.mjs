#!/usr/bin/env node
// 给账本塞 3 条「昨天答崩、今天到期」的样例项,让你立刻在首页看到渲染效果。
// 仅供视觉确认,不是测试也不是生产数据。
//
// 跑法:  npm run seed:ledger-demo
// 撤销:  rm .omx/review-ledger/ledger.json
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ledgerDir = path.resolve(path.dirname(__filename), "../.omx/review-ledger");
const ledgerPath = path.join(ledgerDir, "ledger.json");

const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
// next_due_at = 1 小时前 → listDue (now=现在) 一定会拉到。
const dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function id(handle) {
  const hash = createHash("sha1").update(`${handle}:${Math.random()}`).digest("hex").slice(0, 10);
  const slug = handle.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug}-${hash}`;
}

const items = [
  {
    id: id("讲清 ReentrantLock 与 synchronized 的取舍"),
    handle: "讲清 ReentrantLock 与 synchronized 的取舍",
    source_ref: "demo://java-concurrency",
    evidence: {
      question: "讲清 ReentrantLock 与 synchronized 的取舍。",
      missedAnchors: ["可中断/可定时的真实场景", "公平锁代价", "性能权衡", "释放方式差异"],
    },
    state: "shaky",
    streak: 0,
    created_at: yesterday,
    last_seen_at: yesterday,
    next_due_at: dueAt,
  },
  {
    id: id("HTTP/2 多路复用为何不解决 HOL blocking"),
    handle: "HTTP/2 多路复用为何不解决 HOL blocking",
    source_ref: "demo://http2",
    evidence: {
      question: "HTTP/2 的多路复用为什么不解决队头阻塞?",
      missedAnchors: ["TCP 层丢包仍阻塞所有流", "QUIC 在用户态做流隔离才解决"],
    },
    state: "shaky",
    streak: 0,
    created_at: yesterday,
    last_seen_at: yesterday,
    next_due_at: dueAt,
  },
  {
    id: id("MySQL 索引失效的典型场景"),
    handle: "MySQL 索引失效的典型场景",
    source_ref: "demo://mysql-index",
    evidence: {
      question: "MySQL InnoDB 索引失效的几种典型场景。",
      missedAnchors: ["索引列做函数/运算", "组合索引最左前缀"],
    },
    state: "shaky",
    streak: 0,
    created_at: yesterday,
    last_seen_at: yesterday,
    next_due_at: dueAt,
  },
];

// 合并已有 ledger,不要冲掉真账本数据。
let existing = { version: 1, items: [] };
try {
  existing = JSON.parse(await readFile(ledgerPath, "utf8"));
} catch {}
const existingHandles = new Set((existing.items || []).map((it) => it.handle));
const additions = items.filter((it) => !existingHandles.has(it.handle));
const merged = {
  version: 1,
  updated_at: new Date().toISOString(),
  items: [...(existing.items || []), ...additions],
};

await mkdir(ledgerDir, { recursive: true });
const tmp = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
await rename(tmp, ledgerPath);

console.log(`✅ seeded ${additions.length} demo item(s) (total ${merged.items.length})`);
console.log(`   open http://127.0.0.1:3000 — 「今日复习」block should show ${merged.items.length} item(s)`);
