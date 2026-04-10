from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.engine.session_engine import (
    answer_session,
    apply_focus_concept,
    apply_focus_domain,
    create_session,
    get_session,
    project_session,
    SESSIONS,
)
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
    burdenSignal: str = "normal"
    interactionPreference: Optional[str] = None


class FocusDomainRequest(BaseModel):
    sessionId: str
    domainId: str


class FocusConceptRequest(BaseModel):
    sessionId: str
    conceptId: str


app = FastAPI(title="Learning Loop AI Service")


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": str(exc) or "Internal Server Error"})


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "tutorEngine": describe_tutor_intelligence()}


@app.post("/api/interview/start-target")
def start_target(payload: StartTargetRequest) -> Dict[str, Any]:
    session = create_session(payload)
    return project_session(session)


@app.post("/api/interview/answer")
def answer(payload: AnswerRequest) -> Dict[str, Any]:
    session = SESSIONS.get(payload.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    result = answer_session(session, payload)
    SESSIONS[payload.sessionId] = session
    return result


@app.post("/api/interview/focus-domain")
def focus_domain(payload: FocusDomainRequest) -> Dict[str, Any]:
    session = SESSIONS.get(payload.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    return apply_focus_domain(session, payload.domainId)


@app.post("/api/interview/focus-concept")
def focus_concept(payload: FocusConceptRequest) -> Dict[str, Any]:
    session = SESSIONS.get(payload.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    return apply_focus_concept(session, payload.conceptId)


@app.get("/api/interview/{session_id}")
def read_session(session_id: str) -> Dict[str, Any]:
    return get_session(session_id)
