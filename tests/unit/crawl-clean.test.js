import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanJobDescription,
  cleanInterviewText,
  normalizeJdRecord,
  normalizeInterviewRecord,
} from "../../src/corpus/crawl-clean.js";

// 真实 BOSS直聘 JD 的形态：顶部导航 + 双「职位描述」+ 正文 + 招聘者卡片 + 页脚。
const dirtyJd = [
  "首页", "职位", "公司", "搜索", "消息", "简历",
  "后端开发工程师 50-80K", "北京 3-5年 本科", "感兴趣 立即沟通", "新增附件简历",
  "公司基本信息", "字节跳动", "微信扫码分享 举报",
  "职位描述", "JVM", "Java", "Spring",
  "职位描述",
  "团队介绍：商业数据平台。", "1、负责平台建设；", "职位要求", "1、精通 Java；", "5、有大数据经验加分。",
  "宇文敏洁", "刚刚活跃", "字节跳动", "招聘专员",
  "竞争力分析", "BOSS 安全提示", "公司介绍", "工作地址", "更多职位",
].join("\n");

test("cleanJobDescription keeps the body, drops nav, recruiter card, and footer", () => {
  const text = cleanJobDescription(dirtyJd);
  assert.match(text, /团队介绍/);
  assert.match(text, /职位要求/);
  assert.match(text, /有大数据经验加分/);
  // 导航 / 招聘者 / 页脚都不该留下。
  for (const junk of ["首页", "职位描述", "宇文敏洁", "刚刚活跃", "竞争力分析", "BOSS 安全提示", "更多职位"]) {
    assert.ok(!text.includes(junk), `should drop: ${junk}`);
  }
});

test("cleanJobDescription falls back to nav-stripping when no 职位描述 anchor", () => {
  const raw = ["首页", "职位", "岗位职责：写代码。", "任职要求：会 Java。", "Copyright © 2026"].join("\n");
  const text = cleanJobDescription(raw);
  assert.match(text, /岗位职责/);
  assert.match(text, /任职要求/);
  assert.ok(!text.includes("首页"));
  assert.ok(!text.includes("Copyright"));
});

test("cleanInterviewText drops promo lines but keeps the question list", () => {
  const raw = [
    "1. Transformer 的 Decoder 介绍一下？",
    "2. B+ 树有了解吗？",
    "📳对于想求职算法岗的同学，欢迎后台联系。",
  ].join("\n");
  const text = cleanInterviewText(raw);
  assert.match(text, /Transformer/);
  assert.match(text, /B\+ 树/);
  assert.ok(!text.includes("后台联系"));
});

test("normalizeJdRecord shapes a library record from raw crawl", () => {
  const record = normalizeJdRecord({
    content_id: "abc",
    title: "AI agent开发 25-50K",
    experience: "北京 经验不限 硕士",
    tags: ["餐补", "五险一金"],
    job_context: { keyword: "AI Agent" },
    detail_url: "https://example.com/job/abc",
    job_description: dirtyJd,
  });
  assert.equal(record.id, "abc");
  assert.equal(record.kind, "jd");
  assert.equal(record.role, "AI Agent");
  assert.match(record.text, /团队介绍/);
  assert.equal(record.url, "https://example.com/job/abc");
});

test("normalizeInterviewRecord shapes a library record and picks the shard role", () => {
  const record = normalizeInterviewRecord({
    content_id: "999",
    title: "淘天实习一面",
    content_text: "1. RAG 怎么做？\n欢迎后台联系。",
    job_context: { shard_name: "软件开发" },
    detail_url: "https://nowcoder.com/x",
  });
  assert.equal(record.id, "999");
  assert.equal(record.kind, "interview");
  assert.equal(record.role, "软件开发");
  assert.match(record.text, /RAG/);
  assert.ok(!record.text.includes("后台联系"));
});
