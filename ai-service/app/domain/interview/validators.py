from __future__ import annotations

from typing import Any, Dict

from app.engine.turn_envelope import assert_valid_turn_envelope


def validate_decomposition_payload(payload: Dict[str, Any]) -> None:
    summary = payload.get("summary") or {}
    units = payload.get("units") or []
    if not isinstance(units, list) or len(units) < 3:
        raise ValueError("Tutor intelligence returned too few teaching units.")
    if not str(summary.get("framing", "")).strip():
        raise ValueError("Tutor intelligence returned invalid teaching units.")


def validate_turn_envelope_payload(payload: Dict[str, Any], concept_id: str) -> None:
    assert_valid_turn_envelope(payload, concept_id)


def validate_explain_concept_payload(payload: Dict[str, Any]) -> None:
    paragraphs = payload.get("teachingParagraphs")
    if not isinstance(paragraphs, list) or len(paragraphs) < 2:
        raise ValueError("Explain concept payload must include at least two teaching paragraphs.")
    if not str(payload.get("checkQuestion", "")).strip():
        raise ValueError("Explain concept payload must include a check question.")
