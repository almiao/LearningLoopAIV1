// 一次性导入：从 newcode-craw 的原始抓取里抽样、清洗，落成 app 自有 corpus（提交进库）。
//
//   node scripts/import-crawl-corpus.mjs
//
// 源目录默认 ../newcode-craw/data，可用环境变量 CRAWL_DATA_DIR 覆盖。
// 产出 data/corpus/jd-library.jsonl 和 interview-library.jsonl（各抽 ~100 条干净记录）。
// 第三方抓取内容，只抽样提交、不入全量（见对话决定）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeJdRecord,
  normalizeInterviewRecord,
} from "../src/corpus/crawl-clean.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcDir = process.env.CRAWL_DATA_DIR || path.resolve(repoRoot, "../newcode-craw/data");
const outDir = path.resolve(repoRoot, "data/corpus");

const JD_TARGET = 100;
const INTERVIEW_TARGET = 100;
const JD_MIN_TEXT = 60; // 清洗后正文太短的丢掉（多半剥壳失败/空 JD）。
const INTERVIEW_MIN_TEXT = 60;
const INTERVIEW_MAX_TEXT = 4000;

function readJsonl(file) {
  const full = path.join(srcDir, file);
  if (!existsSync(full)) {
    console.warn(`  跳过（不存在）：${file}`);
    return [];
  }
  return readFileSync(full, "utf8")
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
    .filter(Boolean);
}

function writeJsonl(file, records) {
  mkdirSync(outDir, { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(path.join(outDir, file), `${body}\n`, "utf8");
}

function collectJd() {
  const sources = [
    ["zhipin_ai_agent_jds.jsonl", JD_TARGET / 2],
    ["zhipin_jds.current_chrome.jsonl", JD_TARGET],
  ];
  const seen = new Set();
  const out = [];
  for (const [file] of sources) {
    for (const raw of readJsonl(file)) {
      const record = normalizeJdRecord(raw);
      if (!record.id || record.text.length < JD_MIN_TEXT || !record.title) {
        continue;
      }
      const key = `${record.title}|${record.text.slice(0, 40)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(record);
      if (out.length >= JD_TARGET) {
        return out;
      }
    }
  }
  return out;
}

function collectInterviews() {
  const seen = new Set();
  const out = [];
  for (const raw of readJsonl("nowcoder_interviews.jsonl")) {
    const record = normalizeInterviewRecord(raw);
    if (!record.id || record.text.length < INTERVIEW_MIN_TEXT || record.text.length > INTERVIEW_MAX_TEXT) {
      continue;
    }
    // 至少要像一份「问了若干题」的面经：含数字序号或问号。
    if (!/[0-9０-９]/.test(record.text) && !record.text.includes("?") && !record.text.includes("？")) {
      continue;
    }
    if (seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    out.push(record);
    if (out.length >= INTERVIEW_TARGET) {
      break;
    }
  }
  return out;
}

function preview(label, records) {
  console.log(`\n=== ${label}：${records.length} 条 ===`);
  for (const record of records.slice(0, 2)) {
    console.log(`· ${record.title} [${record.role || "无分类"}]`);
    console.log(`  ${record.text.replace(/\n/g, " / ").slice(0, 160)}`);
  }
}

function main() {
  console.log(`源目录：${srcDir}`);
  const jd = collectJd();
  const interviews = collectInterviews();
  writeJsonl("jd-library.jsonl", jd);
  writeJsonl("interview-library.jsonl", interviews);
  preview("JD", jd);
  preview("面经", interviews);
  console.log(`\n已写入 ${outDir}/`);
}

main();
