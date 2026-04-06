import { createSource, normalizeWhitespace } from "../material/material-model.js";

const titlePattern = /<title[^>]*>([^<]+)<\/title>/i;
const tagPattern = /<[^>]+>/g;
const scriptPattern = /<script[\s\S]*?<\/script>/gi;
const stylePattern = /<style[\s\S]*?<\/style>/gi;

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
