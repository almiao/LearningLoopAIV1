from __future__ import annotations

import uuid
from contextvars import ContextVar
from dataclasses import dataclass


trace_id_var: ContextVar[str] = ContextVar("trace_id", default="unknown")
session_id_var: ContextVar[str] = ContextVar("session_id", default="unknown")
turn_var: ContextVar[int] = ContextVar("turn", default=0)
request_path_var: ContextVar[str] = ContextVar("request_path", default="unknown")
request_method_var: ContextVar[str] = ContextVar("request_method", default="unknown")
last_llm_call_id_var: ContextVar[str] = ContextVar("last_llm_call_id", default="")


@dataclass
class TraceContextTokens:
    trace_token: object
    session_token: object
    turn_token: object
    path_token: object
    method_token: object
    call_id_token: object


def new_trace() -> str:
    return str(uuid.uuid4())


def bind_request_context(*, trace_id: str | None = None, session_id: str = "unknown", turn: int = 0, path: str = "unknown", method: str = "unknown") -> TraceContextTokens:
    return TraceContextTokens(
        trace_token=trace_id_var.set(trace_id or new_trace()),
        session_token=session_id_var.set(session_id),
        turn_token=turn_var.set(turn),
        path_token=request_path_var.set(path),
        method_token=request_method_var.set(method),
        call_id_token=last_llm_call_id_var.set(""),
    )


def reset_request_context(tokens: TraceContextTokens) -> None:
    trace_id_var.reset(tokens.trace_token)
    session_id_var.reset(tokens.session_token)
    turn_var.reset(tokens.turn_token)
    request_path_var.reset(tokens.path_token)
    request_method_var.reset(tokens.method_token)
    last_llm_call_id_var.reset(tokens.call_id_token)


def set_session_context(session_id: str = "unknown", turn: int | None = None) -> None:
    session_id_var.set(session_id or "unknown")
    if turn is not None:
        turn_var.set(turn)


def set_last_llm_call_id(call_id: str) -> None:
    last_llm_call_id_var.set(call_id)


def current_trace_context() -> dict:
    return {
        "trace_id": trace_id_var.get(),
        "session_id": session_id_var.get(),
        "turn": turn_var.get(),
        "request_path": request_path_var.get(),
        "request_method": request_method_var.get(),
        "last_llm_call_id": last_llm_call_id_var.get(),
    }
