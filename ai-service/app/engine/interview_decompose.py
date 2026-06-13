from __future__ import annotations

import os
import re
from typing import Any, Callable, Dict, List

from app.domain.interview.parsers import parse_provider_json_text
from app.engine.jd_decompose import MAX_TOPICS, normalize_jd_topics
from app.engine.tutor_intelligence import stream_provider_text_chunks

# 面经拆话题 — 「面经当主轴」的拆解。
#
# 与 JD 拆解（jd_decompose）对称：输入一篇真实面经（牛客等抓取的 content_text，
# 本就是一串被问到的题），抽成扁平可操练话题清单 + theme。复用 normalize_jd_topics
# 做归一/去重/封顶，产出与 JD 拆解同形 {topics:[{topic, importance, theme}]}。


def _allow_mock() -> bool:
    return (
        os.environ.get("APP_ENV") == "test"
        or os.environ.get("LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE") == "1"
    )


def build_interview_decompose_prompt(*, report_text: str, role: str = "") -> str:
    role_block = f"目标岗位：{role.strip()}\n" if role.strip() else ""
    return f"""你是一名面试备战教练。下面是一篇真实面经（候选人记录的被问到的问题）。
把它整理成一份「扁平的可操练话题清单」，供另一名候选人逐个练习。
{role_block}
面经原文：
{report_text.strip()}

整理规则：
- 扁平一列，每条是一个可被当面追问的具体话题（把面经里口语化的提问改写成清晰话题）。
- 去掉与考察无关的内容（寒暄、流程吐槽、自我介绍环节）。
- 8 到 {MAX_TOPICS} 条。importance 两档：core（明显的硬核技术追问）和 secondary（边角/加分）。
- 给每条打一个 theme（所属主题），全表只用 4 到 6 个主题，名称复用、不要发明同义词；theme 是 2 到 6 个字的短名词。

只输出 JSON，不要任何解释，格式：
{{
  "topics": [{{"topic": "话题（一句话，可被追问）", "importance": "core" 或 "secondary", "theme": "所属主题（短名词）"}}]
}}"""


def _heuristic_topics(*, report_text: str) -> List[Dict[str, Any]]:
    """离线测试替身：按行/序号切面经，确定性产出话题，不调 LLM。"""
    lines = [
        re.sub(r"^[\s\-*•·]?\s*[0-9０-９]+[.、）)]\s*", "", line).strip()
        for line in re.split(r"[\n]+", report_text or "")
    ]
    candidates = [line for line in lines if len(line) >= 4]
    topics = [
        {"topic": line, "importance": "core" if index < 5 else "secondary", "theme": ""}
        for index, line in enumerate(candidates[:MAX_TOPICS])
    ]
    return normalize_jd_topics({"topics": topics})


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
        raise RuntimeError("No LLM API key configured for interview decomposition.")
    text = "".join(stream_provider_text_chunks(
        provider=provider,
        api_key=api_key,
        model=model,
        prompt=prompt,
        base_url=base_url,
    ))
    return parse_provider_json_text(text)


def decompose_interview(
    *,
    report_text: str,
    role: str = "",
    complete_json: Callable[[str], Any] | None = None,
) -> Dict[str, Any]:
    """把一篇面经拆成扁平话题清单（与 JD 拆解同形）。"""
    clean_report = str(report_text or "").strip()
    if not clean_report:
        raise ValueError("report_text is required.")

    if complete_json is None and _allow_mock():
        return {"topics": _heuristic_topics(report_text=clean_report)}

    complete = complete_json or _provider_complete_json
    raw = complete(build_interview_decompose_prompt(report_text=clean_report, role=role))
    topics = normalize_jd_topics(raw)
    if not topics:
        topics = _heuristic_topics(report_text=clean_report)
    return {"topics": topics}
