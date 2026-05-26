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


def _format_seed(seed: Dict[str, Any], index: int) -> str:
    return "\n".join([
        f"{index}. seedId={seed.get('seedId', '')}",
        f"题目：{seed.get('baseQuestion', '')}",
        f"主题：{'、'.join(seed.get('topics') or [])}",
        f"追问角度：{'；'.join(seed.get('followupAngles') or [])}",
        f"强回答信号：{'；'.join(seed.get('strongAnswerSignals') or [])}",
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
        lines.append(
            "；".join([
                f"第{stage.get('step')}问",
                f"主题={stage.get('theme', '')}",
                f"seedId={stage.get('seedId', '')}",
                f"原始题={stage.get('baseQuestion', '')}",
                f"目标={stage.get('objective', '')}",
                f"允许追问={'; '.join(stage.get('allowedFollowups') or [])}",
            ])
        )
    guardrails = interview_plan.get("guardrails") or []
    if guardrails:
        lines.append("计划约束：" + " / ".join(_normalize_list(guardrails)))
    return "\n".join(lines)


def build_interview_plan_prompt(*, scope: Dict[str, Any], seeds: List[Dict[str, Any]]) -> str:
    seed_block = "\n\n".join(_format_seed(seed, index + 1) for index, seed in enumerate(seeds[:12]))
    return "\n".join([
        "你是 LoopAssist 的模拟面试规划官。",
        "你要先生成一份可展示给候选人的面试大纲，同时这份大纲会约束后续面试官逐轮提问。",
        "大纲必须综合候选人简历、目标岗位 JD、用户所选岗位/轮次/主题，以及真实面经题源。",
        "如果简历或 JD 未提供，不要编造，只根据已提供信息和题源规划。",
        "不要用固定模板机械列题；要解释为什么这么安排，以及每个题目方向来自哪里。",
        "输出必须是合法 JSON，不要输出 Markdown、解释性前后缀或内部推理。",
        "JSON 字段必须包含：title, rationale, sourceExplanation, stages, guardrails。",
        "stages 是数组，每项包含：step, theme, objective, source, seedId, baseQuestion, allowedFollowups, strongSignals。",
        "stage 数量应接近 questionBudget；如果题源不足，可以复用主题但要说明验证目标不同。",
        "",
        f"选定 scope：{_format_scope(scope)}",
        "",
        "候选人简历与岗位 JD 上下文：",
        _format_candidate_context(scope),
        "",
        "真实面经题源（只供规划和出题来源说明）：",
        seed_block or "无题源，按 scope 自然规划。",
    ])


def _coerce_plan_stage(stage: Dict[str, Any], index: int) -> Dict[str, Any]:
    return {
        "step": int(stage.get("step") or index + 1),
        "theme": _normalize(stage.get("theme") or "综合"),
        "objective": _normalize(stage.get("objective") or "验证候选人对当前主题的真实掌握和项目证据。"),
        "source": _normalize(stage.get("source") or "由简历、岗位 JD 与真实面经题源综合生成。"),
        "seedId": _normalize(stage.get("seedId")),
        "baseQuestion": _normalize(stage.get("baseQuestion") or "请结合一个具体项目场景展开说明。"),
        "allowedFollowups": _normalize_list(stage.get("allowedFollowups"))[:4],
        "strongSignals": _normalize_list(stage.get("strongSignals"))[:4],
    }


def _normalize_interview_plan(payload: Dict[str, Any], scope: Dict[str, Any], seeds: List[Dict[str, Any]]) -> Dict[str, Any]:
    question_budget = max(1, int(scope.get("questionBudget") or 8))
    stages = [
        _coerce_plan_stage(stage, index)
        for index, stage in enumerate((payload.get("stages") or [])[:question_budget])
        if isinstance(stage, dict)
    ]
    if not stages:
        stages = [
            _coerce_plan_stage({
                "theme": (seed.get("topics") or ["综合"])[0],
                "source": "来自真实面经题源。",
                "seedId": seed.get("seedId", ""),
                "baseQuestion": seed.get("baseQuestion", ""),
                "allowedFollowups": seed.get("followupAngles") or [],
                "strongSignals": seed.get("strongAnswerSignals") or [],
            }, index)
            for index, seed in enumerate((seeds or [])[:question_budget])
        ]
    return {
        "title": _normalize(payload.get("title") or "本轮模拟面试大纲"),
        "rationale": _normalize(payload.get("rationale") or "根据候选人材料、岗位要求和真实面经题源安排本轮问题顺序。"),
        "sourceExplanation": _normalize(payload.get("sourceExplanation") or "题目来源于用户选择的岗位面经，并结合简历与 JD 做方向约束。"),
        "stages": stages,
        "guardrails": _normalize_list(payload.get("guardrails"))[:5] or [
            "后续提问应围绕大纲主题推进。",
            "候选人回答只影响追问切入点和深度，不应让面试偏离岗位目标。",
        ],
    }


def build_interviewer_prompt(
    *,
    scope: Dict[str, Any],
    seeds: List[Dict[str, Any]],
    transcript: List[Dict[str, Any]],
    interview_plan: Optional[Dict[str, Any]] = None,
    is_first_turn: bool = False,
) -> str:
    seed_block = "\n\n".join(_format_seed(seed, index + 1) for index, seed in enumerate(seeds[:12]))
    remaining_budget = max(1, int(scope.get("questionBudget") or 8) - sum(1 for turn in transcript if turn.get("role") == "interviewer"))
    return "\n".join([
        "你是 LoopAssist 的真实模拟面试官。",
        "你只输出下一句面试官要说的话。不要输出评分、诊断、答案提示、题源说明、JSON 以外的解释或内部推理。",
        "面试过程必须像真人持续问答，但每一问都要基本符合内部面试计划，不能因为上一轮回答随意跑到计划外主题。",
        "根据候选人的上一轮回答自然追问：短回答追当前计划步骤的项目证据；扎实回答再推进到下一计划步骤或相邻主题。",
        "如果刚开始，优先使用当前计划步骤绑定的真实面经题源作为开场问题。",
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
        "真实面经题源（只供你出题和追问，不要向用户展示题源）：",
        seed_block or "无题源，按 scope 自然出题。",
        "",
        "当前完整 transcript：",
        _format_transcript(transcript),
    ])


def build_review_prompt(*, scope: Dict[str, Any], transcript: List[Dict[str, Any]]) -> str:
    return "\n".join([
        "你是严格但务实的面试复盘官。只基于完整 transcript 做最终复盘。",
        "输出合法 JSON，字段必须包含：readinessScore, summary, topicPerformance, strengths, weaknesses, likelyFollowups, practicalNextSteps, nextRecommendedScope。",
        "readinessScore 是 0-100 整数。topicPerformance 是数组，每项包含 topic, verdict, evidence。",
        "不要评价未发生的内容；如果证据不足，请明确说证据不足。",
        "",
        f"选定 scope：{_format_scope(scope)}",
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
        source_bits = ["真实面经题源"]
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

    def review(self, *, scope: Dict[str, Any], transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
        candidate_turns = [turn for turn in transcript if turn.get("role") == "candidate"]
        total_chars = sum(len(_normalize(turn.get("text"))) for turn in candidate_turns)
        score = max(35, min(82, 40 + len(candidate_turns) * 8 + total_chars // 40))
        topics = scope.get("topics") if isinstance(scope.get("topics"), list) else []
        return {
            "readinessScore": score,
            "summary": "这是一轮基于真实面经题源的模拟复盘。当前回答能进入对话，但还需要更多项目细节、指标和权衡来支撑。",
            "topicPerformance": [
                {
                    "topic": topic or "综合",
                    "verdict": "证据有限，建议继续专项追问",
                    "evidence": "候选人已给出回答，但 transcript 中可量化指标和失败案例还不够充分。",
                }
                for topic in (topics or ["综合"])
            ],
            "strengths": ["能持续回应问题", "具备把问题拉回项目场景的基础"],
            "weaknesses": ["回答中可量化结果偏少", "对边界条件和排查路径展开不足"],
            "likelyFollowups": ["你具体负责哪一段？", "这个方案的瓶颈在哪里？", "线上怎么验证它真的有效？"],
            "practicalNextSteps": ["准备一个 STAR 项目案例", "为每个核心主题补一条指标和一个踩坑案例"],
            "nextRecommendedScope": "围绕本轮薄弱主题再做 6 轮追问型模拟面试",
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

    def review(self, *, scope: Dict[str, Any], transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._complete_json(build_review_prompt(scope=scope, transcript=transcript))


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
    review = intelligence.review(scope=session.get("scope") or {}, transcript=session.get("transcript") or [])
    return {
        "sessionId": session_id,
        "review": review,
        "transcript": session.get("transcript") or [],
    }
