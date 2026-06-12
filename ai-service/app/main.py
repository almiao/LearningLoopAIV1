from __future__ import annotations

import asyncio
import json
import queue
import threading
from typing import Any, Awaitable, Callable, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from app.core.tracing import (
    bind_request_context,
    current_trace_context,
    reset_request_context,
    set_session_context,
    trace_id_var,
)
from app.engine.anchor_judge import judge_anchors
from app.engine.control_intents import detect_control_intent
from app.engine.session_engine import (
    answer_session,
    apply_focus_concept,
    apply_focus_domain,
    create_session,
    create_tutor_message_turn,
    generate_review_question,
    get_tutor_intelligence,
    get_session,
    get_current_checkpoint_concept,
    get_current_checkpoint_point,
    get_checkpoint_point,
    project_session,
    restore_session,
    SESSIONS,
)
from app.infra.llm.snapshot import SnapshotStore
from app.loopassist import (
    answer_loopassist,
    create_loopassist_session,
    generate_loopassist_rescue_material,
    plan_loopassist_rescue,
    review_loopassist_question,
    review_loopassist_session,
    summarize_loopassist_review,
    stream_loopassist_answer,
)
from app.observability import events
from app.observability.logger import logger
from app.engine.tutor_intelligence import answer_knowledge_question_heuristic, describe_tutor_intelligence


def sse_event(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def enqueue_stream_turn(
    event_queue: "queue.Queue[tuple[str, Dict[str, Any]]]",
    turn: Dict[str, Any],
) -> None:
    event_queue.put(("turn_append", {"turn": turn}))


def patch_stream_turn(
    event_queue: "queue.Queue[tuple[str, Dict[str, Any]]]",
    *,
    turn_id: str,
    delta: str,
    content: str,
) -> None:
    event_queue.put(("turn_patch", {
        "turnId": turn_id,
        "delta": delta,
        "content": content,
    }))


def append_progress_turn_from_stream(
    *,
    session: Dict[str, Any],
    event_queue: "queue.Queue[tuple[str, Dict[str, Any]]]",
    data: Dict[str, Any],
) -> None:
    content = str(data.get("detail") or data.get("label") or "").strip()
    if not content:
        return
    concept = get_current_checkpoint_concept(session)
    point = get_current_checkpoint_point(session) or get_checkpoint_point(session, concept["id"]) or concept
    turn = create_tutor_message_turn(
        kind="process",
        action="process",
        concept_id=point["id"],
        concept_title=point["title"],
        checkpoint_id=concept["id"],
        checkpoint_statement=concept.get("checkpointStatement", concept["title"]),
        content=content,
    )
    session["turns"].append(turn)
    enqueue_stream_turn(event_queue, turn)


def ensure_stream_feedback_turn(
    *,
    session: Dict[str, Any],
    event_queue: "queue.Queue[tuple[str, Dict[str, Any]]]",
    stream_state: Dict[str, Any],
    action: str,
) -> Dict[str, Any]:
    existing = stream_state.get("feedback_turn")
    if existing:
        return existing
    concept = get_current_checkpoint_concept(session)
    point = get_current_checkpoint_point(session) or get_checkpoint_point(session, concept["id"]) or concept
    turn = create_tutor_message_turn(
        kind="feedback",
        action=action,
        concept_id=point["id"],
        concept_title=point["title"],
        checkpoint_id=concept["id"],
        checkpoint_statement=concept.get("checkpointStatement", concept["title"]),
        content="",
    )
    stream_state["feedback_turn"] = turn
    stream_state["feedback_content"] = ""
    session["_streamFeedbackTurnId"] = turn["turnId"]
    session["turns"].append(turn)
    enqueue_stream_turn(event_queue, turn)
    return turn


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

    def generate_teach_reply_stream(self, **kwargs) -> str:
        chunks = []
        if hasattr(self.base, "generate_teach_reply_stream_events"):
            for chunk in self.base.generate_teach_reply_stream_events(**kwargs):
                if not chunk:
                    continue
                chunks.append(chunk)
                self.on_chunk(chunk)
            self.on_done()
            return "".join(chunks)

        text = self.base.generate_teach_reply_stream(**kwargs) if hasattr(self.base, "generate_teach_reply_stream") else self.generate_reply_stream(**kwargs)
        if text:
            chunks.append(text)
            self.on_chunk(text)
        self.on_done()
        return "".join(chunks)


class StartTargetRequest(BaseModel):
    userId: str = ""
    source: Dict[str, Any]
    decomposition: Optional[Dict[str, Any]] = None
    targetBaseline: Dict[str, Any]
    targetProgress: Dict[str, Any] = {}
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


class RestoreSessionRequest(BaseModel):
    sessionSnapshot: Dict[str, Any]


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
    goal: str = "interview"
    taskType: str = "freeform"
    title: str = ""
    context: str = ""


class StartTargetRequest(BaseModel):
    userId: str = ""
    source: Dict[str, Any]
    decomposition: Optional[Dict[str, Any]] = None
    targetBaseline: Dict[str, Any]
    targetProgress: Dict[str, Any] = {}
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


class RestoreSessionRequest(BaseModel):
    sessionSnapshot: Dict[str, Any]


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
    goal: str = "interview"
    taskType: str = "freeform"
    title: str = ""
    context: str = ""


class LoopAssistStartRequest(BaseModel):
    userId: str = ""
    scope: Dict[str, Any] = {}
    seeds: List[Dict[str, Any]] = []


class LoopAssistAnswerRequest(BaseModel):
    sessionId: str
    answer: str


class LoopAssistReviewRequest(BaseModel):
    sessionId: str


class LoopAssistQuestionReviewRequest(BaseModel):
    sessionId: str
    questionNumber: int


class LoopAssistReviewSummaryRequest(BaseModel):
    sessionId: str
    questionReviews: List[Dict[str, Any]] = []


class LoopAssistRescueMaterialRequest(BaseModel):
    scope: Dict[str, Any] = {}
    gap: Dict[str, Any] = {}


class LoopAssistRescuePlanRequest(BaseModel):
    scope: Dict[str, Any] = {}
    review: Dict[str, Any] = {}
    documents: List[Dict[str, Any]] = []


class AnchorJudgeRequest(BaseModel):
    question: str
    answer: str
    sourceExcerpt: str = ""


class ReviewQuestionRequest(BaseModel):
    reviewItem: Dict[str, Any]
    sourceExcerpt: str = ""


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
    }


@app.post("/api/superapp/answer-knowledge-question")
def answer_superapp_knowledge_question(payload: SuperappKnowledgeQuestionRequest) -> Dict[str, Any]:
    question = str(payload.question or "").strip()
    context = str(payload.context or "").strip()
    goal = str(payload.goal or "interview").strip() or "interview"
    task_type = str(payload.taskType or "freeform").strip() or "freeform"
    if not question:
        raise HTTPException(status_code=400, detail="question is required.")

    title_line = f"# {payload.title}\n\n" if payload.title else ""
    full_context = f"{title_line}{context}".strip()
    intelligence = get_tutor_intelligence()
    if intelligence and hasattr(intelligence, "answer_knowledge_question"):
        content = intelligence.answer_knowledge_question(question=question, context=full_context, goal=goal, task_type=task_type)
    else:
        content = answer_knowledge_question_heuristic(question=question, context=full_context, goal=goal, task_type=task_type)
    return {
        "mode": "knowledge_qa",
        "content": content,
        "suggestedFollowUp": "把这个点出成一道快答题",
    }


@app.post("/api/loopassist/start")
def loopassist_start(payload: LoopAssistStartRequest) -> Dict[str, Any]:
    return create_loopassist_session(
        scope=payload.scope or {},
        seeds=payload.seeds or [],
        user_id=payload.userId,
    )


@app.post("/api/loopassist/answer")
def loopassist_answer(payload: LoopAssistAnswerRequest) -> Dict[str, Any]:
    try:
        return answer_loopassist(session_id=payload.sessionId, answer=payload.answer)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/loopassist/answer-stream")
def loopassist_answer_stream(payload: LoopAssistAnswerRequest) -> StreamingResponse:
    def generate():
        event_queue: queue.Queue[tuple[str, Dict[str, Any]]] = queue.Queue()

        def emit(event: str, data: Dict[str, Any]) -> None:
            event_queue.put((event, data))

        def worker():
            try:
                stream_loopassist_answer(
                    session_id=payload.sessionId,
                    answer=payload.answer,
                    emit=emit,
                )
            except KeyError as exc:  # pragma: no cover - streamed back to client
                event_queue.put(("error", {"error": str(exc)}))
            except Exception as exc:  # pragma: no cover - streamed back to client
                event_queue.put(("error", {"error": str(exc) or "LoopAssist stream failed."}))
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


@app.post("/api/loopassist/review")
def loopassist_review(payload: LoopAssistReviewRequest) -> Dict[str, Any]:
    try:
        return review_loopassist_session(session_id=payload.sessionId)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/loopassist/review-question")
def loopassist_review_question(payload: LoopAssistQuestionReviewRequest) -> Dict[str, Any]:
    try:
        return review_loopassist_question(
            session_id=payload.sessionId,
            question_number=payload.questionNumber,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/loopassist/review-summary")
def loopassist_review_summary(payload: LoopAssistReviewSummaryRequest) -> Dict[str, Any]:
    try:
        return summarize_loopassist_review(
            session_id=payload.sessionId,
            question_reviews=payload.questionReviews,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/loopassist/rescue-material")
def loopassist_rescue_material(payload: LoopAssistRescueMaterialRequest) -> Dict[str, Any]:
    return generate_loopassist_rescue_material(scope=payload.scope, gap=payload.gap)


@app.post("/api/loopassist/rescue-plan")
def loopassist_rescue_plan(payload: LoopAssistRescuePlanRequest) -> Dict[str, Any]:
    return plan_loopassist_rescue(
        scope=payload.scope,
        review=payload.review,
        documents=payload.documents,
    )


# 一次性锚点判分（PRODUCT.md §0.1）。无状态、不入库；漏掉的锚点由 Node 侧穿透适配器写进失败账本。
@app.post("/api/anchor-judge")
def anchor_judge(payload: AnchorJudgeRequest) -> Dict[str, Any]:
    return judge_anchors(
        question=payload.question,
        answer=payload.answer,
        source_excerpt=payload.sourceExcerpt,
    )


@app.post("/api/review/generate-question")
def review_generate_question(payload: ReviewQuestionRequest) -> Dict[str, Any]:
    return generate_review_question(
        review_item=payload.reviewItem,
        source_excerpt=payload.sourceExcerpt,
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
    control_intent = detect_control_intent(str(payload.answer or "").strip(), payload.intent or "")
    stream_feedback_action = "teach" if control_intent == "teach" else "reply"

    def generate():
        event_queue: queue.Queue[tuple[str, Dict[str, Any]]] = queue.Queue()
        stream_state: Dict[str, Any] = {
            "feedback_turn": None,
            "feedback_content": "",
        }

        def emit_delta(delta: str) -> None:
            if delta:
                feedback_turn = ensure_stream_feedback_turn(
                    session=session,
                    event_queue=event_queue,
                    stream_state=stream_state,
                    action=stream_feedback_action,
                )
                next_content = f"{stream_state.get('feedback_content', '')}{delta}"
                stream_state["feedback_content"] = next_content
                feedback_turn["content"] = next_content
                patch_stream_turn(
                    event_queue,
                    turn_id=feedback_turn["turnId"],
                    delta=delta,
                    content=next_content,
                )
            event_queue.put(("reply_delta", {"delta": delta}))

        def emit_reply_done() -> None:
            event_queue.put(("reply_done", {}))

        def emit_progress(event: str, data: Dict[str, Any]) -> None:
            if event == "progress":
                append_progress_turn_from_stream(
                    session=session,
                    event_queue=event_queue,
                    data=data,
                )
            event_queue.put((event, data))

        def emit_turn(turn: Dict[str, Any]) -> None:
            enqueue_stream_turn(event_queue, turn)

        base_intelligence = get_tutor_intelligence()
        intelligence = StreamingTutorIntelligence(base_intelligence, emit_delta, emit_reply_done) if base_intelligence else None

        def worker():
            try:
                result = answer_session(
                    session,
                    payload,
                    intelligence_override=intelligence,
                    progress_callback=emit_progress,
                    turn_callback=emit_turn,
                )
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


@app.post("/api/interview/restore-session")
def restore_training_session(payload: RestoreSessionRequest) -> Dict[str, Any]:
    session = restore_session(payload.sessionSnapshot)
    set_session_context(session_id=session["sessionId"], turn=len(session.get("turns", [])))
    return session


@app.get("/api/interview/{session_id}")
def read_session(session_id: str) -> Dict[str, Any]:
    set_session_context(session_id=session_id, turn=0)
    return get_session(session_id)
