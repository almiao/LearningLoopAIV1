import { readFile } from "node:fs/promises";
import path from "node:path";

const defaultKnowledgeRoot = process.env.LLAI_KNOWLEDGE_BASE_ROOT || path.resolve(process.cwd(), "data/javaguide");
const knowledgeRoot = path.resolve(defaultKnowledgeRoot);
const docsRoot = path.join(knowledgeRoot, "docs");
const assetsRoot = path.join(knowledgeRoot, "assets");
const manifestPath = path.join(knowledgeRoot, "manifest.json");

const assetMimeTypes = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

let manifestCache = null;

function normalizeSlashes(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function ensureDocsRelativePath(inputPath = "") {
  const raw = normalizeSlashes(inputPath).trim().replace(/^\/+/, "");
  const withoutDocsPrefix = raw.startsWith("docs/") ? raw.slice("docs/".length) : raw;
  const normalized = path.posix.normalize(withoutDocsPrefix || ".");

  if (!normalized || normalized === "." || normalized === "./") {
    return "README.md";
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Knowledge path is outside docs root.");
  }
  return normalized;
}

function normalizeDocPath(inputPath = "") {
  return `docs/${ensureDocsRelativePath(inputPath)}`;
}

function buildSafePath(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Knowledge path is outside root.");
  }
  return absolutePath;
}

export async function readKnowledgeManifest() {
  if (!manifestCache) {
    manifestCache = JSON.parse(await readFile(manifestPath, "utf8"));
  }
  return manifestCache;
}

export async function listKnowledgeDocuments() {
  const manifest = await readKnowledgeManifest();
  return manifest.docs || [];
}

function splitHash(target = "") {
  const hashIndex = target.indexOf("#");
  if (hashIndex < 0) {
    return { pathname: target, hash: "" };
  }
  return {
    pathname: target.slice(0, hashIndex),
    hash: target.slice(hashIndex + 1),
  };
}

function extractLinkTarget(rawTarget = "") {
  const trimmed = String(rawTarget || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  const match = trimmed.match(/^(\S+)/);
  return match ? match[1] : trimmed;
}

function isExternalUrl(target = "") {
  return /^https?:\/\//i.test(target);
}

function resolveRelativePath(currentDocPath, targetPath, { treatAsMarkdown = true } = {}) {
  const currentRelative = ensureDocsRelativePath(currentDocPath);
  const currentDirectory = path.posix.dirname(currentRelative);
  const sourceTarget = normalizeSlashes(targetPath).replace(/^\/+/, "");
  let resolved = sourceTarget.startsWith("docs/")
    ? sourceTarget.slice("docs/".length)
    : path.posix.normalize(path.posix.join(currentDirectory, sourceTarget));

  if (resolved === "." || resolved === "") {
    resolved = currentRelative;
  }
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error("Resolved knowledge path is outside docs root.");
  }
  if (treatAsMarkdown) {
    if (resolved.endsWith("/")) {
      resolved = `${resolved}README.md`;
    } else if (!path.posix.extname(resolved)) {
      resolved = `${resolved}.md`;
    }
  }
  return `docs/${resolved}`;
}

function rewriteLinkTarget(rawTarget, currentDocPath, serviceBaseUrl) {
  const target = extractLinkTarget(rawTarget);
  if (!target) {
    return "";
  }
  if (isExternalUrl(target)) {
    return `${serviceBaseUrl}/api/knowledge/redirect?url=${encodeURIComponent(target)}`;
  }
  if (target.startsWith("#")) {
    return target;
  }

  const { pathname, hash } = splitHash(target);
  const resolvedDocPath = resolveRelativePath(currentDocPath, pathname, { treatAsMarkdown: true });
  const hashSuffix = hash ? `#${hash}` : "";
  return `/learn?doc=${encodeURIComponent(resolvedDocPath)}${hashSuffix}`;
}

function rewriteImageTarget(rawTarget, currentDocPath, serviceBaseUrl) {
  const target = extractLinkTarget(rawTarget);
  if (!target) {
    return "";
  }
  if (isExternalUrl(target)) {
    return `${serviceBaseUrl}/api/knowledge/asset?url=${encodeURIComponent(target)}`;
  }
  if (target.startsWith("#")) {
    return target;
  }

  const { pathname } = splitHash(target);
  const resolvedAssetPath = resolveRelativePath(currentDocPath, pathname, { treatAsMarkdown: false });
  return `${serviceBaseUrl}/api/knowledge/asset?path=${encodeURIComponent(resolvedAssetPath)}`;
}

function splitFenceSegments(markdown = "") {
  return String(markdown || "").split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
}

function rewriteMarkdownSegment(segment, currentDocPath, serviceBaseUrl) {
  const rewrittenImages = segment.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, rawTarget) => (
    `![${alt}](${rewriteImageTarget(rawTarget, currentDocPath, serviceBaseUrl)})`
  ));

  return rewrittenImages.replace(/(^|[^!])\[([^\]]+)\]\(([^)]+)\)/gm, (_, prefix, label, rawTarget) => (
    `${prefix}[${label}](${rewriteLinkTarget(rawTarget, currentDocPath, serviceBaseUrl)})`
  ));
}

function rewriteMarkdownLinks(markdown, currentDocPath, serviceBaseUrl) {
  return splitFenceSegments(markdown)
    .map((segment) => (
      segment.startsWith("```") || segment.startsWith("~~~")
        ? segment
        : rewriteMarkdownSegment(segment, currentDocPath, serviceBaseUrl)
    ))
    .join("");
}

export function getAssetMimeType(assetPath = "") {
  return assetMimeTypes[path.extname(String(assetPath || "").toLowerCase())] || "application/octet-stream";
}

export async function readJavaGuideDocument(docPath, { serviceBaseUrl = "" } = {}) {
  const normalizedDocPath = normalizeDocPath(docPath);
  const manifest = await readKnowledgeManifest();
  const metadata = (manifest.docs || []).find((doc) => doc.path === normalizedDocPath);
  if (!metadata) {
    throw new Error("Knowledge document not found.");
  }

  const relativePath = ensureDocsRelativePath(normalizedDocPath);
  const rawMarkdown = await readFile(buildSafePath(docsRoot, relativePath), "utf8");

  return {
    ...metadata,
    markdown: serviceBaseUrl
      ? rewriteMarkdownLinks(rawMarkdown, normalizedDocPath, serviceBaseUrl)
      : rawMarkdown,
  };
}

export async function readJavaGuideAsset(assetPath) {
  const relativePath = ensureDocsRelativePath(assetPath);
  const absolutePath = buildSafePath(assetsRoot, relativePath);
  return {
    absolutePath,
    mimeType: getAssetMimeType(relativePath),
    body: await readFile(absolutePath),
  };
}
