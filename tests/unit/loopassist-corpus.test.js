import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractLoopAssistArtifacts,
  importLoopAssistCorpus,
} from "../../scripts/import-nowcoder-loopassist-corpus.mjs";
import {
  buildLoopAssistOptions,
  filterLoopAssistSeeds,
  previewLoopAssistScope,
} from "../../src/loopassist/corpus.js";

const rows = [
  {
    content_id: "row-1",
    title: "淘天 Java 后端一面面经",
    detail_url: "https://example.com/1",
    job_context: { shard_path: "软件开发" },
    content_text: [
      "1. 介绍一下你的项目，以及你负责的核心模块？",
      "2. AQS 的底层实现原理是什么？",
      "3. 欢迎后台联系参加高质量项目辅导。",
    ].join("\n"),
    metrics: { view_count: 180 },
    question_hint: "查看真题",
  },
  {
    content_id: "row-1",
    title: "重复面经",
    content_text: "1. AQS 的底层实现原理是什么？",
  },
];

test("LoopAssist import extracts stable, deduped NowCoder question seeds", () => {
  const { reports, seeds } = extractLoopAssistArtifacts(rows);

  assert.equal(reports.length, 1);
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0].rolePath, "软件开发 / Java");
  assert.equal(seeds[0].stage, "一面");
  assert.equal(seeds[0].company, "淘天");
  assert.match(seeds.map((seed) => seed.baseQuestion).join("\n"), /AQS/);
  assert.doesNotMatch(seeds.map((seed) => seed.baseQuestion).join("\n"), /项目辅导/);
});

test("LoopAssist import script writes manifest, reports, and question seeds", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "loopassist-corpus-"));
  const sourcePath = path.join(tmpDir, "source.jsonl");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(
    sourcePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  ));

  const manifest = importLoopAssistCorpus({ sourcePath, outputDir: tmpDir });
  const seedsText = await readFile(path.join(tmpDir, "question-seeds.jsonl"), "utf8");

  assert.equal(manifest.reportCount, 1);
  assert.equal(manifest.seedCount, 2);
  assert.match(seedsText, /AQS/);
  await rm(tmpDir, { recursive: true, force: true });
});

test("LoopAssist scope filtering returns options, matches, and thin-scope warnings", () => {
  const seeds = extractLoopAssistArtifacts(rows).seeds;
  const options = buildLoopAssistOptions(seeds);
  const filtered = filterLoopAssistSeeds({ role: "Java", round: "一面", topics: ["并发"] }, seeds);
  const preview = previewLoopAssistScope({ role: "Java", round: "三面", topics: ["不存在"] }, seeds);

  assert.ok(options.roles.some((item) => item.value.includes("Java")));
  assert.ok(filtered.some((seed) => seed.baseQuestion.includes("AQS")));
  assert.ok(preview.warnings.some((warning) => warning.includes("题源偏薄")));
});
