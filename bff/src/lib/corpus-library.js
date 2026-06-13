import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 爬取语料库（JD / 面经）的只读检索 — 「选库里的 JD/面经」的数据源。
//
// 数据由 scripts/import-crawl-corpus.mjs 离线清洗后落进 data/corpus/*.jsonl（已入库）。
// 这里只做内存缓存 + 关键词/岗位过滤 + 分页。列表只回摘要（excerpt），全文留给
// create() 按 id 在服务端取（getLibraryItem），避免列表 payload 把全文一股脑带出去。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.resolve(__dirname, "../../../data/corpus");

const files = {
  jd: "jd-library.jsonl",
  interview: "interview-library.jsonl",
};

const cache = new Map();

function loadKind(kind) {
  if (cache.has(kind)) {
    return cache.get(kind);
  }
  const file = files[kind];
  const full = file ? path.join(corpusDir, file) : "";
  let records = [];
  if (full && existsSync(full)) {
    records = readFileSync(full, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((record) => record && record.id && record.text);
  }
  cache.set(kind, records);
  return records;
}

// 测试用：清掉内存缓存，让下次 load 重新读盘。
export function resetCorpusCache() {
  cache.clear();
}

function toSummary(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    role: record.role || "",
    excerpt: String(record.text || "").replace(/\s+/g, " ").slice(0, 160),
    url: record.url || "",
  };
}

function matches(record, query, role) {
  if (role && !(record.role || "").toLowerCase().includes(role)) {
    return false;
  }
  if (!query) {
    return true;
  }
  // 面经 role 粒度粗（多为「软件开发」），所以关键词搜标题+正文，不只搜 role。
  return `${record.title} ${record.text}`.toLowerCase().includes(query);
}

export function searchLibrary({ kind = "jd", q = "", role = "", page = 1, pageSize = 20 } = {}) {
  const records = loadKind(kind);
  const query = String(q || "").trim().toLowerCase();
  const roleFilter = String(role || "").trim().toLowerCase();
  const filtered = records.filter((record) => matches(record, query, roleFilter));

  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 50);
  const current = Math.max(Number(page) || 1, 1);
  const start = (current - 1) * size;
  const items = filtered.slice(start, start + size).map(toSummary);

  // 岗位下拉的可选值（去重，仅 JD 有意义）。
  const roles = [...new Set(records.map((record) => record.role).filter(Boolean))];

  return {
    kind,
    total: filtered.length,
    page: current,
    pageSize: size,
    roles,
    items,
  };
}

export function getLibraryItem({ kind = "jd", id = "" } = {}) {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    return null;
  }
  return loadKind(kind).find((record) => record.id === cleanId) || null;
}
