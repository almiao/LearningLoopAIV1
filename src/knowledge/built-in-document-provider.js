import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildSelfSourceRef } from "./source-refs.js";
import { buildLearningFromMarkdown, buildRenderDescriptor } from "./source-document-format.js";

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

export function ensureBuiltInDocumentRelativePath(inputPath = "") {
  const raw = normalizeSlashes(inputPath).trim().replace(/^\/+/, "");
  const withoutDocsPrefix = raw.startsWith("docs/") ? raw.slice("docs/".length) : raw;
  const normalized = path.posix.normalize(withoutDocsPrefix || ".");

  if (!normalized || normalized === "." || normalized === "./") {
    return "README.md";
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Source document path is outside built-in corpus root.");
  }
  return normalized;
}

export function normalizeBuiltInDocumentPath(inputPath = "") {
  return `docs/${ensureBuiltInDocumentRelativePath(inputPath)}`;
}

function buildSafePath(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Source document path is outside root.");
  }
  return absolutePath;
}

export async function readBuiltInManifest() {
  if (!manifestCache) {
    manifestCache = JSON.parse(await readFile(manifestPath, "utf8"));
  }
  return manifestCache;
}

export async function listBuiltInDocuments() {
  const manifest = await readBuiltInManifest();
  return (manifest.docs || []).map((document) => ({
    ...document,
    sourceType: "built-in-document",
    provider: "built-in-corpus",
    providerLabel: "JavaGuide",
  }));
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
  const currentRelative = ensureBuiltInDocumentRelativePath(currentDocPath);
  const currentDirectory = path.posix.dirname(currentRelative);
  const sourceTarget = normalizeSlashes(targetPath).replace(/^\/+/, "");
  let resolved = sourceTarget.startsWith("docs/")
    ? sourceTarget.slice("docs/".length)
    : path.posix.normalize(path.posix.join(currentDirectory, sourceTarget));

  if (resolved === "." || resolved === "") {
    resolved = currentRelative;
  }
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error("Resolved source path is outside built-in corpus root.");
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
  const rewrittenImages = segment.replace(/!\[([^\]]*)]\(([^)]+)\)/g, (_, alt, rawTarget) => (
    `![${alt}](${rewriteImageTarget(rawTarget, currentDocPath, serviceBaseUrl)})`
  ));

  return rewrittenImages.replace(/(^|[^!])\[([^\]]+)]\(([^)]+)\)/gm, (_, prefix, label, rawTarget) => (
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

export async function readBuiltInDocument(docPath, { serviceBaseUrl = "" } = {}) {
  const normalizedDocPath = normalizeBuiltInDocumentPath(docPath);
  const manifest = await readBuiltInManifest();
  const metadata = (manifest.docs || []).find((doc) => doc.path === normalizedDocPath);
  if (!metadata) {
    throw new Error("Source document not found.");
  }

  const relativePath = ensureBuiltInDocumentRelativePath(normalizedDocPath);
  const rawMarkdown = await readFile(buildSafePath(docsRoot, relativePath), "utf8");
  const markdown = serviceBaseUrl
    ? rewriteMarkdownLinks(rawMarkdown, normalizedDocPath, serviceBaseUrl)
    : rawMarkdown;
  const learningBase = buildLearningFromMarkdown(rawMarkdown, { fallbackTitle: metadata.title });
  const document = {
    ...metadata,
    sourceType: "built-in-document",
    provider: "built-in-corpus",
    providerLabel: "JavaGuide",
    primaryFormat: "markdown",
    markdown,
    source: {
      kind: "built-in-document",
      mimeType: "text/markdown",
      filename: path.posix.basename(normalizedDocPath),
      url: "",
      storedAssetPath: normalizedDocPath,
      snapshotAvailable: true,
      snapshotCapturedAt: "",
      byteSize: Buffer.byteLength(rawMarkdown, "utf8"),
    },
    render: {
      ...buildRenderDescriptor({
        format: "markdown",
        hasOriginalPreview: false,
        hasLearningPreview: true,
      }),
      viewUrl: "",
      fallbackUrl: "",
    },
    learning: {
      ...learningBase,
      markdown,
      chunkCount: learningBase.text
        ? learningBase.text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).length
        : 0,
      sufficientForQa: learningBase.text.length >= 220,
      sufficientForTraining: learningBase.text.length >= 220,
      extractionStatus: "ready",
      extractionNotes: "",
    },
    originalSource: {
      kind: "built-in-document",
      previewable: false,
    },
  };
  const selfRef = buildSelfSourceRef(document);
  return {
    ...document,
    sourceRefs: selfRef ? [selfRef] : [],
  };
}

export async function readBuiltInAsset(assetPath) {
  const relativePath = ensureBuiltInDocumentRelativePath(assetPath);
  const absolutePath = buildSafePath(assetsRoot, relativePath);
  return {
    absolutePath,
    mimeType: getAssetMimeType(relativePath),
    body: await readFile(absolutePath),
  };
}
