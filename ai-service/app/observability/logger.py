from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

from app.core.config import observability, versions
from app.core.tracing import current_trace_context


def _configure_root_logger() -> None:
    root_logger = logging.getLogger("ai_service")
    if root_logger.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    root_logger.setLevel(getattr(logging, observability.log_level, logging.INFO))
    root_logger.addHandler(handler)
    root_logger.propagate = False


def _normalize(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(key): _normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_normalize(item) for item in value]
    return str(value)


class StructuredLogger:
    def __init__(self, name: str):
        _configure_root_logger()
        self._logger = logging.getLogger(name)

    def event(self, event_name: str, **kwargs: Any) -> None:
        record = {
            **current_trace_context(),
            "event": event_name,
            "timestamp": time.time(),
            "agent_version": versions.agent_version,
            "prompt_version": versions.prompt_version,
            "rubric_version": versions.rubric_version,
            "context_builder_version": versions.context_builder_version,
            "parser_version": versions.parser_version,
            "validator_version": versions.validator_version,
            "environment": versions.environment,
            **{key: _normalize(value) for key, value in kwargs.items()},
        }
        self._logger.info(json.dumps(record, ensure_ascii=False))


logger = StructuredLogger("ai_service")
