import { decomposeSource, summarizeSourceForDisplay } from "../material/concept-decomposer.js";
import { normalizeWhitespace } from "../material/material-model.js";
import {
  analyzeLearnerAnswer,
  buildTutorFeedback,
  createFollowUpQuestion
} from "./probe-engine.js";
import { judgeConcept } from "./mastery-judge.js";
import { chooseNextAction } from "./tutor-policy.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "/chat/completions";
const defaultOpenAIModel = process.env.OPENAI_MODEL || "gpt-5-mini";
const defaultDeepSeekBaseUrl = process.env.LLAI_DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const defaultDeepSeekModel = process.env.LLAI_DEEPSEEK_MODEL || "deepseek-chat";
const defaultProviderTimeoutMs = Number(process.env.LLAI_LLM_TIMEOUT_MS || 90000);

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureString(value, fallback = "") {
  const normalized = normalizeWhitespace(value);
  return normalized || fallback;
}

function slugify(value) {
  return ensureString(value, "unit")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "unit";
}

function validateUnit(unit, index) {
  return {
    id: ensureString(unit.id, `${slugify(unit.title || `unit-${index + 1}`)}-${index + 1}`),
    title: ensureString(unit.title, `Teachable Unit ${index + 1}`),
    summary: ensureString(unit.summary),
    excerpt: ensureString(unit.excerpt || unit.evidenceReference || unit.summary),
    keywords: ensureArray(unit.keywords).map((item) => ensureString(item)).filter(Boolean).slice(0, 8),
    sourceAnchors: ensureArray(unit.sourceAnchors).map((item) => ensureString(item)).filter(Boolean).slice(0, 3),
    misconception: ensureString(unit.misconception),
    importance: ensureString(unit.importance, "secondary"),
    coverage: ensureString(unit.coverage, "medium"),
    diagnosticQuestion: ensureString(unit.diagnosticQuestion),
    retryQuestion: ensureString(unit.retryQuestion),
    stretchQuestion: ensureString(unit.stretchQuestion),
    checkQuestion: ensureString(unit.checkQuestion, unit.retryQuestion || unit.diagnosticQuestion),
    remediationHint: ensureString(unit.remediationHint),
    order: index + 1
  };
}

function normalizeDecompositionPayload(payload, source) {
  const rawUnits = ensureArray(payload?.units).slice(0, 7);
  if (rawUnits.length < 3) {
    throw new Error("Tutor intelligence returned too few teaching units.");
  }

  const units = rawUnits.map(validateUnit).filter((unit) => unit.summary && unit.diagnosticQuestion);
  if (units.length < 3) {
    throw new Error("Tutor intelligence returned invalid teaching units.");
  }

  const keyThemes = ensureArray(payload?.summary?.keyThemes)
    .map((item) => ensureString(item))
    .filter(Boolean)
    .slice(0, 3);

  return {
    concepts: units,
    summary: {
      sourceTitle: ensureString(payload?.summary?.sourceTitle, source.title),
      keyThemes: keyThemes.length > 0 ? keyThemes : units.slice(0, 3).map((unit) => unit.title),
      framing: ensureString(
        payload?.summary?.framing,
        `我先从材料里提炼出 ${units.slice(0, 3).map((unit) => unit.title).join("、")} 这些切入点。`
      )
    }
  };
}

function normalizeReviewPayload(payload, concept) {
  const judge = payload?.judge ?? {};
  const feedback = payload?.feedback ?? {};

  return {
    signal: ["positive", "negative", "noise"].includes(payload?.signal) ? payload.signal : "noise",
    judge: {
      state: ["solid", "partial", "weak", "不可判"].includes(judge?.state) ? judge.state : "weak",
      confidence:
        typeof judge?.confidence === "number" && judge.confidence >= 0 && judge.confidence <= 1
          ? judge.confidence
          : 0.3,
      reasons: ensureArray(judge?.reasons).map((item) => ensureString(item)).filter(Boolean).slice(0, 4)
    },
    feedback: {
      explanation: ensureString(feedback?.explanation),
      gap: ensureString(feedback?.gap),
      evidenceReference: ensureString(feedback?.evidenceReference || concept.excerpt),
      coachingStep: ensureString(feedback?.coachingStep),
      positiveConfirmation: ensureString(feedback?.positiveConfirmation),
      enrichment: ensureString(feedback?.enrichment),
      teachingChunk: ensureString(feedback?.teachingChunk),
      checkQuestion: ensureString(feedback?.checkQuestion)
    },
    nextQuestion: ensureString(payload?.nextQuestion)
  };
}

function normalizeTutorMovePayload(payload, concept) {
  const judge = payload?.judge ?? {};

  return {
    moveType: ensureString(payload?.moveType, "repair"),
    signal: ["positive", "negative", "noise"].includes(payload?.signal) ? payload.signal : "noise",
    judge: {
      state: ["solid", "partial", "weak", "不可判"].includes(judge?.state) ? judge.state : "weak",
      confidence:
        typeof judge?.confidence === "number" && judge.confidence >= 0 && judge.confidence <= 1
          ? judge.confidence
          : 0.3,
      reasons: ensureArray(judge?.reasons).map((item) => ensureString(item)).filter(Boolean).slice(0, 4)
    },
    visibleReply: ensureString(payload?.visibleReply),
    evidenceReference: ensureString(payload?.evidenceReference || concept.excerpt),
    teachingChunk: ensureString(payload?.teachingChunk),
    nextQuestion: ensureString(payload?.nextQuestion),
    takeaway: ensureString(payload?.takeaway, concept.summary),
    confirmedUnderstanding: ensureString(payload?.confirmedUnderstanding),
    remainingGap: ensureString(payload?.remainingGap),
    revisitReason: ensureString(payload?.revisitReason),
    completeCurrentUnit: Boolean(payload?.completeCurrentUnit),
    requiresResponse: payload?.requiresResponse !== false
  };
}

function formatRecentTurns(turns = []) {
  return turns
    .slice(-6)
    .map((turn) => {
      const label = turn.role === "tutor" ? "Tutor" : "Learner";
      const suffix = [turn.kind, turn.action].filter(Boolean).join("/");
      return `${label}${suffix ? ` (${suffix})` : ""}: ${turn.content}`;
    })
    .join("\n");
}

function importanceNeedsRevisit(concept) {
  return (concept.importance || "secondary") === "core";
}

function extractTextFromResponsesPayload(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  for (const item of ensureArray(payload?.output)) {
    for (const content of ensureArray(item?.content)) {
      if (typeof content?.text === "string" && content.text.trim()) {
        return content.text;
      }
    }
  }

  throw new Error("OpenAI response did not include text output.");
}

function stripCodeFence(text) {
  return String(text ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function parseProviderJsonText(text) {
  const cleaned = stripCodeFence(text);

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }

  throw new Error("Provider response did not contain valid JSON.");
}

function createTimeoutSignal(timeoutMs = defaultProviderTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
    }
  };
}

function isAbortLikeError(error) {
  return (
    error?.name === "AbortError" ||
    /aborted|abort/i.test(String(error?.message || "")) ||
    /This operation was aborted/i.test(String(error || ""))
  );
}

function wrapProviderError(error, providerName, timeoutMs) {
  if (isAbortLikeError(error)) {
    return new Error(`${providerName} 请求超时（>${Math.round(timeoutMs / 1000)}s），请重试。`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

async function callOpenAIJson({
  apiKey,
  model = defaultOpenAIModel,
  prompt,
  schema,
  fetchImpl = globalThis.fetch,
  timeoutMs = defaultProviderTimeoutMs
}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for AI tutor mode.");
  }

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      signal: timeout.signal,
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "You are the cognition layer for an AI tutor. Return only valid JSON matching the provided schema. " +
                  "Use the submitted material as the primary anchor, but you may use necessary background knowledge to teach clearly. " +
                  "Never drift into generic motivational talk."
              }
            ]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: prompt }]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: schema.name,
            schema: schema.schema,
            strict: true
          }
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    return parseProviderJsonText(extractTextFromResponsesPayload(payload));
  } catch (error) {
    throw wrapProviderError(error, "OpenAI", timeoutMs);
  } finally {
    timeout.clear();
  }
}

function extractMessageContent(payload, providerName) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }

  throw new Error(`${providerName} response did not include message content.`);
}

async function callDeepSeekJson({
  apiKey,
  baseUrl = defaultDeepSeekBaseUrl,
  model = defaultDeepSeekModel,
  prompt,
  schema,
  fetchImpl = globalThis.fetch,
  timeoutMs = defaultProviderTimeoutMs
}) {
  if (!apiKey) {
    throw new Error("LLAI_DEEPSEEK_API_KEY is required for DeepSeek tutor mode.");
  }

  const url = `${baseUrl.replace(/\/$/, "")}${DEEPSEEK_CHAT_COMPLETIONS_URL}`;
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const timeout = createTimeoutSignal(timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        signal: timeout.signal,
        body: JSON.stringify({
          model,
          response_format: {
            type: "json_object"
          },
          messages: [
            {
              role: "system",
              content:
                "You are the cognition layer for an AI tutor. Return valid json only. " +
                "Use the submitted material as the primary anchor, but you may use necessary background knowledge to teach clearly. " +
                "Never drift into generic motivational talk."
            },
            {
              role: "user",
              content: [
                prompt,
                "",
                "Return json matching this shape:",
                JSON.stringify(schema.example, null, 2)
              ].join("\n")
            }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DeepSeek request failed: ${response.status} ${errorText}`);
      }

      const payload = await response.json();
      return parseProviderJsonText(extractMessageContent(payload, "DeepSeek"));
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isAbortLikeError(error)) {
        throw wrapProviderError(error, "DeepSeek", timeoutMs);
      }
    } finally {
      timeout.clear();
    }
  }

  throw wrapProviderError(lastError, "DeepSeek", timeoutMs);
}

const decompositionSchema = {
  name: "tutor_decomposition",
  example: {
    summary: {
      sourceTitle: "AQS 详解",
      keyThemes: ["AQS 的作用是什么？", "AQS 为什么使用 CLH 锁队列的变体？"],
      framing: "我先从材料里提炼出几个切入点，再围绕其中的具体机制来出题。"
    },
    units: [
      {
        id: "aqs-role-1",
        title: "AQS 的作用是什么？",
        summary: "AQS 为锁和同步器提供通用框架。",
        excerpt: "AQS 提供了资源获取和释放的通用框架。",
        keywords: ["aqs", "synchronizer"],
        sourceAnchors: ["AQS 提供了资源获取和释放的通用框架。"],
        misconception: "容易只说它很重要，不说明它到底抽象了什么。",
        importance: "core",
        coverage: "high",
        diagnosticQuestion: "请直接回答：AQS 的作用是什么？",
        retryQuestion: "先只回答一个点：AQS 替同步器隐藏了哪类底层线程协调逻辑？",
        stretchQuestion: "继续深入：AQS 为什么能复用到多种同步器上？",
        checkQuestion: "现在用你自己的话复述：AQS 为什么不是具体锁，而是同步器底座？",
        remediationHint: "先抓住材料里的关键点，再讲它屏蔽的底层协调逻辑。"
      }
    ]
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "units"],
    properties: {
      summary: {
        type: "object",
        additionalProperties: false,
        required: ["sourceTitle", "keyThemes", "framing"],
        properties: {
          sourceTitle: { type: "string" },
          keyThemes: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string" }
          },
          framing: { type: "string" }
        }
      },
      units: {
        type: "array",
        minItems: 3,
        maxItems: 7,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "summary",
            "excerpt",
            "keywords",
            "sourceAnchors",
            "misconception",
            "diagnosticQuestion",
            "retryQuestion",
            "stretchQuestion",
            "remediationHint"
          ],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            excerpt: { type: "string" },
            keywords: { type: "array", items: { type: "string" } },
            sourceAnchors: { type: "array", items: { type: "string" } },
            misconception: { type: "string" },
            importance: { type: "string" },
            coverage: { type: "string" },
            diagnosticQuestion: { type: "string" },
            retryQuestion: { type: "string" },
            stretchQuestion: { type: "string" },
            checkQuestion: { type: "string" },
            remediationHint: { type: "string" }
          }
        }
      }
    }
  }
};

const reviewSchema = {
  name: "tutor_turn_review",
  example: {
    signal: "negative",
    judge: {
      state: "partial",
      confidence: 0.45,
      reasons: ["回答比较泛，还没有落到关键机制"]
    },
    feedback: {
      explanation: "这题目前还没答到位。缺口：回答比较泛。材料证据：AQS 提供了资源获取和释放的通用框架。可以先按这个骨架回答：AQS 替同步器隐藏了哪类底层线程协调逻辑？",
      gap: "回答比较泛，没有讲到具体机制",
      evidenceReference: "AQS 提供了资源获取和释放的通用框架。",
      coachingStep: "AQS 替同步器隐藏了哪类底层线程协调逻辑？",
      positiveConfirmation: "",
      enrichment: "",
      teachingChunk: "AQS 并不是具体锁，而是把同步器实现里反复出现的排队、获取、释放、阻塞唤醒逻辑抽出来统一封装。",
      checkQuestion: "现在换成你自己的话说一遍：AQS 为什么不是具体锁，而是同步器的底座？"
    },
    nextQuestion: "先只回答一个点：AQS 替同步器隐藏了哪类底层线程协调逻辑？"
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["signal", "judge", "feedback", "nextQuestion"],
    properties: {
      signal: {
        type: "string",
        enum: ["positive", "negative", "noise"]
      },
      judge: {
        type: "object",
        additionalProperties: false,
        required: ["state", "confidence", "reasons"],
        properties: {
          state: { type: "string", enum: ["solid", "partial", "weak", "不可判"] },
          confidence: { type: "number" },
          reasons: { type: "array", items: { type: "string" } }
        }
      },
      feedback: {
        type: "object",
        additionalProperties: false,
        required: ["explanation", "gap", "evidenceReference", "coachingStep"],
        properties: {
          explanation: { type: "string" },
          gap: { type: "string" },
          evidenceReference: { type: "string" },
          coachingStep: { type: "string" },
          positiveConfirmation: { type: "string" },
          enrichment: { type: "string" },
          teachingChunk: { type: "string" },
          checkQuestion: { type: "string" }
        }
      },
      nextQuestion: { type: "string" }
    }
  }
};

const tutorMoveSchema = {
  name: "tutor_turn_move",
  example: {
    moveType: "teach",
    signal: "negative",
    judge: {
      state: "partial",
      confidence: 0.42,
      reasons: ["方向接近，但还没有讲清对象和机制"]
    },
    visibleReply:
      "你前面的方向其实是对的，只是还差最关键的一步。我先帮你把这一层讲清楚：AQS 不是具体锁，而是给同步器提供统一获取/释放资源框架的底座。",
    evidenceReference: "AQS 提供了资源获取和释放的通用框架。",
    teachingChunk:
      "AQS 不是具体锁，而是把同步器实现里通用的排队、获取、释放、阻塞唤醒逻辑统一抽出来。",
    nextQuestion: "现在别背原话，用你自己的话说一下：为什么 AQS 更像同步器底座而不是一把锁？",
    takeaway: "先记住：AQS 是构建锁和同步器的底层通用框架，不是某一把具体锁。",
    confirmedUnderstanding: "你已经意识到它和并发控制有关。",
    remainingGap: "还没把“抽象框架”这层角色说出来。",
    revisitReason: "这个点需要后续结合具体同步器再回头验证。",
    completeCurrentUnit: false,
    requiresResponse: true
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "moveType",
      "signal",
      "judge",
      "visibleReply",
      "evidenceReference",
      "teachingChunk",
      "nextQuestion",
      "takeaway",
      "confirmedUnderstanding",
      "remainingGap",
      "revisitReason",
      "completeCurrentUnit",
      "requiresResponse"
    ],
    properties: {
      moveType: {
        type: "string",
        enum: ["probe", "affirm", "deepen", "repair", "teach", "check", "summarize", "advance", "abstain"]
      },
      signal: {
        type: "string",
        enum: ["positive", "negative", "noise"]
      },
      judge: {
        type: "object",
        additionalProperties: false,
        required: ["state", "confidence", "reasons"],
        properties: {
          state: { type: "string", enum: ["solid", "partial", "weak", "不可判"] },
          confidence: { type: "number" },
          reasons: { type: "array", items: { type: "string" } }
        }
      },
      visibleReply: { type: "string" },
      evidenceReference: { type: "string" },
      teachingChunk: { type: "string" },
      nextQuestion: { type: "string" },
      takeaway: { type: "string" },
      confirmedUnderstanding: { type: "string" },
      remainingGap: { type: "string" },
      revisitReason: { type: "string" },
      completeCurrentUnit: { type: "boolean" },
      requiresResponse: { type: "boolean" }
    }
  }
};

function formatSourceForPrompt(source) {
  return [
    `TITLE: ${source.title}`,
    source.url ? `URL: ${source.url}` : null,
    "CONTENT:",
    source.content
  ]
    .filter(Boolean)
    .join("\n");
}

export function createOpenAITutorIntelligence({
  apiKey = process.env.OPENAI_API_KEY,
  model = defaultOpenAIModel,
  fetchImpl = globalThis.fetch
} = {}) {
  return {
    kind: "openai",

    async decomposeSource({ source }) {
      const prompt = [
        "Read the submitted learning material and produce 3-7 document-local teachable units.",
        "Requirements:",
        "- Stay anchored to the submitted source, but use minimal background knowledge when needed for clearer teaching.",
        "- Do not leak frontmatter, tags, SEO metadata, or boilerplate into the learner-facing summary.",
        "- Each unit must support a concrete first diagnostic question.",
        "- Each unit should include a check question for teach-back after explanation.",
        "- Prefer mechanisms, distinctions, failure modes, and misconceptions over broad topic labels.",
        "- Assign importance as core/secondary/optional and coverage as high/medium/low.",
        "",
        formatSourceForPrompt(source)
      ].join("\n");

      const payload = await callOpenAIJson({
        apiKey,
        model,
        fetchImpl,
        prompt,
        schema: decompositionSchema
      });

      return normalizeDecompositionPayload(payload, source);
    },

    async reviewTurn({ session, concept, answer, burdenSignal = "normal", priorEvidence = [] }) {
      const prompt = [
        "You are evaluating one learner turn inside an AI tutoring session.",
        "Judge the learner semantically, not by keyword overlap alone.",
        "The material is the primary anchor, but you may use necessary background knowledge for explanation.",
        "Return a concrete next question; do not ask generic prompts like 'why is this important?'",
        "When the learner is directionally correct, explicitly confirm what they got right and add one useful enrichment.",
        "When the learner is stuck, stop interrogating and give one compact teaching chunk plus a teach-back question.",
        "Keep the tone natural and tutor-like, not template-heavy.",
        "",
        `SOURCE TITLE: ${session.source.title}`,
        `SESSION FRAMING: ${session.summary.framing}`,
        `CURRENT UNIT: ${concept.title}`,
        `UNIT SUMMARY: ${concept.summary}`,
        `UNIT EVIDENCE: ${concept.excerpt}`,
        `UNIT MISCONCEPTION: ${concept.misconception}`,
        `CURRENT QUESTION: ${session.currentProbe}`,
        `LEARNER ANSWER: ${answer}`,
        `BURDEN SIGNAL: ${burdenSignal}`,
        `INTERACTION PREFERENCE: ${session.interactionPreference}`,
        `ENGAGEMENT SIGNALS: ${JSON.stringify(session.engagement)}`,
        `PRIOR EVIDENCE: ${JSON.stringify(priorEvidence.slice(-2))}`,
        "RECENT TURNS:",
        formatRecentTurns(session.turns)
      ].join("\n");

      const payload = await callOpenAIJson({
        apiKey,
        model,
        fetchImpl,
        prompt,
        schema: reviewSchema
      });

      return normalizeReviewPayload(payload, concept);
    },

    async generateTutorMove({ session, concept, answer, burdenSignal = "normal", priorEvidence = [] }) {
      const prompt = [
        "You are the tutor decision engine for one live turn.",
        "Choose the single best pedagogical next move.",
        "The whole tutoring system should default to Chinese in its visible replies, even when the question text is English.",
        "Do not sound mechanical. Avoid labels like 'gap', 'evidence', 'next step' in the visible reply.",
        "Use natural tutor language, but keep the decision itself structured in JSON.",
        "Produce a self-contained pedagogical move with knowledge closure.",
        "That means the learner should be able to take away a stable understanding from this single reply, even if the conversation stops here.",
        "The material is the primary anchor, but you may use necessary background knowledge to teach clearly.",
        "",
        `SOURCE TITLE: ${session.source.title}`,
        `SESSION FRAMING: ${session.summary.framing}`,
        `CURRENT UNIT: ${concept.title}`,
        `UNIT SUMMARY: ${concept.summary}`,
        `UNIT EVIDENCE: ${concept.excerpt}`,
        `UNIT IMPORTANCE: ${concept.importance}`,
        `UNIT COVERAGE: ${concept.coverage}`,
        `CURRENT QUESTION: ${session.currentProbe}`,
        `LEARNER ANSWER: ${answer}`,
        `BURDEN SIGNAL: ${burdenSignal}`,
        `INTERACTION PREFERENCE: ${session.interactionPreference}`,
        `PRIOR EVIDENCE: ${JSON.stringify(priorEvidence.slice(-2))}`,
        "RECENT TURNS:",
        formatRecentTurns(session.turns),
        "",
        "Guidance:",
        "- If the learner is partly right, first acknowledge what is right, then gently narrow the gap.",
        "- If the learner is stuck, prefer a compact explanation that includes conclusion, mechanism, and takeaway, plus a teach-back question.",
        "- Do not rely on analogy alone; if you use analogy, it must support, not replace, the explanation.",
        "- If the learner already knows enough for this session goal, you may summarize or advance.",
        "- Repeated control signals like 'next' or 'teach' indicate user intent and should affect the next move naturally.",
        "- nextQuestion should be empty when no response is needed.",
        "- takeaway must be a short stable sentence the learner can remember.",
        "- if this point should be revisited later, explain briefly why in revisitReason."
      ].join("\n");

      const payload = await callOpenAIJson({
        apiKey,
        model,
        fetchImpl,
        prompt,
        schema: tutorMoveSchema
      });

      return normalizeTutorMovePayload(payload, concept);
    }
  };
}

export function createDeepSeekTutorIntelligence({
  apiKey = process.env.LLAI_DEEPSEEK_API_KEY,
  baseUrl = defaultDeepSeekBaseUrl,
  model = defaultDeepSeekModel,
  fetchImpl = globalThis.fetch
} = {}) {
  return {
    kind: "deepseek",

    async decomposeSource({ source }) {
      const prompt = [
        "Read the submitted learning material and produce 3-7 document-local teachable units in json.",
        "Requirements:",
        "- Stay anchored to the submitted source, but use minimal background knowledge when needed for clearer teaching.",
        "- Do not leak frontmatter, tags, SEO metadata, or boilerplate into the learner-facing summary.",
        "- Each unit must support a concrete first diagnostic question.",
        "- Each unit should include a check question for teach-back after explanation.",
        "- Prefer mechanisms, distinctions, failure modes, and misconceptions over broad topic labels.",
        "- Assign importance as core/secondary/optional and coverage as high/medium/low.",
        "",
        formatSourceForPrompt(source)
      ].join("\n");

      const payload = await callDeepSeekJson({
        apiKey,
        baseUrl,
        model,
        fetchImpl,
        prompt,
        schema: decompositionSchema
      });

      return normalizeDecompositionPayload(payload, source);
    },

    async reviewTurn({ session, concept, answer, burdenSignal = "normal", priorEvidence = [] }) {
      const prompt = [
        "You are evaluating one learner turn inside an AI tutoring session. Return json only.",
        "Judge the learner semantically, not by keyword overlap alone.",
        "The material is the primary anchor, but you may use necessary background knowledge for explanation.",
        "Return a concrete next question; do not ask generic prompts like 'why is this important?'",
        "When the learner is directionally correct, explicitly confirm what they got right and add one useful enrichment.",
        "When the learner is stuck, stop interrogating and give one compact teaching chunk plus a teach-back question.",
        "Keep the tone natural and tutor-like, not template-heavy.",
        "",
        `SOURCE TITLE: ${session.source.title}`,
        `SESSION FRAMING: ${session.summary.framing}`,
        `CURRENT UNIT: ${concept.title}`,
        `UNIT SUMMARY: ${concept.summary}`,
        `UNIT EVIDENCE: ${concept.excerpt}`,
        `UNIT MISCONCEPTION: ${concept.misconception}`,
        `CURRENT QUESTION: ${session.currentProbe}`,
        `LEARNER ANSWER: ${answer}`,
        `BURDEN SIGNAL: ${burdenSignal}`,
        `INTERACTION PREFERENCE: ${session.interactionPreference}`,
        `ENGAGEMENT SIGNALS: ${JSON.stringify(session.engagement)}`,
        `PRIOR EVIDENCE: ${JSON.stringify(priorEvidence.slice(-2))}`,
        "RECENT TURNS:",
        formatRecentTurns(session.turns)
      ].join("\n");

      const payload = await callDeepSeekJson({
        apiKey,
        baseUrl,
        model,
        fetchImpl,
        prompt,
        schema: reviewSchema
      });

      return normalizeReviewPayload(payload, concept);
    },

    async generateTutorMove({ session, concept, answer, burdenSignal = "normal", priorEvidence = [] }) {
      const prompt = [
        "You are the tutor decision engine for one live turn. Return json only.",
        "Choose the single best pedagogical next move.",
        "The whole tutoring system should default to Chinese in its visible replies, even when the question text is English.",
        "Do not sound mechanical. Avoid labels like 'gap', 'evidence', 'next step' in the visible reply.",
        "Use natural tutor language, but keep the decision itself structured in JSON.",
        "Produce a self-contained pedagogical move with knowledge closure.",
        "That means the learner should be able to take away a stable understanding from this single reply, even if the conversation stops here.",
        "The material is the primary anchor, but you may use necessary background knowledge to teach clearly.",
        "",
        `SOURCE TITLE: ${session.source.title}`,
        `SESSION FRAMING: ${session.summary.framing}`,
        `CURRENT UNIT: ${concept.title}`,
        `UNIT SUMMARY: ${concept.summary}`,
        `UNIT EVIDENCE: ${concept.excerpt}`,
        `UNIT IMPORTANCE: ${concept.importance}`,
        `UNIT COVERAGE: ${concept.coverage}`,
        `CURRENT QUESTION: ${session.currentProbe}`,
        `LEARNER ANSWER: ${answer}`,
        `BURDEN SIGNAL: ${burdenSignal}`,
        `INTERACTION PREFERENCE: ${session.interactionPreference}`,
        `PRIOR EVIDENCE: ${JSON.stringify(priorEvidence.slice(-2))}`,
        "RECENT TURNS:",
        formatRecentTurns(session.turns),
        "",
        "Guidance:",
        "- If the learner is partly right, first acknowledge what is right, then gently narrow the gap.",
        "- If the learner is stuck, prefer a compact explanation that includes conclusion, mechanism, and takeaway, plus a teach-back question.",
        "- Do not rely on analogy alone; if you use analogy, it must support, not replace, the explanation.",
        "- If the learner already knows enough for this session goal, you may summarize or advance.",
        "- Repeated control signals like 'next' or 'teach' indicate user intent and should affect the next move naturally.",
        "- nextQuestion should be empty when no response is needed.",
        "- takeaway must be a short stable sentence the learner can remember.",
        "- if this point should be revisited later, explain briefly why in revisitReason."
      ].join("\n");

      const payload = await callDeepSeekJson({
        apiKey,
        baseUrl,
        model,
        fetchImpl,
        prompt,
        schema: tutorMoveSchema
      });

      return normalizeTutorMovePayload(payload, concept);
    }
  };
}

export function createTutorIntelligence(options = {}) {
  const enabled = String(process.env.LLAI_LLM_ENABLED || "true").toLowerCase();
  if (["0", "false", "no", "off"].includes(enabled)) {
    throw new Error("AI tutor mode is disabled.");
  }

  const provider = String(process.env.LLAI_LLM_PROVIDER || "OPENAI").toUpperCase();
  if (provider === "DEEPSEEK") {
    return createDeepSeekTutorIntelligence(options);
  }

  if (provider === "OPENAI") {
    return createOpenAITutorIntelligence(options);
  }

  throw new Error(`Unsupported AI tutor provider: ${provider}`);
}

export function createHeuristicTutorIntelligence() {
  return {
    kind: "heuristic-test-double",

    async decomposeSource({ source }) {
      return {
        concepts: decomposeSource(source),
        summary: summarizeSourceForDisplay(source, decomposeSource(source))
      };
    },

    async reviewTurn({ session, concept, answer, burdenSignal = "normal", priorEvidence = [] }) {
      const analysis = analyzeLearnerAnswer({ concept, answer });
      const normalizedSignal = analysis.signal;
      const tutorFeedback = buildTutorFeedback({
        concept,
        analysis,
        noiseDetected: normalizedSignal === "noise"
      });
      const judge = judgeConcept({
        entry: {
          entries: [
            ...priorEvidence,
            {
              signal: normalizedSignal,
              answer,
              explanation: tutorFeedback.explanation
            }
          ]
        },
        sourceAligned: true,
        promptContaminated: false,
        informationGain: 1
      });

      return {
        signal: normalizedSignal,
        judge,
        feedback: tutorFeedback,
        nextQuestion: createFollowUpQuestion({
          concept,
          lastSignal: normalizedSignal,
          burdenSignal
        })
      };
    },

    async generateTutorMove({ session, concept, answer, burdenSignal = "normal", priorEvidence = [] }) {
      const analysis = analyzeLearnerAnswer({ concept, answer });
      const normalizedSignal = analysis.signal;
      const tutorFeedback = buildTutorFeedback({
        concept,
        analysis,
        noiseDetected: normalizedSignal === "noise"
      });
      const judge = judgeConcept({
        entry: {
          entries: [
            ...priorEvidence,
            {
              signal: normalizedSignal,
              answer,
              explanation: tutorFeedback.explanation
            }
          ]
        },
        sourceAligned: true,
        promptContaminated: false,
        informationGain: 1
      });
      const conceptState = session.conceptStates[concept.id];
      const decision = chooseNextAction({
        concept,
        conceptState,
        review: {
          signal: normalizedSignal,
          judge
        },
        burdenSignal,
        interactionPreference: session.interactionPreference
      });
      const shouldLighten =
        session.engagement.skipCount >= 2 ||
        session.engagement.teachRequestCount >= 2 ||
        session.engagement.consecutiveControlCount >= 1;
      if (shouldLighten && decision.action === "deepen") {
        decision.action = "advance";
      }
      if (session.engagement.skipCount >= 2 && decision.action === "repair") {
        decision.action = "advance";
      }

      if (decision.action === "advance") {
        return {
          moveType: "advance",
          signal: normalizedSignal,
          judge,
          visibleReply:
            session.engagement.skipCount >= 2
              ? `这个点我先帮你记下来，后面再回头看。我们先往下走，别把节奏卡住。`
              : `这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。`,
          evidenceReference: concept.excerpt,
          teachingChunk: "",
          nextQuestion: "",
          takeaway: concept.summary,
          confirmedUnderstanding: normalizedSignal === "positive" ? `你已经碰到了“${concept.title}”的核心方向。` : "",
          remainingGap: tutorFeedback.gap,
          revisitReason: importanceNeedsRevisit(concept) ? "这个点后面可以再结合相关场景复查。" : "",
          completeCurrentUnit: true,
          requiresResponse: false
        };
      }

      if (decision.action === "teach") {
        return {
          moveType: "teach",
          signal: normalizedSignal,
          judge,
          visibleReply:
            `你前面的方向有一点接近，但还差最关键的一层。` +
            ` 我先把这一层讲清楚：${tutorFeedback.teachingChunk || concept.summary}`,
          evidenceReference: concept.excerpt,
          teachingChunk: tutorFeedback.teachingChunk || concept.summary,
          nextQuestion: concept.checkQuestion || tutorFeedback.checkQuestion || concept.retryQuestion,
          takeaway: concept.summary,
          confirmedUnderstanding: normalizedSignal === "negative" ? "你已经碰到了相关概念。" : "",
          remainingGap: tutorFeedback.gap,
          revisitReason: "如果现在还不稳，后面可以再结合具体场景回头检查。",
          completeCurrentUnit: false,
          requiresResponse: true
        };
      }

      if (decision.action === "deepen" || decision.action === "affirm") {
        return {
          moveType: decision.action,
          signal: normalizedSignal,
          judge,
          visibleReply:
            `${tutorFeedback.positiveConfirmation || `你这轮已经抓住了“${concept.title}”的关键点。`}` +
            ` 如果再补完整一点，会更像面试里的高质量表达。`,
          evidenceReference: concept.excerpt,
          teachingChunk: "",
          nextQuestion: concept.stretchQuestion || createFollowUpQuestion({ concept, lastSignal: normalizedSignal, burdenSignal }),
          takeaway: concept.summary,
          confirmedUnderstanding: tutorFeedback.positiveConfirmation || `你已经抓住了“${concept.title}”的关键点。`,
          remainingGap: "",
          revisitReason: "",
          completeCurrentUnit: false,
          requiresResponse: true
        };
      }

      return {
        moveType: "repair",
        signal: normalizedSignal,
        judge,
        visibleReply:
          `你的方向不算离谱，但还没把关键机制讲完整。` +
          ` 我们先收窄到一个点：${concept.retryQuestion || tutorFeedback.coachingStep}`,
        evidenceReference: concept.excerpt,
        teachingChunk: "",
        nextQuestion: concept.retryQuestion || tutorFeedback.coachingStep,
        takeaway: concept.summary,
        confirmedUnderstanding: normalizedSignal === "negative" ? "你已经碰到了一部分关键词。" : "",
        remainingGap: tutorFeedback.gap,
        revisitReason: "如果这一轮先不继续深挖，后面可以再回访这个关键点。",
        completeCurrentUnit: false,
        requiresResponse: true
      };
    }
  };
}
