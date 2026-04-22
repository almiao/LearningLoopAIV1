from __future__ import annotations

import os
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

from app.core.tracing import set_session_context, trace_id_var
from app.engine.tutor_intelligence import (
    DEFAULT_DEEPSEEK_BASE_URL,
    DEFAULT_DEEPSEEK_MODEL,
    DEFAULT_OPENAI_MODEL,
    call_deepseek_text,
    call_openai_text,
    stream_deepseek_text_chunks,
)
from app.observability import events
from app.observability.logger import logger


ASSIST_SESSIONS: Dict[str, Dict[str, Any]] = {}
ASSIST_SESSION_LOCKS: Dict[str, threading.Lock] = {}
DEFAULT_FRAMEWORK_POINT_COUNT = int(os.environ.get("INTERVIEW_ASSIST_FRAMEWORK_POINTS", "3"))
DETAIL_TAG = "</detail>"
FRAMEWORK_OPEN = "<framework>"
FRAMEWORK_CLOSE = "</framework>"
VOICE_DEMO_DIR = os.environ.get("INTERVIEW_ASSIST_VOICE_DEMO_DIR", ".omx/interview-assist/voice-demos")


def _normalize(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _recent_turns(session: Dict[str, Any], limit: int = 2) -> List[Dict[str, Any]]:
    return list(session.get("turns") or [])[-limit:]


def _format_recent_turns(turns: List[Dict[str, Any]]) -> str:
    if not turns:
        return "无历史轮次。"

    blocks = []
    for index, turn in enumerate(turns, start=1):
        lines = [f"历史轮次 {index}"]
        question_text = _normalize(turn.get("questionText"))
        if question_text:
            lines.append(f"面试官：{question_text}")
        framework_points = [
            _normalize(item) for item in (turn.get("frameworkPoints") or []) if _normalize(item)
        ]
        if framework_points:
            lines.append("框架：")
            lines.extend(f"{point_index}. {point}" for point_index, point in enumerate(framework_points, start=1))
        detail_blocks = [_normalize(item) for item in (turn.get("detailBlocks") or []) if _normalize(item)]
        if detail_blocks:
            lines.append("展开：")
            lines.extend(f"{point_index}. {detail}" for point_index, detail in enumerate(detail_blocks, start=1))
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _parse_framework_points(text: str) -> List[str]:
    lines = []
    for raw_line in text.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s*", "", raw_line.strip())
        if cleaned:
            lines.append(cleaned)
    points = [_normalize(line) for line in lines if _normalize(line)]
    if len(points) < DEFAULT_FRAMEWORK_POINT_COUNT:
        raise ValueError("Interview assist framework output returned too few framework points.")
    return points[:DEFAULT_FRAMEWORK_POINT_COUNT]


def _framework_prompt(question_text: str, recent_turns: List[Dict[str, Any]]) -> str:
    return "\n".join(
        [
            "你是一个实时面试辅助模型。",
            "目标：在用户听到完整面试题后，先给一套可以马上开口组织语言的回答框架，再逐点展开细节。",
            "请严格按下面的标签协议输出，不要输出标签外的任何文字。",
            "",
            "输出格式必须完全遵守：",
            "<framework>",
            "1. 第一条框架点",
            "2. 第二条框架点",
            "3. 第三条框架点",
            "</framework>",
            "<detail index=\"1\">第一条框架点的展开内容，1-2句，口语化。</detail>",
            "<detail index=\"2\">第二条框架点的展开内容，1-2句，口语化。</detail>",
            "<detail index=\"3\">第三条框架点的展开内容，1-2句，口语化。</detail>",
            "",
            f"必须先完整输出 {DEFAULT_FRAMEWORK_POINT_COUNT} 条框架点并关闭 </framework>，然后才能开始任何 <detail>。",
            "框架点要求 8-20 个字，直接可说，覆盖：结论主线、核心机制/论据、项目场景/边界取舍。",
            "detail 要和对应框架点一一对应，每条 1-2 句，能被用户直接复述。",
            "",
            f"当前问题：{question_text}",
            "",
            "历史上下文（仅供参考）：",
            _format_recent_turns(recent_turns),
        ]
    )


class MockInterviewAssistIntelligence:
    provider = "MOCK"
    model = "mock-interview-assist-v1"
    configured = True

    def stream_answer(self, *, question_text: str, recent_turns: List[Dict[str, Any]]) -> List[str]:
        question = _normalize(question_text) or "当前问题"
        framework_points = [
            f"先回答：{question[:18]}",
            "补核心机制和关键依据",
            "落到项目场景与取舍",
        ][: DEFAULT_FRAMEWORK_POINT_COUNT]
        context_note = ""
        if recent_turns:
            context_note = " 上一轮内容可以顺手带一句，形成连续回答。"
        details = [
            f"先直接给结论，说明你会怎么回答这个问题，再把重点收在 {framework_points[0]}。{context_note}".strip(),
            f"然后讲清楚这件事背后的关键机制、为什么这么做，以及它成立的前提条件，围绕 {framework_points[1]} 往下展开。",
            f"最后补一个真实项目里的使用场景、收益或边界取舍，把回答落在经验层，收束到 {framework_points[2]}。",
        ][: len(framework_points)]
        full_text = "\n".join(
            [
                "<framework>",
                *[f"{index}. {point}" for index, point in enumerate(framework_points, start=1)],
                "</framework>",
                *[
                    f"<detail index=\"{index + 1}\">{detail}</detail>"
                    for index, detail in enumerate(details)
                ],
            ]
        )
        step = max(24, len(full_text) // 5)
        return [full_text[index : index + step] for index in range(0, len(full_text), step)]


class ProviderInterviewAssistIntelligence:
    def __init__(self, *, provider: str, model: str, api_key: str, base_url: str = ""):
        self.provider = provider.upper()
        self.model = model
        self.api_key = api_key
        self.base_url = base_url

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def stream_answer(self, *, question_text: str, recent_turns: List[Dict[str, Any]]) -> List[str]:
        prompt = _framework_prompt(question_text, recent_turns)
        if self.provider == "DEEPSEEK":
            return list(
                stream_deepseek_text_chunks(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    base_url=self.base_url or DEFAULT_DEEPSEEK_BASE_URL,
                )
            )
        text = call_openai_text(api_key=self.api_key, model=self.model, prompt=prompt)
        return [text] if text else []


def _create_interview_assist_intelligence():
    provider = str(os.environ.get("INTERVIEW_ASSIST_LLM_PROVIDER", "OPENAI")).upper()
    if provider == "MOCK":
        return MockInterviewAssistIntelligence()
    if provider == "DEEPSEEK":
        return ProviderInterviewAssistIntelligence(
            provider="DEEPSEEK",
            model=os.environ.get("INTERVIEW_ASSIST_DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL),
            api_key=os.environ.get("INTERVIEW_ASSIST_DEEPSEEK_API_KEY", os.environ.get("LLAI_DEEPSEEK_API_KEY", "")),
            base_url=os.environ.get("INTERVIEW_ASSIST_DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL),
        )
    return ProviderInterviewAssistIntelligence(
        provider="OPENAI",
        model=os.environ.get("INTERVIEW_ASSIST_OPENAI_MODEL", os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)),
        api_key=os.environ.get("INTERVIEW_ASSIST_OPENAI_API_KEY", os.environ.get("OPENAI_API_KEY", "")),
    )


def _require_intelligence():
    intelligence = _create_interview_assist_intelligence()
    if intelligence and getattr(intelligence, "configured", False):
        return intelligence
    raise RuntimeError("Interview assist pure-LLM mode is required but no provider is configured.")


def create_assist_session(*, target_role: str) -> Dict[str, Any]:
    session_id = f"assist_{uuid4().hex[:12]}"
    session = {
        "sessionId": session_id,
        "targetRole": _normalize(target_role) or "java-backend",
        "createdAt": int(time.time() * 1000),
        "turns": [],
        "turnCounter": 0,
        "activeTurnIds": [],
        "transportMode": "mock",
        "roomName": f"interview_assist_{session_id}",
        "participantToken": "",
    }
    ASSIST_SESSIONS[session_id] = session
    ASSIST_SESSION_LOCKS[session_id] = threading.Lock()
    set_session_context(session_id=session_id, turn=0)
    logger.event(
        events.ASSIST_SESSION_STARTED,
        session_id=session_id,
        target_role=session["targetRole"],
        transport_mode=session["transportMode"],
    )
    return dict(session)


def create_realtime_session(
    *,
    self_role: str,
    mode: str,
    resume_text: str = "",
) -> Dict[str, Any]:
    session_id = f"assist_{uuid4().hex[:12]}"
    normalized_role = _normalize(self_role) or "candidate"
    normalized_mode = _normalize(mode) or "assist_candidate"
    session = {
        "sessionId": session_id,
        "selfRole": normalized_role,
        "mode": normalized_mode,
        "status": "created",
        "createdAt": int(time.time() * 1000),
        "voiceDemoUploaded": False,
        "voiceDemoPath": "",
        "resumeText": _normalize(resume_text),
        "turns": [],
        "turnCounter": 0,
        "activeTurnIds": [],
    }
    ASSIST_SESSIONS[session_id] = session
    ASSIST_SESSION_LOCKS[session_id] = threading.Lock()
    set_session_context(session_id=session_id, turn=0)
    return dict(session)


def store_voice_demo(*, session_id: str, filename: str, body: bytes) -> Dict[str, Any]:
    session = ASSIST_SESSIONS.get(session_id)
    if not session:
        raise KeyError("Unknown interview assist session.")
    os.makedirs(VOICE_DEMO_DIR, exist_ok=True)
    extension = os.path.splitext(filename or "")[1] or ".bin"
    demo_path = os.path.join(VOICE_DEMO_DIR, f"{session_id}{extension}")
    with open(demo_path, "wb") as output:
        output.write(body)
    session["voiceDemoUploaded"] = True
    session["voiceDemoPath"] = demo_path
    session["status"] = "ready"
    return {
        "sessionId": session_id,
        "voiceDemoUploaded": True,
        "voiceDemoPath": demo_path,
        "status": session["status"],
    }


def _create_turn_metadata(*, session: Dict[str, Any], question_text: str, question_ended_at: int) -> Dict[str, Any]:
    session["turnCounter"] = int(session.get("turnCounter", 0)) + 1
    turn_id = f"{session['sessionId']}_turn_{session['turnCounter']}"
    return {
        "turnId": turn_id,
        "questionText": question_text,
        "questionEndedAt": question_ended_at,
        "traceId": trace_id_var.get(),
    }


def _detail_open_tag(index: int) -> str:
    return f"<detail index=\"{index + 1}\">"


def _should_flush_detail_delta(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    if len(stripped) >= 16:
        return True
    return stripped.endswith(("。", "！", "？", ".", "!", "?", "；", ";", "，", ","))


def stream_assist_answer(
    *,
    session_id: str,
    question_text: str,
    question_ended_at: Optional[int],
    emit: Callable[[str, Dict[str, Any]], None],
) -> Dict[str, Any]:
    session = ASSIST_SESSIONS.get(session_id)
    if not session:
        raise KeyError("Unknown interview assist session.")
    session_lock = ASSIST_SESSION_LOCKS.setdefault(session_id, threading.Lock())
    with session_lock:
        question = _normalize(question_text)
        ended_at = int(question_ended_at or time.time() * 1000)
        started_at = time.time()
        recent_turns = _recent_turns(session)
        set_session_context(session_id=session_id, turn=len(session["turns"]) + 1)
        meta = _create_turn_metadata(session=session, question_text=question, question_ended_at=ended_at)
        session["activeTurnIds"].append(meta["turnId"])

        try:
            logger.event(events.QUESTION_END_DETECTED, session_id=session_id, turn_id=meta["turnId"], question_text_chars=len(question))
            logger.event(events.FIRST_SCREEN_GENERATION_STARTED, session_id=session_id, turn_id=meta["turnId"])

            intelligence = _require_intelligence()
            stream_chunks = intelligence.stream_answer(question_text=question, recent_turns=recent_turns)
            stream_buffer = ""
            framework_buffer = ""
            framework_points: List[str] = []
            detail_blocks = [""] * DEFAULT_FRAMEWORK_POINT_COUNT
            detail_pending = [""] * DEFAULT_FRAMEWORK_POINT_COUNT
            detail_started: set[int] = set()
            detail_done: set[int] = set()
            current_detail_index: Optional[int] = None
            framework_started = False
            framework_emitted = False
            framework_latency_ms = 0

            for chunk in stream_chunks:
                stream_buffer += chunk or ""

                if not framework_emitted:
                    if not framework_started:
                        open_index = stream_buffer.find(FRAMEWORK_OPEN)
                        if open_index < 0:
                            stream_buffer = stream_buffer[-(len(FRAMEWORK_OPEN) - 1) :]
                            continue
                        stream_buffer = stream_buffer[open_index + len(FRAMEWORK_OPEN) :]
                        framework_started = True
                    close_index = stream_buffer.find(FRAMEWORK_CLOSE)
                    if close_index >= 0:
                        framework_buffer += stream_buffer[:close_index]
                        framework_points = _parse_framework_points(framework_buffer)
                        framework_latency_ms = int((time.time() - started_at) * 1000)
                        for index, point in enumerate(framework_points):
                            emit(
                                "framework_delta",
                                {
                                    "sessionId": session_id,
                                    "turnId": meta["turnId"],
                                    "questionText": question,
                                    "index": index,
                                    "point": point,
                                },
                            )
                        logger.event(
                            events.FIRST_SCREEN_READY,
                            session_id=session_id,
                            turn_id=meta["turnId"],
                            latency_ms=framework_latency_ms,
                            key_points_count=len(framework_points),
                        )
                        emit(
                            "framework_done",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "traceId": meta["traceId"],
                                "questionText": question,
                                "frameworkPoints": framework_points,
                                "frameworkLatencyMs": framework_latency_ms,
                                "contextTurnsUsed": len(recent_turns),
                            },
                        )
                        framework_emitted = True
                        logger.event(events.EXPANSION_READY, session_id=session_id, turn_id=meta["turnId"])
                        stream_buffer = stream_buffer[close_index + len(FRAMEWORK_CLOSE) :]
                    else:
                        safe_length = max(0, len(stream_buffer) - (len(FRAMEWORK_CLOSE) - 1))
                        if safe_length > 0:
                            framework_buffer += stream_buffer[:safe_length]
                            stream_buffer = stream_buffer[safe_length:]
                        continue

                while framework_emitted:
                    if current_detail_index is None:
                        match = re.search(r"<detail index=\"(\d+)\">", stream_buffer)
                        if not match:
                            break
                        next_index = int(match.group(1)) - 1
                        if next_index < 0 or next_index >= len(framework_points):
                            raise ValueError("Interview assist detail output returned an invalid detail index.")
                        current_detail_index = next_index
                        if current_detail_index not in detail_started:
                            emit(
                                "detail_start",
                                {
                                    "sessionId": session_id,
                                    "turnId": meta["turnId"],
                                    "index": current_detail_index,
                                    "title": framework_points[current_detail_index],
                                },
                            )
                            detail_started.add(current_detail_index)
                        stream_buffer = stream_buffer[match.end() :]
                        continue

                    close_index = stream_buffer.find(DETAIL_TAG)
                    if close_index >= 0:
                        delta = stream_buffer[:close_index]
                        if delta:
                            detail_pending[current_detail_index] += delta
                        if detail_pending[current_detail_index].strip():
                            detail_blocks[current_detail_index] += detail_pending[current_detail_index]
                            emit(
                                "detail_delta",
                                {
                                    "sessionId": session_id,
                                    "turnId": meta["turnId"],
                                    "index": current_detail_index,
                                    "delta": detail_pending[current_detail_index],
                                },
                            )
                            detail_pending[current_detail_index] = ""
                        detail_blocks[current_detail_index] = _normalize(detail_blocks[current_detail_index])
                        emit(
                            "detail_done",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "index": current_detail_index,
                                "detail": detail_blocks[current_detail_index],
                            },
                        )
                        detail_done.add(current_detail_index)
                        stream_buffer = stream_buffer[close_index + len(DETAIL_TAG) :]
                        current_detail_index = None
                        continue

                    safe_length = max(0, len(stream_buffer) - (len(DETAIL_TAG) - 1))
                    if safe_length <= 0:
                        break
                    delta = stream_buffer[:safe_length]
                    detail_pending[current_detail_index] += delta
                    if _should_flush_detail_delta(detail_pending[current_detail_index]):
                        detail_blocks[current_detail_index] += detail_pending[current_detail_index]
                        emit(
                            "detail_delta",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "index": current_detail_index,
                                "delta": detail_pending[current_detail_index],
                            },
                        )
                        detail_pending[current_detail_index] = ""
                    stream_buffer = stream_buffer[safe_length:]
                    break

            if not framework_emitted:
                raise ValueError("Interview assist model output did not produce a complete framework block.")
            if current_detail_index is not None:
                if detail_pending[current_detail_index].strip():
                    detail_blocks[current_detail_index] += detail_pending[current_detail_index]
                    emit(
                        "detail_delta",
                        {
                            "sessionId": session_id,
                            "turnId": meta["turnId"],
                            "index": current_detail_index,
                            "delta": detail_pending[current_detail_index],
                        },
                    )
                    detail_pending[current_detail_index] = ""
                detail_blocks[current_detail_index] = _normalize(detail_blocks[current_detail_index])
                emit(
                    "detail_done",
                    {
                        "sessionId": session_id,
                        "turnId": meta["turnId"],
                        "index": current_detail_index,
                        "detail": detail_blocks[current_detail_index],
                    },
                )
                detail_done.add(current_detail_index)
            detail_blocks = [_normalize(item) for item in detail_blocks[: len(framework_points)]]
            if len(detail_done) < len(framework_points):
                raise ValueError("Interview assist model output did not complete all detail blocks.")

            total_latency_ms = int((time.time() - started_at) * 1000)
            turn_record = {
                "turnId": meta["turnId"],
                "questionText": question,
                "frameworkPoints": framework_points,
                "detailBlocks": detail_blocks,
                "questionEndedAt": ended_at,
                "latencyMs": total_latency_ms,
            }
            session["turns"].append(turn_record)
            session["turns"] = session["turns"][-2:]

            payload = {
                "sessionId": session_id,
                "turnId": meta["turnId"],
                "traceId": meta["traceId"],
                "questionText": question,
                "frameworkPoints": framework_points,
                "detailBlocks": detail_blocks,
                "frameworkLatencyMs": framework_latency_ms,
                "latencyMs": total_latency_ms,
                "contextTurnsUsed": len(recent_turns),
            }
            emit("answer_ready", payload)
            return payload
        finally:
            session["activeTurnIds"] = [
                turn_id for turn_id in session.get("activeTurnIds", []) if turn_id != meta["turnId"]
            ]


def ack_first_screen_rendered(*, session_id: str, turn_id: str, rendered_at: Optional[int] = None) -> Dict[str, Any]:
    session = ASSIST_SESSIONS.get(session_id)
    if not session:
        raise KeyError("Unknown interview assist session.")
    known_turn = any(item.get("turnId") == turn_id for item in session.get("turns", []))
    active_turn = turn_id in set(session.get("activeTurnIds", []))
    if not (known_turn or active_turn):
        raise KeyError("Unknown interview assist turn.")
    rendered_at = int(rendered_at or time.time() * 1000)
    logger.event(events.FIRST_SCREEN_RENDERED, session_id=session_id, turn_id=turn_id, rendered_at=rendered_at)
    return {"ok": True, "sessionId": session_id, "turnId": turn_id, "renderedAt": rendered_at}


def describe_interview_assist() -> Dict[str, Any]:
    provider = str(os.environ.get("INTERVIEW_ASSIST_LLM_PROVIDER", "OPENAI")).upper()
    configured = provider == "MOCK" or bool(
        os.environ.get("INTERVIEW_ASSIST_OPENAI_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("INTERVIEW_ASSIST_DEEPSEEK_API_KEY")
        or os.environ.get("LLAI_DEEPSEEK_API_KEY")
    )
    realtime_asr_configured = bool(os.environ.get("DASHSCOPE_API_KEY"))
    return {
        "available": True,
        "transportMode": "aliyun-realtime-ws",
        "pureLlm": True,
        "provider": provider,
        "configured": configured,
        "streamStages": ["framework", "detail"],
        "contextWindowTurns": 2,
        "realtimeAsr": {
            "provider": "ALIYUN_DASHSCOPE",
            "configured": realtime_asr_configured,
            "speakerMode": "default_interviewer",
        },
    }
