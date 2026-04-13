import { readFile } from "node:fs/promises";
import path from "node:path";

const defaultJavaGuideRoot = process.env.LLAI_JAVAGUIDE_ROOT || "/Users/lee/IdeaProjects/JavaGuide";
const javaGuideDocsRoot = path.resolve(defaultJavaGuideRoot, "docs");

const assetMimeTypes = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

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
    throw new Error("JavaGuide path is outside docs root.");
  }
  return normalized;
}

function buildAbsoluteDocsPath(relativePath) {
  const absolutePath = path.resolve(javaGuideDocsRoot, relativePath);
  if (absolutePath !== javaGuideDocsRoot && !absolutePath.startsWith(`${javaGuideDocsRoot}${path.sep}`)) {
    throw new Error("JavaGuide path is outside docs root.");
  }
  return absolutePath;
}

function readFrontmatterTitle(raw = "") {
  const match = String(raw || "").match(/^---\r?\n[\s\S]*?^\s*title:\s*(.+?)\s*$[\s\S]*?^---\s*$/m);
  return match ? String(match[1]).trim().replace(/^['"]|['"]$/g, "") : "";
}

function stripFrontmatter(raw = "") {
  return String(raw || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function stripMarkdownNoise(raw = "") {
  return stripFrontmatter(raw)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r/g, "")
    .trim();
}

function splitFenceSegments(markdown = "") {
  return String(markdown || "").split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
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

function isExternalUrl(target = "") {
  return /^https?:\/\//i.test(target);
}

function normalizeLearnDocPath(targetPath = "") {
  const relativePath = ensureDocsRelativePath(targetPath);
  return `docs/${relativePath}`;
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
    throw new Error("Resolved JavaGuide path is outside docs root.");
  }
  if (treatAsMarkdown) {
    if (resolved.endsWith("/")) {
      resolved = `${resolved}README.md`;
    } else if (!path.posix.extname(resolved)) {
      resolved = `${resolved}.md`;
    }
  }
  return normalizeLearnDocPath(resolved);
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

export function slugifyHeading(text = "") {
  const slug = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function extractMarkdownHeadings(markdown = "") {
  const headings = [];
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  let inFence = false;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      return;
    }

    const match = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (!match) {
      return;
    }

    const text = match[2].trim();
    headings.push({
      id: slugifyHeading(text),
      level: match[1].length,
      text,
    });
  });

  return headings;
}

export function getAssetMimeType(assetPath = "") {
  return assetMimeTypes[path.extname(String(assetPath || "")).toLowerCase()] || "application/octet-stream";
}

export async function readJavaGuideDocument(docPath, { serviceBaseUrl = "" } = {}) {
  const normalizedDocPath = normalizeLearnDocPath(docPath);
  const absolutePath = buildAbsoluteDocsPath(ensureDocsRelativePath(normalizedDocPath));
  const raw = await readFile(absolutePath, "utf8");
  const titleFromFrontmatter = readFrontmatterTitle(raw);
  const strippedMarkdown = stripMarkdownNoise(raw);
  const headings = extractMarkdownHeadings(strippedMarkdown);

  return {
    path: normalizedDocPath,
    title: titleFromFrontmatter || headings[0]?.text || path.posix.basename(normalizedDocPath, ".md"),
    markdown: serviceBaseUrl
      ? rewriteMarkdownLinks(strippedMarkdown, normalizedDocPath, serviceBaseUrl)
      : strippedMarkdown,
    headings,
  };
}

export async function readJavaGuideAsset(assetPath) {
  const relativePath = ensureDocsRelativePath(assetPath);
  const absolutePath = buildAbsoluteDocsPath(relativePath);
  return {
    absolutePath,
    mimeType: getAssetMimeType(relativePath),
    body: await readFile(absolutePath),
  };
}
