from __future__ import annotations

import json
import os
import queue
import re
import threading
import time
from typing import Any, Callable, Dict, Iterator, List, Optional
from uuid import uuid4

from app.core.tracing import set_session_context
from app.domain.interview.parsers import parse_provider_json_text
from app.engine.tutor_intelligence import (
    DEFAULT_DEEPSEEK_BASE_URL,
    DEFAULT_DEEPSEEK_MODEL,
    DEFAULT_OPENAI_MODEL,
    stream_provider_text_chunks,
)
from app.observability.logger import logger


LOOPASSIST_SESSIONS: Dict[str, Dict[str, Any]] = {}
LOOPASSIST_LOCKS: Dict[str, threading.Lock] = {}


def _normalize(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _strip_code_fence(text: str) -> str:
    stripped = str(text or "").strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z0-9_-]*\n?", "", stripped)
        stripped = re.sub(r"\n?```$", "", stripped)
    return stripped.strip()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _style_label(style: str) -> str:
    return {
        "probing": "追问型",
        "pressure": "压力型",
        "coaching": "引导型",
        "realistic": "真实还原",
    }.get(_normalize(style), _normalize(style) or "真实还原")


def _format_scope(scope: Dict[str, Any]) -> str:
    topics = scope.get("topics") or []
    return json.dumps({
        "role": scope.get("role") or scope.get("rolePath") or "软件开发",
        "round": scope.get("round") or scope.get("stage") or "一面",
        "topics": topics if isinstance(topics, list) else [topics],
        "companyStyle": scope.get("companyStyle") or scope.get("company") or "通用",
        "interviewStyle": _style_label(scope.get("interviewStyle") or "realistic"),
        "questionBudget": scope.get("questionBudget") or 8,
    }, ensure_ascii=False)


def _normalize_list(values: Any) -> List[str]:
    if values is None:
        return []
    source = values if isinstance(values, list) else [values]
    normalized: List[str] = []
    seen = set()
    for value in source:
        item = _normalize(value)
        if item and item not in seen:
            normalized.append(item)
            seen.add(item)
    return normalized


def _normalize_int(value: Any, default: int = 0, *, minimum: int = 0, maximum: int = 100) -> int:
    try:
        numeric = int(round(float(value)))
    except (TypeError, ValueError):
        numeric = default
    return max(minimum, min(maximum, numeric))


def _status_from_score(score: int) -> str:
    if score >= 75:
        return "good"
    if score >= 45:
        return "warn"
    return "miss"


def _difficulty_label(question_text: str, topic: str) -> str:
    text = _normalize(question_text)
    topic_text = _normalize(topic)
    if any(keyword in text for keyword in ["原理", "底层", "机制", "源码", "索引", "事务", "并发"]):
        return "中高"
    if any(keyword in topic_text for keyword in ["系统设计", "分布式", "数据库", "并发"]):
        return "中高"
    if any(keyword in text for keyword in ["项目", "介绍", "自我介绍", "负责"]):
        return "中等"
    return "高频"


def _scope_text(scope: Dict[str, Any], keys: List[str]) -> str:
    chunks: List[str] = []
    for key in keys:
        value = scope.get(key)
        if isinstance(value, list):
            chunks.extend(_normalize(item) for item in value)
        elif isinstance(value, dict):
            chunks.append(json.dumps(value, ensure_ascii=False))
        else:
            chunks.append(_normalize(value))
    return _normalize(" ".join(chunk for chunk in chunks if chunk))


def _format_candidate_context(scope: Dict[str, Any]) -> str:
    resume_text = _scope_text(scope, [
        "resume",
        "resumeText",
        "resumeSummary",
        "candidateProfile",
        "candidateProfileText",
        "userResume",
    ])
    jd_text = _scope_text(scope, [
        "jd",
        "jobDescription",
        "jobDescriptionText",
        "jobRequirements",
        "jobPosting",
    ])
    lines = [
        f"简历摘要：{resume_text or '未提供。'}",
        f"岗位 JD：{jd_text or '未提供。'}",
    ]
    return "\n".join(lines)


def _format_source_context(seed: Dict[str, Any], index: int) -> str:
    report_text = _normalize(seed.get("sourceReportText"))[:900]
    return "\n".join([
        f"[历史面经样本 {index}] contextId={seed.get('seedId', '')}",
        f"来源：{seed.get('sourceReportTitle') or seed.get('company') or '真实面经'} / {seed.get('rolePath', '')} / {seed.get('stage', '')}",
        f"面经问题线索（只代表历史候选人的经历，不是要照搬的最终问法）：{seed.get('baseQuestion', '')}",
        f"主题线索：{'、'.join(seed.get('topics') or [])}",
        f"追问线索：{'；'.join(seed.get('followupAngles') or [])}",
        f"强回答信号线索：{'；'.join(seed.get('strongAnswerSignals') or [])}",
        f"原始面经片段：{report_text or '未提供原文片段。'}",
    ])


def _format_transcript(transcript: List[Dict[str, Any]]) -> str:
    if not transcript:
        return "无。"
    lines = []
    for turn in transcript:
        role = "面试官" if turn.get("role") == "interviewer" else "候选人"
        lines.append(f"{role}：{_normalize(turn.get('text'))}")
    return "\n".join(lines)


def _current_plan_step(interview_plan: Dict[str, Any], transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    stages = interview_plan.get("stages") or []
    if not stages:
        return {}
    interviewer_count = sum(1 for turn in transcript if turn.get("role") == "interviewer")
    candidate_turns = [turn for turn in transcript if turn.get("role") == "candidate"]
    if candidate_turns and len(_normalize(candidate_turns[-1].get("text"))) < 24:
        interviewer_count = max(0, interviewer_count - 1)
    index = min(max(interviewer_count, 0), len(stages) - 1)
    return stages[index]


def _format_interview_plan(interview_plan: Dict[str, Any], transcript: List[Dict[str, Any]]) -> str:
    if not interview_plan:
        return "未生成内部计划。"
    current_step = _current_plan_step(interview_plan, transcript)
    lines = [
        f"计划总目标：{interview_plan.get('goal', '')}",
        f"当前应执行步骤：第{current_step.get('step', 1)}问，主题={current_step.get('theme', '')}，目标={current_step.get('objective', '')}",
    ]
    for stage in (interview_plan.get("stages") or [])[:12]:
        contexts = stage.get("sourceContexts") or []
        context_line = " / ".join(_normalize(context.get("label") or context.get("type")) for context in contexts if isinstance(context, dict))
        lines.append(
            "；".join([
                f"第{stage.get('step')}问",
                f"主题={stage.get('theme', '')}",
                f"最终问题={stage.get('baseQuestion', '')}",
                f"目标={stage.get('objective', '')}",
                f"参考上下文={context_line}",
                f"允许追问={'; '.join(stage.get('allowedFollowups') or [])}",
            ])
        )
    guardrails = interview_plan.get("guardrails") or []
    if guardrails:
        lines.append("计划约束：" + " / ".join(_normalize_list(guardrails)))
    return "\n".join(lines)


def build_interview_plan_prompt(*, scope: Dict[str, Any], seeds: List[Dict[str, Any]]) -> str:
    source_context_block = "\n\n".join(_format_source_context(seed, index + 1) for index, seed in enumerate(seeds[:12]))
    return "\n".join([
        "你是 LoopAssist 的模拟面试规划官。",
        "你要先生成一份可展示给候选人的面试大纲，同时这份大纲会约束后续面试官逐轮提问。",
        "大纲必须综合三类 sample source context：候选人材料、目标岗位 JD、历史真实面经样本。",
        "历史面经样本用于理解该岗位真实考法和追问风格，不是候选人的真实经历，也不是要照搬的最终题目。",
        "你要先读懂候选人实际材料，再参考历史面经生成适合当前候选人的最终问题；如果简历或 JD 未提供，不要编造。",
        "不要用固定模板机械列题；要解释为什么这么安排，并让用户能看懂每一题具体参考了哪些上下文。",
        "输出必须是合法 JSON，不要输出 Markdown、解释性前后缀或内部推理。",
        "JSON 字段必须包含：title, rationale, sourceExplanation, stages, guardrails。",
        "stages 是数组，每项包含：step, theme, objective, source, seedId, baseQuestion, allowedFollowups, strongSignals, sourceContexts。",
        "baseQuestion 必须是你生成的最终面试问题，不是历史面经原句。",
        "sourceContexts 是数组，用来给用户展示本题参考材料；每项包含 type、label、excerpt、reason。type 只能是 user_resume、user_jd、historical_interview、selected_scope。",
        "stage 数量应接近 questionBudget；如果历史面经不足，可以复用主题但要说明验证目标不同。",
        "",
        f"选定 scope：{_format_scope(scope)}",
        "",
        "用户提供的 sample source context：",
        _format_candidate_context(scope),
        "",
        "历史面经 sample source context：",
        source_context_block or "无历史面经样本，按 scope 自然规划。",
    ])


def _find_stage_seed(stage: Dict[str, Any], seeds: List[Dict[str, Any]]) -> Dict[str, Any]:
    seed_id = _normalize(stage.get("seedId"))
    base_question = _normalize(stage.get("baseQuestion"))
    source = _normalize(stage.get("source"))
    if seed_id:
        for seed in seeds:
            candidate_id = _normalize(seed.get("seedId"))
            if candidate_id == seed_id or candidate_id.startswith(f"{seed_id}_") or seed_id.startswith(candidate_id):
                return seed
    for seed in seeds:
        candidate_id = _normalize(seed.get("seedId"))
        if candidate_id and candidate_id in source:
            return seed
    if base_question:
        for seed in seeds:
            if _normalize(seed.get("baseQuestion")) == base_question:
                return seed
    return {}


def _source_preview(seed: Dict[str, Any], scope: Dict[str, Any]) -> Dict[str, Any]:
    if not seed:
        return {}
    return {
        "seedId": _normalize(seed.get("seedId")),
        "reportId": _normalize(seed.get("reportId")),
        "title": _normalize(seed.get("sourceReportTitle")),
        "url": _normalize(seed.get("sourceReportUrl")),
        "rolePath": _normalize(seed.get("rolePath")),
        "stage": _normalize(seed.get("stage")),
        "company": _normalize(seed.get("company")),
        "baseQuestion": _normalize(seed.get("baseQuestion")),
        "topics": _normalize_list(seed.get("topics")),
        "followupAngles": _normalize_list(seed.get("followupAngles"))[:4],
        "strongSignals": _normalize_list(seed.get("strongAnswerSignals"))[:4],
        "reportText": str(seed.get("sourceReportText") or "")[:1600],
        "resumeText": _scope_text(scope, ["resume", "resumeText", "resumeSummary", "candidateProfile", "candidateProfileText", "userResume"])[:800],
        "jobDescription": _scope_text(scope, ["jd", "jobDescription", "jobDescriptionText", "jobRequirements", "jobPosting"])[:800],
    }


def _coerce_source_context(context: Dict[str, Any], index: int) -> Dict[str, Any]:
    context_type = _normalize(context.get("type")) or "historical_interview"
    return {
        "type": context_type,
        "label": _normalize(context.get("label")) or {
            "user_resume": "用户简历",
            "user_jd": "用户 JD",
            "selected_scope": "所选岗位范围",
            "historical_interview": "历史面经",
        }.get(context_type, f"参考材料 {index + 1}"),
        "excerpt": _normalize(context.get("excerpt"))[:500],
        "reason": _normalize(context.get("reason"))[:220],
        "contextId": _normalize(context.get("contextId") or context.get("seedId")),
        "url": _normalize(context.get("url")),
    }


def _default_source_contexts(seed: Dict[str, Any], scope: Dict[str, Any]) -> List[Dict[str, Any]]:
    contexts: List[Dict[str, Any]] = []
    resume_text = _scope_text(scope, ["resume", "resumeText", "resumeSummary", "candidateProfile", "candidateProfileText", "userResume"])
    jd_text = _scope_text(scope, ["jd", "jobDescription", "jobDescriptionText", "jobRequirements", "jobPosting"])
    if resume_text:
        contexts.append(_coerce_source_context({
            "type": "user_resume",
            "label": "用户简历",
            "excerpt": resume_text[:500],
            "reason": "用于判断题目是否需要贴近候选人的真实项目经历。",
        }, len(contexts)))
    if jd_text:
        contexts.append(_coerce_source_context({
            "type": "user_jd",
            "label": "用户 JD",
            "excerpt": jd_text[:500],
            "reason": "用于控制岗位能力要求和考察深度。",
        }, len(contexts)))
    if seed:
        contexts.append(_coerce_source_context({
            "type": "historical_interview",
            "label": f"历史面经 {seed.get('seedId') or seed.get('reportId') or ''}".strip(),
            "excerpt": _normalize(seed.get("baseQuestion") or seed.get("sourceReportText"))[:500],
            "reason": "用于参考真实面试的考点和追问风格，不代表当前候选人的经历。",
            "contextId": seed.get("seedId") or seed.get("reportId"),
            "url": seed.get("sourceReportUrl"),
        }, len(contexts)))
    if not contexts:
        contexts.append(_coerce_source_context({
            "type": "selected_scope",
            "label": "所选岗位范围",
            "excerpt": _format_scope(scope),
            "reason": "未提供更多材料时，根据用户选择的岗位和轮次生成通用面试大纲。",
        }, 0))
    return contexts[:5]


def _coerce_source_contexts(stage: Dict[str, Any], seed: Dict[str, Any], scope: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_contexts = stage.get("sourceContexts")
    if isinstance(raw_contexts, list):
        contexts = [
            _coerce_source_context(context, index)
            for index, context in enumerate(raw_contexts)
            if isinstance(context, dict)
        ]
        if contexts:
            return contexts[:5]
    return _default_source_contexts(seed, scope)


def _coerce_plan_stage(stage: Dict[str, Any], index: int, scope: Optional[Dict[str, Any]] = None, seeds: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    matched_seed = _find_stage_seed(stage, seeds or [])
    normalized_scope = scope or {}
    source_contexts = _coerce_source_contexts(stage, matched_seed, normalized_scope)
    return {
        "step": int(stage.get("step") or index + 1),
        "theme": _normalize(stage.get("theme") or (matched_seed.get("topics") or ["综合"])[0]),
        "objective": _normalize(stage.get("objective") or "验证候选人对当前主题的真实掌握和项目证据。"),
        "source": _normalize(stage.get("source") or "由 sample source context 综合生成。"),
        "seedId": _normalize(stage.get("seedId") or matched_seed.get("seedId")),
        "baseQuestion": _normalize(stage.get("baseQuestion") or stage.get("question") or matched_seed.get("baseQuestion") or "请结合一个具体项目场景展开说明。"),
        "allowedFollowups": _normalize_list(stage.get("allowedFollowups") or matched_seed.get("followupAngles"))[:4],
        "strongSignals": _normalize_list(stage.get("strongSignals") or matched_seed.get("strongAnswerSignals"))[:4],
        "sourceContexts": source_contexts,
        "sourcePreview": {
            **_source_preview(matched_seed, normalized_scope),
            "sourceContexts": source_contexts,
        },
    }


def _normalize_interview_plan(payload: Dict[str, Any], scope: Dict[str, Any], seeds: List[Dict[str, Any]]) -> Dict[str, Any]:
    question_budget = max(1, int(scope.get("questionBudget") or 8))
    stages = [
        _coerce_plan_stage(stage, index, scope, seeds)
        for index, stage in enumerate((payload.get("stages") or [])[:question_budget])
        if isinstance(stage, dict)
    ]
    if not stages:
        stages = [
            _coerce_plan_stage({
                "theme": (seed.get("topics") or ["综合"])[0],
                "source": "来自历史面经 sample source context。",
                "seedId": seed.get("seedId", ""),
                "baseQuestion": seed.get("baseQuestion", ""),
                "allowedFollowups": seed.get("followupAngles") or [],
                "strongSignals": seed.get("strongAnswerSignals") or [],
            }, index, scope, seeds)
            for index, seed in enumerate((seeds or [])[:question_budget])
        ]
    return {
        "title": _normalize(payload.get("title") or "本轮模拟面试大纲"),
        "rationale": _normalize(payload.get("rationale") or "根据用户材料、岗位要求和历史面经样本安排本轮问题顺序。"),
        "sourceExplanation": _normalize(payload.get("sourceExplanation") or "题目由 sample source context 综合生成：历史面经用于参考真实考法，用户材料用于控制贴合度。"),
        "stages": stages,
        "guardrails": _normalize_list(payload.get("guardrails"))[:5] or [
            "后续提问应围绕大纲主题推进。",
            "候选人回答只影响追问切入点和深度，不应让面试偏离岗位目标。",
            "历史面经只作为参考上下文，不应被当作当前候选人的真实经历。",
        ],
    }


def _question_turn_records(transcript: List[Dict[str, Any]], interview_plan: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    interviewer_indexes = [
        index
        for index, turn in enumerate(transcript or [])
        if turn.get("role") == "interviewer"
    ]
    stages = (interview_plan or {}).get("stages") or []

    for order, interviewer_index in enumerate(interviewer_indexes):
        interviewer_turn = transcript[interviewer_index]
        next_interviewer_index = interviewer_indexes[order + 1] if order + 1 < len(interviewer_indexes) else len(transcript)
        candidate_turns = [
            turn
            for turn in transcript[interviewer_index + 1:next_interviewer_index]
            if turn.get("role") == "candidate"
        ]
        answer_text = _normalize(" ".join(_normalize(turn.get("text")) for turn in candidate_turns if _normalize(turn.get("text"))))
        plan_step = interviewer_turn.get("planStep")
        stage = {}
        if isinstance(plan_step, int) and 1 <= plan_step <= len(stages):
            stage = stages[plan_step - 1]
        elif order < len(stages):
            stage = stages[order]
        topic = _normalize(interviewer_turn.get("topic") or stage.get("theme") or "综合")
        question_text = _normalize(interviewer_turn.get("text") or stage.get("baseQuestion") or "")
        records.append({
            "questionNumber": order + 1,
            "planStep": int(plan_step or stage.get("step") or order + 1),
            "topic": topic or "综合",
            "difficulty": _difficulty_label(question_text, topic),
            "questionText": question_text,
            "answerText": answer_text,
            "objective": _normalize(stage.get("objective")),
            "sourceLabel": _normalize(stage.get("source") or stage.get("sourcePreview", {}).get("title")),
            "seedId": _normalize(interviewer_turn.get("seedId") or stage.get("seedId")),
            "strongSignals": _normalize_list(stage.get("strongSignals"))[:4],
            "allowedFollowups": _normalize_list(stage.get("allowedFollowups"))[:4],
        })
    return records


def _format_review_question_records(question_records: List[Dict[str, Any]]) -> str:
    if not question_records:
        return "无题目记录。"
    lines: List[str] = []
    for record in question_records:
        lines.extend([
            f"[第 {record.get('questionNumber')} 题]",
            f"topic={record.get('topic') or '综合'}",
            f"difficulty={record.get('difficulty') or '高频'}",
            f"question={record.get('questionText') or '未记录'}",
            f"candidate_answer={record.get('answerText') or '未回答或无记录'}",
            f"objective={record.get('objective') or '未提供'}",
            f"strong_signals={'；'.join(record.get('strongSignals') or []) or '未提供'}",
            f"allowed_followups={'；'.join(record.get('allowedFollowups') or []) or '未提供'}",
            "",
        ])
    return "\n".join(lines).strip()


def _default_question_review(record: Dict[str, Any]) -> Dict[str, Any]:
    answer_text = _normalize(record.get("answerText"))
    lower_answer = answer_text.lower()
    if not answer_text or any(token in lower_answer for token in ["不知道", "不会", "不太清楚", "没做过", "忘了", "换题"]):
        score = 28
        status = "miss"
        performance_summary = "这题没有形成有效回答，核心考点基本空缺。"
        strengths = ["没有硬编答案，避免继续扩大失误。"] if answer_text else []
        misses = [
            "没有覆盖题目的核心机制或项目证据。",
            "缺少结构化回答，面试官无法判断真实掌握程度。",
        ]
        key_points = _normalize_list(record.get("strongSignals")) or [
            "先给结论，再补机制、取舍和结果。",
            "至少讲出一个真实项目场景或线上证据。",
        ]
        coaching_tip = "先把这题拆成“结论 → 原理/方案 → 为什么这么做 → 项目结果”四句，能稳定把 0 分题拉回及格线。"
    elif len(answer_text) < 36:
        score = 54
        status = "warn"
        performance_summary = "回答有方向，但明显偏短，关键机制、取舍或结果没有展开。"
        strengths = ["已经能给出方向性的回答。"]
        misses = [
            "缺少关键细节，难以支撑继续深挖。",
            "没有把项目动作、指标或边界条件讲出来。",
        ]
        key_points = _normalize_list(record.get("strongSignals")) or [
            "补一条机制解释。",
            "补一个真实场景和结果指标。",
        ]
        coaching_tip = "下一次至少补上一个“为什么这样做”和一个“线上怎么验证”的细节，让回答从概括变成可追问。"
    else:
        score = 79
        status = "good"
        performance_summary = "这题回答已经能形成完整交流，说明你对主题有基本掌握。"
        strengths = [
            "回答长度和信息量足够支撑继续追问。",
            "能把问题拉回到项目或机制层面。",
        ]
        misses = ["如果再补一条量化结果或边界条件，可信度会更强。"]
        key_points = _normalize_list(record.get("strongSignals")) or [
            "继续保留结论先行的表达。",
            "补充指标和取舍，会更接近强回答。",
        ]
        coaching_tip = "这题已经能聊下去，继续补“结果指标 + 边界条件”就能把优势题变成稳定拿分题。"
    return {
        "questionNumber": record.get("questionNumber"),
        "topic": record.get("topic") or "综合",
        "difficulty": record.get("difficulty") or "高频",
        "status": status,
        "score": score,
        "questionText": record.get("questionText") or "",
        "answerText": answer_text,
        "performanceSummary": performance_summary,
        "strengths": strengths,
        "misses": misses,
        "keyPoints": key_points,
        "coachingTip": coaching_tip,
        "likelyFollowups": _normalize_list(record.get("allowedFollowups"))[:3],
        "objective": record.get("objective") or "",
        "sourceLabel": record.get("sourceLabel") or "",
        "seedId": record.get("seedId") or "",
    }


def _default_capability_distribution(question_reviews: List[Dict[str, Any]], scope: Dict[str, Any]) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for review in question_reviews:
        topic = _normalize(review.get("topic")) or "综合"
        grouped.setdefault(topic, []).append(review)

    if not grouped:
        topics = scope.get("topics") if isinstance(scope.get("topics"), list) else []
        grouped = {(_normalize(topic) or "综合"): [] for topic in (topics or ["综合"])}

    distribution: List[Dict[str, Any]] = []
    for topic, items in grouped.items():
        avg_score = int(round(sum(int(item.get("score") or 0) for item in items) / max(len(items), 1)))
        status = _status_from_score(avg_score)
        distribution.append({
            "topic": topic or "综合",
            "score": avg_score,
            "verdict": {
                "good": "这一块可以继续深挖真实场景。",
                "warn": "有基础，但还不够稳，容易被继续追问打穿。",
                "miss": "这是本轮主要短板，需要优先补课。",
            }[status],
            "evidence": {
                "good": "至少有一道相关题回答较完整，能继续展开。",
                "warn": "相关题有方向，但细节和取舍解释不足。",
                "miss": "相关题出现空缺、拒答或明显失焦。",
            }[status],
            "questionCount": len(items),
        })
    return sorted(distribution, key=lambda item: int(item.get("score") or 0), reverse=True)


def _normalize_question_review(item: Dict[str, Any], record: Dict[str, Any]) -> Dict[str, Any]:
    fallback = _default_question_review(record)
    score = _normalize_int(item.get("score"), int(fallback.get("score") or 0))
    status = _normalize(item.get("status")).lower()
    if status not in {"miss", "warn", "good"}:
        status = _status_from_score(score)
    return {
        "questionNumber": _normalize_int(item.get("questionNumber"), int(record.get("questionNumber") or 1), minimum=1, maximum=99),
        "topic": _normalize(item.get("topic") or record.get("topic") or fallback.get("topic")),
        "difficulty": _normalize(item.get("difficulty") or record.get("difficulty") or fallback.get("difficulty")) or "高频",
        "status": status,
        "score": score,
        "questionText": _normalize(item.get("questionText") or item.get("title") or record.get("questionText") or fallback.get("questionText")),
        "answerText": _normalize(item.get("answerText") or record.get("answerText") or fallback.get("answerText")),
        "performanceSummary": _normalize(item.get("performanceSummary") or item.get("performance") or fallback.get("performanceSummary")),
        "strengths": _normalize_list(item.get("strengths"))[:4] or fallback.get("strengths") or [],
        "misses": _normalize_list(item.get("misses") or item.get("weaknesses"))[:4] or fallback.get("misses") or [],
        "keyPoints": _normalize_list(item.get("keyPoints") or item.get("standardAnswerPoints") or item.get("answerFramework"))[:5] or fallback.get("keyPoints") or [],
        "coachingTip": _normalize(item.get("coachingTip") or item.get("tip") or fallback.get("coachingTip")),
        "likelyFollowups": _normalize_list(item.get("likelyFollowups") or item.get("followups") or record.get("allowedFollowups"))[:4] or fallback.get("likelyFollowups") or [],
        "objective": _normalize(item.get("objective") or record.get("objective") or fallback.get("objective")),
        "sourceLabel": _normalize(item.get("sourceLabel") or record.get("sourceLabel") or fallback.get("sourceLabel")),
        "seedId": _normalize(item.get("seedId") or record.get("seedId") or fallback.get("seedId")),
    }


def _normalize_capability_item(item: Dict[str, Any], fallback_topic: str = "综合") -> Dict[str, Any]:
    score = _normalize_int(item.get("score"), 0)
    return {
        "topic": _normalize(item.get("topic") or fallback_topic) or "综合",
        "score": score,
        "verdict": _normalize(item.get("verdict")) or {
            "good": "整体较稳，可以继续深挖。",
            "warn": "有基础，但还不够稳。",
            "miss": "属于明显短板，需要优先补强。",
        }[_status_from_score(score)],
        "evidence": _normalize(item.get("evidence")) or "基于本轮相关题目的作答情况综合判断。",
        "questionCount": _normalize_int(item.get("questionCount"), 1, minimum=0, maximum=99),
    }


def _normalize_review_payload(
    payload: Dict[str, Any],
    *,
    scope: Dict[str, Any],
    transcript: List[Dict[str, Any]],
    interview_plan: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    question_records = _question_turn_records(transcript, interview_plan)
    raw_question_reviews = payload.get("questionReviews")
    question_reviews = [
        _normalize_question_review(item, question_records[index])
        for index, item in enumerate(raw_question_reviews if isinstance(raw_question_reviews, list) else [])
        if isinstance(item, dict) and index < len(question_records)
    ]
    if len(question_reviews) < len(question_records):
        question_reviews.extend(
            _default_question_review(record)
            for record in question_records[len(question_reviews):]
        )

    capability_distribution = [
        _normalize_capability_item(item)
        for item in (payload.get("capabilityDistribution") or [])
        if isinstance(item, dict)
    ]
    if not capability_distribution and isinstance(payload.get("topicPerformance"), list):
        capability_distribution = [
            _normalize_capability_item(item, fallback_topic=_normalize(item.get("topic")) or "综合")
            for item in payload.get("topicPerformance")
            if isinstance(item, dict)
        ]
    if not capability_distribution:
        capability_distribution = _default_capability_distribution(question_reviews, scope)

    miss_count = sum(1 for item in question_reviews if item.get("status") == "miss")
    warn_count = sum(1 for item in question_reviews if item.get("status") == "warn")
    good_count = sum(1 for item in question_reviews if item.get("status") == "good")
    readiness_score = _normalize_int(
        payload.get("readinessScore"),
        default=int(round(sum(item.get("score", 0) for item in question_reviews) / max(len(question_reviews), 1))) if question_reviews else 0,
    )

    summary = _normalize(payload.get("summary"))
    if not summary:
        summary = f"本轮共 {len(question_reviews)} 题：{miss_count} 题明显失分，{warn_count} 题需要补细节，{good_count} 题基本能继续聊。"

    return {
        "readinessScore": readiness_score,
        "summary": summary,
        "capabilityDistribution": capability_distribution,
        "topicPerformance": capability_distribution,
        "questionReviews": question_reviews,
        "strengths": _normalize_list(payload.get("strengths"))[:5] or [
            "已答出的题能保持交流，不会完全失去主线。",
        ],
        "weaknesses": _normalize_list(payload.get("weaknesses"))[:5] or [
            "薄弱题缺少结构化回答，容易被一问击穿。",
        ],
        "likelyFollowups": _normalize_list(payload.get("likelyFollowups"))[:5] or [
            "你具体负责哪一段？",
            "为什么这样设计？",
        ],
        "practicalNextSteps": _normalize_list(payload.get("practicalNextSteps"))[:5] or [
            "优先补最薄弱的 2-3 个主题，再做一轮定向模拟。",
        ],
        "nextRecommendedScope": _normalize(payload.get("nextRecommendedScope")) or "围绕本轮薄弱主题继续专项模拟",
        "counts": {
            "miss": miss_count,
            "warn": warn_count,
            "good": good_count,
            "total": len(question_reviews),
        },
    }


def build_question_review_prompt(*, scope: Dict[str, Any], question_record: Dict[str, Any]) -> str:
    return "\n".join([
        "你是严格但务实的面试复盘官，现在只诊断一题。",
        "输出合法 JSON，不要输出 Markdown 或解释性前后缀。",
        "字段必须包含：questionNumber, topic, difficulty, status, score, performanceSummary, strengths, misses, keyPoints, coachingTip, likelyFollowups。",
        "status 只能是 miss、warn、good。",
        "只基于本题的题目、候选人回答和考察目标做判断，不要编造 transcript 里没有的信息。",
        "keyPoints 要写这题应该答到的关键点，必须具体。",
        "",
        f"选定 scope：{_format_scope(scope)}",
        "",
        "本题信息：",
        json.dumps(question_record, ensure_ascii=False),
    ])


def build_review_summary_prompt(
    *,
    scope: Dict[str, Any],
    question_reviews: List[Dict[str, Any]],
    capability_distribution: List[Dict[str, Any]],
) -> str:
    return "\n".join([
        "你是严格但务实的面试复盘官，现在只基于结构化逐题结果生成整轮总结。",
        "不要重读原始 transcript，不要假设额外上下文。",
        "输出合法 JSON，字段必须包含：readinessScore, summary, strengths, weaknesses, likelyFollowups, practicalNextSteps, nextRecommendedScope。",
        "summary 是面向候选人的总评，应该概括通过风险、主要短板和下一步建议。",
        "strengths / weaknesses / likelyFollowups / practicalNextSteps 都要是简洁数组。",
        "",
        f"选定 scope：{_format_scope(scope)}",
        "",
        "结构化能力分布：",
        json.dumps(capability_distribution, ensure_ascii=False),
        "",
        "结构化逐题结果：",
        json.dumps(question_reviews, ensure_ascii=False),
    ])


def build_rescue_material_prompt(*, scope: Dict[str, Any], gap: Dict[str, Any]) -> str:
    return "\n".join([
        "你是一位擅长把面试暴露的知识缺口讲透的技术老师。",
        "你的任务不是教人怎么面试，而是基于这次面试暴露出的知识缺口，写一份能真正补上这块知识的学习讲解。",
        "输出必须是 Markdown 正文，不要输出 JSON、不要用代码块包裹整篇、不要任何解释性前后缀。",
        "整篇结构按下面顺序，用二级标题：",
        "## 知识点讲解 —— 这是正文主体，篇幅要够。要把这块知识从“是什么、为什么需要、底层机制/原理、典型流程”一路讲到一个具体例子，宁可展开讲透也不要只列要点。",
        "## 常见误区 —— 针对候选人这次答错或答漏的点，先点出错误理解，再给出正确理解。",
        "## 面试怎么答 —— 用 3-5 步给出清晰的答题骨架，简洁即可，只作为辅助。",
        "## 高概率追问 —— 列出后续可能的追问，并对每个追问补一句话要点答案，让它也成为学习内容，而不是单纯罗列问题。",
        "硬性要求：以知识讲解为主体，面试答法只是附带；严禁出现“这篇先补什么”“训练提示”这类元信息或流程说明。",
        "可以结合可靠的通用技术知识把原理讲透，但不要编造候选人没说过的项目经历或公司。",
        "全程用中文，把原理讲清楚胜过堆术语。",
        "",
        f"选定 scope：{_format_scope(scope)}",
        "",
        "本次面试暴露的知识缺口（topic 是主题，misses 是答错/答漏的点，keyPoints 是本该答到的关键点，likelyFollowups 是可能追问）：",
        json.dumps(gap, ensure_ascii=False),
    ])


def _weak_question_reviews(review: Dict[str, Any]) -> List[Dict[str, Any]]:
    question_reviews = review.get("questionReviews") if isinstance(review, dict) else None
    weak: List[Dict[str, Any]] = []
    for item in question_reviews or []:
        if not isinstance(item, dict):
            continue
        if _normalize(item.get("status")) == "good":
            continue
        weak.append(item)
    return weak


def _format_gap_questions(question_reviews: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for item in question_reviews:
        gap = {
            "questionNumber": item.get("questionNumber"),
            "topic": _normalize(item.get("topic")),
            "questionText": _normalize(item.get("questionText")),
            "status": _normalize(item.get("status")),
            "score": item.get("score"),
            "misses": _normalize_list(item.get("misses")),
            "keyPoints": _normalize_list(item.get("keyPoints")),
            "likelyFollowups": _normalize_list(item.get("likelyFollowups")),
            "performanceSummary": _normalize(item.get("performanceSummary")),
            "coachingTip": _normalize(item.get("coachingTip")),
        }
        lines.append(json.dumps(gap, ensure_ascii=False))
    return "\n".join(lines) if lines else "（无明确薄弱题目）"


def _format_document_library(documents: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for document in documents or []:
        if not isinstance(document, dict):
            continue
        doc_path = _normalize(document.get("path"))
        if not doc_path:
            continue
        title = _normalize(document.get("title")) or doc_path
        labels = document.get("folderLabels")
        category = " / ".join(_normalize(label) for label in labels if _normalize(label)) if isinstance(labels, list) else ""
        lines.append(f"{doc_path} | {category or '未分类'} | {title}")
    return "\n".join(lines) if lines else "（资料库为空，全部走 AI 生成）"


def build_rescue_plan_prompt(*, scope: Dict[str, Any], review: Dict[str, Any], documents: List[Dict[str, Any]]) -> str:
    weak_questions = _weak_question_reviews(review)
    review_summary = _normalize(review.get("summary")) if isinstance(review, dict) else ""
    return "\n".join([
        "你是一位资深技术面试教练。根据本次面试的复盘结果，为候选人规划一份「面试补救清单」。",
        "铁律：清单里的每一项都必须直接对应这次面试真正暴露出来的薄弱点，绝不能引入与本次面试无关的话题或知识点。",
        "",
        "工作方式：",
        "1. 读完下面这次面试的复盘：每道薄弱题目都带有主题 topic、原题 questionText、判定 status、本应答到的关键点 keyPoints、答错或答漏的点 misses、可能的追问 likelyFollowups。",
        "2. 把性质相近、可以合并成同一份学习材料的薄弱点合并成一项；不要为每道题机械拆一项，也不要为了凑数硬加无关项。最终一般 2-6 项即可。",
        "3. 对每一项，判断「已有资料库」里是否存在一篇能直接覆盖这个缺口的现成文档：",
        "   - 若有：reuseDocPath 填它的 path（必须严格复制资料库清单里的 path，禁止编造或改写），source 设为 \"reuse\"。",
        "   - 若没有合适现成文档：source 设为 \"generate\"（之后由 AI 单独生成讲解），reuseDocPath 留空字符串。",
        "   - 若这块知识依赖版本/最新实践、需要联网核对：source 设为 \"checked\"，reuseDocPath 留空字符串。",
        "   - 拿不准资料库文档是否真的对口时，宁可 generate，也不要勉强 reuse 一篇不贴合的文档。",
        "4. 给每一项写一个具体、贴合本次缺口的中文标题，不要直接套用资料库里无关文档的名字。",
        "",
        "只输出严格 JSON，不要任何解释或代码块包裹，结构如下：",
        '{"items":[{"title":"...","questionNumbers":[1,2],"summary":"一句话说明这项补什么缺口","misses":["..."],"keyPoints":["..."],"likelyFollowups":["..."],"source":"reuse|generate|checked","reuseDocPath":"","priority":0}]}',
        "priority 为 0-100 的整数，越高越优先，反映这个缺口对面试结果的影响；items 按 priority 从高到低排序。",
        "",
        f"选定 scope：{_format_scope(scope)}",
        f"本轮复盘摘要：{review_summary or '（无）'}",
        "",
        "本次面试的薄弱题目（每行一个 JSON）：",
        _format_gap_questions(weak_questions),
        "",
        "已有资料库（每行格式： path | 分类 | 标题；reuseDocPath 只能从这里挑）：",
        _format_document_library(documents),
    ])


def _default_rescue_plan(review: Dict[str, Any]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for item in _weak_question_reviews(review):
        topic = _normalize(item.get("topic")) or _normalize(item.get("questionText")) or "这块知识"
        status = _normalize(item.get("status"))
        question_number = item.get("questionNumber")
        items.append({
            "title": f"{topic} · 面试补救讲解",
            "questionNumbers": [question_number] if question_number else [],
            "summary": _normalize(item.get("coachingTip")) or _normalize(item.get("performanceSummary")) or f"补上「{topic}」这块在面试里暴露的缺口。",
            "misses": _normalize_list(item.get("misses")),
            "keyPoints": _normalize_list(item.get("keyPoints")),
            "likelyFollowups": _normalize_list(item.get("likelyFollowups")),
            "source": "generate",
            "reuseDocPath": "",
            "priority": 100 if status == "miss" else 60,
        })
    return items


def _normalize_rescue_plan(payload: Any, *, documents: List[Dict[str, Any]]) -> Dict[str, Any]:
    raw_items = payload.get("items") if isinstance(payload, dict) else None
    valid_paths = {
        _normalize(document.get("path"))
        for document in (documents or [])
        if isinstance(document, dict) and _normalize(document.get("path"))
    }
    normalized: List[Dict[str, Any]] = []
    for item in raw_items or []:
        if not isinstance(item, dict):
            continue
        title = _normalize(item.get("title"))
        if not title:
            continue
        source = _normalize(item.get("source")).lower()
        reuse_path = _normalize(item.get("reuseDocPath"))
        if reuse_path and reuse_path not in valid_paths:
            reuse_path = ""
        if reuse_path:
            source = "reuse"
        elif source not in {"generate", "checked"}:
            source = "generate"
        question_numbers = []
        for value in item.get("questionNumbers") or []:
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            if number > 0 and number not in question_numbers:
                question_numbers.append(number)
        normalized.append({
            "title": title,
            "questionNumbers": question_numbers,
            "summary": _normalize(item.get("summary")),
            "misses": _normalize_list(item.get("misses")),
            "keyPoints": _normalize_list(item.get("keyPoints")),
            "likelyFollowups": _normalize_list(item.get("likelyFollowups")),
            "source": source,
            "reuseDocPath": reuse_path,
            "priority": _normalize_int(item.get("priority"), default=50, minimum=0, maximum=100),
        })
    normalized.sort(key=lambda entry: entry.get("priority", 0), reverse=True)
    return {"items": normalized[:12]}


def _build_mock_rescue_markdown(gap: Dict[str, Any]) -> str:
    topic = _normalize(gap.get("topic")) or _normalize(gap.get("title")) or "这块知识"
    misses = _normalize_list(gap.get("misses"))
    key_points = _normalize_list(gap.get("keyPoints"))
    followups = _normalize_list(gap.get("likelyFollowups"))
    lines = [
        f"# {topic} 知识补救",
        "",
        "## 知识点讲解",
        "",
        f"先把 {topic} 真正要解决的问题、底层机制和典型流程讲清楚，再落到一个具体例子上。",
    ]
    for point in key_points[:5]:
        lines.append(f"- {point}")
    lines += ["", "## 常见误区", ""]
    if misses:
        lines += [f"- {point}" for point in misses[:5]]
    else:
        lines.append("- 只记结论、说不清机制和适用边界。")
    lines += ["", "## 面试怎么答", "", "1. 先给结论。", "2. 补机制与适用边界。", "3. 落回项目里的实际选择。", "", "## 高概率追问", ""]
    if followups:
        lines += [f"- {point} —— 抓住机制和取舍来回答。" for point in followups[:4]]
    else:
        lines.append("- 为什么这样设计而不是另一种？ —— 从代价与场景对比切入。")
    return "\n".join(lines)


def build_interviewer_prompt(
    *,
    scope: Dict[str, Any],
    seeds: List[Dict[str, Any]],
    transcript: List[Dict[str, Any]],
    interview_plan: Optional[Dict[str, Any]] = None,
    is_first_turn: bool = False,
) -> str:
    source_context_block = "\n\n".join(_format_source_context(seed, index + 1) for index, seed in enumerate(seeds[:12]))
    remaining_budget = max(1, int(scope.get("questionBudget") or 8) - sum(1 for turn in transcript if turn.get("role") == "interviewer"))
    return "\n".join([
        "你是 LoopAssist 的真实模拟面试官。",
        "你只输出下一句面试官要说的话。不要输出评分、诊断、答案提示、题源说明、JSON 以外的解释或内部推理。",
        "面试过程必须像真人持续问答，但每一问都要基本符合内部面试计划，不能因为上一轮回答随意跑到计划外主题。",
        "根据候选人的上一轮回答自然追问：短回答追当前计划步骤的项目证据；扎实回答再推进到下一计划步骤或相邻主题。",
        "如果刚开始，优先使用内部面试计划里的最终问题；历史面经只作为 sample source context，不要照搬历史面经原句。",
        "不要把历史面经里出现的经历、公司、技术栈说成当前候选人已经做过；问法要来自当前计划和候选人已提供材料。",
        "面试风格要求体现在措辞和追问压力里，但不要说“现在进入某某风格”。",
        "输出必须是合法 JSON：{\"text\":\"...\",\"topic\":\"可选主题\",\"seedId\":\"可选seedId\",\"planStep\":1}",
        "",
        f"选定 scope：{_format_scope(scope)}",
        f"剩余可问轮次约：{remaining_budget}",
        f"是否第一句：{str(is_first_turn).lower()}",
        "",
        "候选人简历与岗位 JD 上下文（可能为空；未提供时不要编造）：",
        _format_candidate_context(scope),
        "",
        "内部面试计划（不要向用户展示计划本身，只用来约束下一问）：",
        _format_interview_plan(interview_plan or {}, transcript),
        "",
        "历史面经 sample source context（只供理解真实考法，不要向用户展示，也不要照搬为最终问题）：",
        source_context_block or "无历史面经样本，按 scope 自然出题。",
        "",
        "当前完整 transcript：",
        _format_transcript(transcript),
    ])


def build_review_prompt(
    *,
    scope: Dict[str, Any],
    transcript: List[Dict[str, Any]],
    interview_plan: Optional[Dict[str, Any]] = None,
) -> str:
    question_records = _question_turn_records(transcript, interview_plan)
    return "\n".join([
        "你是严格但务实的面试复盘官。只基于完整 transcript 做最终复盘。",
        "输出合法 JSON，字段必须包含：readinessScore, summary, capabilityDistribution, strengths, weaknesses, likelyFollowups, practicalNextSteps, nextRecommendedScope, questionReviews。",
        "readinessScore 是 0-100 整数。",
        "capabilityDistribution 是数组，每项包含：topic, score, verdict, evidence, questionCount。",
        "questionReviews 必须按题目顺序逐题输出，长度必须与题目清单一致。",
        "questionReviews 每项必须包含：questionNumber, topic, difficulty, status, score, performanceSummary, strengths, misses, keyPoints, coachingTip, likelyFollowups。",
        "status 只能是 miss、warn、good 三种。",
        "keyPoints 要写这题真正应该答到的关键点，不要写空泛鸡汤。",
        "不要评价未发生的内容；如果证据不足，请明确说证据不足。",
        "",
        f"选定 scope：{_format_scope(scope)}",
        "",
        "内部面试计划（用于理解每题目标和主题，不要编造计划外内容）：",
        _format_interview_plan(interview_plan or {}, transcript),
        "",
        "按题整理后的 transcript：",
        _format_review_question_records(question_records),
        "",
        "完整 transcript：",
        _format_transcript(transcript),
    ])


class MockLoopAssistIntelligence:
    provider = "MOCK"
    model = "mock-loopassist-v1"
    configured = True

    def interview_plan(self, *, scope: Dict[str, Any], seeds: List[Dict[str, Any]]) -> Dict[str, Any]:
        question_budget = max(1, int(scope.get("questionBudget") or 8))
        source_bits = ["历史面经样本"]
        if _scope_text(scope, ["resume", "resumeText", "resumeSummary", "candidateProfile", "candidateProfileText", "userResume"]):
            source_bits.append("候选人简历")
        if _scope_text(scope, ["jd", "jobDescription", "jobDescriptionText", "jobRequirements", "jobPosting"]):
            source_bits.append("目标岗位 JD")
        stages = []
        usable_seeds = seeds or [{
            "seedId": "",
            "baseQuestion": "介绍一下你最近做的一个项目，以及你负责的核心部分。",
            "topics": ["项目"],
            "followupAngles": ["你负责哪一段？", "线上效果如何验证？"],
            "strongAnswerSignals": ["能讲清职责", "有指标", "能说明取舍"],
        }]
        for index in range(question_budget):
            seed = usable_seeds[index % len(usable_seeds)]
            theme = (seed.get("topics") or ["综合"])[0]
            stages.append({
                "step": index + 1,
                "theme": theme,
                "objective": f"验证候选人在{theme}上的项目证据、技术理解和取舍判断。",
                "source": "、".join(source_bits),
                "seedId": seed.get("seedId", ""),
                "baseQuestion": seed.get("baseQuestion", ""),
                "allowedFollowups": seed.get("followupAngles") or [],
                "strongSignals": seed.get("strongAnswerSignals") or [],
            })
        return _normalize_interview_plan({
            "title": "本轮模拟面试大纲",
            "rationale": "先用真实面经锁定核心主题，再结合候选人材料和岗位要求控制追问深度。",
            "sourceExplanation": f"本轮主要参考{'、'.join(source_bits)}。",
            "stages": stages,
            "guardrails": ["每一问围绕大纲推进", "回答只改变追问深度，不改变本轮主线"],
        }, scope, seeds)

    def interviewer_message(
        self,
        *,
        scope: Dict[str, Any],
        seeds: List[Dict[str, Any]],
        transcript: List[Dict[str, Any]],
        interview_plan: Optional[Dict[str, Any]] = None,
        is_first_turn: bool = False,
    ) -> Dict[str, Any]:
        interviewer_turns = [turn for turn in transcript if turn.get("role") == "interviewer"]
        candidate_turns = [turn for turn in transcript if turn.get("role") == "candidate"]
        plan_step = _current_plan_step(interview_plan or {}, transcript)
        seed_id = plan_step.get("seedId")
        seed = next((item for item in seeds if _normalize(item.get("seedId")) == seed_id), None)
        if not seed:
            seed = seeds[min(len(interviewer_turns), max(0, len(seeds) - 1))] if seeds else {}
        if is_first_turn or not candidate_turns:
            question = plan_step.get("baseQuestion") or seed.get("baseQuestion") or "介绍一下你最近做的一个项目，以及你负责的核心部分。"
            text = f"我们先从本轮最相关的问题开始：{question}"
        else:
            answer = _normalize(candidate_turns[-1].get("text"))
            if len(answer) < 24:
                theme = plan_step.get("theme") or (seed.get("topics") or ["项目"])[0]
                text = f"这个回答还比较概括。你能围绕{theme}结合一个具体项目场景，把你的做法、为什么这么做、以及结果讲完整一点吗？"
            else:
                angle = (plan_step.get("allowedFollowups") or seed.get("followupAngles") or ["如果线上出现异常，你会怎么定位？"])[0]
                text = f"好，继续追一下：{angle}"
        return {
            "text": text,
            "topic": plan_step.get("theme") or (seed.get("topics") or ["综合"])[0],
            "seedId": plan_step.get("seedId") or seed.get("seedId", ""),
            "planStep": plan_step.get("step"),
        }

    def review(
        self,
        *,
        scope: Dict[str, Any],
        transcript: List[Dict[str, Any]],
        interview_plan: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        question_reviews = [
            _default_question_review(record)
            for record in _question_turn_records(transcript, interview_plan)
        ]
        score = int(round(sum(item.get("score", 0) for item in question_reviews) / max(len(question_reviews), 1))) if question_reviews else 0
        miss_count = sum(1 for item in question_reviews if item.get("status") == "miss")
        warn_count = sum(1 for item in question_reviews if item.get("status") == "warn")
        good_count = sum(1 for item in question_reviews if item.get("status") == "good")
        return _normalize_review_payload({
            "readinessScore": score,
            "summary": f"本轮共 {len(question_reviews)} 题：{miss_count} 题明显失分，{warn_count} 题需要补细节，{good_count} 题已经能继续聊下去。",
            "capabilityDistribution": _default_capability_distribution(question_reviews, scope),
            "questionReviews": question_reviews,
            "strengths": ["能持续作答，没有轻易脱离问题主线。"] if question_reviews else [],
            "weaknesses": ["薄弱题里缺少机制、取舍和项目证据。"] if question_reviews else [],
            "likelyFollowups": ["你具体负责哪一段？", "为什么这样设计？", "线上怎么验证有效？"],
            "practicalNextSteps": ["先补最薄弱的主题，再做一轮同岗位专项模拟。"],
            "nextRecommendedScope": "围绕本轮最低分主题继续专项追问",
        }, scope=scope, transcript=transcript, interview_plan=interview_plan)

    def review_question(self, *, scope: Dict[str, Any], question_record: Dict[str, Any]) -> Dict[str, Any]:
        return _default_question_review(question_record)

    def rescue_material(self, *, scope: Dict[str, Any], gap: Dict[str, Any]) -> Dict[str, Any]:
        return {"markdown": _build_mock_rescue_markdown(gap)}

    def rescue_plan(self, *, scope: Dict[str, Any], review: Dict[str, Any], documents: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {"items": _default_rescue_plan(review)}

    def summarize_review(
        self,
        *,
        scope: Dict[str, Any],
        question_reviews: List[Dict[str, Any]],
        capability_distribution: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        miss_count = sum(1 for item in question_reviews if item.get("status") == "miss")
        warn_count = sum(1 for item in question_reviews if item.get("status") == "warn")
        good_count = sum(1 for item in question_reviews if item.get("status") == "good")
        readiness_score = int(round(sum(int(item.get("score") or 0) for item in question_reviews) / max(len(question_reviews), 1))) if question_reviews else 0
        weakest_topics = [item.get("topic") for item in sorted(capability_distribution, key=lambda item: int(item.get("score") or 0))[:2] if item.get("topic")]
        return {
            "readinessScore": readiness_score,
            "summary": f"本轮共 {len(question_reviews)} 题：{miss_count} 题明显失分，{warn_count} 题需要补细节，{good_count} 题已经能继续聊。优先补 {('、'.join(weakest_topics) or '当前短板主题')}。",
            "strengths": ["已经能在部分题目上给出完整回答。"] if good_count else [],
            "weaknesses": ["多个主题存在机制、取舍或项目证据缺口。"] if miss_count or warn_count else [],
            "likelyFollowups": ["你具体负责哪一段？", "为什么这样设计？", "线上怎么验证有效？"],
            "practicalNextSteps": ["先补最低分主题，再做一轮同岗位专项模拟。"],
            "nextRecommendedScope": (weakest_topics[0] if weakest_topics else "薄弱主题") + " 专项追问",
        }


class ProviderLoopAssistIntelligence:
    def __init__(self, *, provider: str, model: str, api_key: str, base_url: str = ""):
        self.provider = provider.upper()
        self.model = model
        self.api_key = api_key
        self.base_url = base_url

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _complete_json(self, prompt: str) -> Dict[str, Any]:
        text = "".join(stream_provider_text_chunks(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            prompt=prompt,
            base_url=self.base_url,
        ))
        return parse_provider_json_text(text)

    def _complete_text(self, prompt: str) -> str:
        text = "".join(stream_provider_text_chunks(
            provider=self.provider,
            api_key=self.api_key,
            model=self.model,
            prompt=prompt,
            base_url=self.base_url,
        ))
        return _strip_code_fence(text)

    def rescue_material(self, *, scope: Dict[str, Any], gap: Dict[str, Any]) -> Dict[str, Any]:
        markdown = self._complete_text(build_rescue_material_prompt(scope=scope, gap=gap))
        if not markdown:
            raise RuntimeError("LoopAssist rescue material returned empty text.")
        return {"markdown": markdown}

    def rescue_plan(self, *, scope: Dict[str, Any], review: Dict[str, Any], documents: List[Dict[str, Any]]) -> Dict[str, Any]:
        payload = self._complete_json(build_rescue_plan_prompt(scope=scope, review=review, documents=documents))
        return payload if isinstance(payload, dict) else {"items": []}

    def interview_plan(self, *, scope: Dict[str, Any], seeds: List[Dict[str, Any]]) -> Dict[str, Any]:
        payload = self._complete_json(build_interview_plan_prompt(scope=scope, seeds=seeds))
        return _normalize_interview_plan(payload, scope, seeds)

    def interviewer_message(
        self,
        *,
        scope: Dict[str, Any],
        seeds: List[Dict[str, Any]],
        transcript: List[Dict[str, Any]],
        interview_plan: Optional[Dict[str, Any]] = None,
        is_first_turn: bool = False,
    ) -> Dict[str, Any]:
        payload = self._complete_json(build_interviewer_prompt(
            scope=scope,
            seeds=seeds,
            transcript=transcript,
            interview_plan=interview_plan,
            is_first_turn=is_first_turn,
        ))
        text = _normalize(payload.get("text"))
        if not text:
            raise RuntimeError("LoopAssist interviewer returned empty text.")
        return {
            "text": text,
            "topic": _normalize(payload.get("topic")),
            "seedId": _normalize(payload.get("seedId")),
            "planStep": payload.get("planStep"),
        }

    def review(
        self,
        *,
        scope: Dict[str, Any],
        transcript: List[Dict[str, Any]],
        interview_plan: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = self._complete_json(build_review_prompt(
            scope=scope,
            transcript=transcript,
            interview_plan=interview_plan,
        ))
        return _normalize_review_payload(
            payload,
            scope=scope,
            transcript=transcript,
            interview_plan=interview_plan,
        )

    def review_question(self, *, scope: Dict[str, Any], question_record: Dict[str, Any]) -> Dict[str, Any]:
        payload = self._complete_json(build_question_review_prompt(
            scope=scope,
            question_record=question_record,
        ))
        return _normalize_question_review(payload, question_record)

    def summarize_review(
        self,
        *,
        scope: Dict[str, Any],
        question_reviews: List[Dict[str, Any]],
        capability_distribution: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        return self._complete_json(build_review_summary_prompt(
            scope=scope,
            question_reviews=question_reviews,
            capability_distribution=capability_distribution,
        ))


def _allow_mock() -> bool:
    return (
        os.environ.get("APP_ENV") == "test"
        or os.environ.get("LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE") == "1"
    )


def _create_intelligence():
    provider = str(os.environ.get("LOOPASSIST_LLM_PROVIDER") or os.environ.get("INTERVIEW_ASSIST_LLM_PROVIDER") or os.environ.get("LLAI_LLM_PROVIDER") or "OPENAI").upper()
    if provider == "MOCK" or _allow_mock():
        return MockLoopAssistIntelligence()
    if provider == "DEEPSEEK":
        return ProviderLoopAssistIntelligence(
            provider="DEEPSEEK",
            model=os.environ.get("LOOPASSIST_DEEPSEEK_MODEL", os.environ.get("LLAI_DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL)),
            api_key=os.environ.get("LOOPASSIST_DEEPSEEK_API_KEY", os.environ.get("LLAI_DEEPSEEK_API_KEY", "")),
            base_url=os.environ.get("LOOPASSIST_DEEPSEEK_BASE_URL", os.environ.get("LLAI_DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL)),
        )
    return ProviderLoopAssistIntelligence(
        provider="OPENAI",
        model=os.environ.get("LOOPASSIST_OPENAI_MODEL", os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)),
        api_key=os.environ.get("LOOPASSIST_OPENAI_API_KEY", os.environ.get("OPENAI_API_KEY", "")),
    )


def _require_intelligence():
    intelligence = _create_intelligence()
    if intelligence and getattr(intelligence, "configured", False):
        return intelligence
    raise RuntimeError("LoopAssist LLM provider is not configured.")


def _turn(role: str, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "turnId": f"loop_turn_{uuid4().hex[:10]}",
        "role": role,
        "text": _normalize(text),
        "createdAt": _now_ms(),
        **(metadata or {}),
    }


def _interviewer_turn_count(session: Dict[str, Any]) -> int:
    return sum(1 for turn in session.get("transcript") or [] if turn.get("role") == "interviewer")


def _remaining_budget(session: Dict[str, Any]) -> int:
    return max(0, int(session.get("questionBudget") or 8) - _interviewer_turn_count(session))


def _session_completed(session: Dict[str, Any]) -> bool:
    return _remaining_budget(session) <= 0


def _public_session(session: Dict[str, Any], interviewer_message: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "sessionId": session["sessionId"],
        "scope": session.get("scope") or {},
        "transcript": session.get("transcript") or [],
        "interviewerMessage": interviewer_message,
        "interviewPlan": session.get("interviewPlan") or {},
        "remainingBudget": _remaining_budget(session),
        "completed": _session_completed(session),
        "createdAt": session.get("createdAt"),
    }


def create_loopassist_session(*, scope: Dict[str, Any], seeds: List[Dict[str, Any]], user_id: str = "") -> Dict[str, Any]:
    session_id = f"loop_{uuid4().hex[:12]}"
    scope = dict(scope or {})
    scope["questionBudget"] = int(scope.get("questionBudget") or 8)
    session = {
        "sessionId": session_id,
        "userId": user_id,
        "scope": scope,
        "seeds": seeds[:12],
        "questionBudget": scope["questionBudget"],
        "transcript": [],
        "createdAt": _now_ms(),
    }
    intelligence = _require_intelligence()
    session["interviewPlan"] = intelligence.interview_plan(scope=scope, seeds=session["seeds"])
    message = intelligence.interviewer_message(
        scope=scope,
        seeds=session["seeds"],
        transcript=[],
        interview_plan=session["interviewPlan"],
        is_first_turn=True,
    )
    session["transcript"].append(_turn("interviewer", message["text"], {
        "topic": message.get("topic", ""),
        "seedId": message.get("seedId", ""),
        "planStep": message.get("planStep"),
    }))
    LOOPASSIST_SESSIONS[session_id] = session
    LOOPASSIST_LOCKS[session_id] = threading.Lock()
    set_session_context(session_id=session_id, turn=1)
    logger.event(
        "loopassist_session_started",
        session_id=session_id,
        seed_count=len(session["seeds"]),
        plan_steps=len(session.get("interviewPlan", {}).get("stages") or []),
    )
    return _public_session(session, message)


def answer_loopassist(*, session_id: str, answer: str) -> Dict[str, Any]:
    session = LOOPASSIST_SESSIONS.get(session_id)
    if not session:
      raise KeyError("Unknown LoopAssist session.")
    lock = LOOPASSIST_LOCKS.setdefault(session_id, threading.Lock())
    with lock:
        session["transcript"].append(_turn("candidate", answer))
        if _session_completed(session):
            set_session_context(session_id=session_id, turn=len(session.get("transcript") or []))
            return _public_session(session, None)
        intelligence = _require_intelligence()
        message = intelligence.interviewer_message(
            scope=session.get("scope") or {},
            seeds=session.get("seeds") or [],
            transcript=session.get("transcript") or [],
            interview_plan=session.get("interviewPlan") or {},
            is_first_turn=False,
        )
        session["transcript"].append(_turn("interviewer", message["text"], {
            "topic": message.get("topic", ""),
            "seedId": message.get("seedId", ""),
            "planStep": message.get("planStep"),
        }))
        set_session_context(session_id=session_id, turn=len(session.get("transcript") or []))
        return _public_session(session, message)


def stream_loopassist_answer(*, session_id: str, answer: str, emit: Callable[[str, Dict[str, Any]], None]) -> None:
    session = answer_loopassist(session_id=session_id, answer=answer)
    text = _normalize((session.get("interviewerMessage") or {}).get("text"))
    if text:
        step = max(12, len(text) // 5)
        for index in range(0, len(text), step):
            emit("reply_delta", {"delta": text[index:index + step]})
        emit("interviewer_message", session.get("interviewerMessage") or {})
    emit("session", session)


def review_loopassist_session(*, session_id: str) -> Dict[str, Any]:
    session = LOOPASSIST_SESSIONS.get(session_id)
    if not session:
      raise KeyError("Unknown LoopAssist session.")
    intelligence = _require_intelligence()
    review = intelligence.review(
        scope=session.get("scope") or {},
        transcript=session.get("transcript") or [],
        interview_plan=session.get("interviewPlan") or {},
    )
    return {
        "sessionId": session_id,
        "review": review,
        "transcript": session.get("transcript") or [],
    }


def review_loopassist_question(*, session_id: str, question_number: int) -> Dict[str, Any]:
    session = LOOPASSIST_SESSIONS.get(session_id)
    if not session:
        raise KeyError("Unknown LoopAssist session.")
    question_records = _question_turn_records(session.get("transcript") or [], session.get("interviewPlan") or {})
    if question_number < 1 or question_number > len(question_records):
        raise KeyError("Unknown LoopAssist question.")
    intelligence = _require_intelligence()
    question_record = question_records[question_number - 1]
    review = intelligence.review_question(
        scope=session.get("scope") or {},
        question_record=question_record,
    )
    return {
        "sessionId": session_id,
        "questionReview": _normalize_question_review(review, question_record),
    }


def summarize_loopassist_review(*, session_id: str, question_reviews: List[Dict[str, Any]]) -> Dict[str, Any]:
    session = LOOPASSIST_SESSIONS.get(session_id)
    if not session:
        raise KeyError("Unknown LoopAssist session.")
    normalized_question_reviews = [
        _normalize_question_review(item, item)
        for item in question_reviews
        if isinstance(item, dict)
    ]
    capability_distribution = _default_capability_distribution(normalized_question_reviews, session.get("scope") or {})
    intelligence = _require_intelligence()
    summary_payload = intelligence.summarize_review(
        scope=session.get("scope") or {},
        question_reviews=normalized_question_reviews,
        capability_distribution=capability_distribution,
    )
    review = {
        **summary_payload,
        "capabilityDistribution": capability_distribution,
        "questionReviews": normalized_question_reviews,
    }
    return {
        "sessionId": session_id,
        "review": _normalize_review_payload(
            review,
            scope=session.get("scope") or {},
            transcript=session.get("transcript") or [],
            interview_plan=session.get("interviewPlan") or {},
        ),
    }


def generate_loopassist_rescue_material(*, scope: Dict[str, Any], gap: Dict[str, Any]) -> Dict[str, Any]:
    intelligence = _require_intelligence()
    return intelligence.rescue_material(scope=scope or {}, gap=gap or {})


def plan_loopassist_rescue(
    *,
    scope: Dict[str, Any],
    review: Dict[str, Any],
    documents: List[Dict[str, Any]],
) -> Dict[str, Any]:
    intelligence = _require_intelligence()
    payload = intelligence.rescue_plan(scope=scope or {}, review=review or {}, documents=documents or [])
    return _normalize_rescue_plan(payload, documents=documents or [])
