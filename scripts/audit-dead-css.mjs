// 审计 frontend/app/globals.css 中没有任何 JS 引用的 class 选择器。
// 动态类名按"模板前缀"保活：JS 里出现 `ll-state-${...}` 时，所有 ll-state-* 视为在用。
// 只报告，不修改。用法: node scripts/audit-dead-css.mjs [--blocks]
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const cssPath = path.join(root, "frontend/app/globals.css");

async function listFiles(directory, suffixes) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolute, suffixes));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      files.push(absolute);
    }
  }
  return files;
}

const jsRoots = ["frontend/components", "frontend/app", "frontend/lib", "tests"];
const jsFiles = (await Promise.all(jsRoots.map((dir) => listFiles(path.join(root, dir), [".js", ".jsx"])))).flat();
const corpus = (await Promise.all(jsFiles.map((file) => readFile(file, "utf8")))).join("\n");

// 模板前缀: `xxx-${` 之前的连续 class 片段
const dynamicPrefixes = new Set();
for (const match of corpus.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*-)\$\{/g)) {
  dynamicPrefixes.add(match[1]);
}

const css = await readFile(cssPath, "utf8");

// 解析顶层 rule block（支持 @media 一层嵌套），记录每个 block 的行范围与选择器
const lines = css.split("\n");
const blocks = [];
let buffer = "";
let depth = 0;
let startLine = 0;
let inAtRule = false;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (depth === 0 && buffer.trim() === "") startLine = i;
  buffer += `${line}\n`;
  for (const ch of line) {
    if (ch === "{") {
      depth += 1;
      if (depth === 1 && buffer.trimStart().startsWith("@")) inAtRule = true;
    }
    if (ch === "}") depth -= 1;
  }
  if (depth === 0 && buffer.includes("{")) {
    if (inAtRule) {
      // @media 内部递归当作独立块处理: 把内部内容再拆一次
      const inner = buffer.slice(buffer.indexOf("{") + 1, buffer.lastIndexOf("}"));
      const innerLines = inner.split("\n");
      let innerBuffer = "";
      let innerDepth = 0;
      let innerStart = startLine;
      for (let j = 0; j < innerLines.length; j += 1) {
        if (innerDepth === 0 && innerBuffer.trim() === "") innerStart = startLine + j;
        innerBuffer += `${innerLines[j]}\n`;
        for (const ch of innerLines[j]) {
          if (ch === "{") innerDepth += 1;
          if (ch === "}") innerDepth -= 1;
        }
        if (innerDepth === 0 && innerBuffer.includes("{")) {
          blocks.push({ start: innerStart, end: startLine + j, text: innerBuffer, inMedia: true });
          innerBuffer = "";
        }
      }
    } else {
      blocks.push({ start: startLine, end: i, text: buffer, inMedia: false });
    }
    buffer = "";
    inAtRule = false;
  }
}

function classesInSelector(selector) {
  return [...selector.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]);
}

function classIsLive(name) {
  if (corpus.includes(name)) return true;
  for (const prefix of dynamicPrefixes) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

const deadBlocks = [];
const liveCache = new Map();
for (const block of blocks) {
  const selector = block.text.slice(0, block.text.indexOf("{"));
  const alternatives = selector.split(",").map((s) => s.trim()).filter(Boolean);
  if (!alternatives.length) continue;
  // block 死 = 每个逗号分支里都含至少一个死 class
  const allDead = alternatives.every((alt) => {
    const classNames = classesInSelector(alt);
    if (!classNames.length) return false; // 元素/属性选择器,保守保留
    return classNames.some((name) => {
      if (!liveCache.has(name)) liveCache.set(name, classIsLive(name));
      return !liveCache.get(name);
    });
  });
  if (allDead) deadBlocks.push(block);
}

const deadLines = deadBlocks.reduce((sum, block) => sum + (block.end - block.start + 1), 0);
console.log(`globals.css: ${lines.length} 行, ${blocks.length} 个 rule block`);
console.log(`死 block: ${deadBlocks.length} 个, 共 ${deadLines} 行`);

if (process.argv.includes("--blocks")) {
  for (const block of deadBlocks) {
    const selector = block.text.slice(0, block.text.indexOf("{")).trim().replace(/\s+/g, " ");
    console.log(`${block.start + 1}-${block.end + 1}${block.inMedia ? " [media]" : ""}: ${selector}`);
  }
}
