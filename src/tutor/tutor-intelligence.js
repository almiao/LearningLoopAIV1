import { decomposeSource, summarizeSourceForDisplay } from "../material/concept-decomposer.js";
import { normalizeWhitespace } from "../material/material-model.js";
import { buildContextPacket, formatContextPacketForPrompt } from "./context-packet.js";
import { loadJavaGuideSourceSnippets } from "./java-guide-source-reader.js";
import {
  analyzeLearnerAnswer,
  buildTutorFeedback,
  createFollowUpQuestion
} from "./probe-engine.js";
import { judgeConcept } from "./mastery-judge.js";
import { chooseNextAction } from "./tutor-policy.js";
import {
  confidenceToLevel,
  normalizeTutorTurnEnvelope
} from "./tutor-turn-protocol.js";
import { createEmptyRuntimeMap, normalizeConfidenceLevel, normalizeInfoGainLevel, scoreToConfidenceLevel } from "./turn-envelope.js";

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

function normalizeExplainConceptPayload(payload, concept) {
  const paragraphs = ensureArray(payload?.teachingParagraphs)
    .map((item) => ensureString(item))
    .filter(Boolean)
    .map((text) =>
      String(text)
        .replace(/^核心结论[:：]\s*/gm, "")
        .replace(/^理解抓手[:：]\s*/gm, "可以这样理解：")
        .replace(/^建议阅读[:：]\s*/gm, "如果还想继续顺着看，建议看看：")
        .trim()
    );
  const teachingChunk = (paragraphs.length ? paragraphs.join("\n\n") : String(payload?.teachingChunk ?? concept.summary))
    .replace(/^核心结论[:：]\s*/gm, "")
    .replace(/^理解抓手[:：]\s*/gm, "可以这样理解：")
    .replace(/^建议阅读[:：]\s*/gm, "如果还想继续顺着看，建议看看：")
    .trim();

  return {
    visibleReply: ensureString(payload?.visibleReply, concept.summary),
    teachingChunk: ensureString(teachingChunk, concept.summary),
    teachingParagraphs: paragraphs.length ? paragraphs : [ensureString(teachingChunk, concept.summary)],
    checkQuestion: ensureString(payload?.checkQuestion, concept.checkQuestion || concept.retryQuestion),
    takeaway: ensureString(payload?.takeaway, concept.summary)
  };
}

function createFallbackRuntimeMap({
  concept,
  answer,
  previousRuntimeMap = null,
  priorEvidence = [],
  judge,
  tutorFeedback
}) {
  const understandingSupported = String(answer || "").trim().length > 0 && judge.state !== "weak";

  return {
    anchorId: concept.id,
    hypotheses: [
      {
        id: `${concept.id}-core-understanding`,
        status: understandingSupported ? "supported" : "unsupported",
        confidenceLevel: confidenceToLevel(judge.confidence),
        evidenceRefs: priorEvidence.slice(-2).map((entry, index) => entry.id || `ev-${index + 1}`),
        note:
          judge.state === "solid"
            ? `用户已经能比较稳定地解释“${concept.title}”。`
            : `用户还没有稳定解释“${concept.title}”的核心机制。`
      }
    ],
    misunderstandings: concept.misconception
      ? [
          {
            label: concept.misconception,
            confidenceLevel: judge.state === "solid" ? "low" : confidenceToLevel(judge.confidence),
            evidenceRefs: priorEvidence.slice(-1).map((entry, index) => entry.id || `ev-${index + 1}`)
          }
        ]
      : [],
    openQuestions: [tutorFeedback.checkQuestion || concept.checkQuestion || concept.retryQuestion]
      .filter(Boolean)
      .slice(0, 3),
    infoGainLevel:
      previousRuntimeMap?.infoGainLevel === "low" && judge.state !== "solid"
        ? "low"
        : judge.state === "solid"
          ? "negligible"
          : judge.state === "partial"
            ? "medium"
            : "high"
  };
}

function buildLegacyEnvelope({
  session,
  concept,
  priorEvidence = [],
  move,
  tutorFeedback = null
}) {
  const runtimeMap = createFallbackRuntimeMap({
    concept,
    answer: priorEvidence.at(-1)?.answer || "",
    previousRuntimeMap: session.runtimeMaps?.[concept.id] || null,
    priorEvidence,
    judge: move.judge,
    tutorFeedback:
      tutorFeedback || {
        checkQuestion: move.nextQuestion,
        gap: move.remainingGap
      }
  });

  const nextMove = {
    intent:
      move.moveType === "teach"
        ? "先把关键机制讲清楚，再用 teach-back 确认用户是否真正理解。"
        : move.moveType === "advance"
          ? "这个点先收口并切到下一个更有信息增量的能力项。"
          : "继续围绕当前点收窄问题，验证真正的理解边界。",
    reason: move.remainingGap || move.takeaway || concept.summary,
    expectedGain: runtimeMap.infoGainLevel === "high" ? "high" : runtimeMap.infoGainLevel === "negligible" ? "low" : runtimeMap.infoGainLevel,
    uiMode: move.moveType,
    shouldStop: !move.requiresResponse,
    requiresResponse: move.requiresResponse
  };

  return normalizeTutorTurnEnvelope(
    {
      runtimeMap,
      nextMove,
      reply: {
        ...move,
        teachingParagraphs: move.teachingChunk ? move.teachingChunk.split(/\n{2,}/).filter(Boolean) : []
      },
      writebackSuggestion: {
        shouldWrite: true,
        mode: "immediate",
        admission:
          move.judge.state === "solid" || move.signal !== "noise" ? "strong" : "review",
        reason: "当前轮产出了足以更新长期记忆的能力证据。",
        anchorPatch: {
          state: move.judge.state,
          confidenceLevel: confidenceToLevel(move.judge.confidence),
          derivedPrinciple: move.takeaway || concept.summary,
          projectedTargets: session.targetBaseline?.id ? [session.targetBaseline.id] : []
        }
      }
    },
    {
      concept,
      session,
      previousRuntimeMap: session.runtimeMaps?.[concept.id] || null
    }
  );
}

function normalizeTeachingParagraph(text) {
  return String(text ?? "")
    .replace(/^核心结论[:：]\s*/gm, "")
    .replace(/^理解抓手[:：]\s*/gm, "可以这样理解：")
    .replace(/^建议阅读[:：]\s*/gm, "如果还想继续顺着看，建议看看：")
    .trim();
}

function normalizeTurnEnvelopePayload(payload, concept) {
  const runtimeMap = payload?.runtime_map || {};
  const anchorAssessment = runtimeMap.anchor_assessment || {};
  const nextMove = payload?.next_move || {};
  const reply = payload?.reply || {};
  const teachingParagraphs = ensureArray(reply.teaching_paragraphs)
    .map((item) => normalizeTeachingParagraph(ensureString(item)))
    .filter(Boolean);

  return {
    runtime_map: {
      anchor_id: ensureString(runtimeMap.anchor_id, concept.id),
      turn_signal: ["positive", "negative", "noise"].includes(runtimeMap.turn_signal)
        ? runtimeMap.turn_signal
        : "noise",
      anchor_assessment: {
        state: ["solid", "partial", "weak", "不可判"].includes(anchorAssessment.state)
          ? anchorAssessment.state
          : "不可判",
        confidence_level: normalizeConfidenceLevel(anchorAssessment.confidence_level, "low"),
        reasons: ensureArray(anchorAssessment.reasons).map((item) => ensureString(item)).filter(Boolean).slice(0, 4)
      },
      hypotheses: ensureArray(runtimeMap.hypotheses).slice(0, 5),
      misunderstandings: ensureArray(runtimeMap.misunderstandings).slice(0, 4),
      open_questions: ensureArray(runtimeMap.open_questions).map((item) => ensureString(item)).filter(Boolean).slice(0, 3),
      verification_targets: ensureArray(runtimeMap.verification_targets).slice(0, 3),
      info_gain_level: normalizeInfoGainLevel(runtimeMap.info_gain_level, "medium")
    },
    next_move: {
      intent: ensureString(nextMove.intent, "先继续收集一点信息，再决定要不要切到讲解。"),
      reason: ensureString(nextMove.reason, "当前还需要确认用户究竟卡在定义、机制还是边界上。"),
      expected_gain: normalizeInfoGainLevel(nextMove.expected_gain, "medium"),
      ui_mode: ["probe", "teach", "verify", "advance", "revisit", "stop"].includes(nextMove.ui_mode)
        ? nextMove.ui_mode
        : "probe"
    },
    reply: {
      visible_reply: ensureString(reply.visible_reply, concept.summary),
      teaching_paragraphs: teachingParagraphs,
      evidence_reference: ensureString(reply.evidence_reference, concept.excerpt || concept.summary),
      next_prompt: ensureString(reply.next_prompt),
      takeaway: ensureString(reply.takeaway, concept.summary),
      confirmed_understanding: ensureString(reply.confirmed_understanding),
      remaining_gap: ensureString(reply.remaining_gap),
      revisit_reason: ensureString(reply.revisit_reason),
      requires_response: reply.requires_response !== false,
      complete_current_unit: Boolean(reply.complete_current_unit)
    },
    writeback_suggestion: {
      should_write: payload?.writeback_suggestion?.should_write !== false,
      mode: ["update", "append_conflict", "noop"].includes(payload?.writeback_suggestion?.mode)
        ? payload.writeback_suggestion.mode
        : "update",
      reason: ensureString(payload?.writeback_suggestion?.reason, "new_turn_signal"),
      anchor_patch: {
        state: ["solid", "partial", "weak", "不可判"].includes(payload?.writeback_suggestion?.anchor_patch?.state)
          ? payload.writeback_suggestion.anchor_patch.state
          : "partial",
        confidence_level: normalizeConfidenceLevel(
          payload?.writeback_suggestion?.anchor_patch?.confidence_level,
          "medium"
        ),
        derived_principle: ensureString(
          payload?.writeback_suggestion?.anchor_patch?.derived_principle ||
            payload?.writeback_suggestion?.anchor_patch?.derivedPrinciple,
          concept.summary
        )
      }
    }
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

const explainConceptSchema = {
  name: "tutor_explain_concept",
  example: {
    visibleReply:
      "好，这一轮我直接按学习模式带你过这个点。先不要急着背术语，我们先把它到底解决了什么、没解决什么讲清楚。",
    teachingParagraphs: [
      "很多人会把 MVCC 讲成“数据库的并发问题解决方案”，这其实太大了。更准确地说，它主要服务的是快照读，让事务在并发环境下还能看到一个一致的历史视图。",
      "它依赖的不是某个单点魔法，而是 Read View 和 undo log 版本链一起工作：事务在读的时候，不是总看最新值，而是看当前这个事务应该看到的那个版本。",
      "但这件事只覆盖快照读。像当前读、for update、写操作，以及你在面试里常被追问的幻读边界，就不能只靠 MVCC 解释，必须把锁，尤其是 next-key lock，一起带上。真正容易错的地方就在这里：把“MVCC 很重要”误讲成“MVCC 什么都解决了”。"
    ],
    checkQuestion: "现在用你自己的话说一遍：MVCC 解决了什么，为什么还不等于所有并发问题都没了？",
    takeaway: "先记住：MVCC 主要负责快照读一致视图，当前读和幻读边界还要看锁。"
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["visibleReply", "teachingParagraphs", "checkQuestion", "takeaway"],
    properties: {
      visibleReply: { type: "string" },
      teachingParagraphs: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: { type: "string" }
      },
      checkQuestion: { type: "string" },
      takeaway: { type: "string" }
    }
  }
};

const tutorTurnEnvelopeSchema = {
  name: "tutor_turn_envelope",
  example: {
    runtimeMap: {
      anchorId: "mvcc-repeatable-read",
      hypotheses: [
        {
          id: "snapshot-read-boundary",
          status: "supported",
          confidenceLevel: "medium",
          evidenceRefs: ["ev-1"],
          note: "用户已经提到了快照读，但还没把当前读和锁边界说清。"
        }
      ],
      misunderstandings: [
        {
          label: "把 MVCC 当成万能并发控制",
          confidenceLevel: "medium",
          evidenceRefs: ["ev-1"]
        }
      ],
      openQuestions: ["为什么 current read 还要锁"],
      infoGainLevel: "medium"
    },
    nextMove: {
      intent: "先收窄到快照读和当前读的边界，再判断是否需要进入 teach。",
      reason: "当前主要缺口在边界而不是定义。",
      expectedGain: "medium",
      uiMode: "repair",
      shouldStop: false,
      requiresResponse: true
    },
    reply: {
      moveType: "repair",
      signal: "negative",
      judge: {
        state: "partial",
        confidence: 0.46,
        reasons: ["已经碰到关键词，但还没把边界讲完整。"]
      },
      visibleReply: "你已经碰到关键点了，但现在最大的缺口是把快照读、当前读和锁边界拆开讲。",
      evidenceReference: "MVCC 主要服务快照读一致视图，当前读与幻读边界仍需锁机制解释。",
      teachingChunk: "",
      teachingParagraphs: [],
      nextQuestion: "那你现在试着说说，为什么 current read 不能只靠 MVCC？",
      takeaway: "先记住：MVCC 主要解释快照读，当前读和幻读边界还要把锁带上。",
      confirmedUnderstanding: "你已经意识到快照读和幻读有关。",
      remainingGap: "还没把 current read 为什么需要锁说清楚。",
      revisitReason: "",
      completeCurrentUnit: false,
      requiresResponse: true
    },
    writebackSuggestion: {
      shouldWrite: true,
      mode: "immediate",
      admission: "review",
      reason: "当前轮已经产出可以更新锚点状态的证据。",
      anchorPatch: {
        state: "partial",
        confidenceLevel: "medium",
        derivedPrinciple: "MVCC 主要负责快照读一致视图，当前读和幻读边界仍需锁机制解释。",
        projectedTargets: ["bigtech-java-backend"]
      }
    }
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["runtimeMap", "nextMove", "reply", "writebackSuggestion"],
    properties: {
      runtimeMap: {
        type: "object",
        additionalProperties: false,
        required: ["anchorId", "hypotheses", "misunderstandings", "openQuestions", "infoGainLevel"],
        properties: {
          anchorId: { type: "string" },
          hypotheses: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "status", "confidenceLevel", "evidenceRefs", "note"],
              properties: {
                id: { type: "string" },
                status: { type: "string" },
                confidenceLevel: { type: "string" },
                evidenceRefs: { type: "array", items: { type: "string" } },
                note: { type: "string" }
              }
            }
          },
          misunderstandings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "confidenceLevel", "evidenceRefs"],
              properties: {
                label: { type: "string" },
                confidenceLevel: { type: "string" },
                evidenceRefs: { type: "array", items: { type: "string" } }
              }
            }
          },
          openQuestions: { type: "array", items: { type: "string" } },
          infoGainLevel: { type: "string" }
        }
      },
      nextMove: {
        type: "object",
        additionalProperties: false,
        required: ["intent", "reason", "expectedGain", "uiMode", "shouldStop", "requiresResponse"],
        properties: {
          intent: { type: "string" },
          reason: { type: "string" },
          expectedGain: { type: "string" },
          uiMode: { type: "string" },
          shouldStop: { type: "boolean" },
          requiresResponse: { type: "boolean" }
        }
      },
      reply: tutorMoveSchema.schema,
      writebackSuggestion: {
        type: "object",
        additionalProperties: false,
        required: ["shouldWrite", "mode", "admission", "reason", "anchorPatch"],
        properties: {
          shouldWrite: { type: "boolean" },
          mode: { type: "string" },
          admission: { type: "string" },
          reason: { type: "string" },
          anchorPatch: {
            type: "object",
            additionalProperties: false,
            required: ["state", "confidenceLevel", "derivedPrinciple", "projectedTargets"],
            properties: {
              state: { type: "string" },
              confidenceLevel: { type: "string" },
              derivedPrinciple: { type: "string" },
              projectedTargets: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  }
};

const turnEnvelopeSchema = {
  name: "tutor_turn_envelope",
  example: {
    runtime_map: {
      anchor_id: "mvcc-repeatable-read",
      turn_signal: "negative",
      anchor_assessment: {
        state: "partial",
        confidence_level: "medium",
        reasons: ["用户已经知道 MVCC 提供历史快照，但还没把当前读和锁边界讲清楚。"]
      },
      hypotheses: [
        {
          id: "knows_snapshot_read",
          status: "supported",
          confidence_level: "medium",
          evidence_refs: ["ev-mvcc-1"],
          note: "用户知道 MVCC 解决的是快照读一致性。"
        }
      ],
      misunderstandings: [
        {
          label: "把 MVCC 当成万能并发控制",
          confidence_level: "medium",
          evidence_refs: ["ev-mvcc-1"]
        }
      ],
      open_questions: ["为什么 current read 还要 next-key lock"],
      verification_targets: [
        {
          id: "verify-lock-boundary",
          question: "那为什么 RR 有 MVCC 以后，当前读还是要 next-key lock？",
          why: "这能验证用户是否真正分清了 MVCC 和锁的边界。"
        }
      ],
      info_gain_level: "medium"
    },
    next_move: {
      intent: "先把用户已经说对的部分接住，再用一个更窄的问题验证他是否真的分清了快照读和当前读。",
      reason: "当前缺口主要在边界，不在定义本身。",
      expected_gain: "medium",
      ui_mode: "verify"
    },
    reply: {
      visible_reply: "你已经碰到关键点了：MVCC 确实让事务能基于历史快照读数据，但它只解决快照读的一致视图，不会把当前读和锁全都替你处理掉。",
      teaching_paragraphs: [],
      evidence_reference: "面试常追问 RR 为什么还要 next-key lock，以及快照读 / 当前读边界。",
      next_prompt: "那你现在继续说说，为什么 RR 有 MVCC 了，当前读还是要 next-key lock？",
      takeaway: "先记住：MVCC 主要管快照读，当前读和幻读边界还要看锁。",
      confirmed_understanding: "你已经知道 MVCC 和历史快照有关。",
      remaining_gap: "还没把快照读 / 当前读 / 锁边界讲成一条完整链路。",
      revisit_reason: "",
      requires_response: true,
      complete_current_unit: false
    },
    writeback_suggestion: {
      should_write: true,
      mode: "update",
      reason: "new_high_value_partial_signal",
      anchor_patch: {
        state: "partial",
        confidence_level: "medium",
        derived_principle: "用户已经知道 MVCC 负责快照读一致视图，但对锁边界仍不稳定。"
      }
    }
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["runtime_map", "next_move", "reply", "writeback_suggestion"],
    properties: {
      runtime_map: {
        type: "object",
        additionalProperties: false,
        required: [
          "anchor_id",
          "turn_signal",
          "anchor_assessment",
          "hypotheses",
          "misunderstandings",
          "open_questions",
          "verification_targets",
          "info_gain_level"
        ],
        properties: {
          anchor_id: { type: "string" },
          turn_signal: { type: "string", enum: ["positive", "negative", "noise"] },
          anchor_assessment: {
            type: "object",
            additionalProperties: false,
            required: ["state", "confidence_level", "reasons"],
            properties: {
              state: { type: "string", enum: ["solid", "partial", "weak", "不可判"] },
              confidence_level: { type: "string", enum: ["high", "medium", "low"] },
              reasons: { type: "array", items: { type: "string" } }
            }
          },
          hypotheses: { type: "array", items: { type: "object" } },
          misunderstandings: { type: "array", items: { type: "object" } },
          open_questions: { type: "array", items: { type: "string" } },
          verification_targets: { type: "array", items: { type: "object" } },
          info_gain_level: { type: "string", enum: ["high", "medium", "low", "negligible"] }
        }
      },
      next_move: {
        type: "object",
        additionalProperties: false,
        required: ["intent", "reason", "expected_gain", "ui_mode"],
        properties: {
          intent: { type: "string" },
          reason: { type: "string" },
          expected_gain: { type: "string", enum: ["high", "medium", "low", "negligible"] },
          ui_mode: { type: "string", enum: ["probe", "teach", "verify", "advance", "revisit", "stop"] }
        }
      },
      reply: {
        type: "object",
        additionalProperties: false,
        required: [
          "visible_reply",
          "teaching_paragraphs",
          "evidence_reference",
          "next_prompt",
          "takeaway",
          "confirmed_understanding",
          "remaining_gap",
          "revisit_reason",
          "requires_response",
          "complete_current_unit"
        ],
        properties: {
          visible_reply: { type: "string" },
          teaching_paragraphs: { type: "array", items: { type: "string" } },
          evidence_reference: { type: "string" },
          next_prompt: { type: "string" },
          takeaway: { type: "string" },
          confirmed_understanding: { type: "string" },
          remaining_gap: { type: "string" },
          revisit_reason: { type: "string" },
          requires_response: { type: "boolean" },
          complete_current_unit: { type: "boolean" }
        }
      },
      writeback_suggestion: {
        type: "object",
        additionalProperties: false,
        required: ["should_write", "mode", "reason", "anchor_patch"],
        properties: {
          should_write: { type: "boolean" },
          mode: { type: "string", enum: ["update", "append_conflict", "noop"] },
          reason: { type: "string" },
          anchor_patch: {
            type: "object",
            additionalProperties: false,
            required: ["state", "confidence_level", "derived_principle"],
            properties: {
              state: { type: "string", enum: ["solid", "partial", "weak", "不可判"] },
              confidence_level: { type: "string", enum: ["high", "medium", "low"] },
              derived_principle: { type: "string" }
            }
          }
        }
      }
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

function buildTurnEnvelopePrompt({ contextPacket, answer }) {
  return [
    "You are the main reasoning engine for one AI tutor turn. Return json only.",
    "Use Chinese in all visible learner-facing text.",
    "Follow this internal order: first update runtime_map, then decide next_move, then write the reply, then propose writeback_suggestion.",
    "Preserve prior hypotheses unless new evidence explicitly refutes them.",
    "The runtime_map must stay anchored to the current anchor_id and cite evidence ids where possible.",
    "Do not ask repetitive probes when info_gain_level is negligible or stop_conditions discourage more probing.",
    "The reply must sound like a strong human tutor, not like a template or checklist.",
    "When teach is the right move, teaching_paragraphs must contain a complete explanation; do not use rigid headings such as 核心结论 or 理解抓手.",
    "When a response is still needed, next_prompt must be a concrete question the learner can answer immediately.",
    "When long-term memory should not be updated, set writeback_suggestion.should_write to false and mode to noop.",
    "",
    "CONTEXT_PACKET_JSON:",
    JSON.stringify(contextPacket, null, 2),
    "",
    `CURRENT_LEARNER_INPUT: ${answer}`
  ].join("\n");
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

    async generateTurnEnvelope({ concept, contextPacket, answer }) {
      const payload = await callOpenAIJson({
        apiKey,
        model,
        fetchImpl,
        prompt: buildTurnEnvelopePrompt({ contextPacket, answer }),
        schema: turnEnvelopeSchema
      });

      return normalizeTurnEnvelopePayload(payload, concept);
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

    async generateTutorTurn({ session, concept, answer, burdenSignal = "normal", priorEvidence = [], rawEvidencePoint = null }) {
      const contextPacket = buildContextPacket({
        session,
        concept,
        answer,
        burdenSignal,
        priorEvidence,
        rawEvidencePoint
      });
      const prompt = [
        "You are the cognition layer for one live AI tutor turn.",
        "Return one json object with runtimeMap, nextMove, reply, and writebackSuggestion.",
        "Use Chinese in all learner-facing text.",
        "Follow this internal order: update the runtime understanding map, choose the next best move, generate the visible reply, then suggest writeback.",
        "Preserve prior supported hypotheses unless new evidence explicitly refutes them.",
        "Do not sound mechanical in the reply. Avoid rigid labels like 'gap' or 'next step' in visible learner-facing text.",
        "The system has hard guardrails for scope and stop conditions. Do not try to override them in prose.",
        "",
        "CONTEXT PACKET:",
        formatContextPacketForPrompt(contextPacket),
        "",
        "Requirements:",
        "- runtimeMap.hypotheses must be evidence-linked and concise.",
        "- nextMove should describe intent and reason, not just name an action.",
        "- reply must be self-contained and genuinely useful even if the learner stops here.",
        "- writebackSuggestion should be conservative: suggest strong admission only when this turn materially changes or reinforces the anchor state."
      ].join("\n");

      const payload = await callOpenAIJson({
        apiKey,
        model,
        fetchImpl,
        prompt,
        schema: tutorTurnEnvelopeSchema
      });

      return normalizeTutorTurnEnvelope(payload, {
        concept,
        session,
        previousRuntimeMap: session.runtimeMaps?.[concept.id] || null
      });
    },

    async generateTutorMove(args) {
      const envelope = await this.generateTutorTurn(args);
      return envelope.reply;
    },

    async explainConcept({ session, concept, contextPacket = null }) {
      const guideSnippets = await loadJavaGuideSourceSnippets(concept.javaGuideSources || []);
      const prompt = [
        "You are generating a compact study card for a tutoring product. Return json only.",
        "The learner explicitly clicked a control meaning 'teach me this point now'.",
        "Use Chinese in all visible text.",
        "Ground the explanation in the concept and the provided JavaGuide snippets.",
        "Do not produce generic motivation. Produce a concise but genuinely useful learning card that can stand on its own even if the learner never opens the source articles.",
        "",
        `TARGET: ${session.targetBaseline?.title || session.source.title}`,
        `CURRENT CONCEPT: ${concept.title}`,
        `CONCEPT SUMMARY: ${concept.summary}`,
        `CONCEPT EXCERPT: ${concept.excerpt}`,
        `MISCONCEPTION: ${concept.misconception}`,
        `REMEDIATION HINT: ${concept.remediationHint}`,
        `CHECK QUESTION: ${concept.checkQuestion || concept.retryQuestion}`,
        contextPacket ? `CURRENT_CONTEXT_PACKET_JSON: ${JSON.stringify(contextPacket, null, 2)}` : "",
        `JAVAGUIDE SOURCES: ${guideSnippets.map((item) => item.title).join("、")}`,
        ...guideSnippets.flatMap((item) => [`SOURCE TITLE: ${item.title}`, `SOURCE SNIPPET: ${item.snippet}`]),
        "",
        "Requirements:",
        "- visibleReply should sound like a tutor switching into study mode",
        "- teachingParagraphs must be a complete teaching explanation, not a note stub",
        "- teachingParagraphs should feel like a short live explanation from a strong tutor, not like a checklist",
        "- cover the concept definition, mechanism, boundary/contrast, and the most common misunderstanding, but do it naturally rather than through forced section headers",
        "- use the JavaGuide snippets as supporting references only; do not let the output degrade into a list of article titles",
        "- never use rigid labels such as '核心结论' or '理解抓手' or '建议阅读' as section headers",
        "- return 2-4 short natural paragraphs in teachingParagraphs",
        "- checkQuestion should force a teach-back in the learner's own words",
        "- takeaway should be a single stable sentence"
      ].join("\n");

      const payload = await callOpenAIJson({
        apiKey,
        model,
        fetchImpl,
        prompt,
        schema: explainConceptSchema
      });

      return normalizeExplainConceptPayload(payload, concept);
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

    async generateTurnEnvelope({ concept, contextPacket, answer }) {
      const payload = await callDeepSeekJson({
        apiKey,
        baseUrl,
        model,
        fetchImpl,
        prompt: buildTurnEnvelopePrompt({ contextPacket, answer }),
        schema: turnEnvelopeSchema
      });

      return normalizeTurnEnvelopePayload(payload, concept);
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

    async generateTutorTurn({ session, concept, answer, burdenSignal = "normal", priorEvidence = [], rawEvidencePoint = null }) {
      const contextPacket = buildContextPacket({
        session,
        concept,
        answer,
        burdenSignal,
        priorEvidence,
        rawEvidencePoint
      });
      const prompt = [
        "You are the cognition layer for one live AI tutor turn. Return json only.",
        "Return one json object with runtimeMap, nextMove, reply, and writebackSuggestion.",
        "Use Chinese in all learner-facing text.",
        "Follow this internal order: update runtimeMap, choose nextMove, generate reply, then suggest writeback.",
        "Preserve prior supported hypotheses unless new evidence explicitly refutes them.",
        "Do not sound mechanical in the reply. Avoid rigid labels like 'gap' or 'next step' in visible learner-facing text.",
        "",
        "CONTEXT PACKET:",
        formatContextPacketForPrompt(contextPacket),
        "",
        "Requirements:",
        "- runtimeMap.hypotheses must be evidence-linked and concise.",
        "- nextMove should describe intent and reason, not just name an action.",
        "- reply must be self-contained and genuinely useful even if the learner stops here.",
        "- writebackSuggestion should be conservative: suggest strong admission only when this turn materially changes or reinforces the anchor state."
      ].join("\n");

      const payload = await callDeepSeekJson({
        apiKey,
        baseUrl,
        model,
        fetchImpl,
        prompt,
        schema: tutorTurnEnvelopeSchema
      });

      return normalizeTutorTurnEnvelope(payload, {
        concept,
        session,
        previousRuntimeMap: session.runtimeMaps?.[concept.id] || null
      });
    },

    async generateTutorMove(args) {
      const envelope = await this.generateTutorTurn(args);
      return envelope.reply;
    },

    async explainConcept({ session, concept, contextPacket = null }) {
      const guideSnippets = await loadJavaGuideSourceSnippets(concept.javaGuideSources || []);
      const prompt = [
        "You are generating a compact study card for a tutoring product. Return json only.",
        "The learner explicitly clicked a control meaning 'teach me this point now'.",
        "Use Chinese in all visible text.",
        "Ground the explanation in the concept and the provided JavaGuide snippets.",
        "Do not produce generic motivation. Produce a concise but genuinely useful learning card that can stand on its own even if the learner never opens the source articles.",
        "",
        `TARGET: ${session.targetBaseline?.title || session.source.title}`,
        `CURRENT CONCEPT: ${concept.title}`,
        `CONCEPT SUMMARY: ${concept.summary}`,
        `CONCEPT EXCERPT: ${concept.excerpt}`,
        `MISCONCEPTION: ${concept.misconception}`,
        `REMEDIATION HINT: ${concept.remediationHint}`,
        `CHECK QUESTION: ${concept.checkQuestion || concept.retryQuestion}`,
        contextPacket ? `CURRENT_CONTEXT_PACKET_JSON: ${JSON.stringify(contextPacket, null, 2)}` : "",
        `JAVAGUIDE SOURCES: ${guideSnippets.map((item) => item.title).join("、")}`,
        ...guideSnippets.flatMap((item) => [`SOURCE TITLE: ${item.title}`, `SOURCE SNIPPET: ${item.snippet}`]),
        "",
        "Requirements:",
        "- visibleReply should sound like a tutor switching into study mode",
        "- teachingParagraphs must be a complete teaching explanation, not a note stub",
        "- teachingParagraphs should feel like a short live explanation from a strong tutor, not like a checklist",
        "- cover the concept definition, mechanism, boundary/contrast, and the most common misunderstanding, but do it naturally rather than through forced section headers",
        "- use the JavaGuide snippets as supporting references only; do not let the output degrade into a list of article titles",
        "- never use rigid labels such as '核心结论' or '理解抓手' or '建议阅读' as section headers",
        "- return 2-4 short natural paragraphs in teachingParagraphs",
        "- checkQuestion should force a teach-back in the learner's own words",
        "- takeaway should be a single stable sentence"
      ].join("\n");

      const payload = await callDeepSeekJson({
        apiKey,
        baseUrl,
        model,
        fetchImpl,
        prompt,
        schema: explainConceptSchema
      });

      return normalizeExplainConceptPayload(payload, concept);
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

    async generateTurnEnvelope({ session, concept, answer, burdenSignal = "normal", priorEvidence = [], contextPacket }) {
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

      const confidenceLevel = scoreToConfidenceLevel(judge.confidence);
      const previousMap = contextPacket?.runtime_understanding_map || createEmptyRuntimeMap(concept.id);
      const nextPrompt =
        decision.action === "advance"
          ? ""
          : decision.action === "teach"
            ? concept.checkQuestion || tutorFeedback.checkQuestion || concept.retryQuestion
            : decision.action === "deepen" || decision.action === "affirm"
              ? concept.stretchQuestion || createFollowUpQuestion({ concept, lastSignal: normalizedSignal, burdenSignal })
              : concept.retryQuestion || tutorFeedback.coachingStep;
      const infoGainLevel =
        decision.action === "advance"
          ? "low"
          : decision.action === "teach"
            ? "medium"
            : normalizedSignal === "positive"
              ? "high"
              : conceptState.attempts >= 2
                ? "low"
                : "medium";
      const uiMode =
        decision.action === "teach"
          ? "teach"
          : decision.action === "advance"
            ? "advance"
            : decision.action === "affirm" || decision.action === "deepen"
              ? "verify"
              : "probe";
      const misunderstandings = normalizedSignal === "positive"
        ? []
        : [
            {
              label: concept.misconception || `“${concept.title}”目前还没有被讲成稳定机制。`,
              confidence_level: normalizedSignal === "noise" ? "low" : "medium",
              evidence_refs: [contextPacket?.draft_evidence?.id || `ev-${concept.id}-draft`]
            }
          ];
      const supportedHypotheses = [
        ...(Array.isArray(previousMap?.hypotheses) ? previousMap.hypotheses.slice(0, 2) : []),
        {
          id: `${concept.id}-current-turn`,
          status:
            normalizedSignal === "positive"
              ? "supported"
              : normalizedSignal === "negative"
                ? "unsupported"
                : "unknown",
          confidence_level: confidenceLevel,
          evidence_refs: [contextPacket?.draft_evidence?.id || `ev-${concept.id}-draft`],
          note:
            normalizedSignal === "positive"
              ? `用户已经碰到了“${concept.title}”的关键机制。`
              : `用户目前还没把“${concept.title}”讲成稳定链路。`
        }
      ].slice(-3);

      let visibleReply = "";
      let teachingParagraphs = [];
      let confirmedUnderstanding = "";
      let remainingGap = tutorFeedback.gap;
      let revisitReason = "";
      let requiresResponse = true;
      let completeCurrentUnit = false;

      if (decision.action === "advance") {
        visibleReply =
          session.engagement.skipCount >= 2
            ? "这个点我先帮你记下来，后面再回头看。我们先往下走，别把节奏卡住。"
            : "这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。";
        confirmedUnderstanding =
          normalizedSignal === "positive" ? `你已经碰到了“${concept.title}”的核心方向。` : "";
        revisitReason = importanceNeedsRevisit(concept) ? "这个点后面可以再结合相关场景复查。" : "";
        requiresResponse = false;
        completeCurrentUnit = true;
      } else if (decision.action === "teach") {
        visibleReply =
          `你前面的方向有一点接近，但还差最关键的一层。` +
          ` 我先把这一层讲清楚：${tutorFeedback.teachingChunk || concept.summary}`;
        teachingParagraphs = (tutorFeedback.teachingChunk || concept.summary)
          .split(/\n{2,}/)
          .map((item) => item.trim())
          .filter(Boolean);
        confirmedUnderstanding = normalizedSignal === "negative" ? "你已经碰到了相关概念。" : "";
        revisitReason = "如果现在还不稳，后面可以再结合具体场景回头检查。";
      } else if (decision.action === "deepen" || decision.action === "affirm") {
        visibleReply =
          `${tutorFeedback.positiveConfirmation || `你这轮已经抓住了“${concept.title}”的关键点。`}` +
          ` 如果再补完整一点，会更像面试里的高质量表达。`;
        confirmedUnderstanding =
          tutorFeedback.positiveConfirmation || `你已经抓住了“${concept.title}”的关键点。`;
        remainingGap = "";
      } else {
        visibleReply =
          `你的方向不算离谱，但还没把关键机制讲完整。` +
          ` 我们先收窄到一个点：${concept.retryQuestion || tutorFeedback.coachingStep}`;
        confirmedUnderstanding = normalizedSignal === "negative" ? "你已经碰到了一部分关键词。" : "";
        revisitReason = "如果这一轮先不继续深挖，后面可以再回访这个关键点。";
      }

      const suggestionMode =
        previousMap?.anchor_assessment?.state &&
        previousMap.anchor_assessment.state !== "不可判" &&
        judge.state !== "不可判" &&
        judge.state !== previousMap.anchor_assessment.state &&
        judge.confidence < 0.55
          ? "append_conflict"
          : normalizedSignal === "noise" && !String(answer || "").trim()
            ? "noop"
            : "update";

      return normalizeTurnEnvelopePayload(
        {
          runtime_map: {
            anchor_id: concept.id,
            turn_signal: normalizedSignal,
            anchor_assessment: {
              state: judge.state,
              confidence_level: confidenceLevel,
              reasons: judge.reasons
            },
            hypotheses: supportedHypotheses,
            misunderstandings,
            open_questions: nextPrompt ? [nextPrompt] : [],
            verification_targets: nextPrompt
              ? [
                  {
                    id: `${concept.id}-verify-${conceptState.attempts + 1}`,
                    question: nextPrompt,
                    why: remainingGap || tutorFeedback.gap
                  }
                ]
              : [],
            info_gain_level: infoGainLevel
          },
          next_move: {
            intent:
              uiMode === "teach"
                ? "先把当前缺口讲清楚，再看用户能不能用自己的话复述回来。"
                : uiMode === "advance"
                  ? "这个点先收口，继续推进整体节奏。"
                  : uiMode === "verify"
                    ? "先确认用户是不是已经把关键点讲稳了，再决定要不要收口。"
                    : "先把问题收窄到一个更可判断的切口。 ",
            reason:
              uiMode === "teach"
                ? "当前继续追问的收益不高，先讲一层更能帮助用户理解。"
                : uiMode === "advance"
                  ? "当前再深挖的收益有限，应该优先保持整体推进感。"
                  : uiMode === "verify"
                    ? "用户已经摸到关键方向，可以通过一个更具体的问题确认是否真的稳了。"
                    : "用户还没有把机制链路讲完整，需要更具体的验证。 ",
            expected_gain: infoGainLevel,
            ui_mode: uiMode
          },
          reply: {
            visible_reply: visibleReply,
            teaching_paragraphs: teachingParagraphs,
            evidence_reference: concept.excerpt,
            next_prompt: nextPrompt,
            takeaway: concept.summary,
            confirmed_understanding: confirmedUnderstanding,
            remaining_gap: remainingGap,
            revisit_reason: revisitReason,
            requires_response: requiresResponse,
            complete_current_unit: completeCurrentUnit
          },
          writeback_suggestion: {
            should_write: suggestionMode !== "noop",
            mode: suggestionMode,
            reason:
              suggestionMode === "append_conflict"
                ? "conflicting_signal_against_previous_memory"
                : normalizedSignal === "positive"
                  ? "new_high_value_positive_evidence"
                  : normalizedSignal === "negative"
                    ? "new_high_value_partial_signal"
                    : "low_value_repeat",
            anchor_patch: {
              state: judge.state,
              confidence_level: confidenceLevel,
              derived_principle:
                normalizedSignal === "positive"
                  ? `${concept.title} 这个点已经能讲出关键机制，但还可以继续压边界。`
                  : `${concept.title} 目前还需要先把最关键的一层机制讲稳。`
            }
          }
        },
        concept
      );
    },

    async generateTutorTurn({ session, concept, answer, burdenSignal = "normal", priorEvidence = [], rawEvidencePoint = null }) {
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

      let legacyMove;
      if (decision.action === "advance") {
        legacyMove = {
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
        return buildLegacyEnvelope({
          session,
          concept,
          priorEvidence: [...priorEvidence, rawEvidencePoint].filter(Boolean),
          move: legacyMove,
          tutorFeedback
        });
      }

      if (decision.action === "teach") {
        legacyMove = {
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
        return buildLegacyEnvelope({
          session,
          concept,
          priorEvidence: [...priorEvidence, rawEvidencePoint].filter(Boolean),
          move: legacyMove,
          tutorFeedback
        });
      }

      if (decision.action === "deepen" || decision.action === "affirm") {
        legacyMove = {
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
        return buildLegacyEnvelope({
          session,
          concept,
          priorEvidence: [...priorEvidence, rawEvidencePoint].filter(Boolean),
          move: legacyMove,
          tutorFeedback
        });
      }

      legacyMove = {
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

      return buildLegacyEnvelope({
        session,
        concept,
        priorEvidence: [...priorEvidence, rawEvidencePoint].filter(Boolean),
        move: legacyMove,
        tutorFeedback
      });
    },

    async generateTutorMove(args) {
      const envelope = await this.generateTutorTurn(args);
      return envelope.reply;
    },

    async explainConcept({ concept }) {
      const guideTitles = (concept.javaGuideSources || []).slice(0, 2).map((source) => source.title);
      return {
        visibleReply: [
          "好，我先不让你继续猜了。",
          concept.summary,
          concept.remediationHint ? `优先抓住：${concept.remediationHint}` : "",
          guideTitles.length ? `建议先读 ${guideTitles.map((title) => `《${title}》`).join("、")}。` : ""
        ]
          .filter(Boolean)
          .join(" "),
        teachingParagraphs: [
          `${concept.summary}`,
          concept.remediationHint ? `你可以先抓住这样一个理解角度：${concept.remediationHint}` : "",
          guideTitles.length ? `如果想继续顺着看，优先读 ${guideTitles.map((title) => `《${title}》`).join("、")}。` : ""
        ].filter(Boolean),
        teachingChunk: [
          `${concept.summary}`,
          concept.remediationHint ? `你可以先抓住这样一个理解角度：${concept.remediationHint}` : "",
          guideTitles.length ? `如果想继续顺着看，优先读 ${guideTitles.map((title) => `《${title}》`).join("、")}。` : ""
        ]
          .filter(Boolean)
          .join("\n\n"),
        checkQuestion: concept.checkQuestion || concept.retryQuestion,
        takeaway: concept.summary
      };
    }
  };
}
