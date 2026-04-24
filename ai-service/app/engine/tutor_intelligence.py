from __future__ import annotations

import json
import os
import socket
import ssl
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional
from urllib import error, request

from app.domain.interview.parsers import parse_provider_json_text
from app.domain.interview.validators import (
    validate_decomposition_payload,
    validate_explain_concept_payload,
    validate_turn_envelope_payload,
)
from app.engine.context_packet import normalize_whitespace, trim_text
from app.infra.llm.client import TracedLLMClient
from app.core.config import versions


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
    raw_text, _ = call_openai_raw_text(api_key=api_key, model=model, prompt=prompt, schema=schema, timeout_ms=timeout_ms)
    return parse_provider_json_text(raw_text)


def call_openai_raw_text(*, api_key: str, model: str, prompt: str, schema: Dict[str, Any], timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS) -> tuple[str, Dict[str, Any]]:
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
    return _extract_openai_text(payload), payload


def call_openai_text(*, api_key: str, model: str, prompt: str, timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS) -> str:
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
                                "You are a strong human tutor. Return only the learner-facing markdown reply text. "
                                "Do not return JSON, labels, analysis notes, or next-step planning."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": prompt}],
                },
            ],
        },
        timeout_ms,
    )
    return ensure_string(_extract_openai_text(payload))


def call_deepseek_json(
    *,
    api_key: str,
    model: str,
    prompt: str,
    schema: Dict[str, Any],
    base_url: str = DEFAULT_DEEPSEEK_BASE_URL,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> Dict[str, Any]:
    raw_text, _ = call_deepseek_raw_text(
        api_key=api_key,
        model=model,
        prompt=prompt,
        schema=schema,
        base_url=base_url,
        timeout_ms=timeout_ms,
    )
    return parse_provider_json_text(raw_text)


def call_deepseek_raw_text(
    *,
    api_key: str,
    model: str,
    prompt: str,
    schema: Dict[str, Any],
    base_url: str = DEFAULT_DEEPSEEK_BASE_URL,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> tuple[str, Dict[str, Any]]:
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
    return _extract_chat_message_content(payload, "DeepSeek"), payload


def call_deepseek_text(
    *,
    api_key: str,
    model: str,
    prompt: str,
    base_url: str = DEFAULT_DEEPSEEK_BASE_URL,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> str:
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
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a strong human tutor. Return only the learner-facing markdown reply text. "
                        "Do not return JSON, labels, analysis notes, or next-step planning."
                    ),
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
        },
        timeout_ms,
    )
    return ensure_string(_extract_chat_message_content(payload, "DeepSeek"))


def stream_deepseek_text_chunks(
    *,
    api_key: str,
    model: str,
    prompt: str,
    base_url: str = DEFAULT_DEEPSEEK_BASE_URL,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> Iterator[str]:
    if not api_key:
        raise RuntimeError("LLAI_DEEPSEEK_API_KEY is required for DeepSeek tutor mode.")
    url = f"{base_url.rstrip('/')}{DEEPSEEK_CHAT_COMPLETIONS_URL}"
    req = request.Request(
        url,
        data=json.dumps(
            {
                "model": model,
                "stream": True,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a strong human tutor. Return only the learner-facing markdown reply text. "
                            "Do not return JSON, labels, analysis notes, or next-step planning."
                        ),
                    },
                    {
                        "role": "user",
                        "content": prompt,
                    },
                ],
            }
        ).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    ssl_context = create_ssl_context()
    try:
        with request.urlopen(req, timeout=timeout_ms / 1000, context=ssl_context) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = ensure_array(payload.get("choices"))
                delta = ((choices[0] if choices else {}).get("delta") or {})
                content = delta.get("content")
                if isinstance(content, str) and content:
                    yield content
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Provider request failed: {exc.code} {body}") from exc
    except (socket.timeout, TimeoutError) as exc:
        raise RuntimeError(f"LLM request timed out (>{round(timeout_ms / 1000)}s).") from exc


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


STATE_ALIASES = {
    "solid": "solid",
    "完全掌握": "solid",
    "掌握扎实": "solid",
    "partial": "partial",
    "部分掌握": "partial",
    "部分理解": "partial",
    "基本掌握": "partial",
    "weak": "weak",
    "弱": "weak",
    "掌握较弱": "weak",
    "理解较弱": "weak",
    "不可判": "不可判",
    "无法判断": "不可判",
    "无法判定": "不可判",
    "不确定": "不可判",
    "unknown": "不可判",
}

SIGNAL_ALIASES = {
    "positive": "positive",
    "正向": "positive",
    "积极": "positive",
    "negative": "negative",
    "负向": "negative",
    "消极": "negative",
    "noise": "noise",
    "中性": "noise",
    "不确定": "noise",
    "uncertain": "noise",
}


def normalize_state_alias(value: Any, fallback: str = "不可判") -> str:
    normalized = ensure_string(value).strip()
    return STATE_ALIASES.get(normalized, fallback)


def normalize_signal_alias(value: Any, fallback: str = "noise") -> str:
    normalized = ensure_string(value).strip().lower()
    return SIGNAL_ALIASES.get(normalized, fallback)


def normalize_turn_envelope_payload(payload: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    runtime_map = (payload or {}).get("runtime_map") or {}
    anchor_assessment = runtime_map.get("anchor_assessment") or {}
    next_move = (payload or {}).get("next_move") or {}
    suggestion = (payload or {}).get("writeback_suggestion") or {}
    follow_up_question = ensure_string(next_move.get("follow_up_question") or next_move.get("followUpQuestion"))
    ui_mode = next_move.get("ui_mode") if next_move.get("ui_mode") in {"probe", "teach", "verify", "advance", "revisit", "stop"} else "probe"
    if ui_mode in {"probe", "teach", "verify"} and not follow_up_question:
        follow_up_question = ensure_string(
            concept.get("checkQuestion") or concept.get("retryQuestion") or concept.get("diagnosticQuestion"),
            f"你先用自己的话讲一下：{concept.get('title', '这个点')} 的关键机制是什么？",
        )
    return {
        "runtime_map": {
            "anchor_id": ensure_string(runtime_map.get("anchor_id"), concept.get("id", "")),
            "turn_signal": normalize_signal_alias(runtime_map.get("turn_signal"), "noise"),
            "anchor_assessment": {
                "state": normalize_state_alias(anchor_assessment.get("state"), "不可判"),
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
            "ui_mode": ui_mode,
            "follow_up_question": follow_up_question,
        },
        "writeback_suggestion": {
            "should_write": suggestion.get("should_write") is not False,
            "mode": suggestion.get("mode") if suggestion.get("mode") in {"update", "append_conflict", "noop"} else "update",
            "reason": ensure_string(suggestion.get("reason"), "new_turn_signal"),
            "anchor_patch": {
                "state": normalize_state_alias(((suggestion.get("anchor_patch") or {}).get("state")), "partial"),
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
        "takeaway": ensure_string((payload or {}).get("takeaway")),
    }


def format_source_for_prompt(source: Dict[str, Any]) -> str:
    lines = [f"TITLE: {source.get('title', '')}"]
    if source.get("url"):
        lines.append(f"URL: {source.get('url')}")
    lines.extend(["CONTENT:", source.get("content", "")])
    return "\n".join(lines)


TURN_INPUT_TYPES = {"answer", "request_explain", "request_advance", "mixed"}
TURN_EVIDENCE_QUALITY = {"strong", "partial", "weak", "none"}

TUTOR_TOP_LEVEL_CONTRACT = [
    "Follow the learner's explicit intent before inferred intent.",
    "Stay on the current concept unless the learner explicitly asks to move on or the current unit is already complete.",
    "Prefer incremental tutoring: fix one missing link instead of replaying the whole topic.",
    "Before any follow-up question, add concrete value that helps the learner immediately.",
    "Use recent teaching as prior context; do not repeat a full lecture unless the learner is still clearly lost.",
    "Keep learner-facing Chinese natural, specific, and conversational rather than templated.",
]

TUTOR_CONFLICT_ORDER = [
    "explicit learner intent > inferred intent",
    "current concept continuity > opportunistic topic switch",
    "recent teaching + unresolved gap > restating the whole explanation",
    "one highest-value missing link > listing multiple gaps at once",
    "clear stop or advance request > extra probing",
]

TUTOR_BEHAVIOR_EXAMPLES = [
    "Good follow-up: 先接住对的部分，再只问一个能补链路的问题。",
    "Bad follow-up: 把多个定义、机制、边界问题塞进同一句追问里。",
    "Good incremental teaching: 只补当前缺口，并明确说清这一步补的是哪条链路。",
    "Bad incremental teaching: 明明刚讲过核心机制，又从头完整重讲一遍。",
    "Good correction: 直接指出错位点，并给出更准确的表达。",
    "Bad correction: 空泛表扬后再丢一个没有新增信息的问题。",
]


def normalize_turn_diagnosis_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    diagnosis = payload or {}
    input_type = ensure_string(diagnosis.get("input_type"), "answer")
    evidence_quality = ensure_string(diagnosis.get("evidence_quality"), "weak")
    return {
        "input_type": input_type if input_type in TURN_INPUT_TYPES else "answer",
        "evidence_quality": evidence_quality if evidence_quality in TURN_EVIDENCE_QUALITY else "weak",
        "key_claim": ensure_string(diagnosis.get("key_claim")),
        "confirmed_understanding": ensure_string(diagnosis.get("confirmed_understanding")),
        "has_misconception": bool(diagnosis.get("has_misconception")),
        "misconception_detail": ensure_string(diagnosis.get("misconception_detail")),
    }


def build_turn_diagnosis_prompt(*, concept: Dict[str, Any], context_packet: Dict[str, Any], answer: str) -> str:
    concept_snapshot = {
        "title": concept.get("title", ""),
        "summary": concept.get("summary", ""),
        "misconception": concept.get("misconception", ""),
        "current_question": context_packet.get("dynamic", {}).get("currentQuestion", ""),
    }
    return "\n".join(
        [
            "You are a learning diagnosis engine for one tutor turn. Return json only.",
            "Diagnose what the learner is doing and what single gap matters most right now.",
            "Do not teach, persuade, or write learner-facing prose here.",
            "",
            "TOP-LEVEL TUTOR CONTRACT:",
            *[f"- {item}" for item in TUTOR_TOP_LEVEL_CONTRACT[:4]],
            "",
            "CONCEPT_SNAPSHOT_JSON:",
            json.dumps(concept_snapshot, ensure_ascii=False, indent=2),
            "",
            "ANCHOR_STATE_JSON:",
            json.dumps(context_packet.get("anchor_state") or {}, ensure_ascii=False, indent=2),
            "",
            f"LEARNER_INPUT: {answer}",
        ]
    )


def build_reply_stream_prompt(*, context_packet: Dict[str, Any], answer: str) -> str:
    return "\n".join(
        [
            "You are writing the learner-facing reply for one AI tutor turn.",
            "Use Chinese markdown only. Do not return JSON.",
            "Focus only on evaluating the learner's current answer and giving the most helpful explanation or correction for this moment.",
            "Do not promise what the system will ask next.",
            "Do not say you will switch topics, stop, or move on.",
            "Do not include labels such as '下一步' or 'gap' or 'runtime'.",
            "If useful, end with one stable takeaway sentence naturally inside the prose.",
            "If the learner is mainly asking for explanation, give a direct explanation instead of interrogating.",
            "Keep the reply self-contained and valuable even if the learner stops here.",
            "",
            "CONTEXT_PACKET_JSON:",
            json.dumps(context_packet, ensure_ascii=False, indent=2),
            "",
            f"CURRENT_LEARNER_INPUT: {answer}",
        ]
    )


def build_turn_envelope_prompt(
    *,
    context_packet: Dict[str, Any],
    answer: str,
    diagnosis: Dict[str, Any],
    forced_action: str | None = None,
    concept: Dict[str, Any] | None = None,
) -> str:
    sections = [
        "You are the main decision engine for one AI tutor turn. Return json only.",
        "Do not write the learner-facing reply here.",
        "First update runtime_map, then decide next_move, then propose writeback_suggestion.",
        "Preserve prior hypotheses unless new evidence explicitly refutes them.",
        "The runtime_map must stay anchored to the current anchor_id and cite evidence ids where possible.",
        "",
        "TOP-LEVEL TUTOR CONTRACT:",
        *[f"- {item}" for item in TUTOR_TOP_LEVEL_CONTRACT],
        "",
        "CONFLICT RESOLUTION ORDER:",
        *[f"- {item}" for item in TUTOR_CONFLICT_ORDER],
        "",
        "GOOD / BAD BEHAVIOR EXAMPLES:",
        *[f"- {item}" for item in TUTOR_BEHAVIOR_EXAMPLES],
        "",
        "DECISION RULES:",
        "- Treat budget, friction_signals, and stop_conditions as orchestration factors before proposing more probing.",
        "- If recent teaching already covered the core mechanism, prefer naming the one missing link over repeating the full explanation.",
        "- When a response is still needed on the current concept, follow_up_question must be a concrete question the learner can answer immediately.",
        "- Treat follow_up_question as a candidate follow-up only for staying on the current concept. If the turn should switch or stop, leave follow_up_question empty.",
        "- Keep writeback_suggestion conservative. Use noop when this turn does not materially change the anchor state.",
        "",
        "CONTEXT_PACKET_JSON:",
        json.dumps(context_packet, ensure_ascii=False, indent=2),
        "",
        "TURN_DIAGNOSIS_JSON:",
        json.dumps(diagnosis, ensure_ascii=False, indent=2),
        "",
        f"CURRENT_LEARNER_INPUT: {answer}",
    ]

    if forced_action:
        sections.extend(["", f"FORCED_ACTION: {forced_action}"])

    if forced_action == "teach" and concept:
        sections.extend(
            [
                "",
                "TEACHING CONTEXT:",
                json.dumps(
                    {
                        "concept_title": concept.get("title", ""),
                        "concept_summary": concept.get("summary", ""),
                        "concept_excerpt": concept.get("excerpt", ""),
                        "misconception": concept.get("misconception", ""),
                        "remediation_hint": concept.get("remediationHint", ""),
                        "check_question": concept.get("checkQuestion") or concept.get("retryQuestion") or "",
                        "sources": concept.get("javaGuideSources", []),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                "",
                "When FORCED_ACTION is teach, do not probe before helping.",
                "Keep the follow_up_question focused on one teach-back question after the explanation stage.",
            ]
        )

    return "\n".join(sections)


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

TURN_DIAGNOSIS_SCHEMA = {
    "name": "tutor_turn_diagnosis",
    "example": {
        "input_type": "answer",
        "evidence_quality": "partial",
        "key_claim": "用户知道 MVCC 和历史版本有关。",
        "confirmed_understanding": "已经知道 MVCC 不是直接读最新值。",
        "has_misconception": False,
        "misconception_detail": "",
    },
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "input_type",
            "evidence_quality",
            "key_claim",
            "confirmed_understanding",
            "has_misconception",
            "misconception_detail",
        ],
        "properties": {
            "input_type": {"type": "string", "enum": sorted(TURN_INPUT_TYPES)},
            "evidence_quality": {"type": "string", "enum": sorted(TURN_EVIDENCE_QUALITY)},
            "key_claim": {"type": "string"},
            "confirmed_understanding": {"type": "string"},
            "has_misconception": {"type": "boolean"},
            "misconception_detail": {"type": "string"},
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
            "follow_up_question": "那你现在继续说说，为什么 RR 有 MVCC 了，当前读还是要 next-key lock？",
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
        "required": ["runtime_map", "next_move", "writeback_suggestion"],
        "properties": {
            "runtime_map": {"type": "object"},
            "next_move": {"type": "object"},
            "writeback_suggestion": {"type": "object"},
        },
    },
}

EXPLAIN_CONCEPT_SCHEMA = {
    "name": "tutor_explain_concept",
    "example": {
        "visibleReply": "我们先把这个点拆开讲清楚。先不要急着背术语，先抓住它到底解决了什么、没解决什么。",
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
        self.client = TracedLLMClient()

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

    def _call_json_traced(
        self,
        *,
        call_type: str,
        prompt: str,
        schema: Dict[str, Any],
        validator=None,
    ):
        system_prompt = (
            "You are the cognition layer for an AI tutor. Return valid json only. "
            "Use the submitted material as the primary anchor, but you may use necessary background knowledge to teach clearly. "
            "Never drift into generic motivational talk."
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]
        return self.client.call_json(
            call_type=call_type,
            model=self.model,
            parser_version=versions.parser_version,
            system_prompt=system_prompt,
            messages=messages,
            provider=self.provider,
            request_fn=lambda: (
                call_deepseek_raw_text(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    schema=schema,
                    base_url=self.base_url or DEFAULT_DEEPSEEK_BASE_URL,
                )
                if self.provider == "DEEPSEEK"
                else call_openai_raw_text(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    schema=schema,
                )
            ),
            parser=parse_provider_json_text,
            validator=validator,
        )

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
        result = self._call_json_traced(
            call_type="decompose",
            prompt=prompt,
            schema=DECOMPOSITION_SCHEMA,
            validator=validate_decomposition_payload,
        )
        return normalize_decomposition_payload(result.parsed, source)

    def diagnose_turn(self, *, concept: Dict[str, Any], context_packet: Dict[str, Any], answer: str) -> Dict[str, Any]:
        result = self._call_json_traced(
            call_type="turn_diagnosis",
            prompt=build_turn_diagnosis_prompt(concept=concept, context_packet=context_packet, answer=answer),
            schema=TURN_DIAGNOSIS_SCHEMA,
            validator=lambda payload: normalize_turn_diagnosis_payload(payload),
        )
        return normalize_turn_diagnosis_payload(result.parsed)

    def generate_turn_envelope(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
        forced_action: str | None = None,
    ) -> Dict[str, Any]:
        diagnosis = (
            {
                "input_type": "request_explain",
                "evidence_quality": "none",
                "key_claim": "",
                "confirmed_understanding": ensure_string((context_packet.get("anchor_state") or {}).get("confirmed_understanding")),
                "has_misconception": False,
                "misconception_detail": "",
            }
            if forced_action == "teach"
            else self.diagnose_turn(concept=concept, context_packet=context_packet, answer=answer)
        )
        result = self._call_json_traced(
            call_type="answer_turn",
            prompt=build_turn_envelope_prompt(
                context_packet=context_packet,
                answer=answer,
                diagnosis=diagnosis,
                forced_action=forced_action,
                concept=concept,
            ),
            schema=TURN_ENVELOPE_SCHEMA,
            validator=lambda payload: validate_turn_envelope_payload(
                normalize_turn_envelope_payload(payload, concept),
                concept.get("id", "")
            ),
        )
        return normalize_turn_envelope_payload(result.parsed, concept)

    def generate_reply_stream(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> str:
        prompt = build_reply_stream_prompt(context_packet=context_packet, answer=answer)
        if self.provider == "DEEPSEEK":
            return call_deepseek_text(
                api_key=self.api_key,
                model=self.model,
                prompt=prompt,
                base_url=self.base_url or DEFAULT_DEEPSEEK_BASE_URL,
            )
        return call_openai_text(api_key=self.api_key, model=self.model, prompt=prompt)

    def generate_reply_stream_events(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> Iterator[str]:
        prompt = build_reply_stream_prompt(context_packet=context_packet, answer=answer)
        if self.provider == "DEEPSEEK":
            yield from stream_deepseek_text_chunks(
                api_key=self.api_key,
                model=self.model,
                prompt=prompt,
                base_url=self.base_url or DEFAULT_DEEPSEEK_BASE_URL,
            )
            return
        text = call_openai_text(api_key=self.api_key, model=self.model, prompt=prompt)
        if text:
            yield text

    def explain_concept(self, *, session: Dict[str, Any], concept: Dict[str, Any], context_packet: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        envelope = self.generate_turn_envelope(
            concept=concept,
            context_packet=context_packet or {},
            answer="",
            forced_action="teach",
        )
        reply = envelope.get("reply") or {}
        teaching_paragraphs = reply.get("teaching_paragraphs") or []
        payload = {
            "visibleReply": reply.get("visible_reply") or concept.get("summary", ""),
            "teachingParagraphs": teaching_paragraphs[:4],
            "checkQuestion": reply.get("next_prompt") or f"现在别背定义，用你自己的话重新讲一遍：{concept.get('title', '这个点')} 最关键的机制是什么？",
            "takeaway": reply.get("takeaway") or "",
        }
        validate_explain_concept_payload(payload)
        return normalize_explain_concept_payload(payload, concept)


class HeuristicTutorIntelligence:
    def __init__(self):
        self.provider = "HEURISTIC"
        self.model = "heuristic-fallback"
        self.kind = "heuristic-fallback"
        self.client = TracedLLMClient()

    @property
    def configured(self) -> bool:
        return True

    def describe(self) -> TutorEngineInfo:
        return TutorEngineInfo(
            provider=self.provider,
            model=self.model,
            enabled=True,
            configured=True,
            reason="fallback_without_provider_credentials",
        )

    def _classify_signal(self, *, concept: Dict[str, Any], answer: str, forced_action: str | None = None) -> str:
        text = ensure_string(answer)
        lowered = text.lower()
        if forced_action == "teach":
            return "noise"
        if not text:
            return "noise"
        if any(token in lowered for token in ("讲", "解释", "总结", "梳理")):
            return "noise"
        concept_tokens = [
            ensure_string(concept.get("title")).lower(),
            ensure_string(concept.get("summary")).lower()[:20],
        ]
        if any(token and token in lowered for token in concept_tokens):
            return "positive"
        return "positive" if len(text) >= 18 else "negative"

    def _build_envelope(
        self,
        *,
        concept: Dict[str, Any],
        answer: str,
        forced_action: str | None = None,
    ) -> Dict[str, Any]:
        signal = self._classify_signal(concept=concept, answer=answer, forced_action=forced_action)
        text = ensure_string(answer)
        lowered = text.lower()
        title = ensure_string(concept.get("title"), "这个点")

        if forced_action == "teach" or any(token in lowered for token in ("讲", "解释", "总结", "梳理")):
            ui_mode = "teach"
            state = "weak"
            confidence_level = "medium"
            follow_up_question = f"现在别背定义，用你自己的话重新讲一遍：{title} 最关键的机制是什么？"
            reason = "用户显式要求讲解或当前更适合先补关键机制。"
        elif any(token in lowered for token in ("下一题", "下一个", "跳过")):
            ui_mode = "advance"
            state = "partial"
            confidence_level = "medium"
            follow_up_question = ""
            reason = "用户要求继续推进当前节奏。"
        elif signal == "positive" and len(text) >= 40:
            ui_mode = "verify"
            state = "solid"
            confidence_level = "high"
            follow_up_question = f"如果面试官继续追问边界，你会怎么解释“{title}”最容易答偏的地方？"
            reason = "用户已经碰到主链，适合再用一个问题确认边界。"
        elif signal == "positive":
            ui_mode = "verify"
            state = "partial"
            confidence_level = "medium"
            follow_up_question = f"结合你刚才的阅读和已有回答，再讲一次：“{title}”这条链路里最容易漏掉的关键一步是什么？"
            reason = "方向基本对，但还需要继续确认是否真正讲稳。"
        else:
            ui_mode = "probe"
            state = "weak"
            confidence_level = "low"
            follow_up_question = f"不要背定义，直接用你自己的话解释：“{title}”最核心的机制是什么，它为什么重要？"
            reason = "当前回答还没有形成稳定机制链路。"

        if ui_mode in {"probe", "teach", "verify"} and not follow_up_question:
            follow_up_question = f"你先用自己的话再讲一下：{title} 的关键机制是什么？"

        return normalize_turn_envelope_payload(
            {
                "runtime_map": {
                    "anchor_id": concept.get("id", ""),
                    "turn_signal": signal,
                    "anchor_assessment": {
                        "state": state,
                        "confidence_level": confidence_level,
                        "reasons": [reason],
                    },
                    "hypotheses": [],
                    "misunderstandings": [] if signal == "positive" else [{"label": concept.get("misconception") or concept.get("summary", "")}],
                    "open_questions": [follow_up_question] if follow_up_question else [],
                    "verification_targets": [],
                    "info_gain_level": "medium" if ui_mode != "advance" else "low",
                },
                "next_move": {
                    "intent": "先补最有价值的一步，再决定是否继续深挖。",
                    "reason": reason,
                    "expected_gain": "medium" if ui_mode != "advance" else "low",
                    "ui_mode": ui_mode,
                    "follow_up_question": follow_up_question,
                },
                "writeback_suggestion": {
                    "should_write": True,
                    "mode": "update",
                    "reason": "heuristic_fallback_turn",
                    "anchor_patch": {
                        "state": state,
                        "confidence_level": confidence_level,
                        "derived_principle": concept.get("summary", ""),
                    },
                },
            },
            concept,
        )

    def generate_turn_envelope(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
        forced_action: str | None = None,
    ) -> Dict[str, Any]:
        return self._build_envelope(concept=concept, answer=answer, forced_action=forced_action)

    def generate_reply_stream(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> str:
        lowered = ensure_string(answer).lower()
        if any(token in lowered for token in ("讲", "解释", "总结", "梳理")):
            return normalize_teaching_paragraph(f"我先把这一层讲清楚：{concept.get('summary', '')}")
        if any(token in lowered for token in ("下一题", "下一个", "跳过")):
            return "这个点我先帮你记下来，我们继续往下推进。"
        if len(ensure_string(answer)) >= 24:
            return f"你的主线方向基本对。接下来最好再把“{concept.get('title', '')}”的关键机制和边界补完整。"
        return f"你的回答还没把“{concept.get('title', '')}”讲成完整链路，我先帮你补一层：{concept.get('summary', '')}"

    def generate_reply_stream_events(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> Iterator[str]:
        text = self.generate_reply_stream(concept=concept, context_packet=context_packet, answer=answer)
        if text:
            yield text

    def explain_concept(self, *, session: Dict[str, Any], concept: Dict[str, Any], context_packet: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {
            "visibleReply": concept.get("summary", ""),
            "teachingParagraphs": [concept.get("summary", "")],
            "checkQuestion": concept.get("checkQuestion") or concept.get("retryQuestion") or "",
            "takeaway": concept.get("summary", ""),
        }
        validate_explain_concept_payload(payload)
        return normalize_explain_concept_payload(payload, concept)


def create_tutor_intelligence() -> ProviderTutorIntelligence | None:
    enabled = str(os.environ.get("LLAI_LLM_ENABLED", "true")).lower()
    if enabled in {"0", "false", "no", "off"}:
        return HeuristicTutorIntelligence()
    provider = str(os.environ.get("LLAI_LLM_PROVIDER", "OPENAI")).upper()
    if provider == "DEEPSEEK":
        intelligence = ProviderTutorIntelligence(
            provider="DEEPSEEK",
            model=os.environ.get("LLAI_DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL),
            api_key=os.environ.get("LLAI_DEEPSEEK_API_KEY", ""),
            base_url=os.environ.get("LLAI_DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL),
        )
        return intelligence if intelligence.configured else HeuristicTutorIntelligence()
    intelligence = ProviderTutorIntelligence(
        provider="OPENAI",
        model=os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL),
        api_key=os.environ.get("OPENAI_API_KEY", ""),
    )
    return intelligence if intelligence.configured else HeuristicTutorIntelligence()


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
