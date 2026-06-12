import { readSourceDocument } from "../../../src/knowledge/source-document-resolver.js";
import { getDocumentLearningText } from "./knowledge-domain.js";
import { proxyJson } from "./service-proxy.js";

const sourceExcerptLimit = 3200;

function normalizeText(value = "") {
  return String(value || "").trim();
}

function clipText(value = "", limit = sourceExcerptLimit) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function parseReviewPracticePath(pathname = "") {
  const match = /^\/api\/review\/([^/]+)\/practice$/.exec(String(pathname || ""));
  return match ? decodeURIComponent(match[1]) : "";
}

export function getDocumentPathFromSourceRef(sourceRef = "") {
  const value = normalizeText(sourceRef);
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return "";
  }
  return value.split("#")[0].trim();
}

function fallbackRescueMarkdown({ item, question, judgment }) {
  const misses = Array.isArray(judgment?.misses) ? judgment.misses : [];
  const missedList = misses.length
    ? misses.map((miss, index) => `${index + 1}. ${miss}`).join("\n")
    : "1. 先把题目里的关键机制、边界和取舍补全。";
  return [
    `### ${item.handle || "这条复习项"} · 补讲`,
    "",
    `刚才这题是：${question}`,
    "",
    "你这轮还需要补齐：",
    missedList,
    "",
    "再答一次时，先用一句话给出结论，再按“机制 -> 边界 -> 取舍/例子”的顺序展开。",
  ].join("\n");
}

async function buildSourceContext({ item, userId = "", readDocument = readSourceDocument } = {}) {
  const docPath = getDocumentPathFromSourceRef(item?.source_ref || "");
  if (!docPath) {
    return {
      docPath: "",
      title: "",
      excerpt: "",
      available: false,
    };
  }
  try {
    const document = await readDocument(docPath, { userId });
    return {
      docPath: document.path || docPath,
      title: document.title || "",
      excerpt: clipText(getDocumentLearningText(document)),
      available: true,
    };
  } catch {
    return {
      docPath,
      title: "",
      excerpt: "",
      available: false,
    };
  }
}

function serializeReviewItem(item = {}) {
  return {
    id: item.id || "",
    handle: item.handle || "",
    source_ref: item.source_ref || "",
    evidence: item.evidence || {},
    state: item.state || "shaky",
    streak: Number(item.streak || 0),
    last_seen_at: item.last_seen_at || "",
    next_due_at: item.next_due_at || "",
  };
}

function buildRescueGap({ item, question, judgment }) {
  return {
    topic: item.handle || "当前复习项",
    title: item.handle || "当前复习项",
    questionText: question,
    summary: item.evidence?.question || "",
    misses: Array.isArray(judgment?.misses) ? judgment.misses : [],
    keyPoints: Array.isArray(judgment?.hits) ? judgment.hits : [],
    likelyFollowups: [],
  };
}

export function createReviewPracticeDomain({
  store,
  proxy = proxyJson,
  readDocument = readSourceDocument,
  now = () => new Date().toISOString(),
} = {}) {
  if (!store) {
    throw new Error("review practice store is required.");
  }

  async function getItemOrThrow(id = "") {
    const cleanId = normalizeText(id);
    if (!cleanId) {
      throw new Error("review item id is required.");
    }
    const item = await store.get(cleanId);
    if (!item) {
      throw new Error(`review item not found: ${cleanId}`);
    }
    return item;
  }

  async function start({ id, userId = "" } = {}) {
    const item = await getItemOrThrow(id);
    const source = await buildSourceContext({ item, userId, readDocument });
    const { data, traceId } = await proxy("POST", "/api/review/generate-question", {
      reviewItem: serializeReviewItem(item),
      sourceExcerpt: source.excerpt,
    });
    const question = normalizeText(data?.question);
    if (!question) {
      throw new Error("AI 服务未能生成复习题，请稍后重试。");
    }
    return {
      mode: "review_practice",
      reviewItem: serializeReviewItem(item),
      question,
      intent: data?.intent || "review_item_revisit",
      source,
      traceId,
    };
  }

  async function answer({ id, userId = "", question = "", answer: learnerAnswer = "" } = {}) {
    const item = await getItemOrThrow(id);
    const cleanQuestion = normalizeText(question);
    const cleanAnswer = normalizeText(learnerAnswer);
    if (!cleanQuestion) {
      throw new Error("question is required.");
    }
    if (!cleanAnswer) {
      throw new Error("answer is required.");
    }

    const source = await buildSourceContext({ item, userId, readDocument });
    const { data: judgment, traceId } = await proxy("POST", "/api/anchor-judge", {
      question: cleanQuestion,
      answer: cleanAnswer,
      sourceExcerpt: source.excerpt,
    });
    const passed = judgment?.verdict === "pass";
    const updatedItem = await store.updateState({
      id: item.id,
      state: passed ? "solid" : "shaky",
      now: now(),
    });

    let rescue = null;
    if (!passed) {
      try {
        const { data } = await proxy("POST", "/api/loopassist/rescue-material", {
          scope: {
            role: "review-practice",
            round: "到期复习",
            topics: [item.handle].filter(Boolean),
          },
          gap: buildRescueGap({ item, question: cleanQuestion, judgment }),
        });
        const markdown = normalizeText(data?.markdown);
        rescue = {
          markdown: markdown || fallbackRescueMarkdown({ item, question: cleanQuestion, judgment }),
          fallback: !markdown,
        };
      } catch (error) {
        rescue = {
          markdown: fallbackRescueMarkdown({ item, question: cleanQuestion, judgment }),
          fallback: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      mode: "review_practice",
      reviewItem: serializeReviewItem(updatedItem),
      question: cleanQuestion,
      answer: cleanAnswer,
      judgment,
      passed,
      outcome: passed ? "solid" : "shaky",
      rescue,
      source,
      traceId,
    };
  }

  return {
    start,
    answer,
  };
}
