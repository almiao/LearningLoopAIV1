from __future__ import annotations

import os
from typing import Any, Callable, Dict, List

from app.domain.interview.parsers import parse_provider_json_text
from app.engine.tutor_intelligence import stream_provider_text_chunks

# 一次性锚点判分 (one-shot anchor judging) — PRODUCT.md §0.1.
#
# 输入一道题 + 用户回答 (+ 可选原文片段) → LLM 输出「过线必须命中的点」并标命中/漏。
# 纪律（落在代码里）：
#   - 锚点针对**当前这道题**当场生成，判完即弃、不入库、不复用、无身份（§0.1）。
#     它与 context_packet 里的 `anchorIdentity`（持久 concept 本体）同名但相反，绝不复用那套。
#   - 输出「命中/漏掉哪几个」而非裸分数。漏掉的就是复习项的种子（§4）。
#   - 默认防判太松：宁可判 fail 也不放水；低置信 → 标 lowConfidence、不算过线（§0.1）。
#   - 复用现有 LLM 管线（stream_provider_text_chunks + parse_provider_json_text），不是新引擎。

DEFAULT_CONFIDENCE_FLOOR = 0.5


def _allow_mock() -> bool:
    return (
        os.environ.get("APP_ENV") == "test"
        or os.environ.get("LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE") == "1"
    )


def build_anchor_judge_prompt(*, question: str, answer: str, source_excerpt: str = "") -> str:
    source_block = f"\n原文片段（仅供判断，不要照抄）：\n{source_excerpt.strip()}\n" if source_excerpt.strip() else ""
    return f"""你是一名严格的判分官。针对「当前这一道题」，先列出过线必须命中的几个要点（锚点，3-5 个，只针对这道题，不要泛泛而谈），再逐个判断学习者的回答是否命中。
{source_block}
题目：
{question.strip()}

学习者的回答：
{answer.strip()}

判分规则：
- 只针对这道题生成锚点，判完即弃，不要给整个概念铺锚点。
- 宁可判未过也不放水：要点没讲清/只会背定义/答非所问，一律算 hit=false。
- 如果你对判断没有把握，把 confidence 调低（< 0.5）。

只输出 JSON，不要任何解释，格式：
{{
  "anchors": [{{"point": "该命中的要点（一句话）", "hit": true 或 false}}],
  "verdict": "pass" 或 "fail",
  "confidence": 0 到 1 之间的小数
}}"""


def normalize_anchor_judgment(raw: Any, *, confidence_floor: float = DEFAULT_CONFIDENCE_FLOOR) -> Dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}

    raw_anchors = data.get("anchors")
    if not isinstance(raw_anchors, list):
        raw_anchors = []

    anchors: List[Dict[str, Any]] = []
    for entry in raw_anchors:
        if isinstance(entry, dict):
            point = str(entry.get("point", "")).strip()
            hit = bool(entry.get("hit"))
        else:
            point = str(entry).strip()
            hit = False
        if point:
            anchors.append({"point": point, "hit": hit})

    hits = [a["point"] for a in anchors if a["hit"]]
    misses = [a["point"] for a in anchors if not a["hit"]]

    try:
        confidence = float(data.get("confidence", 0) or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    low_confidence = confidence < confidence_floor

    # §0.1 防判太松：只有模型判 pass、且没有漏点、且置信足够，才算过线；其余一律 fail。
    raw_pass = str(data.get("verdict", "")).strip().lower() == "pass"
    verdict = "pass" if (raw_pass and not misses and not low_confidence) else "fail"

    return {
        "verdict": verdict,
        "hits": hits,
        "misses": misses,
        "anchors": anchors,
        "confidence": confidence,
        "lowConfidence": low_confidence,
    }


def _heuristic_judgment(*, question: str, answer: str) -> Dict[str, Any]:
    """离线测试替身：按回答长度给确定性判定，不调 LLM（mirror loopassist 的 mock 思路）。"""
    text = (answer or "").strip()
    if len(text) < 12:
        raw = {
            "verdict": "fail",
            "confidence": 0.8,
            "anchors": [
                {"point": "先说清核心机制", "hit": False},
                {"point": "再讲取舍或边界", "hit": False},
            ],
        }
    elif len(text) < 40:
        raw = {
            "verdict": "fail",
            "confidence": 0.7,
            "anchors": [
                {"point": "核心机制", "hit": True},
                {"point": "失败或边界处理", "hit": False},
            ],
        }
    else:
        raw = {
            "verdict": "pass",
            "confidence": 0.8,
            "anchors": [
                {"point": "核心机制", "hit": True},
                {"point": "关键取舍", "hit": True},
            ],
        }
    return normalize_anchor_judgment(raw)


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
        raise RuntimeError("No LLM API key configured for anchor judging.")
    text = "".join(stream_provider_text_chunks(
        provider=provider,
        api_key=api_key,
        model=model,
        prompt=prompt,
        base_url=base_url,
    ))
    return parse_provider_json_text(text)


def judge_anchors(
    *,
    question: str,
    answer: str,
    source_excerpt: str = "",
    complete_json: Callable[[str], Any] | None = None,
) -> Dict[str, Any]:
    """对一道题 + 一个回答做一次性锚点判分。

    `complete_json` 可注入（测试/穿透适配器用）；不注入时：测试环境走启发式替身，
    否则走真实 LLM 管线。返回 {verdict, hits, misses, anchors, confidence, lowConfidence}。
    """
    if complete_json is None and _allow_mock():
        return _heuristic_judgment(question=question, answer=answer)
    complete = complete_json or _provider_complete_json
    raw = complete(build_anchor_judge_prompt(question=question, answer=answer, source_excerpt=source_excerpt))
    return normalize_anchor_judgment(raw)
