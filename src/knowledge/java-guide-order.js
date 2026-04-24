import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const defaultJavaGuideRoot = process.env.LLAI_JAVAGUIDE_ROOT || "/Users/lee/IdeaProjects/JavaGuide";
const sourceDocsRoot = path.resolve(defaultJavaGuideRoot, "docs");
const generatedManifestPath = path.resolve(repoRoot, "data/javaguide/manifest.json");
const skipDirectoryNames = new Set([".git", ".vuepress", "node_modules", "snippets"]);

let orderCache = null;

function normalizeSlashes(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeDocPath(docPath = "") {
  const normalized = normalizeSlashes(docPath).replace(/^\/+/, "");
  return normalized.startsWith("docs/") ? normalized : `docs/${normalized}`;
}

function compareNames(left = "", right = "") {
  const leftReadme = /^readme\.md$/i.test(left);
  const rightReadme = /^readme\.md$/i.test(right);
  if (leftReadme !== rightReadme) {
    return leftReadme ? -1 : 1;
  }
  return left.localeCompare(right);
}

function walkDocsDirectory(root, current = "", acc = []) {
  const absoluteDir = path.join(root, current);
  const entries = readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => !skipDirectoryNames.has(entry.name))
    .sort((left, right) => compareNames(left.name, right.name));

  for (const entry of entries) {
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      walkDocsDirectory(root, relativePath, acc);
      continue;
    }
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
      acc.push(normalizeDocPath(relativePath));
    }
  }

  return acc;
}

function loadManifestDocs() {
  if (!existsSync(generatedManifestPath)) {
    return [];
  }
  try {
    const manifest = JSON.parse(readFileSync(generatedManifestPath, "utf8"));
    return (manifest.docs || []).map((doc) => normalizeDocPath(doc.path));
  } catch {
    return [];
  }
}

function buildOrderMap() {
  const orderedDocs =
    existsSync(sourceDocsRoot) && statSync(sourceDocsRoot).isDirectory()
      ? walkDocsDirectory(sourceDocsRoot)
      : loadManifestDocs();

  return new Map(orderedDocs.map((docPath, index) => [docPath, index]));
}

export function getJavaGuideDocumentOrder(docPath = "") {
  if (!orderCache) {
    orderCache = buildOrderMap();
  }
  return orderCache.get(normalizeDocPath(docPath)) ?? Number.MAX_SAFE_INTEGER;
}

export function getJavaGuideDocumentOrderMap() {
  if (!orderCache) {
    orderCache = buildOrderMap();
  }
  return new Map(orderCache);
}
