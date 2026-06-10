// 删除 audit-dead-css.mjs 识别出的死 rule block，并压缩多余空行。
// 用法: node scripts/purge-dead-css.mjs
import { readFile, writeFile, readdir } from "node:fs/promises";
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

const dynamicPrefixes = new Set();
for (const match of corpus.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*-)\$\{/g)) {
  dynamicPrefixes.add(match[1]);
}

const css = await readFile(cssPath, "utf8");
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
          blocks.push({ start: innerStart, end: startLine + j, text: innerBuffer });
          innerBuffer = "";
        }
      }
    } else {
      blocks.push({ start: startLine, end: i, text: buffer });
    }
    buffer = "";
    inAtRule = false;
  }
}

function classesInSelector(selector) {
  return [...selector.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]);
}

const liveCache = new Map();
function classIsLive(name) {
  if (!liveCache.has(name)) {
    let live = corpus.includes(name);
    if (!live) {
      for (const prefix of dynamicPrefixes) {
        if (name.startsWith(prefix)) {
          live = true;
          break;
        }
      }
    }
    liveCache.set(name, live);
  }
  return liveCache.get(name);
}

const deadLineSet = new Set();
let deadBlockCount = 0;
for (const block of blocks) {
  const selector = block.text.slice(0, block.text.indexOf("{"));
  const alternatives = selector.split(",").map((s) => s.trim()).filter(Boolean);
  if (!alternatives.length) continue;
  const allDead = alternatives.every((alt) => {
    const classNames = classesInSelector(alt);
    if (!classNames.length) return false;
    return classNames.some((name) => !classIsLive(name));
  });
  if (allDead) {
    deadBlockCount += 1;
    for (let i = block.start; i <= block.end; i += 1) deadLineSet.add(i);
  }
}

const kept = lines.filter((_, index) => !deadLineSet.has(index));
// 压缩 2+ 连续空行为 1
const collapsed = [];
let blankRun = 0;
for (const line of kept) {
  if (line.trim() === "") {
    blankRun += 1;
    if (blankRun > 1) continue;
  } else {
    blankRun = 0;
  }
  collapsed.push(line);
}

await writeFile(cssPath, collapsed.join("\n"));
console.log(`removed ${deadBlockCount} blocks, ${lines.length - kept.length} lines; ${lines.length} -> ${collapsed.length} lines`);
