import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scheduleNextReview } from "./review-scheduling.js";

// 失败账本 (review item ledger) — PRODUCT.md §4 的持久实体 ②。
//
// 纪律（落在代码里，不只在文档里）：
//   - 扁平列表，无图、无边、无本体。一个 JSON 文件存盘（沿用 .omx/ 约定）。
//   - 失败驱动：只在「答崩」时 recordMiss 才生成一项（§4「练过不留痕」）。
//   - 字段就 §4 的 5 个：handle / source_ref / evidence / state / last_seen·next_due。
//   - 阶段 3 只写不读、不做数据迁移；调度仍是占位（见 placeholderNextDue）。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultLedgerDir = path.resolve(__dirname, "../../.omx/review-ledger");
const LEDGER_FILE = "ledger.json";
const LEDGER_VERSION = 1;

const VALID_STATES = new Set(["shaky", "solid"]);

function normalizeText(value = "") {
  return String(value || "").trim();
}

function slugify(value = "") {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function nowIso() {
  return new Date().toISOString();
}

function parseMs(iso, fallback = 0) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? ms : fallback;
}

function normalizeEvidence(evidence = {}) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const missed = Array.isArray(source.missedAnchors) ? source.missedAnchors : [];
  return {
    // 你答崩的那道题 + 没命中的一次性判分锚点（来自 §0.1）。
    question: normalizeText(source.question),
    missedAnchors: missed.map(normalizeText).filter(Boolean),
  };
}

function normalizeItem(item = {}) {
  const state = VALID_STATES.has(item.state) ? item.state : "shaky";
  const created = item.created_at || nowIso();
  const lastSeen = item.last_seen_at || created;
  return {
    id: normalizeText(item.id),
    handle: normalizeText(item.handle),
    source_ref: normalizeText(item.source_ref),
    evidence: normalizeEvidence(item.evidence),
    state,
    // 连续 solid 次数，喂给调度（见 review-scheduling.js）。
    streak: Math.max(0, Math.floor(Number(item.streak) || 0)),
    created_at: created,
    last_seen_at: lastSeen,
    // 缺失时保守地当「现在到期」，不在这里重算调度（避免 streak 重复计数）。
    next_due_at: item.next_due_at || lastSeen,
  };
}

function buildId(handle) {
  const hash = createHash("sha1")
    .update(`${handle}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 10);
  return `${slugify(handle) || "item"}-${hash}`.slice(0, 120);
}

export function createReviewItemStore({ ledgerDir = defaultLedgerDir } = {}) {
  const ledgerPath = path.join(ledgerDir, LEDGER_FILE);
  // 串行化 read-modify-write，避免并发写互相覆盖。
  let writeChain = Promise.resolve();

  async function readLedger() {
    try {
      const raw = await readFile(ledgerPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.items) ? parsed.items.map(normalizeItem) : [];
    } catch (error) {
      if (String(error?.code || "") === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function writeLedgerAtomically(items) {
    await mkdir(ledgerDir, { recursive: true });
    const tempPath = `${ledgerPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const payload = { version: LEDGER_VERSION, updated_at: nowIso(), items };
    try {
      await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tempPath, ledgerPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function mutate(apply) {
    const next = writeChain.catch(() => {}).then(async () => {
      const items = await readLedger();
      return apply(items);
    });
    writeChain = next.catch(() => {});
    return next;
  }

  return {
    // ——— 读出口（阶段 4 才会被 UI 调用；阶段 3 仅测试用） ———
    async list() {
      return readLedger();
    },

    async get(id) {
      const items = await readLedger();
      return items.find((item) => item.id === id) || null;
    },

    // Today Queue 的「今日复习」块就是这个：账本按 next_due 渲染（§3④）。
    async listDue({ now = nowIso() } = {}) {
      const cutoff = parseMs(now, Date.now());
      const items = await readLedger();
      return items
        .filter((item) => parseMs(item.next_due_at) <= cutoff)
        .sort((a, b) => parseMs(a.next_due_at) - parseMs(b.next_due_at));
    },

    // ——— 写入口（阶段 3 的穿透适配器调用） ———
    // 失败驱动：只在答崩、有漏掉的锚点时调用（§4）。一次过的话题不写任何状态。
    async recordMiss({ handle, source_ref = "", evidence = {}, state = "shaky", now = nowIso() } = {}) {
      const cleanHandle = normalizeText(handle);
      if (!cleanHandle) {
        throw new Error("review item handle is required.");
      }
      const safeState = VALID_STATES.has(state) ? state : "shaky";
      return mutate(async (items) => {
        const schedule = scheduleNextReview({ state: safeState, priorStreak: 0, now });
        const item = normalizeItem({
          id: buildId(cleanHandle),
          handle: cleanHandle,
          source_ref,
          evidence,
          state: safeState,
          streak: schedule.streak,
          created_at: now,
          last_seen_at: now,
          next_due_at: schedule.nextDueAt,
        });
        await writeLedgerAtomically([...items, item]);
        return item;
      });
    },

    // 复练后写回 state 与 next_due（§4 session 回路第 3 步）。
    async updateState({ id, state, now = nowIso() } = {}) {
      if (!VALID_STATES.has(state)) {
        throw new Error(`invalid review item state: ${state}`);
      }
      return mutate(async (items) => {
        let updated = null;
        const nextItems = items.map((item) => {
          if (item.id !== id) {
            return item;
          }
          const schedule = scheduleNextReview({ state, priorStreak: item.streak, now });
          updated = normalizeItem({
            ...item,
            state,
            streak: schedule.streak,
            last_seen_at: now,
            next_due_at: schedule.nextDueAt,
          });
          return updated;
        });
        if (!updated) {
          throw new Error(`review item not found: ${id}`);
        }
        await writeLedgerAtomically(nextItems);
        return updated;
      });
    },
  };
}
