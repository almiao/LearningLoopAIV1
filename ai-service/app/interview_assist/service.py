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
CORE_OPEN = "<core>"
CORE_CLOSE = "</core>"
DETAIL_OPEN = "<detail>"
DETAIL_CLOSE = "</detail>"
VOICE_DEMO_DIR = os.environ.get("INTERVIEW_ASSIST_VOICE_DEMO_DIR", ".omx/interview-assist/voice-demos")


def _read_nonnegative_int_env(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


CONTEXT_WINDOW_TURNS = _read_nonnegative_int_env("INTERVIEW_ASSIST_CONTEXT_TURNS", 2)


def _normalize(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _recent_turns(session: Dict[str, Any], limit: int = CONTEXT_WINDOW_TURNS) -> List[Dict[str, Any]]:
    if limit <= 0:
        return []
    return list(session.get("turns") or [])[-limit:]


def _legacy_framework_summary(turn: Dict[str, Any]) -> str:
    points = [_normalize(item) for item in (turn.get("frameworkPoints") or []) if _normalize(item)]
    if not points:
        return ""
    return "；".join(points)


def _turn_core_text(turn: Dict[str, Any]) -> str:
    return _normalize(
        turn.get("coreMarkdown")
        or turn.get("answerMarkdown")
        or _legacy_framework_summary(turn)
    )


def _turn_detail_text(turn: Dict[str, Any]) -> str:
    detail_markdown = _normalize(turn.get("detailMarkdown"))
    if detail_markdown:
        return detail_markdown
    detail_blocks = [_normalize(item) for item in (turn.get("detailBlocks") or []) if _normalize(item)]
    return " ".join(detail_blocks)


def _extract_subject_from_text(text: str) -> str:
    normalized = _normalize(text)
    if not normalized:
        return ""
    acronym = re.search(r"\b[A-Za-z][A-Za-z0-9+#._-]{1,}\b", normalized)
    if acronym:
        return acronym.group(0)
    match = re.match(r"(.{2,24}?)(?:是什么|是啥|怎么|如何|为什么|呢|？|\\?)", normalized)
    return _normalize(match.group(1)) if match else normalized[:24]


def _resolve_answer_subject(question_text: str, recent_turns: List[Dict[str, Any]]) -> str:
    question = _normalize(question_text)
    if re.search(r"\b[A-Za-z][A-Za-z0-9+#._-]{1,}\b", question):
        return _extract_subject_from_text(question)
    if re.search(r"(它|这个|那个|这块|刚才|上面|前面|it)", question, re.IGNORECASE) and recent_turns:
        return _extract_subject_from_text(_normalize(recent_turns[-1].get("questionText")))
    return _extract_subject_from_text(question)


def _make_references_explicit(text: str, subject: str) -> str:
    subject = _normalize(subject)
    if not subject:
        return text
    result = str(text or "")
    # Keep this as invisible polish: users see clear nouns, not meta-explanations.
    for pronoun in ("它们", "它", "这个", "那个", "这块"):
        result = result.replace(pronoun, subject)
    result = re.sub(r"\b[Ii]t\b", subject, result)
    return result


def _format_recent_turns(turns: List[Dict[str, Any]]) -> str:
    if not turns:
        return "无历史轮次。"

    blocks = []
    for index, turn in enumerate(turns, start=1):
        lines = [f"历史轮次 {index}"]
        question_text = _normalize(turn.get("questionText"))
        if question_text:
            lines.append(f"面试官：{question_text}")
        core_text = _turn_core_text(turn)
        if core_text:
            lines.append(f"AI回答核心：{core_text}")
        detail_text = _turn_detail_text(turn)
        if detail_text:
            lines.append(f"AI回答展开：{detail_text}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _answer_prompt(question_text: str, recent_turns: List[Dict[str, Any]]) -> str:
    return "\n".join(
        [
            "你是一个实时面试辅助模型。",
            "目标：帮用户马上开口回答面试问题。先输出可以直接参考的核心回答，再自然展开。",
            "请严格按下面的标签协议输出，不要输出标签外的任何文字。",
            "",
            "输出格式必须完全遵守：",
            "<core>",
            "用 markdown 写核心回答。可以是一小段，也可以是 2-4 个 bullet。重要词可以加粗。",
            "</core>",
            "<detail>",
            "继续用 markdown 展开说明。按问题需要自然组织，不要固定三段模板。",
            "</detail>",
            "",
            "回答要求：",
            "1. 先完整输出 <core> 并关闭 </core>，再开始 <detail>。",
            "2. 结合历史上下文理解当前问题，但最终回答里不要用“它、这个、那个”等模糊代称，直接写清楚对象名。",
            "3. 如果当前内容明显不是完整问题，或结合上下文也无法判断，可以自然地简短说明无法判断，不要强行编答案。",
            "4. 保持口语化、可直接复述。不要解释你如何理解代称，不要写规则说明。",
            "",
            f"当前问题：{question_text}",
            "",
            f"最近 {CONTEXT_WINDOW_TURNS} 轮上下文（仅供理解当前问题，不要逐字复述）：",
            _format_recent_turns(recent_turns),
        ]
    )


class MockInterviewAssistIntelligence:
    provider = "MOCK"
    model = "mock-interview-assist-v1"
    configured = True

    def stream_answer(self, *, question_text: str, recent_turns: List[Dict[str, Any]]) -> List[str]:
        question = _normalize(question_text) or "当前问题"
        subject = question
        if recent_turns:
            subject = _normalize(recent_turns[-1].get("questionText")) or question
        core = f"**核心点：** 可以先围绕“{subject[:28]}”直接给结论，再补关键机制和项目场景。"
        detail = "\n".join(
            [
                f"- 先把回答对象说清楚，让面试官知道你在回答“{subject[:28]}”。",
                "- 再讲机制、为什么这样设计，以及适用边界。",
                "- 最后落到项目经验：你在哪个场景用过，解决了什么问题，有什么取舍。",
            ]
        )
        full_text = "\n".join(
            [
                CORE_OPEN,
                core,
                CORE_CLOSE,
                DETAIL_OPEN,
                detail,
                DETAIL_CLOSE,
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
        prompt = _answer_prompt(question_text, recent_turns)
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


def _resolved_interview_assist_provider() -> str:
    return str(
        os.environ.get("INTERVIEW_ASSIST_LLM_PROVIDER")
        or os.environ.get("LLAI_LLM_PROVIDER")
        or "OPENAI"
    ).upper()


def _create_interview_assist_intelligence():
    provider = _resolved_interview_assist_provider()
    if provider == "MOCK":
        return MockInterviewAssistIntelligence()
    if provider == "DEEPSEEK":
        return ProviderInterviewAssistIntelligence(
            provider="DEEPSEEK",
            model=os.environ.get(
                "INTERVIEW_ASSIST_DEEPSEEK_MODEL",
                os.environ.get("LLAI_DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL),
            ),
            api_key=os.environ.get("INTERVIEW_ASSIST_DEEPSEEK_API_KEY", os.environ.get("LLAI_DEEPSEEK_API_KEY", "")),
            base_url=os.environ.get(
                "INTERVIEW_ASSIST_DEEPSEEK_BASE_URL",
                os.environ.get("LLAI_DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL),
            ),
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
        answer_subject = _resolve_answer_subject(question, recent_turns)
        set_session_context(session_id=session_id, turn=len(session["turns"]) + 1)
        meta = _create_turn_metadata(session=session, question_text=question, question_ended_at=ended_at)
        session["activeTurnIds"].append(meta["turnId"])

        try:
            logger.event(events.QUESTION_END_DETECTED, session_id=session_id, turn_id=meta["turnId"], question_text_chars=len(question))
            logger.event(events.FIRST_SCREEN_GENERATION_STARTED, session_id=session_id, turn_id=meta["turnId"])

            intelligence = _require_intelligence()
            stream_chunks = intelligence.stream_answer(question_text=question, recent_turns=recent_turns)
            stream_buffer = ""
            core_buffer = ""
            detail_buffer = ""
            detail_pending = ""
            core_markdown = ""
            core_started = False
            core_emitted = False
            detail_started = False
            detail_done = False
            core_latency_ms = 0

            for chunk in stream_chunks:
                stream_buffer += chunk or ""

                if not core_emitted:
                    if not core_started:
                        open_index = stream_buffer.find(CORE_OPEN)
                        if open_index < 0:
                            stream_buffer = stream_buffer[-(len(CORE_OPEN) - 1) :]
                            continue
                        stream_buffer = stream_buffer[open_index + len(CORE_OPEN) :]
                        core_started = True
                    close_index = stream_buffer.find(CORE_CLOSE)
                    if close_index >= 0:
                        core_buffer += stream_buffer[:close_index]
                        core_markdown = _make_references_explicit(core_buffer.strip(), answer_subject)
                        if not core_markdown:
                            raise ValueError("Interview assist model output returned an empty core block.")
                        core_latency_ms = int((time.time() - started_at) * 1000)
                        emit(
                            "core_delta",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "questionText": question,
                                "delta": core_markdown,
                            },
                        )
                        logger.event(
                            events.FIRST_SCREEN_READY,
                            session_id=session_id,
                            turn_id=meta["turnId"],
                            latency_ms=core_latency_ms,
                            key_points_count=1,
                            context_turns_used=len(recent_turns),
                        )
                        emit(
                            "core_done",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "traceId": meta["traceId"],
                                "questionText": question,
                                "coreMarkdown": core_markdown,
                                "frameworkLatencyMs": core_latency_ms,
                                "coreLatencyMs": core_latency_ms,
                                "contextTurnsUsed": len(recent_turns),
                                "contextTurns": recent_turns,
                            },
                        )
                        core_emitted = True
                        logger.event(events.EXPANSION_READY, session_id=session_id, turn_id=meta["turnId"])
                        stream_buffer = stream_buffer[close_index + len(CORE_CLOSE) :]
                    else:
                        safe_length = max(0, len(stream_buffer) - (len(CORE_CLOSE) - 1))
                        if safe_length > 0:
                            core_buffer += stream_buffer[:safe_length]
                            stream_buffer = stream_buffer[safe_length:]
                        continue

                while core_emitted and not detail_done:
                    if not detail_started:
                        open_index = stream_buffer.find(DETAIL_OPEN)
                        if open_index < 0:
                            stream_buffer = stream_buffer[-(len(DETAIL_OPEN) - 1) :]
                            break
                        stream_buffer = stream_buffer[open_index + len(DETAIL_OPEN) :]
                        detail_started = True
                        emit(
                            "detail_start",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "title": "展开说明",
                            },
                        )
                        continue

                    close_index = stream_buffer.find(DETAIL_CLOSE)
                    if close_index >= 0:
                        delta = stream_buffer[:close_index]
                        if delta:
                            detail_pending += delta
                        if detail_pending.strip():
                            sanitized_delta = _make_references_explicit(detail_pending, answer_subject)
                            detail_buffer += sanitized_delta
                            emit(
                                "detail_delta",
                                {
                                    "sessionId": session_id,
                                    "turnId": meta["turnId"],
                                    "delta": sanitized_delta,
                                },
                            )
                            detail_pending = ""
                        detail_markdown = detail_buffer.strip()
                        emit(
                            "detail_done",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "detailMarkdown": detail_markdown,
                                "detail": detail_markdown,
                            },
                        )
                        detail_done = True
                        stream_buffer = stream_buffer[close_index + len(DETAIL_CLOSE) :]
                        break

                    safe_length = max(0, len(stream_buffer) - (len(DETAIL_CLOSE) - 1))
                    if safe_length <= 0:
                        break
                    delta = stream_buffer[:safe_length]
                    detail_pending += delta
                    if _should_flush_detail_delta(detail_pending):
                        sanitized_delta = _make_references_explicit(detail_pending, answer_subject)
                        detail_buffer += sanitized_delta
                        emit(
                            "detail_delta",
                            {
                                "sessionId": session_id,
                                "turnId": meta["turnId"],
                                "delta": sanitized_delta,
                            },
                        )
                        detail_pending = ""
                    stream_buffer = stream_buffer[safe_length:]
                    break

            if not core_emitted:
                raise ValueError("Interview assist model output did not produce a complete core block.")
            if detail_started and not detail_done:
                if detail_pending.strip():
                    sanitized_delta = _make_references_explicit(detail_pending, answer_subject)
                    detail_buffer += sanitized_delta
                    emit(
                        "detail_delta",
                        {
                            "sessionId": session_id,
                            "turnId": meta["turnId"],
                            "delta": sanitized_delta,
                        },
                    )
                    detail_pending = ""
                detail_markdown = detail_buffer.strip()
                emit(
                    "detail_done",
                    {
                        "sessionId": session_id,
                        "turnId": meta["turnId"],
                        "detailMarkdown": detail_markdown,
                        "detail": detail_markdown,
                    },
                )
                detail_done = True
            if not detail_done:
                raise ValueError("Interview assist model output did not produce a complete detail block.")

            detail_markdown = detail_buffer.strip()
            answer_markdown = "\n\n".join(item for item in [core_markdown, detail_markdown] if item)

            total_latency_ms = int((time.time() - started_at) * 1000)
            turn_record = {
                "turnId": meta["turnId"],
                "questionText": question,
                "coreMarkdown": core_markdown,
                "detailMarkdown": detail_markdown,
                "answerMarkdown": answer_markdown,
                "frameworkPoints": [core_markdown],
                "detailBlocks": [detail_markdown],
                "questionEndedAt": ended_at,
                "latencyMs": total_latency_ms,
            }
            session["turns"].append(turn_record)
            session["turns"] = session["turns"][-CONTEXT_WINDOW_TURNS:] if CONTEXT_WINDOW_TURNS > 0 else []

            payload = {
                "sessionId": session_id,
                "turnId": meta["turnId"],
                "traceId": meta["traceId"],
                "questionText": question,
                "coreMarkdown": core_markdown,
                "detailMarkdown": detail_markdown,
                "answerMarkdown": answer_markdown,
                "frameworkPoints": [core_markdown],
                "detailBlocks": [detail_markdown],
                "frameworkLatencyMs": core_latency_ms,
                "coreLatencyMs": core_latency_ms,
                "latencyMs": total_latency_ms,
                "contextTurnsUsed": len(recent_turns),
                "contextTurns": recent_turns,
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
    provider = _resolved_interview_assist_provider()
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
        "streamStages": ["core_markdown", "detail_markdown"],
        "contextWindowTurns": CONTEXT_WINDOW_TURNS,
        "realtimeAsr": {
            "provider": "ALIYUN_DASHSCOPE",
            "configured": realtime_asr_configured,
            "speakerMode": "default_interviewer",
        },
    }
