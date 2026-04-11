from __future__ import annotations

import os
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class VersionConfig:
    agent_version: str = os.environ.get("LLAI_AGENT_VERSION", "1.0.0")
    prompt_version: str = os.environ.get("LLAI_PROMPT_VERSION", "prompt_v1")
    rubric_version: str = os.environ.get("LLAI_RUBRIC_VERSION", "rubric_v1")
    context_builder_version: str = os.environ.get("LLAI_CONTEXT_BUILDER_VERSION", "ctx_v1")
    parser_version: str = os.environ.get("LLAI_PARSER_VERSION", "parser_v1")
    validator_version: str = os.environ.get("LLAI_VALIDATOR_VERSION", "validator_v1")
    tool_schema_version: str = os.environ.get("LLAI_TOOL_SCHEMA_VERSION", "tools_v1")
    model_name: str = os.environ.get("LLAI_MODEL_NAME", os.environ.get("LLAI_DEEPSEEK_MODEL", os.environ.get("OPENAI_MODEL", "gpt-5-mini")))
    environment: str = os.environ.get("APP_ENV", os.environ.get("NODE_ENV", "dev"))

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ObservabilityConfig:
    snapshot_root: str = os.environ.get("LLAI_SNAPSHOT_ROOT", ".omx/logs/ai-service-snapshots")
    log_level: str = os.environ.get("LLAI_LOG_LEVEL", "INFO").upper()


versions = VersionConfig()
observability = ObservabilityConfig()
