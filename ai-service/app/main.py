from __future__ import annotations

import asyncio
import json
import queue
import threading
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.core.tracing import (
    bind_request_context,
    current_trace_context,
    reset_request_context,
    set_session_context,
    trace_id_var,
)
from app.engine.session_engine import (
    answer_session,
    apply_focus_concept,
    apply_focus_domain,
    create_session,
    get_tutor_intelligence,
    get_session,
    project_session,
    SESSIONS,
)
from app.infra.llm.snapshot import SnapshotStore
from app.interview_assist import (
    ack_first_screen_rendered,
    create_assist_session,
    create_realtime_session,
    describe_interview_assist,
    store_voice_demo,
    stream_assist_answer,
)
from app.interview_assist.aliyun_realtime_asr import AliyunRealtimeRecognizer
from app.observability import events
from app.observability.logger import logger
from app.engine.tutor_intelligence import describe_tutor_intelligence


def sse_event(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def poll_realtime_asr_event(recognizer: AliyunRealtimeRecognizer, timeout: float = 0.1):
    """Poll the blocking ASR SDK off the main event loop."""
    return await asyncio.to_thread(recognizer.poll_event, timeout)


class StreamingTutorIntelligence:
    def __init__(self, base, on_chunk, on_done):
        self.base = base
        self.on_chunk = on_chunk
        self.on_done = on_done

    @property
    def configured(self) -> bool:
        return bool(getattr(self.base, "configured", False))

    def generate_turn_envelope(self, **kwargs):
        return self.base.generate_turn_envelope(**kwargs)

    def generate_reply_stream(self, **kwargs) -> str:
        chunks = []
        if hasattr(self.base, "generate_reply_stream_events"):
            for chunk in self.base.generate_reply_stream_events(**kwargs):
                if not chunk:
                    continue
                chunks.append(chunk)
                self.on_chunk(chunk)
            self.on_done()
            return "".join(chunks)

        text = self.base.generate_reply_stream(**kwargs) if hasattr(self.base, "generate_reply_stream") else ""
        if text:
            chunks.append(text)
            self.on_chunk(text)
        self.on_done()
        return "".join(chunks)


class StartTargetRequest(BaseModel):
    userId: str = ""
    source: Dict[str, Any]
    decomposition: Dict[str, Any]
    targetBaseline: Dict[str, Any]
    memoryProfile: Dict[str, Any]
    interactionPreference: str = "balanced"


class AnswerRequest(BaseModel):
    sessionId: str
    answer: str
    intent: Optional[str] = None
    burdenSignal: str = "normal"
    interactionPreference: Optional[str] = None


class FocusDomainRequest(BaseModel):
    sessionId: str
    domainId: str


class FocusConceptRequest(BaseModel):
    sessionId: str
    conceptId: str


class SuperappTaskRequest(BaseModel):
    userId: str = ""
    task: Dict[str, Any]


class SuperappContinueRequest(BaseModel):
    conversationId: str
    userId: str = ""
    questionId: str = ""
    question: str = ""
    answer: str


class SuperappKnowledgeQuestionRequest(BaseModel):
    userId: str = ""
    question: str
    context: str = ""


class InterviewAssistSessionRequest(BaseModel):
    targetRole: str = "java-backend"
    sessionMode: str = "realtime_interview_assist"


class InterviewAssistRealtimeSessionRequest(BaseModel):
    selfRole: str
    mode: str
    resumeText: str = ""


class InterviewAssistFirstScreenRequest(BaseModel):
    sessionId: str
    questionText: str
    questionEndedAt: Optional[int] = None


class InterviewAssistRenderedRequest(BaseModel):
    sessionId: str
    turnId: str
    renderedAt: Optional[int] = None


app = FastAPI(title="Learning Loop AI Service")
snapshot_store = SnapshotStore()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3002",
        "http://localhost:3000",
        "http://localhost:3002",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_tracing_middleware(request: Request, call_next):
    trace_id = request.headers.get("x-trace-id") or None
    tokens = bind_request_context(trace_id=trace_id, path=request.url.path, method=request.method)
    request.state.trace_id = trace_id_var.get()
    logger.event(events.REQUEST_STARTED, path=request.url.path, method=request.method)
    try:
        response = await call_next(request)
        response.headers["x-trace-id"] = trace_id_var.get()
        logger.event(events.REQUEST_COMPLETED, path=request.url.path, method=request.method, status_code=response.status_code)
        return response
    finally:
        reset_request_context(tokens)


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    trace_id = current_trace_context().get("trace_id", "unknown")
    snapshot_store.annotate_error(trace_id, str(exc))
    logger.event(events.REQUEST_FAILED, error=str(exc))
    return JSONResponse(status_code=500, content={"detail": str(exc) or "Internal Server Error"})


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "tutorEngine": describe_tutor_intelligence(),
        "interviewAssist": describe_interview_assist(),
    }


def _normalize_superapp_background(task: Dict[str, Any]) -> str:
    return str(task.get("reason") or task.get("materialContext") or task.get("conceptSummary") or "").strip()


def _normalize_superapp_question(task: Dict[str, Any]) -> str:
    question = str(task.get("diagnosticQuestion") or "").strip()
    if question:
        return question
    title = str(task.get("conceptTitle") or task.get("title") or "当前知识点").strip()
    return f"你先用自己的话讲一下：{title} 的核心作用是什么？"


@app.post("/api/superapp/generate-first-question")
def generate_superapp_first_question(payload: SuperappTaskRequest) -> Dict[str, Any]:
    task = payload.task or {}
    return {
        "questionId": f"{task.get('taskId', 'task')}:q1",
        "content": _normalize_superapp_question(task),
        "background": _normalize_superapp_background(task),
    }


@app.post("/api/superapp/continue-private-chat")
def continue_superapp_private_chat(payload: SuperappContinueRequest) -> Dict[str, Any]:
    answer = str(payload.answer or "").strip()
    if len(answer) < 12:
        return {
            "resolution": "continue",
            "mode": "micro_teach",
            "content": "这句还太短，我先帮你补一个骨架：先说它解决什么问题，再说它靠什么机制做到。你按这个结构重讲一遍。",
            "loopState": "first_reply_processed",
        }
    if len(answer) < 28:
        return {
            "resolution": "continue",
            "mode": "gap_correction",
            "content": "方向基本对，但还缺一个关键点。你再补一句：这个机制为什么能把用户真正拉回到学习动作，而不只是点开提醒？",
            "loopState": "first_reply_processed",
        }
    return {
        "resolution": "continue",
        "mode": "acknowledge_and_probe",
        "content": "这版已经抓到主线了。再往前推进一步：如果只能保留一个最小闭环动作，你会怎么解释“点击后必须直接看到一条可回复的问题”这个约束？",
        "loopState": "first_loop_completed",
    }


@app.post("/api/superapp/answer-knowledge-question")
def answer_superapp_knowledge_question(payload: SuperappKnowledgeQuestionRequest) -> Dict[str, Any]:
    question = str(payload.question or "").strip()
    context = str(payload.context or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required.")

    context_line = f"结合这段材料背景：{context}\n" if context else ""
    return {
        "mode": "knowledge_qa",
        "content": (
            f"{context_line}"
            f"我先按最小学习闭环回答这个问题：{question}\n\n"
            "核心思路是先抓定义，再讲机制，最后补一个边界。"
            "如果你愿意，我们下一轮可以把这个点压成一道快答题。"
        ),
        "suggestedFollowUp": "把这个点出成一道快答题",
    }


@app.post("/api/interview-assist/session")
def interview_assist_session(payload: InterviewAssistSessionRequest) -> Dict[str, Any]:
    return create_assist_session(target_role=payload.targetRole)


@app.post("/api/interview-assist/realtime-session")
def interview_assist_realtime_session(payload: InterviewAssistRealtimeSessionRequest) -> Dict[str, Any]:
    if payload.selfRole not in {"candidate", "interviewer"}:
        raise HTTPException(status_code=400, detail="selfRole must be candidate or interviewer.")
    if payload.mode not in {"assist_interviewer", "assist_candidate"}:
        raise HTTPException(status_code=400, detail="mode must be assist_interviewer or assist_candidate.")
    return create_realtime_session(
        self_role=payload.selfRole,
        mode=payload.mode,
        resume_text=payload.resumeText,
    )


@app.post("/api/interview-assist/voice-demo")
async def interview_assist_voice_demo(
    sessionId: str,
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="voice demo file is empty.")
    try:
        return store_voice_demo(session_id=sessionId, filename=file.filename or "", body=body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.websocket("/ws/interview-assist/{session_id}")
async def interview_assist_realtime_ws(websocket: WebSocket, session_id: str) -> None:
    from app.interview_assist.service import ASSIST_SESSIONS

    session = ASSIST_SESSIONS.get(session_id)
    if not session:
        await websocket.close(code=4404, reason="Unknown interview assist session.")
        return

    await websocket.accept()
    logger.event("interview_assist_realtime_ws_opened", session_id=session_id, mode=session.get("mode"), self_role=session.get("selfRole"))
    recognizer = AliyunRealtimeRecognizer()

    if not recognizer.configured:
        logger.event("interview_assist_realtime_ws_provider_unconfigured", session_id=session_id)
        await websocket.send_json({
            "event": "error",
            "data": {
                "error": "DASHSCOPE_API_KEY is not configured.",
            },
        })
        await websocket.close(code=4500)
        return

    recognizer.start()
    logger.event("interview_assist_realtime_recognizer_started", session_id=session_id)
    await websocket.send_json({"event": "agent_ready", "data": {"sessionId": session_id}})

    stop_event = threading.Event()
    transcript_buffer = ""
    binary_frames_received = 0

    async def send_json_event(event: str, data: Dict[str, Any]) -> None:
        await websocket.send_json({"event": event, "data": data})

    async def drain_events() -> None:
        nonlocal transcript_buffer

        last_event_at = asyncio.get_running_loop().time()
        while True:
            event = await poll_realtime_asr_event(recognizer, timeout=0.1)
            if event is None:
                if stop_event.is_set() and asyncio.get_running_loop().time() - last_event_at > 1.0:
                    break
                continue
            last_event_at = asyncio.get_running_loop().time()

            logger.event(
                "interview_assist_realtime_asr_event",
                session_id=session_id,
                asr_event=event.event,
                text_chars=len(str(event.data.get("text", ""))),
                request_id=str(event.data.get("requestId", "")),
                error_code=str(event.data.get("code", "")),
            )

            if event.event == "asr_partial":
                transcript_buffer = event.data.get("text", transcript_buffer)
                await send_json_event("transcript_partial", {
                    "transcript": transcript_buffer,
                    "isFinal": False,
                })
                continue

            if event.event == "asr_final":
                transcript_buffer = event.data.get("text", transcript_buffer)
                await send_json_event("transcript_final", {
                    "transcript": transcript_buffer,
                    "isFinal": True,
                })
                await send_json_event("turn_committed", {
                    "questionText": transcript_buffer,
                    "role": "interviewer",
                })
                if session.get("mode") == "assist_candidate":
                    try:
                        stream_queue: queue.Queue[tuple[str, Dict[str, Any]]] = queue.Queue()
                        stream_assist_answer(
                            session_id=session_id,
                            question_text=transcript_buffer,
                            question_ended_at=None,
                            emit=lambda ev, data: stream_queue.put((ev, data)),
                        )
                        while not stream_queue.empty():
                            ev, data = stream_queue.get()
                            await send_json_event(ev, data)
                    except Exception as exc:
                        await send_json_event("error", {"error": str(exc)})
                transcript_buffer = ""
                continue

            if event.event == "asr_error":
                await send_json_event("error", {
                    "error": event.data.get("message", "Aliyun ASR error."),
                    "code": event.data.get("code", ""),
                })
                continue

            if stop_event.is_set() and event.event in {"asr_complete", "asr_close"}:
                break

    drain_task = None
    try:
        drain_task = asyncio.create_task(drain_events())

        while True:
            message = await websocket.receive()
            if "bytes" in message and message["bytes"]:
                binary_frames_received += 1
                if binary_frames_received <= 3 or binary_frames_received % 20 == 0:
                    logger.event(
                        "interview_assist_realtime_audio_frame_received",
                        session_id=session_id,
                        frame_index=binary_frames_received,
                        bytes_len=len(message["bytes"]),
                    )
                recognizer.send_audio(message["bytes"])
            elif "text" in message and message["text"]:
                payload = json.loads(message["text"])
                if payload.get("event") == "stop":
                    logger.event(
                        "interview_assist_realtime_stop_requested",
                        session_id=session_id,
                        audio_frames=binary_frames_received,
                    )
                    stop_event.set()
                    recognizer.stop()
                    break
    except WebSocketDisconnect:
        logger.event("interview_assist_realtime_ws_disconnected", session_id=session_id, audio_frames=binary_frames_received)
    finally:
        if not stop_event.is_set():
            stop_event.set()
            recognizer.stop()
        logger.event("interview_assist_realtime_ws_closed", session_id=session_id, audio_frames=binary_frames_received)
        if drain_task:
            try:
                await asyncio.wait_for(drain_task, timeout=3.0)
            except Exception:
                drain_task.cancel()


@app.post("/api/interview-assist/answer-stream")
def interview_assist_answer_stream(payload: InterviewAssistFirstScreenRequest) -> StreamingResponse:
    set_session_context(session_id=payload.sessionId, turn=0)

    def generate():
        event_queue: queue.Queue[tuple[str, Dict[str, Any]]] = queue.Queue()

        def emit(event: str, data: Dict[str, Any]) -> None:
            event_queue.put((event, data))

        def worker():
            try:
                stream_assist_answer(
                    session_id=payload.sessionId,
                    question_text=payload.questionText,
                    question_ended_at=payload.questionEndedAt,
                    emit=emit,
                )
            except KeyError as exc:  # pragma: no cover - streamed back to client
                event_queue.put(("error", {"error": str(exc)}))
            except Exception as exc:  # pragma: no cover - streamed back to client
                event_queue.put(("error", {"error": str(exc) or "Interview assist stream failed."}))
            finally:
                event_queue.put(("done", {}))

        threading.Thread(target=worker, daemon=True).start()
        yield sse_event("reply_status", {"status": "started"})

        while True:
            event, data = event_queue.get()
            if event == "done":
                yield sse_event("done", data)
                break
            yield sse_event(event, data)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/interview-assist/first-screen-rendered")
def interview_assist_first_screen_rendered(payload: InterviewAssistRenderedRequest) -> Dict[str, Any]:
    return ack_first_screen_rendered(
        session_id=payload.sessionId,
        turn_id=payload.turnId,
        rendered_at=payload.renderedAt,
    )


@app.post("/api/interview/start-target")
def start_target(payload: StartTargetRequest) -> Dict[str, Any]:
    session = create_session(payload)
    set_session_context(session_id=session["id"], turn=0)
    return project_session(session)


@app.post("/api/interview/answer")
def answer(payload: AnswerRequest) -> Dict[str, Any]:
    session = SESSIONS.get(payload.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    set_session_context(session_id=payload.sessionId, turn=len(session.get("turns", [])))
    result = answer_session(session, payload)
    SESSIONS[payload.sessionId] = session
    return result


@app.post("/api/interview/answer-stream")
def answer_stream(payload: AnswerRequest) -> StreamingResponse:
    session = SESSIONS.get(payload.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    set_session_context(session_id=payload.sessionId, turn=len(session.get("turns", [])))

    def generate():
        event_queue: queue.Queue[tuple[str, Dict[str, Any]]] = queue.Queue()

        def emit_delta(delta: str) -> None:
            event_queue.put(("reply_delta", {"delta": delta}))

        def emit_reply_done() -> None:
            event_queue.put(("reply_done", {}))

        base_intelligence = get_tutor_intelligence()
        intelligence = StreamingTutorIntelligence(base_intelligence, emit_delta, emit_reply_done) if base_intelligence else None

        def worker():
            try:
                result = answer_session(session, payload, intelligence_override=intelligence)
                SESSIONS[payload.sessionId] = session
                event_queue.put(("turn_result", result))
            except Exception as exc:  # pragma: no cover - streamed back to client
                event_queue.put(("error", {"error": str(exc) or "Answer stream failed."}))
            finally:
                event_queue.put(("done", {}))

        threading.Thread(target=worker, daemon=True).start()
        yield sse_event("reply_status", {"status": "started"})

        while True:
            event, data = event_queue.get()
            if event == "done":
                yield sse_event("done", data)
                break
            yield sse_event(event, data)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/interview/focus-domain")
def focus_domain(payload: FocusDomainRequest) -> Dict[str, Any]:
    session = SESSIONS.get(payload.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    set_session_context(session_id=payload.sessionId, turn=len(session.get("turns", [])))
    return apply_focus_domain(session, payload.domainId)


@app.post("/api/interview/focus-concept")
def focus_concept(payload: FocusConceptRequest) -> Dict[str, Any]:
    session = SESSIONS.get(payload.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    set_session_context(session_id=payload.sessionId, turn=len(session.get("turns", [])))
    return apply_focus_concept(session, payload.conceptId)


@app.get("/api/interview/{session_id}")
def read_session(session_id: str) -> Dict[str, Any]:
    set_session_context(session_id=session_id, turn=0)
    return get_session(session_id)
