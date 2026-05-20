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


def build_interviewer_prompt(
    *,
    scope: Dict[str, Any],
    seeds: List[Dict[str, Any]],
    transcript: List[Dict[str, Any]],
    is_first_turn: bool = False,
) -> str:
    seed_block = "\n\n".join(_format_seed(seed, index + 1) for index, seed in enumerate(seeds[:12]))
    remaining_budget = max(1, int(scope.get("questionBudget") or 8) - sum(1 for turn in transcript if turn.get("role") == "interviewer"))
    return "\n".join([
        "你是 LoopAssist 的真实模拟面试官。",
        "你只输出下一句面试官要说的话。不要输出评分、诊断、答案提示、题源说明、JSON 以外的解释或内部推理。",
        "面试过程必须像真人持续问答：根据候选人的上一轮回答自然追问；如果刚开始，则从题源里挑一个最贴合 scope 的开场问题。",
        "面试风格要求体现在措辞和追问压力里，但不要说“现在进入某某风格”。",
        "如果候选人回答太短，可以要求补细节；如果回答扎实，可以换到相关主题或更深一层。",
        "输出必须是合法 JSON：{\"text\":\"...\",\"topic\":\"可选主题\",\"seedId\":\"可选seedId\"}",
        "",
        f"选定 scope：{_format_scope(scope)}",
        f"剩余可问轮次约：{remaining_budget}",
        f"是否第一句：{str(is_first_turn).lower()}",
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

    def interviewer_message(self, *, scope: Dict[str, Any], seeds: List[Dict[str, Any]], transcript: List[Dict[str, Any]], is_first_turn: bool = False) -> Dict[str, Any]:
        interviewer_turns = [turn for turn in transcript if turn.get("role") == "interviewer"]
        candidate_turns = [turn for turn in transcript if turn.get("role") == "candidate"]
        seed = seeds[min(len(interviewer_turns), max(0, len(seeds) - 1))] if seeds else {}
        if is_first_turn or not candidate_turns:
            text = f"我们先从一个真实面经里很常见的问题开始：{seed.get('baseQuestion') or '介绍一下你最近做的一个项目，以及你负责的核心部分。'}"
        else:
            answer = _normalize(candidate_turns[-1].get("text"))
            if len(answer) < 24:
                text = "这个回答还比较概括。你能结合一个具体项目场景，把你的做法、为什么这么做、以及结果讲完整一点吗？"
            else:
                angle = (seed.get("followupAngles") or ["如果线上出现异常，你会怎么定位？"])[0]
                text = f"好，继续追一下：{angle}"
        return {
            "text": text,
            "topic": (seed.get("topics") or ["综合"])[0],
            "seedId": seed.get("seedId", ""),
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

    def interviewer_message(self, *, scope: Dict[str, Any], seeds: List[Dict[str, Any]], transcript: List[Dict[str, Any]], is_first_turn: bool = False) -> Dict[str, Any]:
        payload = self._complete_json(build_interviewer_prompt(
            scope=scope,
            seeds=seeds,
            transcript=transcript,
            is_first_turn=is_first_turn,
        ))
        text = _normalize(payload.get("text"))
        if not text:
            raise RuntimeError("LoopAssist interviewer returned empty text.")
        return {
            "text": text,
            "topic": _normalize(payload.get("topic")),
            "seedId": _normalize(payload.get("seedId")),
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


def _public_session(session: Dict[str, Any], interviewer_message: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "sessionId": session["sessionId"],
        "scope": session.get("scope") or {},
        "transcript": session.get("transcript") or [],
        "interviewerMessage": interviewer_message,
        "remainingBudget": max(0, int(session.get("questionBudget") or 8) - sum(1 for turn in session.get("transcript") or [] if turn.get("role") == "interviewer")),
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
    message = intelligence.interviewer_message(scope=scope, seeds=session["seeds"], transcript=[], is_first_turn=True)
    session["transcript"].append(_turn("interviewer", message["text"], {
        "topic": message.get("topic", ""),
        "seedId": message.get("seedId", ""),
    }))
    LOOPASSIST_SESSIONS[session_id] = session
    LOOPASSIST_LOCKS[session_id] = threading.Lock()
    set_session_context(session_id=session_id, turn=1)
    logger.event("loopassist_session_started", session_id=session_id, seed_count=len(session["seeds"]))
    return _public_session(session, message)


def answer_loopassist(*, session_id: str, answer: str) -> Dict[str, Any]:
    session = LOOPASSIST_SESSIONS.get(session_id)
    if not session:
      raise KeyError("Unknown LoopAssist session.")
    lock = LOOPASSIST_LOCKS.setdefault(session_id, threading.Lock())
    with lock:
        session["transcript"].append(_turn("candidate", answer))
        intelligence = _require_intelligence()
        message = intelligence.interviewer_message(
            scope=session.get("scope") or {},
            seeds=session.get("seeds") or [],
            transcript=session.get("transcript") or [],
            is_first_turn=False,
        )
        session["transcript"].append(_turn("interviewer", message["text"], {
            "topic": message.get("topic", ""),
            "seedId": message.get("seedId", ""),
        }))
        set_session_context(session_id=session_id, turn=len(session.get("transcript") or []))
        return _public_session(session, message)


def stream_loopassist_answer(*, session_id: str, answer: str, emit: Callable[[str, Dict[str, Any]], None]) -> None:
    session = answer_loopassist(session_id=session_id, answer=answer)
    text = _normalize((session.get("interviewerMessage") or {}).get("text"))
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
