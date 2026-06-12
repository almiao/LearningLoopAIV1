from __future__ import annotations

import os
import re
from typing import Any, Callable, Dict, List

from app.domain.interview.parsers import parse_provider_json_text
from app.engine.tutor_intelligence import stream_provider_text_chunks

# JD 拆扁平话题 — PRODUCT.md「面试战役 ②定范围」。
#
# 输入 JD 文本 (+ 可选简历/岗位名) → 扁平起步话题清单（不是概念图，守 §1.6）。
# 纪律（落在代码里）：
#   - 输出是 per-Goal、随战役生灭的覆盖度清单种子，用完即弃，不进知识账本。
#   - 扁平一列 {topic, importance}，无层级、无边。importance 只有 core/secondary 两档。
#   - 与简历交叉：简历声称会的优先验（core）、JD 要求但简历没提的是缺口（也是 core）。
#   - 复用现有 LLM 管线（stream_provider_text_chunks + parse_provider_json_text），不是新引擎。

MAX_TOPICS = 24

VALID_IMPORTANCE = {"core", "secondary"}


def _allow_mock() -> bool:
    return (
        os.environ.get("APP_ENV") == "test"
        or os.environ.get("LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE") == "1"
    )


def build_jd_decompose_prompt(*, jd_text: str, resume_text: str = "", role: str = "") -> str:
    role_block = f"目标岗位：{role.strip()}\n" if role.strip() else ""
    resume_block = (
        f"\n候选人简历（用于交叉：简历声称会的要优先验证，JD 要求但简历没提的是缺口，两者都标 core）：\n{resume_text.strip()}\n"
        if resume_text.strip()
        else ""
    )
    return f"""你是一名面试备战教练。把下面这份 JD 拆成一份「扁平的可操练话题清单」，供候选人逐个练习。
{role_block}{resume_block}
JD 原文：
{jd_text.strip()}

拆解规则：
- 扁平一列，不要层级、不要分组、不要概念图。
- 每条是一个可以被当面追问的具体话题（如「线程池参数与拒绝策略的取舍」），不是空泛的方向（如「Java 基础」）。
- 8 到 {MAX_TOPICS} 条。importance 只有两档：core（JD 核心要求 / 简历声称会的 / 简历缺口）和 secondary（加分项）。
- 用 JD 和简历的语言，不要自己发明 JD 没要求的话题。

只输出 JSON，不要任何解释，格式：
{{
  "topics": [{{"topic": "话题（一句话，可被追问）", "importance": "core" 或 "secondary"}}]
}}"""


def normalize_jd_topics(raw: Any) -> List[Dict[str, Any]]:
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
        })
        if len(topics) >= MAX_TOPICS:
            break
    return topics


def _heuristic_topics(*, jd_text: str) -> List[Dict[str, Any]]:
    """离线测试替身：按行/标点切 JD，确定性产出话题，不调 LLM（mirror anchor_judge 的 mock 思路）。"""
    lines = [
        re.sub(r"^[\s\-*•·\d.、()（）]+", "", line).strip()
        for line in re.split(r"[\n;；]+", jd_text or "")
    ]
    candidates = [line for line in lines if len(line) >= 4]
    topics = [
        {"topic": line, "importance": "core" if index < 5 else "secondary"}
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
        raise RuntimeError("No LLM API key configured for JD decomposition.")
    text = "".join(stream_provider_text_chunks(
        provider=provider,
        api_key=api_key,
        model=model,
        prompt=prompt,
        base_url=base_url,
    ))
    return parse_provider_json_text(text)


def decompose_jd(
    *,
    jd_text: str,
    resume_text: str = "",
    role: str = "",
    complete_json: Callable[[str], Any] | None = None,
) -> Dict[str, Any]:
    """把 JD 拆成扁平话题清单（覆盖度清单种子）。

    `complete_json` 可注入（测试用）；不注入时：测试环境走启发式替身，否则走真实 LLM 管线。
    返回 {"topics": [{"topic", "importance"}]}。
    """
    clean_jd = str(jd_text or "").strip()
    if not clean_jd:
        raise ValueError("jd_text is required.")

    if complete_json is None and _allow_mock():
        return {"topics": _heuristic_topics(jd_text=clean_jd)}

    complete = complete_json or _provider_complete_json
    raw = complete(build_jd_decompose_prompt(jd_text=clean_jd, resume_text=resume_text, role=role))
    topics = normalize_jd_topics(raw)
    if not topics:
        topics = _heuristic_topics(jd_text=clean_jd)
    return {"topics": topics}
