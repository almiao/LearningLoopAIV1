#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const defaultSourcePath = "/Users/lee/IdeaProjects/newcode-craw/data/nowcoder_interviews.jsonl";
const defaultOutputDir = path.join(rootDir, "data", "loopassist");

const questionPattern = /(？|\?|如何|怎么|为什么|区别|原理|介绍|讲一下|说一下|实现|场景|排查|设计|了解|是什么|是啥|吗)/i;
const promoPattern = /(后台联系|项目辅导|高质量项目|想参加|欢迎|私信|群|课程|简历优化|内推)/i;

export function normalizeInterviewText(value = "") {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stableId(...parts) {
  return createHash("sha1").update(parts.filter(Boolean).join("\n")).digest("hex").slice(0, 12);
}

function parseJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function inferStage(title = "", text = "") {
  const source = `${title}\n${text}`;
  const exact = source.match(/([一二三四五六七八九终HRhr主管技术业务]+面|笔试|群面|oc|offer)/i);
  if (!exact) {
    return "未知轮次";
  }
  const value = exact[1].replace(/^hr$/i, "HR");
  return value.toLowerCase() === "oc" ? "OC" : value;
}

function inferCompany(title = "") {
  const normalized = String(title || "").trim();
  const withoutPrefix = normalized.replace(/^(春招|秋招|暑期|日常|转正|实习|校招|社招)\s*/i, "");
  const match = withoutPrefix.match(/^([A-Za-z0-9\u4e00-\u9fa5＋+._-]{2,12})/);
  return match ? match[1].replace(/(一面|二面|三面|面经|实习|转正|校招|春招|秋招).*$/, "") || "通用" : "通用";
}

function inferRolePath(row = {}) {
  const shardPath = row.job_context?.shard_path || row.job_context?.shard_name || "";
  const title = `${row.title || ""} ${row.author?.auth_display_info || ""}`;
  const roleHints = [
    ["Java", /java|后端/i],
    ["AI / 算法", /算法|机器学习|深度学习|LLM|RAG|AI|NLP|CV|推荐/i],
    ["C++", /c\+\+|cpp|嵌入式/i],
    ["前端", /前端|react|vue|javascript|typescript/i],
    ["测试", /测试|测开|qa/i],
    ["客户端", /客户端|android|ios|移动端/i],
  ];
  const matched = roleHints.find(([, pattern]) => pattern.test(title));
  return [shardPath || "软件开发", matched?.[0]].filter(Boolean).join(" / ");
}

function inferTopics(question = "", row = {}) {
  const source = `${question}\n${row.title || ""}`.toLowerCase();
  const dictionary = [
    ["项目", /项目|业务|经历|实习|落地|系统/],
    ["并发", /并发|线程|锁|aqs|volatile|synchronized|threadlocal|线程池/],
    ["JVM", /jvm|gc|垃圾回收|内存模型|类加载/],
    ["数据库", /mysql|sql|索引|事务|mvcc|b\+?树|redis|缓存/],
    ["网络", /http|tcp|网络|rpc|grpc|https/],
    ["分布式", /分布式|微服务|kafka|mq|消息队列|一致性|限流|熔断/],
    ["算法", /算法|动态规划|哈希|链表|树|数组|两数之和|复杂度/],
    ["LLM", /llm|大模型|agent|rag|react|prompt|多模态|transformer/],
    ["机器学习", /机器学习|深度学习|模型|训练|召回|精度|特征|推荐/],
    ["C++", /c\+\+|malloc|new|智能指针|lambda|map|unordered_map/],
    ["前端", /前端|react|vue|浏览器|css|javascript|typescript/],
    ["系统设计", /设计|架构|高并发|可用性|扩展|系统/],
    ["操作系统", /操作系统|进程|线程|内存|io|linux/],
  ];
  const topics = dictionary.filter(([, pattern]) => pattern.test(source)).map(([topic]) => topic);
  return topics.length ? Array.from(new Set(topics)) : ["综合"];
}

function splitQuestionCandidates(text = "") {
  return normalizeInterviewText(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[？?])\s*/))
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)]|[一二三四五六七八九十]+[.、)])\s*/, "").trim())
    .filter(Boolean);
}

function buildFollowupAngles(question = "") {
  const angles = [];
  if (/项目|业务|系统|落地/.test(question)) {
    angles.push("你在项目里具体负责哪一段？", "如果线上出问题你怎么定位？");
  }
  if (/区别|对比/.test(question)) {
    angles.push("分别适合什么场景？", "有没有踩过相关坑？");
  }
  if (/原理|底层|实现/.test(question)) {
    angles.push("关键数据结构或流程是什么？", "边界条件怎么处理？");
  }
  if (/设计|架构|高并发/.test(question)) {
    angles.push("瓶颈在哪里？", "如何压测和监控？");
  }
  return Array.from(new Set(angles)).slice(0, 4);
}

function buildStrongAnswerSignals(question = "") {
  const signals = ["结论先行", "能解释机制和取舍"];
  if (/项目|业务|系统/.test(question)) {
    signals.push("能绑定真实项目场景和个人贡献");
  }
  if (/性能|高并发|召回|精度|压测/.test(question)) {
    signals.push("能给出指标、验证方式或线上观测");
  }
  if (/区别|场景/.test(question)) {
    signals.push("能讲清适用场景和反例");
  }
  return Array.from(new Set(signals)).slice(0, 5);
}

function qualityScore(question = "", row = {}) {
  let score = 0.45;
  if (questionPattern.test(question)) score += 0.16;
  if (question.length >= 18) score += 0.08;
  if (question.length >= 36) score += 0.06;
  if (row.metrics?.view_count > 100) score += 0.04;
  if (row.question_hint) score += 0.03;
  if (promoPattern.test(question)) score -= 0.3;
  return Math.max(0, Math.min(0.95, Number(score.toFixed(2))));
}

export function extractLoopAssistArtifacts(rows = []) {
  const seenReports = new Set();
  const seenQuestionText = new Set();
  const reports = [];
  const seeds = [];

  for (const row of rows) {
    const contentId = String(row.content_id || row.uuid || stableId(row.title, row.content_text));
    const text = normalizeInterviewText(row.content_text || row.content_html || "");
    const textHash = stableId(text);
    if (!text || seenReports.has(contentId) || seenReports.has(textHash)) {
      continue;
    }
    seenReports.add(contentId);
    seenReports.add(textHash);

    const report = {
      contentId,
      title: row.title || "",
      rolePath: inferRolePath(row),
      stage: inferStage(row.title, text),
      company: inferCompany(row.title),
      sourceReportUrl: row.detail_url || row.url || "",
      createdAt: row.created_at || row.publish_time || "",
      text,
    };
    reports.push(report);

    splitQuestionCandidates(text).forEach((candidate, index) => {
      if (candidate.length < 8 || candidate.length > 180 || promoPattern.test(candidate) || !questionPattern.test(candidate)) {
        return;
      }
      const normalizedQuestion = normalizeInterviewText(candidate).toLowerCase();
      if (seenQuestionText.has(normalizedQuestion)) {
        return;
      }
      seenQuestionText.add(normalizedQuestion);
      const score = qualityScore(candidate, row);
      if (score < 0.5) {
        return;
      }
      seeds.push({
        seedId: `nc_${contentId}_${index}_${stableId(candidate)}`,
        reportId: contentId,
        rolePath: report.rolePath,
        stage: report.stage,
        company: report.company,
        topics: inferTopics(candidate, row),
        baseQuestion: candidate,
        followupAngles: buildFollowupAngles(candidate),
        strongAnswerSignals: buildStrongAnswerSignals(candidate),
        sourceReportUrl: report.sourceReportUrl,
        qualityScore: score,
      });
    });
  }

  return { reports, seeds };
}

export function importLoopAssistCorpus({ sourcePath = defaultSourcePath, outputDir = defaultOutputDir } = {}) {
  const rows = parseJsonl(sourcePath);
  const { reports, seeds } = extractLoopAssistArtifacts(rows);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "interview-reports.jsonl"), `${reports.map((item) => JSON.stringify(item)).join("\n")}\n`);
  writeFileSync(path.join(outputDir, "question-seeds.jsonl"), `${seeds.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourcePath,
    reportCount: reports.length,
    seedCount: seeds.length,
  };
  writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sourcePath = process.argv[2] || defaultSourcePath;
  const outputDir = process.argv[3] || defaultOutputDir;
  const manifest = importLoopAssistCorpus({ sourcePath, outputDir });
  console.log(JSON.stringify(manifest, null, 2));
}
