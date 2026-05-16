import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const scannedRoots = ["bff/src", "frontend/components", "src/knowledge", "src/training", "src/user", "src/superapp", "ai-service/app/engine"];
const allowedFiles = new Set([
  "src/knowledge/source-refs.js",
  "src/baseline/baseline-packs.js",
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolute));
    } else if (/\.(js|py)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

test("new source-document business code avoids JavaGuide-specific identifiers", async () => {
  const files = [];
  for (const scannedRoot of scannedRoots) {
    files.push(...await listFiles(path.join(root, scannedRoot)));
  }

  const offenders = [];
  for (const absolute of files) {
    const relative = path.relative(root, absolute);
    if (allowedFiles.has(relative)) {
      continue;
    }
    const source = await readFile(absolute, "utf8");
    if (/javaGuideSources|javaGuideSourceClusters|readJavaGuide|listKnowledgeDocuments|JavaGuide-specific/.test(source)) {
      offenders.push(relative);
    }
  }

  assert.deepEqual(offenders, []);
});
