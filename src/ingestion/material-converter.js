import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeHtmlToText, sanitizeHtmlForReading } from "./url-fetcher.js";
import { normalizeWhitespace } from "../material/material-model.js";
import {
  buildLearningFromHtml,
  buildLearningFromMarkdown,
  buildLearningFromText,
  buildOutlineFromText,
  buildRenderDescriptor,
  detectPrimaryFormat,
  normalizeMimeType,
} from "../knowledge/source-document-format.js";

const execFileAsync = promisify(execFile);
const maxUploadBytes = 15 * 1024 * 1024;
const allowedVideoHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const textLikeMimePattern = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|yaml|x-yaml))/i;

function isPrivateIpv4(address = "") {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
    || first === 0;
}

function isBlockedHost(hostname = "") {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "169.254.169.254") {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return false;
}

export function validateRemoteMaterialUrl(rawUrl = "", { allowVideo = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("资料地址格式不正确。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("仅支持 http/https 资料地址。");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error("资料地址不支持本机、内网或元数据服务。");
  }
  const isVideo = allowedVideoHosts.has(parsed.hostname.toLowerCase());
  if (!allowVideo && isVideo) {
    throw new Error("当前入口不支持视频地址。");
  }
  return {
    url: parsed.toString(),
    hostname: parsed.hostname.toLowerCase(),
    isVideo,
  };
}

async function fetchWithSafeRedirects(url, { fetchImpl = globalThis.fetch, redirectCount = 0 } = {}) {
  if (redirectCount > 5) {
    throw new Error("资料地址跳转次数过多。");
  }
  const safeUrl = validateRemoteMaterialUrl(url).url;
  const response = await fetchImpl(safeUrl, {
    redirect: "manual",
    headers: {
      "user-agent": "LearningLoopAI/0.1",
    },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("资料地址跳转缺少目标地址。");
    }
    return fetchWithSafeRedirects(new URL(location, safeUrl).toString(), {
      fetchImpl,
      redirectCount: redirectCount + 1,
    });
  }
  if (!response.ok) {
    throw new Error(`资料地址读取失败：${response.status}`);
  }
  return response;
}

function markdownFromText(title = "", text = "") {
  const normalizedTitle = normalizeWhitespace(title || "我的资料");
  const normalizedText = normalizeWhitespace(text);
  if (normalizedText.length < 80) {
    throw new Error("资料内容太短，无法可靠生成学习文档。");
  }
  const paragraphs = normalizedText
    .split(/\n{2,}|\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  return `# ${normalizedTitle}\n\n${paragraphs.join("\n\n")}\n`;
}

function normalizeLearningPayload({
  markdown = "",
  text = "",
  outline = [],
  chunkCount = 0,
  sufficientForQa = false,
  sufficientForTraining = false,
  extractionStatus = "",
  extractionNotes = "",
} = {}) {
  return {
    text: normalizeWhitespace(text),
    markdown: String(markdown || "").trim() ? String(markdown || "") : "",
    outline: Array.isArray(outline) ? outline : [],
    chunkCount: Number.isFinite(chunkCount) ? chunkCount : 0,
    sufficientForQa: Boolean(sufficientForQa),
    sufficientForTraining: Boolean(sufficientForTraining),
    extractionStatus: String(extractionStatus || "").trim(),
    extractionNotes: String(extractionNotes || "").trim(),
  };
}

function buildExtractionFailedLearning({ title = "", note = "" } = {}) {
  const normalizedTitle = normalizeWhitespace(title || "我的资料");
  const normalizedNote = normalizeWhitespace(note || "未能提取足够文本内容。");
  return {
    text: "",
    markdown: `# ${normalizedTitle}\n\n> ${normalizedNote}\n`,
    outline: normalizedTitle
      ? [{ id: "reading-only", label: normalizedTitle, level: 1 }]
      : [],
    chunkCount: 0,
    sufficientForQa: false,
    sufficientForTraining: false,
    extractionStatus: "failed",
    extractionNotes: normalizedNote,
  };
}

function extractTitleFromHtml(html = "", fallback = "远程资料") {
  const match = String(html || "").match(/<title[^>]*>([^<]+)<\/title>/i);
  return normalizeWhitespace(match?.[1] || fallback);
}

function isTextLikeMime(mimeType = "") {
  return textLikeMimePattern.test(String(mimeType || ""));
}

function extensionFromMimeType(mimeType = "", format = "unsupported") {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType === "text/html" || format === "html") {
    return ".html";
  }
  if (normalizedMimeType === "text/markdown" || format === "markdown") {
    return ".md";
  }
  if (normalizedMimeType === "application/pdf" || format === "pdf") {
    return ".pdf";
  }
  if (format === "text") {
    return ".txt";
  }
  return "";
}

function ensureFilenameExtension(filename = "", mimeType = "", format = "unsupported") {
  const base = path.basename(String(filename || "").trim()) || "material";
  if (path.extname(base)) {
    return base;
  }
  const extension = extensionFromMimeType(mimeType, format);
  return extension ? `${base}${extension}` : base;
}

function buildConvertedMaterial({
  title,
  sourceType,
  originalUrl = "",
  originalFilename = "",
  originalMimeType = "",
  originalBytes = null,
  primaryFormat = "unsupported",
  renderSnapshotHtml = "",
  learning,
} = {}) {
  const normalizedLearning = normalizeLearningPayload(learning);
  const previewable = ["html", "pdf", "text", "markdown"].includes(primaryFormat);
  return {
    title,
    markdown: normalizedLearning.markdown,
    primaryFormat,
    sourceType,
    originalUrl,
    originalFilename,
    originalMimeType: normalizeMimeType(originalMimeType) || "application/octet-stream",
    originalBytes,
    renderSnapshotHtml,
    render: buildRenderDescriptor({
      format: primaryFormat,
      hasOriginalPreview: previewable,
      hasLearningPreview: Boolean(normalizedLearning.markdown || normalizedLearning.text),
    }),
    learning: {
      ...normalizedLearning,
      chunkCount: normalizedLearning.text
        ? normalizedLearning.text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).length
        : 0,
      sufficientForQa: normalizedLearning.sufficientForQa || normalizedLearning.text.length >= 220,
      sufficientForTraining: normalizedLearning.sufficientForTraining || normalizedLearning.text.length >= 220,
      extractionStatus: normalizedLearning.extractionStatus || (normalizedLearning.text ? "ready" : "failed"),
      extractionNotes: normalizedLearning.extractionNotes || (normalizedLearning.text ? "" : "未能提取足够文本内容。"),
    },
  };
}

async function convertWithMarkItDown(buffer, { filename = "material.bin" } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "llai-material-"));
  try {
    await mkdir(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, path.basename(filename) || "material.bin");
    await writeFile(sourcePath, buffer);
    const { stdout } = await execFileAsync("markitdown", [sourcePath], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const markdown = normalizeWhitespace(stdout);
    if (markdown.length < 80) {
      throw new Error("MarkItDown 未能提取足够内容。");
    }
    return markdown;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("当前环境未安装 MarkItDown，无法转换该格式。");
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function convertRemoteMaterialUrl(
  url,
  { fetchImpl = globalThis.fetch, markItDownConverter = convertWithMarkItDown } = {},
) {
  const safe = validateRemoteMaterialUrl(url);
  if (safe.isVideo) {
    throw new Error("当前视频地址未能获取可学习文本，请上传文档或提供带文字内容的资料链接。");
  }
  const response = await fetchWithSafeRedirects(safe.url, { fetchImpl });
  const contentType = normalizeMimeType(response.headers.get("content-type") || "text/html");
  const body = Buffer.from(await response.arrayBuffer());
  const fallbackFilename = path.basename(new URL(safe.url).pathname) || safe.hostname;
  const primaryFormat = detectPrimaryFormat({ mimeType: contentType, filename: fallbackFilename });
  let title = safe.hostname;
  let learning;
  let renderSnapshotHtml = "";
  if (primaryFormat === "html") {
    const html = body.toString("utf8");
    title = extractTitleFromHtml(html, safe.hostname);
    learning = buildLearningFromHtml({ html, title });
    renderSnapshotHtml = sanitizeHtmlForReading(html, { baseUrl: response.url || safe.url });
  } else if (primaryFormat === "markdown") {
    title = fallbackFilename.replace(/\.[^.]+$/, "") || safe.hostname;
    learning = buildLearningFromMarkdown(body.toString("utf8"), { fallbackTitle: title });
  } else if (primaryFormat === "text" || isTextLikeMime(contentType)) {
    title = fallbackFilename.replace(/\.[^.]+$/, "") || safe.hostname;
    learning = buildLearningFromText(body.toString("utf8"), { title });
  } else {
    title = fallbackFilename.replace(/\.[^.]+$/, "") || safe.hostname;
    try {
      const convertedMarkdown = await markItDownConverter(body, { filename: fallbackFilename });
      learning = buildLearningFromMarkdown(convertedMarkdown, { fallbackTitle: title });
    } catch (error) {
      learning = buildExtractionFailedLearning({
        title,
        note: error?.message || "未能提取足够文本内容。",
      });
    }
  }
  const originalFilename = ensureFilenameExtension(fallbackFilename || title, contentType, primaryFormat);
  return buildConvertedMaterial({
    title,
    sourceType: "remote-document",
    originalUrl: safe.url,
    originalFilename,
    originalMimeType: contentType,
    originalBytes: body,
    primaryFormat,
    renderSnapshotHtml,
    learning,
  });
}

export async function convertUploadedMaterial({
  filename = "material.txt",
  mimeType = "text/plain",
  contentBase64 = "",
  markItDownConverter = convertWithMarkItDown,
} = {}) {
  const bytes = Buffer.from(String(contentBase64 || ""), "base64");
  if (!bytes.length) {
    throw new Error("上传文件内容为空。");
  }
  if (bytes.length > maxUploadBytes) {
    throw new Error("上传文件超过 15MB 限制。");
  }
  const safeFilename = path.basename(String(filename || "material.txt").replace(/\0/g, "")) || "material.txt";
  const normalizedMimeType = normalizeMimeType(mimeType || "text/plain");
  const primaryFormat = detectPrimaryFormat({ mimeType: normalizedMimeType, filename: safeFilename });
  let learning;
  let renderSnapshotHtml = "";
  if (primaryFormat === "html") {
    const html = bytes.toString("utf8");
    const title = extractTitleFromHtml(html, safeFilename.replace(/\.[^.]+$/, "") || safeFilename);
    learning = buildLearningFromHtml({ html, title });
    renderSnapshotHtml = sanitizeHtmlForReading(html);
  } else if (primaryFormat === "markdown") {
    learning = buildLearningFromMarkdown(bytes.toString("utf8"), {
      fallbackTitle: safeFilename.replace(/\.[^.]+$/, "") || safeFilename,
    });
  } else if (primaryFormat === "text" || isTextLikeMime(normalizedMimeType)) {
    learning = buildLearningFromText(bytes.toString("utf8"), {
      title: safeFilename.replace(/\.[^.]+$/, "") || safeFilename,
    });
  } else {
    const fallbackTitle = safeFilename.replace(/\.[^.]+$/, "") || safeFilename;
    try {
      const convertedMarkdown = await markItDownConverter(bytes, { filename: safeFilename });
      learning = buildLearningFromMarkdown(convertedMarkdown, {
        fallbackTitle,
      });
    } catch (error) {
      learning = buildExtractionFailedLearning({
        title: fallbackTitle,
        note: error?.message || "未能提取足够文本内容。",
      });
    }
  }
  return buildConvertedMaterial({
    title: safeFilename.replace(/\.[^.]+$/, "") || safeFilename,
    sourceType: "uploaded-file",
    originalFilename: ensureFilenameExtension(safeFilename, normalizedMimeType, primaryFormat),
    originalMimeType: normalizedMimeType || "application/octet-stream",
    originalBytes: bytes,
    primaryFormat,
    renderSnapshotHtml,
    learning,
  });
}

export { maxUploadBytes };
