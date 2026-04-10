from __future__ import annotations

import json
import os
import socket
import ssl
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib import error, request

from app.engine.context_packet import normalize_whitespace, trim_text
from app.engine.java_guide_source_reader import load_java_guide_source_snippets


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEEPSEEK_CHAT_COMPLETIONS_URL = "/chat/completions"
DEFAULT_OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5-mini")
DEFAULT_DEEPSEEK_BASE_URL = os.environ.get("LLAI_DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEFAULT_DEEPSEEK_MODEL = os.environ.get("LLAI_DEEPSEEK_MODEL", "deepseek-chat")
DEFAULT_PROVIDER_TIMEOUT_MS = int(os.environ.get("LLAI_LLM_TIMEOUT_MS", "90000"))


def ensure_array(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def ensure_string(value: Any, fallback: str = "") -> str:
    normalized = normalize_whitespace(value)
    return normalized or fallback


def normalize_teaching_paragraph(text: Any) -> str:
    normalized = str(text or "")
    normalized = normalized.replace("核心结论：", "").replace("核心结论:", "")
    normalized = normalized.replace("理解抓手：", "可以这样理解：").replace("理解抓手:", "可以这样理解：")
    normalized = normalized.replace("建议阅读：", "如果还想继续顺着看，建议看看：").replace("建议阅读:", "如果还想继续顺着看，建议看看：")
    return normalized.strip()


def strip_code_fence(text: str) -> str:
    stripped = str(text or "").strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1]
    if stripped.endswith("```"):
        stripped = stripped[:-3]
    return stripped.strip()


def parse_provider_json_text(text: str) -> Dict[str, Any]:
    cleaned = strip_code_fence(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            return json.loads(cleaned[start : end + 1])
    raise ValueError("Provider response did not contain valid JSON.")


def _extract_openai_text(payload: Dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text
    for item in ensure_array(payload.get("output")):
        for content in ensure_array(item.get("content")):
            text = content.get("text")
            if isinstance(text, str) and text.strip():
                return text
    raise ValueError("OpenAI response did not include text output.")


def _extract_chat_message_content(payload: Dict[str, Any], provider_name: str) -> str:
    content = (((payload.get("choices") or [{}])[0]).get("message") or {}).get("content")
    if isinstance(content, str) and content.strip():
        return content
    raise ValueError(f"{provider_name} response did not include message content.")


def create_ssl_context() -> ssl.SSLContext:
    verify_ssl = str(os.environ.get("LLAI_SSL_VERIFY", "true")).lower() not in {"0", "false", "no", "off"}
    ca_bundle = os.environ.get("LLAI_CA_BUNDLE", "").strip()
    if not verify_ssl:
        return ssl._create_unverified_context()
    if ca_bundle:
        return ssl.create_default_context(cafile=ca_bundle)
    return ssl.create_default_context()


def _post_json(url: str, headers: Dict[str, str], payload: Dict[str, Any], timeout_ms: int) -> Dict[str, Any]:
    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    ssl_context = create_ssl_context()
    try:
        with request.urlopen(req, timeout=timeout_ms / 1000, context=ssl_context) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Provider request failed: {exc.code} {body}") from exc
    except (socket.timeout, TimeoutError) as exc:
        raise RuntimeError(f"LLM request timed out (>{round(timeout_ms / 1000)}s).") from exc


def call_openai_json(*, api_key: str, model: str, prompt: str, schema: Dict[str, Any], timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS) -> Dict[str, Any]:
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for AI tutor mode.")
    payload = _post_json(
        OPENAI_RESPONSES_URL,
        {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        {
            "model": model,
            "input": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "You are the cognition layer for an AI tutor. Return only valid JSON matching the provided schema. "
                                "Use the submitted material as the primary anchor, but you may use necessary background knowledge to teach clearly. "
                                "Never drift into generic motivational talk."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": prompt}],
                },
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema["name"],
                    "schema": schema["schema"],
                    "strict": True,
                }
            },
        },
        timeout_ms,
    )
    return parse_provider_json_text(_extract_openai_text(payload))


def call_deepseek_json(
    *,
    api_key: str,
    model: str,
    prompt: str,
    schema: Dict[str, Any],
    base_url: str = DEFAULT_DEEPSEEK_BASE_URL,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> Dict[str, Any]:
    if not api_key:
        raise RuntimeError("LLAI_DEEPSEEK_API_KEY is required for DeepSeek tutor mode.")
    url = f"{base_url.rstrip('/')}{DEEPSEEK_CHAT_COMPLETIONS_URL}"
    payload = _post_json(
        url,
        {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        {
            "model": model,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are the cognition layer for an AI tutor. Return valid json only. "
                        "Use the submitted material as the primary anchor, but you may use necessary background knowledge to teach clearly. "
                        "Never drift into generic motivational talk."
                    ),
                },
                {
                    "role": "user",
                    "content": "\n".join(
                        [
                            prompt,
                            "",
                            "Return json matching this shape:",
                            json.dumps(schema["example"], ensure_ascii=False, indent=2),
                        ]
                    ),
                },
            ],
        },
        timeout_ms,
    )
    return parse_provider_json_text(_extract_chat_message_content(payload, "DeepSeek"))


def _slugify(value: Any) -> str:
    normalized = ensure_string(value, "unit").lower()
    pieces: List[str] = []
    for char in normalized:
        if char.isalnum():
            pieces.append(char)
        else:
            pieces.append("-")
    slug = "".join(pieces).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "unit"


def _validate_unit(unit: Dict[str, Any], index: int) -> Dict[str, Any]:
    return {
        "id": ensure_string(unit.get("id"), f"{_slugify(unit.get('title') or f'unit-{index + 1}')}-{index + 1}"),
        "title": ensure_string(unit.get("title"), f"Teachable Unit {index + 1}"),
        "summary": ensure_string(unit.get("summary")),
        "excerpt": ensure_string(unit.get("excerpt") or unit.get("evidenceReference") or unit.get("summary")),
        "keywords": [ensure_string(item) for item in ensure_array(unit.get("keywords")) if ensure_string(item)][:8],
        "sourceAnchors": [ensure_string(item) for item in ensure_array(unit.get("sourceAnchors")) if ensure_string(item)][:3],
        "misconception": ensure_string(unit.get("misconception")),
        "importance": ensure_string(unit.get("importance"), "secondary"),
        "coverage": ensure_string(unit.get("coverage"), "medium"),
        "diagnosticQuestion": ensure_string(unit.get("diagnosticQuestion")),
        "retryQuestion": ensure_string(unit.get("retryQuestion")),
        "stretchQuestion": ensure_string(unit.get("stretchQuestion")),
        "checkQuestion": ensure_string(unit.get("checkQuestion"), unit.get("retryQuestion") or unit.get("diagnosticQuestion") or ""),
        "remediationHint": ensure_string(unit.get("remediationHint")),
        "order": index + 1,
    }


def normalize_decomposition_payload(payload: Dict[str, Any], source: Dict[str, Any]) -> Dict[str, Any]:
    raw_units = ensure_array((payload or {}).get("units"))[:7]
    if len(raw_units) < 3:
        raise ValueError("Tutor intelligence returned too few teaching units.")
    units = [_validate_unit(unit, index) for index, unit in enumerate(raw_units)]
    units = [unit for unit in units if unit["summary"] and unit["diagnosticQuestion"]]
    if len(units) < 3:
        raise ValueError("Tutor intelligence returned invalid teaching units.")
    key_themes = [ensure_string(item) for item in ensure_array(((payload or {}).get("summary") or {}).get("keyThemes")) if ensure_string(item)][:3]
    return {
        "concepts": units,
        "summary": {
            "sourceTitle": ensure_string(((payload or {}).get("summary") or {}).get("sourceTitle"), source.get("title", "")),
            "keyThemes": key_themes or [unit["title"] for unit in units[:3]],
            "framing": ensure_string(
                ((payload or {}).get("summary") or {}).get("framing"),
                f"我先从材料里提炼出 {'、'.join(unit['title'] for unit in units[:3])} 这些切入点。",
            ),
        },
    }


def normalize_turn_envelope_payload(payload: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    runtime_map = (payload or {}).get("runtime_map") or {}
    anchor_assessment = runtime_map.get("anchor_assessment") or {}
    next_move = (payload or {}).get("next_move") or {}
    reply = (payload or {}).get("reply") or {}
    suggestion = (payload or {}).get("writeback_suggestion") or {}
    teaching_paragraphs = [normalize_teaching_paragraph(ensure_string(item)) for item in ensure_array(reply.get("teaching_paragraphs")) if ensure_string(item)]
    return {
        "runtime_map": {
            "anchor_id": ensure_string(runtime_map.get("anchor_id"), concept.get("id", "")),
            "turn_signal": runtime_map.get("turn_signal") if runtime_map.get("turn_signal") in {"positive", "negative", "noise"} else "noise",
            "anchor_assessment": {
                "state": anchor_assessment.get("state") if anchor_assessment.get("state") in {"solid", "partial", "weak", "不可判"} else "不可判",
                "confidence_level": anchor_assessment.get("confidence_level") if anchor_assessment.get("confidence_level") in {"high", "medium", "low"} else "low",
                "reasons": [ensure_string(item) for item in ensure_array(anchor_assessment.get("reasons")) if ensure_string(item)][:4],
            },
            "hypotheses": ensure_array(runtime_map.get("hypotheses"))[:5],
            "misunderstandings": ensure_array(runtime_map.get("misunderstandings"))[:4],
            "open_questions": [ensure_string(item) for item in ensure_array(runtime_map.get("open_questions")) if ensure_string(item)][:3],
            "verification_targets": ensure_array(runtime_map.get("verification_targets"))[:3],
            "info_gain_level": runtime_map.get("info_gain_level") if runtime_map.get("info_gain_level") in {"high", "medium", "low", "negligible"} else "medium",
        },
        "next_move": {
            "intent": ensure_string(next_move.get("intent"), "先继续收集一点信息，再决定要不要切到讲解。"),
            "reason": ensure_string(next_move.get("reason"), "当前还需要确认用户究竟卡在定义、机制还是边界上。"),
            "expected_gain": next_move.get("expected_gain") if next_move.get("expected_gain") in {"high", "medium", "low", "negligible"} else "medium",
            "ui_mode": next_move.get("ui_mode") if next_move.get("ui_mode") in {"probe", "teach", "verify", "advance", "revisit", "stop"} else "probe",
        },
        "reply": {
            "visible_reply": ensure_string(reply.get("visible_reply"), concept.get("summary", "")),
            "teaching_paragraphs": teaching_paragraphs,
            "evidence_reference": ensure_string(reply.get("evidence_reference"), concept.get("excerpt") or concept.get("summary", "")),
            "next_prompt": ensure_string(reply.get("next_prompt")),
            "takeaway": ensure_string(reply.get("takeaway"), concept.get("summary", "")),
            "confirmed_understanding": ensure_string(reply.get("confirmed_understanding")),
            "remaining_gap": ensure_string(reply.get("remaining_gap")),
            "revisit_reason": ensure_string(reply.get("revisit_reason")),
            "requires_response": reply.get("requires_response") is not False,
            "complete_current_unit": bool(reply.get("complete_current_unit")),
        },
        "writeback_suggestion": {
            "should_write": suggestion.get("should_write") is not False,
            "mode": suggestion.get("mode") if suggestion.get("mode") in {"update", "append_conflict", "noop"} else "update",
            "reason": ensure_string(suggestion.get("reason"), "new_turn_signal"),
            "anchor_patch": {
                "state": ((suggestion.get("anchor_patch") or {}).get("state")) if ((suggestion.get("anchor_patch") or {}).get("state")) in {"solid", "partial", "weak", "不可判"} else "partial",
                "confidence_level": ((suggestion.get("anchor_patch") or {}).get("confidence_level")) if ((suggestion.get("anchor_patch") or {}).get("confidence_level")) in {"high", "medium", "low"} else "medium",
                "derived_principle": ensure_string(
                    ((suggestion.get("anchor_patch") or {}).get("derived_principle"))
                    or ((suggestion.get("anchor_patch") or {}).get("derivedPrinciple")),
                    concept.get("summary", ""),
                ),
            },
        },
    }


def normalize_explain_concept_payload(payload: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    paragraphs = [normalize_teaching_paragraph(ensure_string(item)) for item in ensure_array((payload or {}).get("teachingParagraphs")) if ensure_string(item)]
    teaching_chunk = "\n\n".join(paragraphs) if paragraphs else str((payload or {}).get("teachingChunk") or concept.get("summary", ""))
    return {
        "visibleReply": ensure_string((payload or {}).get("visibleReply"), concept.get("summary", "")),
        "teachingChunk": ensure_string(teaching_chunk, concept.get("summary", "")),
        "teachingParagraphs": paragraphs or [ensure_string(teaching_chunk, concept.get("summary", ""))],
        "checkQuestion": ensure_string((payload or {}).get("checkQuestion"), concept.get("checkQuestion") or concept.get("retryQuestion") or ""),
        "takeaway": ensure_string((payload or {}).get("takeaway"), concept.get("summary", "")),
    }


def format_source_for_prompt(source: Dict[str, Any]) -> str:
    lines = [f"TITLE: {source.get('title', '')}"]
    if source.get("url"):
        lines.append(f"URL: {source.get('url')}")
    lines.extend(["CONTENT:", source.get("content", "")])
    return "\n".join(lines)


def build_turn_envelope_prompt(*, context_packet: Dict[str, Any], answer: str) -> str:
    return "\n".join(
        [
            "You are the main reasoning engine for one AI tutor turn. Return json only.",
            "Use Chinese in all visible learner-facing text.",
            "Follow this internal order: first update runtime_map, then decide next_move, then write the reply, then propose writeback_suggestion.",
            "Preserve prior hypotheses unless new evidence explicitly refutes them.",
            "The runtime_map must stay anchored to the current anchor_id and cite evidence ids where possible.",
            "Do not ask repetitive probes when info_gain_level is negligible or stop_conditions discourage more probing.",
            "Budget, friction_signals, and stop_conditions are orchestration factors. Consider them before proposing continued probing or verification.",
            "The reply must sound like a strong human tutor, not like a template or checklist.",
            "When teach is the right move, teaching_paragraphs must contain a complete explanation; do not use rigid headings such as 核心结论 or 理解抓手.",
            "When a response is still needed on the current anchor, next_prompt must be a concrete question the learner can answer immediately.",
            "Treat next_prompt as a candidate follow-up only for staying on the current anchor. If the turn should hand off to a different anchor or stop, leave next_prompt empty.",
            "When long-term memory should not be updated, set writeback_suggestion.should_write to false and mode to noop.",
            "",
            "CONTEXT_PACKET_JSON:",
            json.dumps(context_packet, ensure_ascii=False, indent=2),
            "",
            f"CURRENT_LEARNER_INPUT: {answer}",
        ]
    )


DECOMPOSITION_SCHEMA = {
    "name": "tutor_decomposition",
    "example": {
        "summary": {
            "sourceTitle": "AQS 详解",
            "keyThemes": ["AQS 的作用是什么？", "AQS 为什么使用 CLH 锁队列的变体？"],
            "framing": "我先从材料里提炼出几个切入点，再围绕其中的具体机制来出题。",
        },
        "units": [
            {
                "id": "aqs-role-1",
                "title": "AQS 的作用是什么？",
                "summary": "AQS 为锁和同步器提供通用框架。",
                "excerpt": "AQS 提供了资源获取和释放的通用框架。",
                "keywords": ["aqs", "synchronizer"],
                "sourceAnchors": ["AQS 提供了资源获取和释放的通用框架。"],
                "misconception": "容易只说它很重要，不说明它到底抽象了什么。",
                "importance": "core",
                "coverage": "high",
                "diagnosticQuestion": "请直接回答：AQS 的作用是什么？",
                "retryQuestion": "先只回答一个点：AQS 替同步器隐藏了哪类底层线程协调逻辑？",
                "stretchQuestion": "继续深入：AQS 为什么能复用到多种同步器上？",
                "checkQuestion": "现在用你自己的话复述：AQS 为什么不是具体锁，而是同步器底座？",
                "remediationHint": "先抓住材料里的关键点，再讲它屏蔽的底层协调逻辑。",
            }
        ],
    },
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["summary", "units"],
        "properties": {
            "summary": {
                "type": "object",
                "additionalProperties": False,
                "required": ["sourceTitle", "keyThemes", "framing"],
                "properties": {
                    "sourceTitle": {"type": "string"},
                    "keyThemes": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "string"}},
                    "framing": {"type": "string"},
                },
            },
            "units": {"type": "array", "minItems": 3, "maxItems": 7, "items": {"type": "object"}},
        },
    },
}

TURN_ENVELOPE_SCHEMA = {
    "name": "tutor_turn_envelope",
    "example": {
        "runtime_map": {
            "anchor_id": "mvcc-repeatable-read",
            "turn_signal": "negative",
            "anchor_assessment": {
                "state": "partial",
                "confidence_level": "medium",
                "reasons": ["用户已经知道 MVCC 提供历史快照，但还没把当前读和锁边界讲清楚。"],
            },
            "hypotheses": [],
            "misunderstandings": [],
            "open_questions": ["为什么 current read 还要 next-key lock"],
            "verification_targets": [],
            "info_gain_level": "medium",
        },
        "next_move": {
            "intent": "先把用户已经说对的部分接住，再用一个更窄的问题验证他是否真的分清了快照读和当前读。",
            "reason": "当前缺口主要在边界，不在定义本身。",
            "expected_gain": "medium",
            "ui_mode": "verify",
        },
        "reply": {
            "visible_reply": "你已经碰到关键点了：MVCC 确实让事务能基于历史快照读数据，但它只解决快照读的一致视图，不会把当前读和锁全都替你处理掉。",
            "teaching_paragraphs": [],
            "evidence_reference": "面试常追问 RR 为什么还要 next-key lock，以及快照读 / 当前读边界。",
            "next_prompt": "那你现在继续说说，为什么 RR 有 MVCC 了，当前读还是要 next-key lock？",
            "takeaway": "先记住：MVCC 主要管快照读，当前读和幻读边界还要看锁。",
            "confirmed_understanding": "你已经知道 MVCC 和历史快照有关。",
            "remaining_gap": "还没把快照读 / 当前读 / 锁边界讲成一条完整链路。",
            "revisit_reason": "",
            "requires_response": True,
            "complete_current_unit": False,
        },
        "writeback_suggestion": {
            "should_write": True,
            "mode": "update",
            "reason": "new_high_value_partial_signal",
            "anchor_patch": {
                "state": "partial",
                "confidence_level": "medium",
                "derived_principle": "用户已经知道 MVCC 负责快照读一致视图，但对锁边界仍不稳定。",
            },
        },
    },
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["runtime_map", "next_move", "reply", "writeback_suggestion"],
        "properties": {
            "runtime_map": {"type": "object"},
            "next_move": {"type": "object"},
            "reply": {"type": "object"},
            "writeback_suggestion": {"type": "object"},
        },
    },
}

EXPLAIN_CONCEPT_SCHEMA = {
    "name": "tutor_explain_concept",
    "example": {
        "visibleReply": "好，这一轮我直接按学习模式带你过这个点。先不要急着背术语，我们先把它到底解决了什么、没解决什么讲清楚。",
        "teachingParagraphs": [
            "很多人会把 MVCC 讲成“数据库的并发问题解决方案”，这其实太大了。更准确地说，它主要服务的是快照读，让事务在并发环境下还能看到一个一致的历史视图。",
            "它依赖的不是某个单点魔法，而是 Read View 和 undo log 版本链一起工作：事务在读的时候，不是总看最新值，而是看当前这个事务应该看到的那个版本。",
        ],
        "checkQuestion": "现在用你自己的话说一遍：MVCC 解决了什么，为什么还不等于所有并发问题都没了？",
        "takeaway": "先记住：MVCC 主要负责快照读一致视图，当前读和幻读边界还要看锁。",
    },
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["visibleReply", "teachingParagraphs", "checkQuestion", "takeaway"],
        "properties": {
            "visibleReply": {"type": "string"},
            "teachingParagraphs": {"type": "array", "minItems": 2, "maxItems": 4, "items": {"type": "string"}},
            "checkQuestion": {"type": "string"},
            "takeaway": {"type": "string"},
        },
    },
}


@dataclass
class TutorEngineInfo:
    provider: str
    model: str
    enabled: bool
    configured: bool
    reason: str = ""


class ProviderTutorIntelligence:
    def __init__(self, provider: str, model: str, api_key: str, base_url: str | None = None):
        self.provider = provider.upper()
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.kind = self.provider.lower()

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def describe(self) -> TutorEngineInfo:
        return TutorEngineInfo(
            provider=self.provider,
            model=self.model,
            enabled=True,
            configured=self.configured,
            reason="" if self.configured else f"{self.provider}_API_KEY missing",
        )

    def _call_json(self, prompt: str, schema: Dict[str, Any]) -> Dict[str, Any]:
        if self.provider == "DEEPSEEK":
            return call_deepseek_json(
                api_key=self.api_key,
                model=self.model,
                base_url=self.base_url or DEFAULT_DEEPSEEK_BASE_URL,
                prompt=prompt,
                schema=schema,
            )
        return call_openai_json(api_key=self.api_key, model=self.model, prompt=prompt, schema=schema)

    def decompose_source(self, source: Dict[str, Any]) -> Dict[str, Any]:
        prompt = "\n".join(
            [
                "Read the submitted learning material and produce 3-7 document-local teachable units.",
                "Requirements:",
                "- Stay anchored to the submitted source, but use minimal background knowledge when needed for clearer teaching.",
                "- Do not leak frontmatter, tags, SEO metadata, or boilerplate into the learner-facing summary.",
                "- Each unit must support a concrete first diagnostic question.",
                "- Each unit should include a check question for teach-back after explanation.",
                "- Prefer mechanisms, distinctions, failure modes, and misconceptions over broad topic labels.",
                "- Assign importance as core/secondary/optional and coverage as high/medium/low.",
                "",
                format_source_for_prompt(source),
            ]
        )
        return normalize_decomposition_payload(self._call_json(prompt, DECOMPOSITION_SCHEMA), source)

    def generate_turn_envelope(self, *, concept: Dict[str, Any], context_packet: Dict[str, Any], answer: str) -> Dict[str, Any]:
        payload = self._call_json(build_turn_envelope_prompt(context_packet=context_packet, answer=answer), TURN_ENVELOPE_SCHEMA)
        return normalize_turn_envelope_payload(payload, concept)

    def explain_concept(self, *, session: Dict[str, Any], concept: Dict[str, Any], context_packet: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        guide_snippets = load_java_guide_source_snippets(concept.get("javaGuideSources") or [])
        prompt = "\n".join(
            [
                "You are generating a compact study card for a tutoring product. Return json only.",
                "The learner explicitly clicked a control meaning 'teach me this point now'.",
                "Use Chinese in all visible text.",
                "Ground the explanation in the concept and the provided JavaGuide snippets.",
                "Do not produce generic motivation. Produce a concise but genuinely useful learning card that can stand on its own even if the learner never opens the source articles.",
                "",
                f"TARGET: {(session.get('targetBaseline') or {}).get('title') or (session.get('source') or {}).get('title', '')}",
                f"CURRENT CONCEPT: {concept.get('title', '')}",
                f"CONCEPT SUMMARY: {concept.get('summary', '')}",
                f"CONCEPT EXCERPT: {concept.get('excerpt', '')}",
                f"MISCONCEPTION: {concept.get('misconception', '')}",
                f"REMEDIATION HINT: {concept.get('remediationHint', '')}",
                f"CHECK QUESTION: {concept.get('checkQuestion') or concept.get('retryQuestion') or ''}",
                f"CURRENT QUESTION: {session.get('currentProbe', '')}",
                f"CONTEXT_PACKET: {json.dumps(context_packet or {}, ensure_ascii=False)}",
                "GUIDE_SNIPPETS_JSON:",
                json.dumps(guide_snippets, ensure_ascii=False, indent=2),
            ]
        )
        payload = self._call_json(prompt, EXPLAIN_CONCEPT_SCHEMA)
        return normalize_explain_concept_payload(payload, concept)


def create_tutor_intelligence() -> ProviderTutorIntelligence | None:
    enabled = str(os.environ.get("LLAI_LLM_ENABLED", "true")).lower()
    if enabled in {"0", "false", "no", "off"}:
        return None
    provider = str(os.environ.get("LLAI_LLM_PROVIDER", "OPENAI")).upper()
    if provider == "DEEPSEEK":
        return ProviderTutorIntelligence(
            provider="DEEPSEEK",
            model=os.environ.get("LLAI_DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL),
            api_key=os.environ.get("LLAI_DEEPSEEK_API_KEY", ""),
            base_url=os.environ.get("LLAI_DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL),
        )
    return ProviderTutorIntelligence(
        provider="OPENAI",
        model=os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL),
        api_key=os.environ.get("OPENAI_API_KEY", ""),
    )


def describe_tutor_intelligence() -> Dict[str, Any]:
    enabled = str(os.environ.get("LLAI_LLM_ENABLED", "true")).lower() not in {"0", "false", "no", "off"}
    intelligence = create_tutor_intelligence() if enabled else None
    if intelligence is None:
        return {
            "enabled": False,
            "provider": str(os.environ.get("LLAI_LLM_PROVIDER", "OPENAI")).upper(),
            "configured": False,
            "model": "",
            "reason": "LLAI_LLM_ENABLED=false",
        }
    info = intelligence.describe()
    return {
        "enabled": info.enabled,
        "provider": info.provider,
        "configured": info.configured,
        "model": info.model,
        "reason": info.reason,
    }
