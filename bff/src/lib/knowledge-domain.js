import { readSourceDocument } from "../../../src/knowledge/source-document-resolver.js";
import { proxyJson } from "./service-proxy.js";

export function getDocumentLearningText(document = {}) {
  const learningText = String(document.learning?.text || "").trim();
  if (learningText) {
    return learningText;
  }
  const learningMarkdown = String(document.learning?.markdown || "").trim();
  if (learningMarkdown) {
    return learningMarkdown;
  }
  return String(document.markdown || "").trim();
}

export function extractReadableKnowledgeLines(content = "") {
  return String(content || "")
    .replace(/\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, "").replace(/^[-*]\s*/, ""))
    .filter(Boolean);
}

export function hasSufficientKnowledgeContent(document = {}) {
  const lines = extractReadableKnowledgeLines(getDocumentLearningText(document));
  const longLines = lines.filter((line) => line.length >= 18);
  const totalTextLength = lines.join(" ").length;
  return longLines.length >= 3 && totalTextLength >= 220;
}

export function normalizeKnowledgeGoal(goal = "") {
  return String(goal || "").trim() || "interview";
}

export function normalizeKnowledgeTaskType(taskType = "") {
  const normalized = String(taskType || "").trim();
  return ["summary", "memory_points", "question_points", "inline_quiz", "selection_explain"].includes(normalized)
    ? normalized
    : "freeform";
}

export function buildFallbackKnowledgeAnswer(question = "", document = {}, { taskType = "freeform" } = {}) {
  const lines = extractReadableKnowledgeLines(getDocumentLearningText(document));
  const headings = lines.filter((line) => line.length <= 48).slice(0, 8);
  const paragraphs = lines.filter((line) => line.length > 18).slice(0, 6);
  if (taskType === "summary" || /总结|概括|3\s*句|三句/.test(question)) {
    return (paragraphs.length ? paragraphs : headings).slice(0, 3).map((line, index) => `${index + 1}. ${line}`).join("\n");
  }
  if (taskType === "memory_points") {
    return (headings.length ? headings : paragraphs).map((line, index) => `${index + 1}. ${line}：这是当前目标下值得优先记住的内容。`).join("\n");
  }
  if (taskType === "inline_quiz") {
    const sourceText = String(question || "").includes("原文：")
      ? String(question || "").split("原文：").at(-1)
      : (paragraphs[0] || headings[0] || "这段原文的核心概念");
    const answer = String(sourceText || "").split(/[。！？；\n]/)[0].trim() || "这段原文的核心概念";
    return `自测题：这段话最核心的概念是什么？\n参考答案：${answer.slice(0, 80)}`;
  }
  if (taskType === "question_points" || /面试|追问|问题/.test(question)) {
    return (headings.length ? headings : paragraphs).map((line, index) => `${index + 1}. 问题：${line} 的核心机制、适用场景和边界是什么？\n考察点：是否真正理解这个关键点，而不是只记住标题。`).join("\n");
  }
  const seeds = (paragraphs.length ? paragraphs : headings).slice(0, 2);
  return seeds.length ? `基于《${document.title || "当前文档"}》，${seeds.join("；")}` : "这篇材料里没有足够内容回答这个问题。";
}

export async function handleKnowledgeAnswer(body) {
  const question = String(body.question || "").trim();
  const docPath = String(body.docPath || "").trim();
  const goal = normalizeKnowledgeGoal(body.goal);
  const taskType = normalizeKnowledgeTaskType(body.taskType);
  if (!question) {
    throw new Error("question is required.");
  }
  if (!docPath) {
    throw new Error("docPath is required.");
  }

  const document = await readSourceDocument(docPath, { userId: body.userId || "" });
  if (!hasSufficientKnowledgeContent(document)) {
    return {
      mode: "knowledge_qa",
      content: `《${document.title || "当前文档"}》当前公开内容不足，暂时无法支持问答。你可以先继续阅读其他正文更完整的材料。`,
      suggestedFollowUp: "换一篇正文更完整的文档继续训练",
      source: {
        title: document.title,
        path: document.path,
      },
      fallbackReason: "insufficient_public_content",
    };
  }
  try {
    const { data, traceId } = await proxyJson("POST", "/api/superapp/answer-knowledge-question", {
      userId: body.userId || "",
      question,
      goal,
      taskType,
      title: document.title,
      context: getDocumentLearningText(document),
    });
    return {
      ...data,
      traceId,
      source: {
        title: document.title,
        path: document.path,
      },
    };
  } catch (error) {
    return {
      mode: "knowledge_qa",
      content: buildFallbackKnowledgeAnswer(question, document, { taskType }),
      suggestedFollowUp: "把这个点出成一道快答题",
      source: {
        title: document.title,
        path: document.path,
      },
      fallbackReason: error.message,
    };
  }
}
