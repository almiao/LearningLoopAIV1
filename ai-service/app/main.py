from __future__ import annotations

import json
import queue
import threading
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
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
from app.observability import events
from app.observability.logger import logger
from app.engine.tutor_intelligence import describe_tutor_intelligence


def sse_event(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


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


app = FastAPI(title="Learning Loop AI Service")
snapshot_store = SnapshotStore()


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
    return {"ok": True, "tutorEngine": describe_tutor_intelligence()}


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
