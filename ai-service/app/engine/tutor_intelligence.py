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
from app.engine.mastery_scoring import default_score_for_state, score_to_state
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


def ensure_reply_text(value: Any, fallback: str = "") -> str:
    if isinstance(value, str):
        return value if value.strip() else fallback
    normalized = str(value or "")
    return normalized if normalized.strip() else fallback


KNOWLEDGE_GOAL_LABELS = {
    "interview": "面试准备",
    "quick_understanding": "快速理解",
    "work": "工作落地",
    "exam": "考试复习",
    "content_output": "内容输出",
}

KNOWLEDGE_TASK_LABELS = {
    "summary": "总结全文",
    "memory_points": "提炼记忆点",
    "question_points": "生成自测问题",
    "freeform": "自由问答",
}


def normalize_knowledge_goal(goal: Any) -> str:
    normalized = ensure_string(goal)
    return normalized if normalized else "interview"


def normalize_knowledge_task_type(task_type: Any) -> str:
    normalized = ensure_string(task_type)
    return normalized if normalized in KNOWLEDGE_TASK_LABELS else "freeform"


def describe_knowledge_goal(goal: Any) -> str:
    normalized = normalize_knowledge_goal(goal)
    return KNOWLEDGE_GOAL_LABELS.get(normalized, normalized)


def _knowledge_task_instruction(task_type: str) -> str:
    normalized = normalize_knowledge_task_type(task_type)
    if normalized == "summary":
        return "\n".join(
            [
                "当前任务：总结全文。",
                "好答案标准：",
                "- 让用户快速知道这篇文档主要讲什么。",
                "- 说明它对当前目标有什么价值。",
                "- 提炼文章最重要的主线、结论和取舍。",
                "- 帮用户判断读完后最应该带走什么。",
                "- 根据文章内容自行决定详略，不要为了固定条数而凑内容。",
            ]
        )
    if normalized == "memory_points":
        return "\n".join(
            [
                "当前任务：提炼记忆点。",
                "好答案标准：",
                "- 只提炼真正值得记住的内容，不为凑数量输出低价值点。",
                "- 每个记忆点要说明为什么重要。",
                "- 优先覆盖容易混淆、容易忘、容易被追问、容易在实践中用错的内容。",
                "- 尽量把抽象概念转成用户能复述的表达。",
                "- 如有必要，可以标出“必记”“建议掌握”“了解即可”等层级。",
            ]
        )
    if normalized == "question_points":
        return "\n".join(
            [
                "当前任务：生成自测问题。",
                "好答案标准：",
                "- 问题应覆盖文章中最值得掌握的关键点。",
                "- 问题不要停留在标题复述，要能检验理解、区分、应用或取舍。",
                "- 每个问题说明它在考察什么。",
                "- 可以给出简短回答要点，帮助用户知道回答时至少要覆盖哪些内容。",
                "- 根据文章内容自行决定问题数量，不需要凑数。",
            ]
        )
    return "\n".join(
        [
            "当前任务：回答用户关于这篇文档的问题。",
            "好答案标准：",
            "- 优先贴合原文里的概念和表述。",
            "- 当用户提出材料之外的延伸、反事实或原理追问时，可以用可靠通用知识补足，并说明这是基于通用知识的推理。",
            "- 不要因为材料没有直接展开就拒答；只有问题明显需要材料中不存在的具体事实时，才说明材料未覆盖该细节。",
        ]
    )


def build_knowledge_answer_prompt(*, question: str, context: str, goal: str = "interview", task_type: str = "freeform") -> str:
    clipped_context = ensure_string(context)[:12_000]
    goal_label = describe_knowledge_goal(goal)
    task_label = KNOWLEDGE_TASK_LABELS.get(normalize_knowledge_task_type(task_type), "自由问答")
    task_instruction = _knowledge_task_instruction(task_type)
    return f"""
你是 LearningLoopAI 的阅读助理。你把用户正在阅读的材料当作主要参考，同时可以结合可靠的通用技术知识回答。

当前用户目标：{goal_label}
当前能力：{task_label}

回答规则：
- 始终围绕当前用户目标处理文档：帮助用户把原文转化成更容易理解、记忆和自测的学习材料。
- 优先保留对目标有价值的信息，弱化无关背景、重复表达和低价值细节。
- 优先贴合【材料】里的概念和表述；当用户提出材料之外的延伸、反事实或原理追问时，可以用通用技术知识补足，并说明这是基于通用知识的推理。
- 不要因为材料没有直接展开就拒答；只有问题明显需要材料中不存在的具体事实时，才说明材料未覆盖该细节。
- 如果用户要求总结，直接给出总结，不要说“你是在提出请求”。
- 不要固定输出数量；根据文章长度、信息密度和当前目标自行决定详略。
- 用中文回答。

{task_instruction}

【材料】
{clipped_context}

【用户问题】
{ensure_string(question)}
""".strip()


def answer_knowledge_question_heuristic(*, question: str, context: str, goal: str = "interview", task_type: str = "freeform") -> str:
    normalized_question = ensure_string(question)
    normalized_context = ensure_string(context)
    normalized_task_type = normalize_knowledge_task_type(task_type)
    goal_label = describe_knowledge_goal(goal)
    lines = [
        line.strip(" #`*-")
        for line in normalized_context.replace("\r", "").split("\n")
        if line.strip() and not line.strip().startswith("!")
    ]
    headings = [line for line in lines if len(line) <= 48][:8]
    paragraphs = [line for line in lines if len(line) > 18][:6]

    if normalized_task_type == "summary" or any(token in normalized_question for token in ("总结", "概括", "3 句", "三句")):
        seeds = paragraphs[:3] or headings[:3] or [normalized_context[:120] or "这篇材料目前没有足够内容可总结。"]
        return f"当前目标：{goal_label}\n\n" + "\n".join(f"{index + 1}. {seed}" for index, seed in enumerate(seeds[:3]))

    if normalized_task_type == "memory_points":
        seeds = headings[:6] or paragraphs[:6] or ["材料核心概念"]
        return f"当前目标：{goal_label}\n\n" + "\n".join(
            f"{index + 1}. {seed}\n为什么值得记：这是当前目标下需要优先保留、复述或区分的内容。"
            for index, seed in enumerate(seeds)
        )

    if normalized_task_type == "question_points" or any(token in normalized_question for token in ("面试", "追问", "问题")):
        seeds = headings[:5] or paragraphs[:5] or ["材料核心概念"]
        return f"当前目标：{goal_label}\n\n" + "\n".join(
            f"{index + 1}. 问题：{seed} 的核心机制、适用场景和边界是什么？\n考察点：是否真正理解这个关键点，并能按当前目标复述或应用。"
            for index, seed in enumerate(seeds)
        )

    seeds = paragraphs[:2] or headings[:2]
    if not seeds:
        return "这篇材料里没有足够内容回答这个问题。"
    return "基于这篇材料，" + "；".join(seeds[:2])


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


def _call_openai_raw_text(*, api_key: str, model: str, prompt: str, schema: Dict[str, Any], timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS) -> tuple[str, Dict[str, Any]]:
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


def _call_openai_text(*, api_key: str, model: str, prompt: str, timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS) -> str:
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
    return ensure_reply_text(_extract_openai_text(payload))


def _call_deepseek_raw_text(
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


def _call_deepseek_text(
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
    return ensure_reply_text(_extract_chat_message_content(payload, "DeepSeek"))


def normalize_provider_name(provider: str) -> str:
    normalized = str(provider or "OPENAI").strip().upper()
    if normalized in {"OPENAI", "DEEPSEEK"}:
        return normalized
    raise ValueError(f"Unsupported LLM provider: {provider}")


def call_provider_raw_text(
    *,
    provider: str,
    api_key: str,
    model: str,
    prompt: str,
    schema: Dict[str, Any],
    base_url: str | None = None,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> tuple[str, Dict[str, Any]]:
    normalized_provider = normalize_provider_name(provider)
    if normalized_provider == "DEEPSEEK":
        return _call_deepseek_raw_text(
            api_key=api_key,
            model=model,
            prompt=prompt,
            schema=schema,
            base_url=base_url or DEFAULT_DEEPSEEK_BASE_URL,
            timeout_ms=timeout_ms,
        )
    return _call_openai_raw_text(
        api_key=api_key,
        model=model,
        prompt=prompt,
        schema=schema,
        timeout_ms=timeout_ms,
    )


def call_provider_json(
    *,
    provider: str,
    api_key: str,
    model: str,
    prompt: str,
    schema: Dict[str, Any],
    base_url: str | None = None,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> Dict[str, Any]:
    raw_text, _ = call_provider_raw_text(
        provider=provider,
        api_key=api_key,
        model=model,
        prompt=prompt,
        schema=schema,
        base_url=base_url,
        timeout_ms=timeout_ms,
    )
    return parse_provider_json_text(raw_text)


def call_provider_text(
    *,
    provider: str,
    api_key: str,
    model: str,
    prompt: str,
    base_url: str | None = None,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> str:
    normalized_provider = normalize_provider_name(provider)
    if normalized_provider == "DEEPSEEK":
        return _call_deepseek_text(
            api_key=api_key,
            model=model,
            prompt=prompt,
            base_url=base_url or DEFAULT_DEEPSEEK_BASE_URL,
            timeout_ms=timeout_ms,
        )
    return _call_openai_text(
        api_key=api_key,
        model=model,
        prompt=prompt,
        timeout_ms=timeout_ms,
    )


def stream_provider_text_chunks(
    *,
    provider: str,
    api_key: str,
    model: str,
    prompt: str,
    base_url: str | None = None,
    timeout_ms: int = DEFAULT_PROVIDER_TIMEOUT_MS,
) -> Iterator[str]:
    normalized_provider = normalize_provider_name(provider)
    if normalized_provider == "DEEPSEEK":
        yield from _stream_deepseek_text_chunks(
            api_key=api_key,
            model=model,
            prompt=prompt,
            base_url=base_url or DEFAULT_DEEPSEEK_BASE_URL,
            timeout_ms=timeout_ms,
        )
        return
    text = call_provider_text(
        provider=normalized_provider,
        api_key=api_key,
        model=model,
        prompt=prompt,
        timeout_ms=timeout_ms,
    )
    if text:
        yield text


def _stream_deepseek_text_chunks(
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
    misconception_anchors = [ensure_string(item) for item in ensure_array(unit.get("misconceptionAnchors")) if ensure_string(item)][:4]
    discriminators = [ensure_string(item) for item in ensure_array(unit.get("discriminators")) if ensure_string(item)][:4]
    return {
        "id": ensure_string(unit.get("id"), f"{_slugify(unit.get('title') or f'unit-{index + 1}')}-{index + 1}"),
        "title": ensure_string(unit.get("title"), f"Teachable Unit {index + 1}"),
        "summary": ensure_string(unit.get("summary")),
        "evidenceSnippet": ensure_string(unit.get("evidenceSnippet") or unit.get("evidenceReference") or unit.get("summary")),
        "misconceptionAnchors": misconception_anchors,
        "discriminators": discriminators,
        "misconception": ensure_string(unit.get("misconception"), "；".join(misconception_anchors)),
        "importance": ensure_string(unit.get("importance"), "secondary"),
        "diagnosticQuestion": ensure_string(unit.get("diagnosticQuestion")),
        "retryQuestion": ensure_string(unit.get("retryQuestion")),
        "stretchQuestion": ensure_string(unit.get("stretchQuestion")),
        "checkQuestion": ensure_string(unit.get("checkQuestion"), unit.get("retryQuestion") or unit.get("diagnosticQuestion") or ""),
        "remediationHint": ensure_string(unit.get("remediationHint")),
        "order": index + 1,
    }


def _validate_checkpoint(checkpoint: Dict[str, Any], index: int, point_id: str, fallback_summary: str = "", fallback_evidence: str = "", fallback_mistakes: List[str] | None = None) -> Dict[str, Any]:
    evidence_snippets = [ensure_string(item) for item in ensure_array(checkpoint.get("evidenceSnippets")) if ensure_string(item)][:3]
    common_mistakes = [ensure_string(item) for item in ensure_array(checkpoint.get("commonMistakes")) if ensure_string(item)][:4]
    return {
        "id": ensure_string(checkpoint.get("id"), f"{point_id}-cp-{index + 1}"),
        "statement": ensure_string(checkpoint.get("statement"), fallback_summary or f"Checkpoint {index + 1}"),
        "evidenceSnippets": evidence_snippets or ([ensure_string(fallback_evidence)] if ensure_string(fallback_evidence) else []),
        "successCriteria": ensure_string(checkpoint.get("successCriteria"), fallback_summary or ensure_string(checkpoint.get("statement"))),
        "commonMistakes": common_mistakes or [item for item in (fallback_mistakes or []) if ensure_string(item)][:4],
        "maxTurns": int(checkpoint.get("maxTurns") or 3),
        "diagnosticQuestion": ensure_string(checkpoint.get("diagnosticQuestion")),
        "checkQuestion": ensure_string(checkpoint.get("checkQuestion")),
        "order": index + 1,
    }


def _build_checkpoints_from_legacy_unit(unit: Dict[str, Any]) -> List[Dict[str, Any]]:
    discriminators = unit.get("discriminators") or []
    misconception_anchors = unit.get("misconceptionAnchors") or []
    if discriminators:
        return [
            _validate_checkpoint(
                {
                    "id": f"{unit['id']}-cp-{index + 1}",
                    "statement": discriminator,
                    "evidenceSnippets": [unit.get("evidenceSnippet", "")],
                    "successCriteria": discriminator,
                    "commonMistakes": misconception_anchors,
                    "maxTurns": 3,
                    "diagnosticQuestion": unit.get("diagnosticQuestion", ""),
                    "checkQuestion": unit.get("checkQuestion", "") or unit.get("retryQuestion", ""),
                },
                index,
                unit["id"],
                fallback_summary=unit.get("summary", ""),
                fallback_evidence=unit.get("evidenceSnippet", ""),
                fallback_mistakes=misconception_anchors,
            )
            for index, discriminator in enumerate(discriminators)
        ]

    return [
        _validate_checkpoint(
            {
                "id": f"{unit['id']}-cp-1",
                "statement": unit.get("summary") or unit.get("title") or "核心检查项",
                "evidenceSnippets": [unit.get("evidenceSnippet", "")],
                "successCriteria": unit.get("summary") or unit.get("title") or "说明当前训练点的核心作用",
                "commonMistakes": misconception_anchors,
                "maxTurns": 3,
                "diagnosticQuestion": unit.get("diagnosticQuestion", ""),
                "checkQuestion": unit.get("checkQuestion", "") or unit.get("retryQuestion", ""),
            },
            0,
            unit["id"],
            fallback_summary=unit.get("summary", ""),
            fallback_evidence=unit.get("evidenceSnippet", ""),
            fallback_mistakes=misconception_anchors,
        )
    ]


def _validate_training_point(point: Dict[str, Any], index: int) -> Dict[str, Any]:
    point_id = ensure_string(point.get("id"), f"{_slugify(point.get('title') or f'point-{index + 1}')}-{index + 1}")
    checkpoints = [
        _validate_checkpoint(
            checkpoint,
            checkpoint_index,
            point_id,
            fallback_summary=ensure_string(point.get("summary")),
            fallback_evidence=ensure_string(point.get("evidenceSnippet") or point.get("summary")),
            fallback_mistakes=[ensure_string(item) for item in ensure_array(point.get("commonMistakes")) if ensure_string(item)],
        )
        for checkpoint_index, checkpoint in enumerate(ensure_array(point.get("checkpoints")))
    ]
    if not checkpoints:
        checkpoints = _build_checkpoints_from_legacy_unit(
            {
                "id": point_id,
                "title": ensure_string(point.get("title"), f"Training Point {index + 1}"),
                "summary": ensure_string(point.get("summary")),
                "evidenceSnippet": ensure_string(point.get("evidenceSnippet") or point.get("summary")),
                "misconceptionAnchors": [ensure_string(item) for item in ensure_array(point.get("commonMistakes") or point.get("misconceptionAnchors")) if ensure_string(item)],
                "discriminators": [ensure_string(item) for item in ensure_array(point.get("discriminators")) if ensure_string(item)],
                "diagnosticQuestion": ensure_string(point.get("diagnosticQuestion")),
                "retryQuestion": ensure_string(point.get("retryQuestion")),
                "checkQuestion": ensure_string(point.get("checkQuestion")),
            }
        )

    return {
        "id": point_id,
        "title": ensure_string(point.get("title"), f"Training Point {index + 1}"),
        "summary": ensure_string(point.get("summary")),
        "importance": ensure_string(point.get("importance"), "secondary"),
        "order": index + 1,
        "checkpoints": checkpoints,
        "abilityDomainId": ensure_string(point.get("abilityDomainId") or point.get("domainId")),
        "abilityDomainTitle": ensure_string(point.get("abilityDomainTitle") or point.get("domainTitle")),
        "questionFamily": ensure_string(point.get("questionFamily")),
        "provenance": point.get("provenance") or point.get("interviewQuestion") or {},
        "provenanceLabel": ensure_string(point.get("provenanceLabel") or ((point.get("interviewQuestion") or {}).get("label"))),
        "javaGuideSources": ensure_array(point.get("javaGuideSources")),
        "remediationMaterials": ensure_array(point.get("remediationMaterials")),
        "remediationHint": ensure_string(point.get("remediationHint")),
    }


def _checkpoint_concept_from_point(point: Dict[str, Any], checkpoint: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": checkpoint["id"],
        "title": point["title"],
        "summary": point["summary"],
        "evidenceSnippet": " / ".join(checkpoint.get("evidenceSnippets") or []) or point["summary"],
        "misconceptionAnchors": checkpoint.get("commonMistakes") or [],
        "discriminators": [checkpoint.get("statement", ""), checkpoint.get("successCriteria", "")] if checkpoint.get("successCriteria") else [checkpoint.get("statement", "")],
        "misconception": "；".join(checkpoint.get("commonMistakes") or []),
        "importance": point.get("importance", "secondary"),
        "diagnosticQuestion": checkpoint.get("diagnosticQuestion") or "",
        "retryQuestion": "",
        "stretchQuestion": "",
        "checkQuestion": checkpoint.get("checkQuestion") or "",
        "remediationHint": "",
        "order": checkpoint.get("order", 1),
        "trainingPointId": point["id"],
        "trainingPointTitle": point["title"],
        "trainingPointSummary": point["summary"],
        "checkpointId": checkpoint["id"],
        "checkpointStatement": checkpoint["statement"],
        "successCriteria": checkpoint["successCriteria"],
        "evidenceSnippets": checkpoint.get("evidenceSnippets") or [],
        "commonMistakes": checkpoint.get("commonMistakes") or [],
        "maxTurns": checkpoint.get("maxTurns", 3),
        "abilityDomainId": point.get("abilityDomainId", ""),
        "abilityDomainTitle": point.get("abilityDomainTitle", ""),
        "domainId": point.get("abilityDomainId", ""),
        "domainTitle": point.get("abilityDomainTitle", ""),
        "questionFamily": point.get("questionFamily", ""),
        "provenance": point.get("provenance") or {},
        "provenanceLabel": point.get("provenanceLabel", ""),
        "interviewQuestion": point.get("provenance") or {},
        "javaGuideSources": point.get("javaGuideSources") or [],
        "remediationMaterials": point.get("remediationMaterials") or [],
        "remediationHint": point.get("remediationHint", ""),
    }


def normalize_decomposition_payload(payload: Dict[str, Any], source: Dict[str, Any]) -> Dict[str, Any]:
    raw_points = ensure_array((payload or {}).get("trainingPoints"))[:7]
    if not raw_points:
        raw_concepts = ensure_array((payload or {}).get("concepts"))
        if raw_concepts:
            raw_points = raw_concepts
    if not raw_points:
        raw_units = ensure_array((payload or {}).get("units"))[:7]
        if len(raw_units) < 1:
            raise ValueError("Tutor intelligence returned too few teaching units.")
        raw_points = []
        for index, unit in enumerate(raw_units):
            normalized_unit = _validate_unit(unit, index)
            raw_points.append(
                {
                    "id": normalized_unit["id"],
                    "title": normalized_unit["title"],
                    "summary": normalized_unit["summary"],
                    "importance": normalized_unit["importance"],
                    "evidenceSnippet": normalized_unit["evidenceSnippet"],
                    "commonMistakes": normalized_unit["misconceptionAnchors"],
                    "checkpoints": _build_checkpoints_from_legacy_unit(normalized_unit),
                }
            )
    training_points = [_validate_training_point(point, index) for index, point in enumerate(raw_points)]
    training_points = [point for point in training_points if point["summary"] and point["checkpoints"]]
    if len(training_points) < 1:
        raise ValueError("Tutor intelligence returned invalid training points.")
    concepts = []
    for point in training_points:
        concepts.extend([_checkpoint_concept_from_point(point, checkpoint) for checkpoint in point["checkpoints"]])
    key_themes = [ensure_string(item) for item in ensure_array(((payload or {}).get("summary") or {}).get("keyThemes")) if ensure_string(item)][:3]
    source_summary = (payload or {}).get("summary") or {}
    return {
        "trainingPoints": training_points,
        "concepts": concepts,
        "summary": {
            "sourceTitle": ensure_string(source_summary.get("sourceTitle"), source.get("title", "")),
            "keyThemes": key_themes or [point["title"] for point in training_points[:3]],
            "framing": ensure_string(
                source_summary.get("framing"),
                f"我先从材料里提炼出 {'、'.join(point['title'] for point in training_points[:3])} 这些训练点。",
            ),
            "overviewDomains": ensure_array(source_summary.get("overviewDomains")),
            "javaGuideSourceClusters": ensure_array(source_summary.get("javaGuideSourceClusters")),
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


def normalize_answer_score(value: Any, fallback: int = 0) -> int:
    try:
        numeric_score = round(float(value))
    except (TypeError, ValueError):
        numeric_score = fallback
    return min(100, max(0, int(numeric_score)))


def normalize_turn_envelope_payload(payload: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    runtime_map = (payload or {}).get("runtime_map") or {}
    anchor_assessment = runtime_map.get("anchor_assessment") or {}
    next_move = (payload or {}).get("next_move") or {}
    suggestion = (payload or {}).get("writeback_suggestion") or {}
    provided_state = normalize_state_alias(anchor_assessment.get("state"), "")
    answer_score = normalize_answer_score(anchor_assessment.get("score"), default_score_for_state(provided_state or "weak"))
    answer_state = "不可判" if provided_state == "不可判" and answer_score == 0 else score_to_state(answer_score)
    anchor_patch = suggestion.get("anchor_patch") or {}
    patch_state = normalize_state_alias(anchor_patch.get("state"), "")
    patch_score = normalize_answer_score(anchor_patch.get("score"), answer_score if answer_state != "不可判" else default_score_for_state(patch_state or "weak"))
    follow_up_question = ensure_string(next_move.get("follow_up_question") or next_move.get("followUpQuestion"))
    ui_mode = next_move.get("ui_mode") if next_move.get("ui_mode") in {"probe", "teach", "verify", "advance", "revisit", "stop"} else "probe"
    return {
        "runtime_map": {
            "anchor_id": concept.get("id", "") or ensure_string(runtime_map.get("anchor_id"), concept.get("id", "")),
            "turn_signal": normalize_signal_alias(runtime_map.get("turn_signal"), "noise"),
            "anchor_assessment": {
                "state": answer_state,
                "score": answer_score,
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
                "state": score_to_state(patch_score),
                "score": patch_score,
                "derived_principle": ensure_string(
                    anchor_patch.get("derived_principle")
                    or anchor_patch.get("derivedPrinciple"),
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


def validate_question_generation_payload(payload: Dict[str, Any]) -> None:
    if not ensure_string((payload or {}).get("question")):
        raise ValueError("AI tutor did not generate a question.")


def format_source_for_prompt(source: Dict[str, Any]) -> str:
    lines = [f"TITLE: {source.get('title', '')}"]
    if source.get("url"):
        lines.append(f"URL: {source.get('url')}")
    lines.extend(["CONTENT:", source.get("content", "")])
    return "\n".join(lines)


TURN_INPUT_TYPES = {"answer", "request_explain", "request_advance", "mixed"}

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
    "answering the current learner-facing question completely > expanding to a different discriminator under the same broad anchor",
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
    return {
        "input_type": input_type if input_type in TURN_INPUT_TYPES else "answer",
        "key_claim": ensure_string(diagnosis.get("key_claim")),
        "confirmed_understanding": ensure_string(diagnosis.get("confirmed_understanding")),
        "judgment_reason": ensure_string(diagnosis.get("judgment_reason")),
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
            "Do not teach, persuade, or write a full learner-facing reply here.",
            "Boundary: this diagnosis call only produces assessment facts. A separate parallel reply/teach call writes the learner-facing explanation.",
            "All diagnosis string fields must be written in Simplified Chinese.",
            "Do not copy English learner claims into key_claim; translate or summarize them in Chinese, while preserving technical identifiers such as LRU, put, Redis, Object[] when needed.",
            "For fields that may be shown to the learner (key_claim, confirmed_understanding, judgment_reason, misconception_detail), write directly to the learner in second person. Do not use third-person labels such as 用户, 学习者, or Learner.",
            "judgment_reason is learner-facing, but it is not a reply or explanation: only explain why the current score/state follows from the answer evidence.",
            "judgment_reason must not introduce new concepts, teach the correct answer, give next-step instructions, ask a question, or repeat the full feedback body.",
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
    normalized_answer = ensure_string(answer)
    explanation_request = normalized_answer in {"查看解析", "看解析", "讲解一下", "解释一下"} or "解析" in normalized_answer
    extra_rules = []
    if explanation_request:
        extra_rules.extend([
            "The learner is explicitly asking for an explanation of the current learner-facing question.",
            "Answer that current question directly and concretely.",
            "Stay tightly scoped to the current checkpoint question instead of summarizing the broader training point.",
            "If the question asks 'which capability / why / how', make sure your explanation explicitly answers that exact ask.",
        ])
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
            *extra_rules,
            "",
            "CONTEXT_PACKET_JSON:",
            json.dumps(context_packet, ensure_ascii=False, indent=2),
            "",
            f"CURRENT_LEARNER_INPUT: {answer}",
        ]
    )


def build_teach_reply_prompt(*, context_packet: Dict[str, Any], answer: str) -> str:
    # Teach mode is a separate task from answer evaluation. The model should
    # explain the current learner-facing question directly, not infer whether
    # "查看解析" was correct or incorrect as an answer.
    return "\n".join(
        [
            "You are writing the learner-facing explanation for the current checkpoint question.",
            "Use Chinese markdown only. Do not return JSON.",
            "The learner has explicitly requested an explanation instead of answering this question.",
            "Treat the current learner input as an explanation request, not as an answer to evaluate.",
            "Explain the current learner-facing question directly and concretely.",
            "Stay tightly scoped to the current checkpoint question instead of summarizing the broader training point.",
            "Do not assume the learner already answered correctly or incorrectly.",
            "Do not promise what the system will ask next.",
            "Do not say you will switch topics, stop, or move on.",
            "Do not include labels such as '下一步' or 'gap' or 'runtime'.",
            "If useful, end with one stable takeaway sentence naturally inside the prose.",
            "Keep the reply self-contained and valuable even if the learner stops here.",
            "",
            "CONTEXT_PACKET_JSON:",
            json.dumps(context_packet, ensure_ascii=False, indent=2),
            "",
            f"CURRENT_LEARNER_INPUT: {ensure_string(answer)}",
        ]
    )


def build_turn_envelope_prompt(
    *,
    context_packet: Dict[str, Any],
    answer: str,
    diagnosis: Dict[str, Any],
    forced_action: str | None = None,
    concept: Dict[str, Any] | None = None,
    retry_missing_followup: bool = False,
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
        "- Use anchor_assessment.score as the only answer score, from 0 to 100.",
        "- Map score < 60 to weak, 60-84 to partial, and >= 85 to solid.",
        "- Do not output secondary reliability fields.",
        "- Treat budget, friction_signals, and stop_conditions as orchestration factors before proposing more probing.",
        "- If recent teaching already covered the core mechanism, prefer naming the one missing link over repeating the full explanation.",
        "- If the answer is complete enough for the current learner-facing question and has_misconception is false, do not open a new follow-up just to cover a different discriminator under the same broad anchor.",
        "- When the learner has already fully answered the current learner-facing question, prefer marking the unit solid and stopping or advancing instead of escalating scope.",
        "- Only a clearly wrong learner answer may ask an immediate same-concept follow_up_question.",
        "- For full, partial, empty, or teach-control turns, leave follow_up_question empty and let orchestration advance or stop.",
        "- Treat follow_up_question as a candidate follow-up only for allowed same-concept wrong-answer repair. If the turn should switch or stop, leave follow_up_question empty.",
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

    if retry_missing_followup:
        sections.extend(
            [
                "",
                "RETRY REQUIREMENT:",
                "Your previous output was rejected because next_move.follow_up_question was missing.",
                "If next_move.ui_mode is probe or verify for wrong-answer repair, you MUST provide one concrete learner-facing follow_up_question.",
                "If next_move.ui_mode is advance, stop, or revisit, follow_up_question MUST be empty.",
            ]
        )

    if forced_action == "teach" and concept:
        sections.extend(
            [
                "",
                "TEACHING CONTEXT:",
                json.dumps(
                    {
                        "concept_title": concept.get("title", ""),
                        "concept_summary": concept.get("summary", ""),
                        "evidence_snippet": concept.get("evidenceSnippet", ""),
                        "misconception_anchors": concept.get("misconceptionAnchors", []) or ([concept.get("misconception")] if concept.get("misconception") else []),
                        "discriminators": concept.get("discriminators", []),
                        "sources": concept.get("javaGuideSources", []),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                "",
                "When FORCED_ACTION is teach, do not probe before helping.",
                "Leave follow_up_question empty; the session orchestrator will advance to the next checkpoint or stop after the explanation.",
            ]
        )

    return "\n".join(sections)


DECOMPOSITION_SCHEMA = {
    "name": "tutor_decomposition",
    "example": {
        "summary": {
            "sourceTitle": "AQS 详解",
            "keyThemes": ["AQS 的同步器底座角色", "独占 acquire/release 主链路"],
            "framing": "我先把材料拆成稳定概念锚点，具体问题会根据学习进展动态生成。",
        },
        "units": [
            {
                "id": "aqs-role-1",
                "title": "AQS 的同步器底座角色",
                "summary": "AQS 为锁和同步器提供通用框架。",
                "evidenceSnippet": "AQS 提供了资源获取和释放的通用框架。",
                "misconceptionAnchors": ["容易只说它很重要，不说明它到底抽象了什么。"],
                "discriminators": ["能说清 AQS 是框架而不是具体锁", "能把 state、队列、唤醒串成一条链路"],
                "importance": "core",
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
            "units": {
                "type": "array",
                "minItems": 3,
                "maxItems": 7,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "id",
                        "title",
                        "summary",
                        "evidenceSnippet",
                        "misconceptionAnchors",
                        "discriminators",
                        "importance",
                    ],
                    "properties": {
                        "id": {"type": "string"},
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                        "evidenceSnippet": {"type": "string"},
                        "misconceptionAnchors": {"type": "array", "maxItems": 4, "items": {"type": "string"}},
                        "discriminators": {"type": "array", "maxItems": 4, "items": {"type": "string"}},
                        "importance": {"type": "string", "enum": ["core", "secondary", "optional"]},
                    },
                },
            },
        },
    },
}

QUESTION_GENERATION_SCHEMA = {
    "name": "tutor_question_generation",
    "example": {
        "question": "先从这条链路开始：如果 ReentrantLock 基于 AQS，独占 acquire 失败后线程会进入哪几个关键步骤？",
        "intent": "诊断用户是否能把 state、入队和阻塞唤醒串起来。",
    },
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["question", "intent"],
        "properties": {
            "question": {"type": "string"},
            "intent": {"type": "string"},
        },
    },
}

TURN_DIAGNOSIS_SCHEMA = {
    "name": "tutor_turn_diagnosis",
    "example": {
        "input_type": "answer",
        "key_claim": "你已经说出 MVCC 和历史版本有关。",
        "confirmed_understanding": "你已经知道 MVCC 不是直接读最新值。",
        "judgment_reason": "这轮能看出你抓住了历史版本这个核心线索，但还没有说明快照读和当前读的边界，所以先判断为部分掌握。",
        "has_misconception": False,
        "misconception_detail": "",
    },
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "input_type",
            "key_claim",
            "confirmed_understanding",
            "judgment_reason",
            "has_misconception",
            "misconception_detail",
        ],
        "properties": {
            "input_type": {"type": "string", "enum": sorted(TURN_INPUT_TYPES)},
            "key_claim": {"type": "string"},
            "confirmed_understanding": {"type": "string"},
            "judgment_reason": {"type": "string"},
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
                "score": 72,
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
                "score": 72,
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
        return call_provider_json(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            base_url=self.base_url,
            prompt=prompt,
            schema=schema,
        )

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
            request_fn=lambda: call_provider_raw_text(
                provider=self.provider,
                api_key=self.api_key,
                model=self.model,
                prompt=prompt,
                schema=schema,
                base_url=self.base_url,
            ),
            parser=parse_provider_json_text,
            validator=validator,
        )

    def decompose_source(self, source: Dict[str, Any]) -> Dict[str, Any]:
        prompt = "\n".join(
            [
                "Read the submitted learning material and produce 3-7 document-local concept anchors.",
                "Requirements:",
                "- Stay anchored to the submitted source, but use minimal background knowledge when needed for clearer teaching.",
                "- Do not leak frontmatter, tags, SEO metadata, or boilerplate into the learner-facing summary.",
                "- Do not generate learner-facing questions during decomposition.",
                "- Decomposition is only for stable concept structure: what to teach, evidence, common misconception anchors, and key discriminators.",
                "- Prefer mechanisms, distinctions, failure modes, and misconception anchors over broad topic labels.",
                "- Keep unit titles as internal anchors. Runtime question generation will turn these anchors into learner-facing prompts based on session state.",
                "- Keep evidenceSnippet short and directly traceable to the submitted material; long documents should still produce compact, high-signal anchors.",
                "- Assign importance as core/secondary/optional.",
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

    def generate_probe_question(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        phase: str = "diagnostic",
        revisit: bool = False,
    ) -> Dict[str, Any]:
        prompt = "\n".join(
            [
                "Generate exactly one learner-facing question for the current tutor turn. Return json only.",
                "Write the learner-facing question in Chinese.",
                "The question must be created from the current session state, not copied from decomposition-time placeholders.",
                "Use the concept anchors as constraints, but adapt to memory, recent turns, previous runtime map, phase, and revisit state.",
                "Ask one concrete, answerable question. Avoid broad prompts like “what is the core mechanism and why is it important”.",
                "If this is a revisit, target the unresolved misconception or missing discriminator instead of repeating the first diagnostic.",
                "",
                f"PHASE: {phase}",
                f"REVISIT: {str(revisit).lower()}",
                "",
                "CONCEPT_ANCHOR_JSON:",
                json.dumps(
                    {
                        "id": concept.get("id", ""),
                        "title": concept.get("title", ""),
                        "summary": concept.get("summary", ""),
                        "evidenceSnippet": concept.get("evidenceSnippet", ""),
                        "misconceptionAnchors": concept.get("misconceptionAnchors", []) or ([concept.get("misconception")] if concept.get("misconception") else []),
                        "discriminators": concept.get("discriminators", []),
                        "importance": concept.get("importance", ""),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                "",
                "CONTEXT_PACKET_JSON:",
                json.dumps(context_packet, ensure_ascii=False, indent=2),
            ]
        )
        result = self._call_json_traced(
            call_type="generate_question",
            prompt=prompt,
            schema=QUESTION_GENERATION_SCHEMA,
            validator=validate_question_generation_payload,
        )
        return {
            "question": ensure_string(result.parsed.get("question")),
            "intent": ensure_string(result.parsed.get("intent")),
        }

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
                "key_claim": "",
                "confirmed_understanding": ensure_string((context_packet.get("anchor_state") or {}).get("confirmed_understanding")),
                "judgment_reason": "你这轮选择查看解析，不按答题证据打分，所以当前不形成新的掌握判定。",
                "has_misconception": False,
                "misconception_detail": "",
            }
            if forced_action == "teach"
            else self.diagnose_turn(concept=concept, context_packet=context_packet, answer=answer)
        )
        def call_with_prompt(*, retry_missing_followup: bool = False):
            return self._call_json_traced(
                call_type="answer_turn",
                prompt=build_turn_envelope_prompt(
                    context_packet=context_packet,
                    answer=answer,
                    diagnosis=diagnosis,
                    forced_action=forced_action,
                    concept=concept,
                    retry_missing_followup=retry_missing_followup,
                ),
                schema=TURN_ENVELOPE_SCHEMA,
                validator=lambda payload: validate_turn_envelope_payload(
                    normalize_turn_envelope_payload(payload, concept),
                    concept.get("id", "")
                ),
            )

        try:
            result = call_with_prompt()
        except Exception as exc:
            if "follow_up_question" not in str(exc):
                raise
            result = call_with_prompt(retry_missing_followup=True)
        envelope = normalize_turn_envelope_payload(result.parsed, concept)
        envelope["turn_diagnosis"] = diagnosis
        return envelope

    def generate_reply_stream(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> str:
        prompt = build_reply_stream_prompt(context_packet=context_packet, answer=answer)
        return call_provider_text(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            prompt=prompt,
            base_url=self.base_url,
        )

    def generate_reply_stream_events(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> Iterator[str]:
        prompt = build_reply_stream_prompt(context_packet=context_packet, answer=answer)
        yield from stream_provider_text_chunks(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            prompt=prompt,
            base_url=self.base_url,
        )

    def generate_teach_reply_stream(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> str:
        prompt = build_teach_reply_prompt(context_packet=context_packet, answer=answer)
        return call_provider_text(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            prompt=prompt,
            base_url=self.base_url,
        )

    def generate_teach_reply_stream_events(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> Iterator[str]:
        prompt = build_teach_reply_prompt(context_packet=context_packet, answer=answer)
        yield from stream_provider_text_chunks(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            prompt=prompt,
            base_url=self.base_url,
        )

    def answer_knowledge_question(self, *, question: str, context: str, goal: str = "interview", task_type: str = "freeform") -> str:
        prompt = build_knowledge_answer_prompt(question=question, context=context, goal=goal, task_type=task_type)
        return call_provider_text(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            prompt=prompt,
            base_url=self.base_url,
        )

    def explain_concept(self, *, session: Dict[str, Any], concept: Dict[str, Any], context_packet: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        envelope = self.generate_turn_envelope(
            concept=concept,
            context_packet=context_packet or {},
            answer="",
            forced_action="teach",
        )
        reply = envelope.get("reply") or {}
        teaching_paragraphs = reply.get("teaching_paragraphs") or []
        check_question = reply.get("next_prompt") or concept.get("checkQuestion")
        if not check_question:
            raise ValueError("AI tutor explanation must include a generated check question.")
        payload = {
            "visibleReply": reply.get("visible_reply") or concept.get("summary", ""),
            "teachingParagraphs": teaching_paragraphs[:4],
            "checkQuestion": check_question,
            "takeaway": reply.get("takeaway") or "",
        }
        validate_explain_concept_payload(payload)
        return normalize_explain_concept_payload(payload, concept)


class HeuristicTutorIntelligence:
    def __init__(self):
        self.provider = "HEURISTIC"
        self.model = "heuristic-test-double"
        self.kind = "heuristic-test-double"
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
            reason="test_double_without_provider_credentials",
        )

    def decompose_source(self, source: Dict[str, Any]) -> Dict[str, Any]:
        title = ensure_string(source.get("title"), "测试材料")
        content = ensure_string(source.get("content"))
        sentences = [part.strip() for part in content.replace("\n", "。").split("。") if part.strip()]
        seeds = sentences[:3] or [title, content[:80] or title, "请围绕材料主线复述一个具体机制"]
        units = []
        for index, seed in enumerate(seeds[:3]):
            unit_title = ensure_string(seed[:32], f"{title} 训练点 {index + 1}")
            units.append(
                {
                    "id": f"test-doc-unit-{index + 1}",
                    "title": unit_title,
                    "summary": ensure_string(seed, title),
                    "evidenceSnippet": ensure_string(seed, title),
                    "misconceptionAnchors": ["容易脱离当前材料泛泛回答。"],
                    "discriminators": [f"能结合材料解释“{unit_title}”，而不是泛泛复述标题。"],
                    "misconception": "容易脱离当前材料泛泛回答。",
                    "importance": "core" if index == 0 else "secondary",
                }
            )
        return {
            "concepts": units,
            "summary": {
                "sourceTitle": title,
                "keyThemes": [unit["title"] for unit in units[:3]],
                "framing": f"测试环境从《{title}》里生成最小训练单元。",
            },
        }

    def generate_probe_question(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        phase: str = "diagnostic",
        revisit: bool = False,
    ) -> Dict[str, Any]:
        title = ensure_string(concept.get("title"), "这个点")
        if revisit:
            question = f"回到刚才没讲稳的地方：围绕“{title}”，你现在会怎么补上最关键的一步？"
        elif phase == "teach-back":
            question = f"用你自己的话复述一下：“{title}”这条链路的核心结论是什么？"
        else:
            question = f"根据当前材料，围绕“{title}”你会先怎么解释？"
        return {
            "question": question,
            "intent": "heuristic_test_double_dynamic_question",
        }

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
            score = 40
            follow_up_question = ""
            reason = "用户显式要求讲解或当前更适合先补关键机制。"
        elif any(token in lowered for token in ("下一题", "下一个", "跳过")):
            ui_mode = "advance"
            state = "partial"
            score = 72
            follow_up_question = ""
            reason = "用户要求继续推进当前节奏。"
        elif signal == "positive" and len(text) >= 40:
            ui_mode = "verify"
            state = "solid"
            score = 92
            follow_up_question = f"如果面试官继续追问边界，你会怎么解释“{title}”最容易答偏的地方？"
            reason = "用户已经碰到主链，适合再用一个问题确认边界。"
        elif signal == "positive":
            ui_mode = "verify"
            state = "partial"
            score = 72
            follow_up_question = f"结合你刚才的阅读和已有回答，再讲一次：“{title}”这条链路里最容易漏掉的关键一步是什么？"
            reason = "方向基本对，但还需要继续确认是否真正讲稳。"
        else:
            ui_mode = "probe"
            state = "weak"
            score = 40
            follow_up_question = (
                concept.get("retryQuestion")
                or concept.get("diagnosticQuestion")
                or f"围绕“{title}”回答一个具体点：材料里它的关键链路是怎么走的？"
            )
            reason = "当前回答还没有形成稳定机制链路。"

        if ui_mode in {"probe", "verify"} and not follow_up_question:
            follow_up_question = f"你先用自己的话再讲一下：{title} 的关键机制是什么？"

        return normalize_turn_envelope_payload(
            {
                "runtime_map": {
                    "anchor_id": concept.get("id", ""),
                    "turn_signal": signal,
                    "anchor_assessment": {
                        "state": state,
                        "score": score,
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
                    "reason": "heuristic_test_double_turn",
                    "anchor_patch": {
                        "state": state,
                        "score": score,
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

    def generate_teach_reply_stream(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> str:
        return self.generate_reply_stream(concept=concept, context_packet=context_packet, answer=answer)

    def generate_teach_reply_stream_events(
        self,
        *,
        concept: Dict[str, Any],
        context_packet: Dict[str, Any],
        answer: str,
    ) -> Iterator[str]:
        text = self.generate_teach_reply_stream(concept=concept, context_packet=context_packet, answer=answer)
        if text:
            yield text

    def answer_knowledge_question(self, *, question: str, context: str, goal: str = "interview", task_type: str = "freeform") -> str:
        return answer_knowledge_question_heuristic(question=question, context=context, goal=goal, task_type=task_type)

    def explain_concept(self, *, session: Dict[str, Any], concept: Dict[str, Any], context_packet: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {
            "visibleReply": concept.get("summary", ""),
            "teachingParagraphs": [concept.get("summary", "")],
            "checkQuestion": concept.get("checkQuestion") or concept.get("retryQuestion") or "",
            "takeaway": concept.get("summary", ""),
        }
        validate_explain_concept_payload(payload)
        return normalize_explain_concept_payload(payload, concept)


def _allow_heuristic_test_double() -> bool:
    explicit_test_double = str(os.environ.get("LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE", "")).lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    app_env = str(os.environ.get("APP_ENV", "")).lower()
    return (
        str(os.environ.get("NODE_ENV", "")).lower() == "test"
        or bool(os.environ.get("PYTEST_CURRENT_TEST"))
        or (app_env == "test" and explicit_test_double)
    )


def create_tutor_intelligence() -> ProviderTutorIntelligence | HeuristicTutorIntelligence | None:
    enabled = str(os.environ.get("LLAI_LLM_ENABLED", "true")).lower()
    if enabled in {"0", "false", "no", "off"}:
        return HeuristicTutorIntelligence() if _allow_heuristic_test_double() else None
    provider = str(os.environ.get("LLAI_LLM_PROVIDER", "OPENAI")).upper()
    if provider == "DEEPSEEK":
        intelligence = ProviderTutorIntelligence(
            provider="DEEPSEEK",
            model=os.environ.get("LLAI_DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL),
            api_key=os.environ.get("LLAI_DEEPSEEK_API_KEY", ""),
            base_url=os.environ.get("LLAI_DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL),
        )
        return intelligence if intelligence.configured else (HeuristicTutorIntelligence() if _allow_heuristic_test_double() else None)
    intelligence = ProviderTutorIntelligence(
        provider="OPENAI",
        model=os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL),
        api_key=os.environ.get("OPENAI_API_KEY", ""),
    )
    return intelligence if intelligence.configured else (HeuristicTutorIntelligence() if _allow_heuristic_test_double() else None)


def describe_tutor_intelligence() -> Dict[str, Any]:
    enabled = str(os.environ.get("LLAI_LLM_ENABLED", "true")).lower() not in {"0", "false", "no", "off"}
    intelligence = create_tutor_intelligence() if enabled else None
    if intelligence is None:
        return {
            "enabled": False,
            "provider": str(os.environ.get("LLAI_LLM_PROVIDER", "OPENAI")).upper(),
            "configured": False,
            "model": "",
            "reason": "AI tutor provider is not configured; heuristic fallback is disabled.",
        }
    info = intelligence.describe()
    return {
        "enabled": info.enabled,
        "provider": info.provider,
        "configured": info.configured,
        "model": info.model,
        "reason": info.reason,
    }
