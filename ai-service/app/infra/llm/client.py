from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from app.core.config import versions
from app.core.tracing import set_last_llm_call_id, trace_id_var
from app.infra.llm.snapshot import SnapshotStore
from app.observability import events
from app.observability.logger import logger


def _hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]


@dataclass
class LLMCallResult:
    parsed: Dict[str, Any]
    raw_response: str
    provider_payload: Dict[str, Any] | None
    llm_call_id: str
    parse_success: bool
    validation_success: bool
    fallback_used: bool = False


class TracedLLMClient:
    def __init__(self, snapshot_store: SnapshotStore | None = None):
        self.snapshot_store = snapshot_store or SnapshotStore()

    def call_json(
        self,
        *,
        call_type: str,
        model: str,
        parser_version: str,
        system_prompt: str,
        messages: list[dict[str, str]],
        request_fn: Callable[[], tuple[str, Dict[str, Any] | None]],
        parser: Callable[[str], Dict[str, Any]],
        validator: Optional[Callable[[Dict[str, Any]], None]] = None,
        provider: str,
    ) -> LLMCallResult:
        trace_id = trace_id_var.get()
        llm_call_id = f"{trace_id[:8]}_{call_type}_{int(time.time() * 1000)}"
        set_last_llm_call_id(llm_call_id)
        started_at = time.time()
        logger.event(
            events.LLM_CALL_STARTED,
            llm_call_id=llm_call_id,
            call_type=call_type,
            provider=provider,
            model=model,
            parser_version=parser_version or versions.parser_version,
            system_prompt_hash=_hash(system_prompt),
            input_messages_count=len(messages),
            input_chars=sum(len(str(message.get("content", ""))) for message in messages),
        )

        raw_response = ""
        parsed: Dict[str, Any] | None = None
        provider_payload: Dict[str, Any] | None = None
        parse_success = False
        validation_success = False

        try:
            raw_response, provider_payload = request_fn()
            parsed = parser(raw_response)
            parse_success = True
            if validator:
                validator(parsed)
            validation_success = True
            latency_ms = int((time.time() - started_at) * 1000)
            bundle = {
                "trace_id": trace_id,
                "llm_call_id": llm_call_id,
                "call_type": call_type,
                "provider": provider,
                "model": model,
                "messages": messages,
                "raw_response": raw_response,
                "provider_payload": provider_payload,
                "parsed": parsed,
                "versions": versions.to_dict(),
                "parse_success": parse_success,
                "validation_success": validation_success,
                "fallback_used": False,
                "error": None,
            }
            snapshot_path = self.snapshot_store.save_bundle(trace_id, llm_call_id, bundle)
            logger.event(
                events.LLM_CALL_COMPLETED,
                llm_call_id=llm_call_id,
                call_type=call_type,
                provider=provider,
                model=model,
                parser_version=parser_version or versions.parser_version,
                latency_ms=latency_ms,
                parse_success=parse_success,
                validation_success=validation_success,
                fallback_used=False,
                snapshot_path=str(snapshot_path),
            )
            return LLMCallResult(
                parsed=parsed,
                raw_response=raw_response,
                provider_payload=provider_payload,
                llm_call_id=llm_call_id,
                parse_success=parse_success,
                validation_success=validation_success,
                fallback_used=False,
            )
        except Exception as exc:
            latency_ms = int((time.time() - started_at) * 1000)
            bundle = {
                "trace_id": trace_id,
                "llm_call_id": llm_call_id,
                "call_type": call_type,
                "provider": provider,
                "model": model,
                "messages": messages,
                "raw_response": raw_response,
                "provider_payload": provider_payload,
                "parsed": parsed,
                "versions": versions.to_dict(),
                "parse_success": parse_success,
                "validation_success": validation_success,
                "fallback_used": False,
                "error": str(exc),
            }
            snapshot_path = self.snapshot_store.save_bundle(trace_id, llm_call_id, bundle)
            if not parse_success:
                logger.event(events.PARSER_FAILED, llm_call_id=llm_call_id, error=str(exc), snapshot_path=str(snapshot_path))
            elif not validation_success:
                logger.event(events.VALIDATION_FAILED, llm_call_id=llm_call_id, error=str(exc), snapshot_path=str(snapshot_path))
            logger.event(
                events.LLM_CALL_FAILED,
                llm_call_id=llm_call_id,
                call_type=call_type,
                provider=provider,
                model=model,
                parser_version=parser_version or versions.parser_version,
                latency_ms=latency_ms,
                parse_success=parse_success,
                validation_success=validation_success,
                fallback_used=False,
                error=str(exc),
                snapshot_path=str(snapshot_path),
            )
            raise
