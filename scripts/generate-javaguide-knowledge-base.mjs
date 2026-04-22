import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sourceRoot = path.resolve(process.env.LLAI_JAVAGUIDE_ROOT || "/Users/lee/IdeaProjects/JavaGuide", "docs");
const outputRoot = path.resolve(repoRoot, "data/javaguide");
const docsOutputRoot = path.join(outputRoot, "docs");
const assetsOutputRoot = path.join(outputRoot, "assets");

const folderLabels = {
  "about-the-author": "作者相关",
  "ai": "AI",
  "books": "书籍",
  "concurrent": "并发",
  "cs-basics": "计算机基础",
  "database": "数据库",
  "distributed-system": "分布式系统",
  "framework": "框架",
  "high-availability": "高可用",
  "high-performance": "高性能",
  "interview-preparation": "面试准备",
  "java": "Java",
  "javaguide": "JavaGuide",
  "jvm": "JVM",
  "message-queue": "消息队列",
  "mysql": "MySQL",
  "network": "网络",
  "open-source-project": "开源项目",
  "redis": "Redis",
  "spring": "Spring",
  "system-design": "系统设计",
  "tools": "工具",
  "zhuanlan": "专栏",
};

const skipDirectoryNames = new Set([".git", ".vuepress", "node_modules"]);
const skipMarkdownDirectories = new Set(["snippets"]);
const assetExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

function normalizeSlashes(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function titleFromFilename(filename = "") {
  return path.posix.basename(filename, path.posix.extname(filename))
    .replace(/^README$/i, "目录")
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (char) => char.toUpperCase())
    .trim() || "未命名文档";
}

function readFrontmatterTitle(raw = "") {
  const match = String(raw || "").match(/^---\r?\n[\s\S]*?^\s*title:\s*(.+?)\s*$[\s\S]*?^---\s*$/m);
  return match ? String(match[1]).trim().replace(/^['"]|['"]$/g, "") : "";
}

function stripFrontmatter(raw = "") {
  return String(raw || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function cleanMarkdown(raw = "") {
  return stripFrontmatter(raw)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r/g, "")
    .trim();
}

function readFirstHeading(markdown = "") {
  const lines = String(markdown || "").split("\n");
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }
  return "";
}

async function listFiles(root) {
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(root, { withFileTypes: true }));
  const files = [];
  for (const entry of entries) {
    if (skipDirectoryNames.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function toDocsPath(relativePath) {
  return `docs/${normalizeSlashes(relativePath)}`;
}

function toFolderLabels(folderSegments) {
  return folderSegments.map((segment) => (
    folderLabels[segment] || segment.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (char) => char.toUpperCase())
  ));
}

async function generate() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(docsOutputRoot, { recursive: true });
  await mkdir(assetsOutputRoot, { recursive: true });

  const files = await listFiles(sourceRoot);
  const docs = [];
  const assets = [];

  for (const absolutePath of files) {
    const relativePath = normalizeSlashes(path.relative(sourceRoot, absolutePath));
    const ext = path.extname(relativePath).toLowerCase();
    const pathSegments = relativePath.split("/");
    const folderSegmentsOnly = pathSegments.slice(0, -1);

    if (ext === ".md" && !folderSegmentsOnly.some((segment) => skipMarkdownDirectories.has(segment))) {
      const raw = await readFile(absolutePath, "utf8");
      const cleaned = cleanMarkdown(raw);
      const frontmatterTitle = readFrontmatterTitle(raw);
      const headingTitle = readFirstHeading(cleaned);
      const title = frontmatterTitle || headingTitle || titleFromFilename(relativePath);
      const target = path.join(docsOutputRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${cleaned}\n`, "utf8");
      docs.push({
        path: toDocsPath(relativePath),
        title,
        titleSource: frontmatterTitle ? "frontmatter" : headingTitle ? "heading" : "filename",
        folderSegments: folderSegmentsOnly,
        folderLabels: toFolderLabels(folderSegmentsOnly),
      });
      continue;
    }

    if (assetExtensions.has(ext)) {
      const target = path.join(assetsOutputRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(absolutePath, target);
      assets.push({
        path: toDocsPath(relativePath),
        folderSegments: folderSegmentsOnly,
        folderLabels: toFolderLabels(folderSegmentsOnly),
      });
    }
  }

  docs.sort((left, right) => left.path.localeCompare(right.path));
  assets.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceRoot,
    documentCount: docs.length,
    assetCount: assets.length,
    folderLabels,
    docs,
    assets,
  };

  await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(outputRoot, "README.md"),
    [
      "# Generated JavaGuide Knowledge Base",
      "",
      "Generated by `node scripts/generate-javaguide-knowledge-base.mjs`.",
      "",
      "- `manifest.json`: document metadata used by the frontend.",
      "- `docs/`: cleaned Markdown copied from JavaGuide.",
      "- `assets/`: local image/static resources copied from JavaGuide.",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`Generated ${docs.length} docs and ${assets.length} assets in ${path.relative(repoRoot, outputRoot)}`);
}

generate().catch((error) => {
  console.error(error);
  process.exit(1);
});
