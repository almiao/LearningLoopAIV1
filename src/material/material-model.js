const sentenceSplitter = /(?<=[.!?。！？])\s+/;
const frontmatterPattern = /^\s*---\s*\n[\s\S]*?\n---\s*/;
const markdownCommentPattern = /<!--[\s\S]*?-->/g;
const markdownImagePattern = /!\[[^\]]*]\([^)]+\)/g;
const markdownLinkPattern = /\[([^\]]+)\]\([^)]+\)/g;
const markdownFencePattern = /```[\s\S]*?```/g;

export function stripFrontmatter(value) {
  return String(value ?? "").replace(frontmatterPattern, "");
}

export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeSourceMarkup(value) {
  return normalizeWhitespace(
    stripFrontmatter(value)
      .replace(markdownCommentPattern, "\n")
      .replace(markdownImagePattern, " ")
      .replace(markdownLinkPattern, "$1")
      .replace(/`([^`]+)`/g, "$1")
  );
}

export function toReadableSourceText(value) {
  return normalizeWhitespace(
    normalizeSourceMarkup(value)
      .replace(markdownFencePattern, "\n")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/\|/g, " ")
  );
}

export function splitIntoParagraphs(content) {
  return normalizeWhitespace(content)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function splitIntoSentences(content) {
  return normalizeWhitespace(content)
    .split(sentenceSplitter)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function safeSnippet(content, maxLength = 240) {
  const normalized = normalizeWhitespace(content);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

export function createSource({
  kind,
  title,
  content,
  rawContent = content,
  url = null,
  metadata = {}
}) {
  const normalizedTitle = normalizeWhitespace(title || "Untitled source");
  const normalizedContent = normalizeWhitespace(content);
  const normalizedRawContent = normalizeWhitespace(rawContent);

  if (!normalizedContent) {
    throw new Error("Source content cannot be empty.");
  }

  const paragraphs = splitIntoParagraphs(normalizedContent);
  const sentences = splitIntoSentences(normalizedContent);

  return {
    kind,
    title: normalizedTitle,
    url,
    metadata,
    rawContent: normalizedRawContent,
    content: normalizedContent,
    paragraphs,
    sentences,
    wordCount: normalizedContent.split(/\s+/).filter(Boolean).length
  };
}

export function createConcept({
  id,
  title,
  summary,
  excerpt,
  keywords = [],
  sourceAnchors = [],
  ...extras
}) {
  return {
    id,
    title,
    summary: normalizeWhitespace(summary),
    excerpt: safeSnippet(excerpt),
    keywords: [...new Set(keywords.map((keyword) => keyword.toLowerCase()))],
    sourceAnchors,
    ...extras
  };
}
