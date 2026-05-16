import { createSource, normalizeWhitespace } from "../material/material-model.js";

const titlePattern = /<title[^>]*>([^<]+)<\/title>/i;
const tagPattern = /<[^>]+>/g;
const scriptPattern = /<script[\s\S]*?<\/script>/gi;
const stylePattern = /<style[\s\S]*?<\/style>/gi;
const bodyPattern = /<body[^>]*>([\s\S]*?)<\/body>/i;

export function normalizeHtmlToText(html) {
  return normalizeWhitespace(
    String(html ?? "")
      .replace(scriptPattern, " ")
      .replace(stylePattern, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(tagPattern, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, "\"")
  );
}

function absolutizeHtmlUrl(rawValue, baseUrl) {
  const value = String(rawValue || "").trim();
  if (!value || value.startsWith("#") || value.startsWith("data:") || value.startsWith("mailto:") || value.startsWith("tel:")) {
    return value;
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

export function sanitizeHtmlForReading(html, { baseUrl = "" } = {}) {
  const body = String(html || "").match(bodyPattern)?.[1] || String(html || "");
  const withoutActiveContent = body
    .replace(scriptPattern, " ")
    .replace(stylePattern, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<object[\s\S]*?<\/object>/gi, " ")
    .replace(/<embed[\s\S]*?>/gi, " ")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\sstyle\s*=\s*"[^"]*"/gi, "")
    .replace(/\sstyle\s*=\s*'[^']*'/gi, "")
    .replace(/\s(href|src)\s*=\s*"javascript:[^"]*"/gi, "")
    .replace(/\s(href|src)\s*=\s*'javascript:[^']*'/gi, "");

  const rewrittenUrls = withoutActiveContent.replace(/\s(href|src)\s*=\s*"([^"]+)"/gi, (_, attribute, value) => (
    ` ${attribute}="${absolutizeHtmlUrl(value, baseUrl)}"`
  )).replace(/\s(href|src)\s*=\s*'([^']+)'/gi, (_, attribute, value) => (
    ` ${attribute}="${absolutizeHtmlUrl(value, baseUrl)}"`
  ));

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Reading Snapshot</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        padding: 32px 24px 64px;
        font-family: "Georgia", "Times New Roman", serif;
        color: #0f172a;
        background: #ffffff;
        line-height: 1.7;
      }
      article {
        max-width: 880px;
        margin: 0 auto;
      }
      img, video {
        max-width: 100%;
        height: auto;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        overflow: auto;
        display: block;
      }
      th, td {
        border: 1px solid #cbd5e1;
        padding: 8px 10px;
      }
      a { color: #1d4ed8; }
      pre, code {
        font-family: "SFMono-Regular", "Consolas", monospace;
        white-space: pre-wrap;
      }
      blockquote {
        margin: 0;
        padding-left: 16px;
        border-left: 4px solid #cbd5e1;
        color: #334155;
      }
    </style>
  </head>
  <body>
    <article>${rewrittenUrls}</article>
  </body>
</html>`;
}

function extractTitleFromHtml(html, fallbackUrl) {
  const match = String(html ?? "").match(titlePattern);
  if (match?.[1]) {
    return normalizeWhitespace(match[1]);
  }

  try {
    const { hostname, pathname } = new URL(fallbackUrl);
    return normalizeWhitespace(`${hostname}${pathname}`);
  } catch {
    return "Submitted URL";
  }
}

export async function fetchSubmittedPage(url, { fetchImpl = globalThis.fetch } = {}) {
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  const response = await fetchImpl(parsedUrl, {
    redirect: "follow",
    headers: {
      "user-agent": "LearningLoopAI/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status}`);
  }

  const html = await response.text();
  const content = normalizeHtmlToText(html);
  if (content.length < 80) {
    throw new Error("Submitted URL does not contain enough readable content.");
  }

  return createSource({
    kind: "url",
    title: extractTitleFromHtml(html, url),
    content,
    url,
    metadata: {
      submittedPageOnly: true
    }
  });
}
