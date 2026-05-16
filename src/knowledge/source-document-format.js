import { normalizeWhitespace, toReadableSourceText } from "../material/material-model.js";

const htmlHeadingPattern = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
const htmlTagPattern = /<[^>]+>/g;

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

export function normalizeMimeType(mimeType = "") {
  return String(mimeType || "").split(";")[0].trim().toLowerCase();
}

export function detectPrimaryFormat({ mimeType = "", filename = "" } = {}) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const normalizedFilename = String(filename || "").trim().toLowerCase();
  if (normalizedMimeType === "text/markdown" || /\.(md|markdown)$/i.test(normalizedFilename)) {
    return "markdown";
  }
  if (normalizedMimeType === "text/html" || /\.(html|htm)$/i.test(normalizedFilename)) {
    return "html";
  }
  if (normalizedMimeType === "application/pdf" || /\.pdf$/i.test(normalizedFilename)) {
    return "pdf";
  }
  if (
    normalizedMimeType.startsWith("text/")
    || /^(application\/(json|xml|xhtml\+xml|javascript|yaml|x-yaml))$/i.test(normalizedMimeType)
    || /\.(txt|json|csv|yaml|yml|xml|log)$/i.test(normalizedFilename)
  ) {
    return "text";
  }
  return "unsupported";
}

export function buildOutlineFromMarkdown(markdown = "") {
  return String(markdown || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.match(/^(#{1,3})\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      id: slugifyOutlineLabel(match[2]),
      label: normalizeWhitespace(match[2]),
      level: match[1].length,
    }))
    .filter((item) => item.label);
}

export function buildOutlineFromHtml(html = "") {
  const outline = [];
  for (const match of String(html || "").matchAll(new RegExp(htmlHeadingPattern))) {
    const level = Number(match[1]);
    const label = normalizeWhitespace(decodeHtmlEntities(String(match[2] || "").replace(htmlTagPattern, " ")));
    if (!label) {
      continue;
    }
    outline.push({
      id: slugifyOutlineLabel(label),
      label,
      level,
    });
  }
  return outline;
}

export function buildOutlineFromText(text = "", { fallbackTitle = "" } = {}) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const candidates = lines.filter((line) => line.length <= 72).slice(0, 6);
  if (candidates.length) {
    return candidates.map((label) => ({
      id: slugifyOutlineLabel(label),
      label,
      level: 1,
    }));
  }
  if (fallbackTitle) {
    return [{
      id: slugifyOutlineLabel(fallbackTitle),
      label: normalizeWhitespace(fallbackTitle),
      level: 1,
    }];
  }
  return [];
}

export function buildLearningFromMarkdown(markdown = "", { fallbackTitle = "" } = {}) {
  const normalizedMarkdown = normalizeWhitespace(markdown);
  const text = toReadableSourceText(normalizedMarkdown);
  return {
    text,
    markdown: normalizedMarkdown,
    outline: buildOutlineFromMarkdown(normalizedMarkdown).length
      ? buildOutlineFromMarkdown(normalizedMarkdown)
      : buildOutlineFromText(text, { fallbackTitle }),
  };
}

export function buildLearningFromText(text = "", { title = "" } = {}) {
  const normalizedText = normalizeWhitespace(text);
  const paragraphs = normalizedText
    .split(/\n{2,}|\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const markdown = `# ${normalizeWhitespace(title || "我的资料")}\n\n${paragraphs.join("\n\n")}\n`;
  return {
    text: normalizedText,
    markdown,
    outline: buildOutlineFromText(normalizedText, { fallbackTitle: title }),
  };
}

export function buildLearningFromHtml({ html = "", title = "" } = {}) {
  const text = normalizeWhitespace(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(htmlTagPattern, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, "\"")
  );
  const learning = buildLearningFromText(text, { title });
  const htmlOutline = buildOutlineFromHtml(html);
  return {
    ...learning,
    outline: htmlOutline.length ? htmlOutline : learning.outline,
  };
}

export function buildRenderDescriptor({
  format = "unsupported",
  hasOriginalPreview = false,
  hasLearningPreview = true,
} = {}) {
  if (format === "html") {
    return {
      format,
      viewMode: "sanitized-html",
      defaultView: hasOriginalPreview ? "original" : "learning",
      previewable: hasOriginalPreview,
      capabilities: {
        outline: true,
        findInPage: true,
        pageJump: false,
        timeSeek: false,
      },
      hasLearningPreview,
    };
  }
  if (format === "pdf") {
    return {
      format,
      viewMode: "pdf",
      defaultView: hasOriginalPreview ? "original" : "learning",
      previewable: hasOriginalPreview,
      capabilities: {
        outline: false,
        findInPage: true,
        pageJump: true,
        timeSeek: false,
      },
      hasLearningPreview,
    };
  }
  if (format === "text") {
    return {
      format,
      viewMode: "text",
      defaultView: hasOriginalPreview ? "original" : "learning",
      previewable: hasOriginalPreview,
      capabilities: {
        outline: true,
        findInPage: true,
        pageJump: false,
        timeSeek: false,
      },
      hasLearningPreview,
    };
  }
  if (format === "markdown") {
    return {
      format,
      viewMode: "markdown",
      defaultView: "learning",
      previewable: hasOriginalPreview,
      capabilities: {
        outline: true,
        findInPage: true,
        pageJump: false,
        timeSeek: false,
      },
      hasLearningPreview,
    };
  }
  return {
    format: "unsupported",
    viewMode: "external",
    defaultView: hasLearningPreview ? "learning" : "original",
    previewable: hasOriginalPreview,
    capabilities: {
      outline: false,
      findInPage: false,
      pageJump: false,
      timeSeek: false,
    },
    hasLearningPreview,
  };
}

export function slugifyOutlineLabel(label = "") {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

