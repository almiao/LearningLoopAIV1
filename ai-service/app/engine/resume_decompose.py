from __future__ import annotations

import os
import re
from typing import Any, Callable, Dict, List

from app.domain.interview.parsers import parse_provider_json_text
from app.engine.tutor_intelligence import stream_provider_text_chunks

MAX_TOPICS = 18
VALID_IMPORTANCE = {"core", "secondary"}


def _allow_mock() -> bool:
    return (
        os.environ.get("APP_ENV") == "test"
        or os.environ.get("LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE") == "1"
    )


def build_resume_decompose_prompt(*, resume_text: str, role: str = "") -> str:
    role_block = f"目标岗位：{role.strip()}\n" if role.strip() else ""
    return f"""你是一名面试备战教练。把下面这份简历拆成「候选人声称会、面试官值得追问」的扁平练习清单。
{role_block}
简历原文：
{resume_text.strip()}

拆解规则：
- 只抽候选人自己声称做过、会用、负责过的能力点。
- 每条必须能被面试官追问，比如「Redis 缓存一致性项目里的兜底策略」，不要写「项目经验」这种空泛词。
- 5 到 {MAX_TOPICS} 条。importance 只有 core/secondary 两档；与目标岗位强相关或简历反复强调的标 core。
- 不要发明简历里没有的经历。

只输出 JSON，不要任何解释，格式：
{{
  "topics": [{{"topic": "简历声称点（一句话，可被追问）", "importance": "core" 或 "secondary"}}]
}}"""


def normalize_resume_topics(raw: Any) -> List[Dict[str, Any]]:
    data = raw if isinstance(raw, dict) else {}
    raw_topics = data.get("topics")
    if not isinstance(raw_topics, list):
        raw_topics = []

    topics: List[Dict[str, Any]] = []
    seen = set()
    for entry in raw_topics:
        if isinstance(entry, dict):
            topic = str(entry.get("topic", "")).strip()
            importance = str(entry.get("importance", "")).strip().lower()
        else:
            topic = str(entry).strip()
            importance = ""
        if not topic or topic in seen:
            continue
        seen.add(topic)
        topics.append({
            "topic": topic,
            "importance": importance if importance in VALID_IMPORTANCE else "core",
            "source": "resume-claim",
        })
        if len(topics) >= MAX_TOPICS:
            break
    return topics


def _heuristic_topics(*, resume_text: str) -> List[Dict[str, Any]]:
    fragments = [
        re.sub(r"^[\s\-*•·\d.、()（）]+", "", item).strip()
        for item in re.split(r"[\n;；。]+", resume_text or "")
    ]
    candidates = [
        item
        for item in fragments
        if len(item) >= 6 and re.search(r"(负责|主导|参与|实现|优化|搭建|设计|落地|使用|熟悉|掌握)", item)
    ]
    if not candidates:
        candidates = [item for item in fragments if len(item) >= 6]
    return normalize_resume_topics({
        "topics": [
            {"topic": item, "importance": "core" if index < 8 else "secondary"}
            for index, item in enumerate(candidates[:MAX_TOPICS])
        ],
    })


def _provider_complete_json(prompt: str) -> Dict[str, Any]:
    provider = str(os.environ.get("LLAI_LLM_PROVIDER") or "OPENAI").upper()
    if provider == "DEEPSEEK":
        api_key = os.environ.get("LLAI_DEEPSEEK_API_KEY", "")
        model = os.environ.get("LLAI_DEEPSEEK_MODEL", "deepseek-chat")
        base_url = os.environ.get("LLAI_DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    else:
        provider = "OPENAI"
        api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("LLAI_OPENAI_API_KEY", "")
        model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
        base_url = os.environ.get("OPENAI_BASE_URL", "")
    if not api_key:
        raise RuntimeError("No LLM API key configured for resume decomposition.")
    text = "".join(stream_provider_text_chunks(
        provider=provider,
        api_key=api_key,
        model=model,
        prompt=prompt,
        base_url=base_url,
    ))
    return parse_provider_json_text(text)


def decompose_resume(
    *,
    resume_text: str,
    role: str = "",
    complete_json: Callable[[str], Any] | None = None,
) -> Dict[str, Any]:
    clean_resume = str(resume_text or "").strip()
    if not clean_resume:
        raise ValueError("resume_text is required.")

    if complete_json is None and _allow_mock():
        return {"topics": _heuristic_topics(resume_text=clean_resume)}

    complete = complete_json or _provider_complete_json
    raw = complete(build_resume_decompose_prompt(resume_text=clean_resume, role=role))
    topics = normalize_resume_topics(raw)
    if not topics:
        topics = _heuristic_topics(resume_text=clean_resume)
    return {"topics": topics}
