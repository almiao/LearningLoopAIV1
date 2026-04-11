from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
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
    get_session,
    project_session,
    SESSIONS,
)
from app.infra.llm.snapshot import SnapshotStore
from app.observability import events
from app.observability.logger import logger
from app.engine.tutor_intelligence import describe_tutor_intelligence


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
