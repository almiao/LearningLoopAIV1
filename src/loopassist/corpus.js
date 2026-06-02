import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const rootDir = path.resolve(new URL("../..", import.meta.url).pathname);
const corpusDir = path.join(rootDir, "data", "loopassist");
const seedsPath = path.join(corpusDir, "question-seeds.jsonl");
const reportsPath = path.join(corpusDir, "interview-reports.jsonl");
const manifestPath = path.join(corpusDir, "manifest.json");

const fallbackSeeds = [
  {
    seedId: "fallback:java:concurrency:1",
    rolePath: "软件开发 / Java 后端",
    stage: "一面",
    company: "通用",
    topics: ["并发", "Java", "项目"],
    baseQuestion: "你在项目里如何处理高并发场景下的线程安全问题？",
    followupAngles: ["锁粒度如何控制", "如何验证并发正确性", "线上问题怎么排查"],
    strongAnswerSignals: ["能结合真实项目", "能讲清机制和取舍", "能说明监控或压测验证"],
    sourceReportUrl: "",
    qualityScore: 0.72,
  },
  {
    seedId: "fallback:ai:rag:1",
    rolePath: "算法 / AI 应用",
    stage: "一面",
    company: "通用",
    topics: ["RAG", "LLM", "项目"],
    baseQuestion: "你们 RAG 的检索召回和生成质量是怎么评估的？",
    followupAngles: ["Query 改写策略", "召回精度指标", "幻觉控制"],
    strongAnswerSignals: ["有指标", "有失败案例", "能解释工程权衡"],
    sourceReportUrl: "",
    qualityScore: 0.7,
  },
  {
    seedId: "fallback:cpp:memory:1",
    rolePath: "软件开发 / C++",
    stage: "一面",
    company: "通用",
    topics: ["C++", "内存", "基础"],
    baseQuestion: "new、malloc 和智能指针的使用场景有什么区别？",
    followupAngles: ["底层分配差异", "RAII", "异常安全"],
    strongAnswerSignals: ["能区分对象构造和内存分配", "能讲生命周期管理"],
    sourceReportUrl: "",
    qualityScore: 0.68,
  },
];

function parseJsonlFile(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeList(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => normalizeText(value))
      .filter(Boolean)
  ));
}

function topicMatches(seedTopics = [], requestedTopics = []) {
  if (!requestedTopics.length) {
    return true;
  }
  const haystack = seedTopics.join(" ").toLowerCase();
  return requestedTopics.some((topic) => haystack.includes(topic.toLowerCase()) || topic.toLowerCase().includes(haystack));
}

function textIncludes(value = "", needle = "") {
  const normalizedNeedle = normalizeText(needle).toLowerCase();
  if (!normalizedNeedle || normalizedNeedle === "all" || normalizedNeedle === "不限") {
    return true;
  }
  return normalizeText(value).toLowerCase().includes(normalizedNeedle);
}

export function loadLoopAssistManifest() {
  if (!existsSync(manifestPath)) {
    return {
      generatedAt: "",
      sourcePath: "",
      reportCount: 0,
      seedCount: fallbackSeeds.length,
      fallback: true,
    };
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function loadLoopAssistSeeds() {
  const seeds = parseJsonlFile(seedsPath);
  return seeds.length ? seeds : fallbackSeeds;
}

export function loadLoopAssistReports() {
  return parseJsonlFile(reportsPath);
}

function enrichSeedWithReport(seed, reportsById) {
  const report = reportsById.get(String(seed.reportId || ""));
  if (!report) {
    return seed;
  }
  return {
    ...seed,
    sourceReportTitle: report.title || "",
    sourceReportText: report.text || "",
    sourceReportCreatedAt: report.createdAt || "",
  };
}

export function buildLoopAssistOptions(seeds = loadLoopAssistSeeds()) {
  const countBy = (mapper) => {
    const counts = new Map();
    for (const seed of seeds) {
      for (const value of normalizeList(mapper(seed))) {
        counts.set(value, (counts.get(value) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"))
      .map(([label, count]) => ({ label, value: label, count }));
  };

  return {
    roles: countBy((seed) => seed.rolePath || "软件开发"),
    rounds: countBy((seed) => seed.stage || "未知轮次"),
    topics: countBy((seed) => seed.topics || []),
    companyStyles: countBy((seed) => seed.company || "通用"),
    interviewStyles: [
      { label: "追问型", value: "probing" },
      { label: "压力型", value: "pressure" },
      { label: "引导型", value: "coaching" },
      { label: "真实还原", value: "realistic" },
    ],
    counts: {
      reports: loadLoopAssistManifest().reportCount || 0,
      seeds: seeds.length,
    },
  };
}

export function filterLoopAssistSeeds(scope = {}, seeds = loadLoopAssistSeeds()) {
  const requestedTopics = normalizeList(scope.topics);
  const role = scope.role || scope.rolePath || "";
  const stage = scope.round || scope.stage || "";
  const companyStyle = scope.companyStyle || scope.company || "";

  return seeds
    .filter((seed) => textIncludes(seed.rolePath, role))
    .filter((seed) => textIncludes(seed.stage, stage))
    .filter((seed) => textIncludes(seed.company, companyStyle))
    .filter((seed) => topicMatches(seed.topics || [], requestedTopics))
    .map((seed) => ({
      seed,
      score:
        Number(seed.qualityScore || 0)
        + (role && textIncludes(seed.rolePath, role) ? 0.1 : 0)
        + (stage && textIncludes(seed.stage, stage) ? 0.08 : 0)
        + requestedTopics.filter((topic) => (seed.topics || []).includes(topic)).length * 0.12
        + (companyStyle && textIncludes(seed.company, companyStyle) ? 0.06 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.seed);
}

export function previewLoopAssistScope(scope = {}, seeds = loadLoopAssistSeeds()) {
  const matchedSeeds = filterLoopAssistSeeds(scope, seeds);
  const warnings = [];
  if (matchedSeeds.length < 5) {
    warnings.push("当前范围题源偏薄，正式面试会自动放宽公司或主题限制。");
  }
  if (!normalizeList(scope.topics).length) {
    warnings.push("未选择主题时会按岗位和轮次混合抽题，适合真实综合面。");
  }

  return {
    matchedCount: matchedSeeds.length,
    warnings,
    sampleSeeds: matchedSeeds.slice(0, 6).map((seed) => ({
      seedId: seed.seedId,
      baseQuestion: seed.baseQuestion,
      topics: seed.topics || [],
      stage: seed.stage || "",
      company: seed.company || "",
    })),
  };
}

export function selectLoopAssistSeeds(scope = {}, seeds = loadLoopAssistSeeds(), { min = 5, max = 12 } = {}) {
  const strictMatches = filterLoopAssistSeeds(scope, seeds);
  const relaxedScope = {
    ...scope,
    companyStyle: "",
  };
  const relaxedMatches = filterLoopAssistSeeds(relaxedScope, seeds);
  const byId = new Map();
  for (const seed of [...strictMatches, ...relaxedMatches, ...seeds]) {
    if (byId.size >= max) {
      break;
    }
    if (!byId.has(seed.seedId)) {
      byId.set(seed.seedId, seed);
    }
  }
  const selected = Array.from(byId.values());
  const reportsById = new Map(loadLoopAssistReports().map((report) => [String(report.contentId || ""), report]));
  const finalSeeds = selected.length >= min ? selected : fallbackSeeds.slice(0, max);
  return finalSeeds.map((seed) => enrichSeedWithReport(seed, reportsById));
}
