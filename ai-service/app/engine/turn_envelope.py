from __future__ import annotations

from typing import Any, Dict, List


ALLOWED_INFO_GAIN_LEVELS = {"high", "medium", "low", "negligible"}
ALLOWED_CONFIDENCE_LEVELS = {"high", "medium", "low"}
ALLOWED_STATES = {"solid", "partial", "weak", "不可判"}
ALLOWED_SIGNALS = {"positive", "negative", "noise"}
ALLOWED_UI_MODES = {"probe", "teach", "verify", "advance", "revisit", "stop"}

CONFIDENCE_SCORE_MAP = {
    "high": 0.84,
    "medium": 0.58,
    "low": 0.28,
}


def confidence_level_to_score(level: str = "low") -> float:
    return CONFIDENCE_SCORE_MAP.get(level, CONFIDENCE_SCORE_MAP["low"])


def score_to_confidence_level(score: float = 0.0) -> str:
    if score >= 0.75:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def normalize_confidence_level(level: str | None, fallback: str = "low") -> str:
    return level if level in ALLOWED_CONFIDENCE_LEVELS else fallback


def normalize_info_gain_level(level: str | None, fallback: str = "medium") -> str:
    return level if level in ALLOWED_INFO_GAIN_LEVELS else fallback


def create_empty_runtime_map(anchor_id: str) -> Dict[str, Any]:
    return {
        "anchor_id": anchor_id,
        "turn_signal": "noise",
        "anchor_assessment": {
            "state": "不可判",
            "confidence_level": "low",
            "reasons": ["当前还没有足够证据，先保持保守判断"],
        },
        "hypotheses": [],
        "misunderstandings": [],
        "open_questions": [],
        "verification_targets": [],
        "info_gain_level": "medium",
    }


def _normalize_hypothesis(entry: Dict[str, Any] | None, index: int) -> Dict[str, Any]:
    if isinstance(entry, str):
        entry = {"note": entry}
    entry = entry or {}
    evidence_refs = entry.get("evidence_refs") or entry.get("evidenceRefs") or []
    return {
        "id": entry.get("id") if str(entry.get("id", "")).strip() else f"hypothesis-{index + 1}",
        "status": entry.get("status") if entry.get("status") in {"supported", "unsupported", "contradicted", "unknown"} else "unknown",
        "confidence_level": normalize_confidence_level(entry.get("confidence_level") or entry.get("confidenceLevel"), "low"),
        "evidence_refs": [value for value in evidence_refs if value][:4],
        "note": str(entry.get("note", "") or ""),
    }


def _normalize_misunderstanding(entry: Dict[str, Any] | None, index: int) -> Dict[str, Any]:
    if isinstance(entry, str):
        entry = {"label": entry}
    entry = entry or {}
    evidence_refs = entry.get("evidence_refs") or entry.get("evidenceRefs") or []
    label = str(entry.get("label", "") or "").strip()
    return {
        "label": label or f"misunderstanding-{index + 1}",
        "confidence_level": normalize_confidence_level(entry.get("confidence_level") or entry.get("confidenceLevel"), "low"),
        "evidence_refs": [value for value in evidence_refs if value][:4],
    }


def merge_runtime_maps(previous_map: Dict[str, Any] | None = None, next_map: Dict[str, Any] | None = None, expected_anchor_id: str = "") -> Dict[str, Any] | None:
    if previous_map is None:
        return next_map
    if next_map is None:
        return previous_map

    anchor_id = next_map.get("anchor_id") or previous_map.get("anchor_id") or expected_anchor_id
    hypothesis_map: Dict[str, Dict[str, Any]] = {}
    for index, entry in enumerate(previous_map.get("hypotheses") or []):
        normalized = _normalize_hypothesis(entry, index)
        hypothesis_map[normalized["id"]] = normalized
    for index, entry in enumerate(next_map.get("hypotheses") or []):
        normalized = _normalize_hypothesis(entry, index)
        hypothesis_map[normalized["id"]] = normalized

    misunderstanding_map: Dict[str, Dict[str, Any]] = {}
    for index, entry in enumerate([*(previous_map.get("misunderstandings") or []), *(next_map.get("misunderstandings") or [])]):
        normalized = _normalize_misunderstanding(entry, index)
        misunderstanding_map[normalized["label"]] = normalized

    verification_targets: List[Dict[str, Any]] = []
    verification_keys = set()
    for entry in [*(previous_map.get("verification_targets") or []), *(next_map.get("verification_targets") or [])]:
        if isinstance(entry, str):
            entry = {"question": entry}
        key = f"{entry.get('id', '')}:{entry.get('question', '')}"
        if not key.strip() or key in verification_keys:
            continue
        verification_keys.add(key)
        verification_targets.append(entry)

    return {
        "anchor_id": anchor_id,
        "turn_signal": next_map.get("turn_signal") or previous_map.get("turn_signal") or "noise",
        "anchor_assessment": next_map.get("anchor_assessment") or previous_map.get("anchor_assessment"),
        "hypotheses": list(hypothesis_map.values())[:6],
        "misunderstandings": list(misunderstanding_map.values())[:4],
        "open_questions": list(dict.fromkeys([*(previous_map.get("open_questions") or []), *(next_map.get("open_questions") or [])]))[:4],
        "verification_targets": verification_targets[:4],
        "info_gain_level": normalize_info_gain_level(next_map.get("info_gain_level") or previous_map.get("info_gain_level"), "medium"),
    }


def build_control_verdict(*, envelope: Dict[str, Any], context_packet: Dict[str, Any], scope_type: str = "pack") -> Dict[str, Any]:
    next_move = envelope.get("next_move") or {}
    reply = envelope.get("reply") or {}
    runtime_map = envelope.get("runtime_map") or {}
    stop_conditions = context_packet.get("stop_conditions") or {}
    budget = context_packet.get("budget") or {}

    should_stop = False
    reason = "continue"
    if next_move.get("ui_mode") in {"advance", "stop", "revisit"} or reply.get("requires_response") is False:
        should_stop = True
        reason = "next_move_requests_stop"
    elif runtime_map.get("info_gain_level") == "negligible":
        reason = "low_information_gain"
    elif stop_conditions.get("probe_budget_reached"):
        reason = "probe_budget_reached"
    elif stop_conditions.get("friction_high"):
        reason = "high_friction"

    if scope_type == "concept" and next_move.get("ui_mode") == "advance":
        reason = "concept_scope_guard"

    return {
        "should_stop": should_stop,
        "reason": reason,
        "confidence_level": ((runtime_map.get("anchor_assessment") or {}).get("confidence_level")) or "low",
        "scope_type": scope_type,
        "budget_snapshot": {
            "remaining_probe_turns": budget.get("remaining_probe_turns"),
            "remaining_teach_turns": budget.get("remaining_teach_turns"),
        },
    }


def assert_valid_turn_envelope(envelope: Dict[str, Any], expected_anchor_id: str) -> None:
    if not isinstance(envelope, dict):
        raise ValueError("Turn envelope payload is required.")
    runtime_map = envelope.get("runtime_map") or {}
    next_move = envelope.get("next_move") or {}
    reply = envelope.get("reply") or {}
    suggestion = envelope.get("writeback_suggestion") or {}

    if runtime_map.get("anchor_id") != expected_anchor_id:
        raise ValueError("Turn envelope runtime_map anchor_id mismatch.")
    if runtime_map.get("turn_signal") not in ALLOWED_SIGNALS:
        raise ValueError("Turn envelope runtime_map turn_signal is invalid.")
    assessment = runtime_map.get("anchor_assessment") or {}
    if assessment.get("state") not in ALLOWED_STATES:
        raise ValueError("Turn envelope runtime_map anchor_assessment state is invalid.")
    if assessment.get("confidence_level") not in ALLOWED_CONFIDENCE_LEVELS:
        raise ValueError("Turn envelope runtime_map anchor_assessment confidence_level is invalid.")
    if runtime_map.get("info_gain_level") not in ALLOWED_INFO_GAIN_LEVELS:
        raise ValueError("Turn envelope runtime_map info_gain_level is invalid.")

    if not str(next_move.get("intent", "")).strip():
        raise ValueError("Turn envelope next_move.intent is required.")
    if not str(next_move.get("reason", "")).strip():
        raise ValueError("Turn envelope next_move.reason is required.")
    if next_move.get("ui_mode") not in ALLOWED_UI_MODES:
        raise ValueError("Turn envelope next_move ui_mode is invalid.")
    if next_move.get("expected_gain") not in ALLOWED_INFO_GAIN_LEVELS:
        raise ValueError("Turn envelope next_move expected_gain is invalid.")

    if not str(reply.get("visible_reply", "")).strip():
        raise ValueError("Turn envelope reply.visible_reply is required.")
    if not str(reply.get("evidence_reference", "")).strip():
        raise ValueError("Turn envelope reply.evidence_reference is required.")
    if not str(reply.get("takeaway", "")).strip():
        raise ValueError("Turn envelope reply.takeaway is required.")
    if not isinstance(reply.get("requires_response"), bool):
        raise ValueError("Turn envelope reply.requires_response is invalid.")
    if not isinstance(reply.get("complete_current_unit"), bool):
        raise ValueError("Turn envelope reply.complete_current_unit is invalid.")
    if reply.get("requires_response") and not str(reply.get("next_prompt", "")).strip():
        raise ValueError("Turn envelope reply.next_prompt is required.")

    if not isinstance(suggestion.get("should_write"), bool):
        raise ValueError("Turn envelope writeback_suggestion.should_write is invalid.")
    if suggestion.get("mode") not in {"update", "append_conflict", "noop"}:
        raise ValueError("Turn envelope writeback_suggestion.mode is invalid.")
    anchor_patch = suggestion.get("anchor_patch") or {}
    if anchor_patch.get("state") not in ALLOWED_STATES:
        raise ValueError("Turn envelope writeback_suggestion.anchor_patch.state is invalid.")
    if anchor_patch.get("confidence_level") not in ALLOWED_CONFIDENCE_LEVELS:
        raise ValueError("Turn envelope writeback_suggestion.anchor_patch.confidence_level is invalid.")


def assert_consistent_turn_envelope(envelope: Dict[str, Any], context_packet: Dict[str, Any]) -> None:
    runtime_map = envelope.get("runtime_map") or {}
    next_move = envelope.get("next_move") or {}
    reply = envelope.get("reply") or {}

    if runtime_map.get("info_gain_level") == "negligible" and next_move.get("ui_mode") == "probe":
        raise ValueError("Turn envelope is inconsistent: negligible info gain cannot continue probing.")
    if (context_packet.get("stop_conditions") or {}).get("should_discourage_more_probe") and next_move.get("ui_mode") == "probe":
        raise ValueError("Turn envelope is inconsistent: stop conditions discourage more probing.")
    if next_move.get("ui_mode") in {"advance", "stop", "revisit"} and reply.get("requires_response"):
        raise ValueError("Turn envelope is inconsistent: non-interactive moves cannot require a response.")
    if next_move.get("ui_mode") in {"probe", "verify"} and reply.get("requires_response") is False:
        raise ValueError("Turn envelope is inconsistent: probing moves must require a response.")
    if next_move.get("ui_mode") == "teach" and not (reply.get("teaching_paragraphs") or []):
        raise ValueError("Turn envelope is inconsistent: teach move requires teaching_paragraphs.")


def turn_envelope_to_tutor_move(envelope: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    runtime_map = envelope.get("runtime_map") or {}
    next_move = envelope.get("next_move") or {}
    reply = envelope.get("reply") or {}
    ui_mode = next_move.get("ui_mode")
    turn_signal = runtime_map.get("turn_signal")

    if ui_mode == "teach":
        move_type = "teach"
    elif ui_mode == "verify":
        move_type = "deepen" if turn_signal == "positive" else "check"
    elif ui_mode in {"advance", "revisit"}:
        move_type = "advance"
    elif ui_mode == "stop":
        move_type = "abstain"
    else:
        move_type = "deepen" if turn_signal == "positive" else "repair"

    teaching_paragraphs = reply.get("teaching_paragraphs") or []
    return {
        "moveType": move_type,
        "signal": runtime_map.get("turn_signal", "noise"),
        "judge": {
            "state": ((runtime_map.get("anchor_assessment") or {}).get("state")) or "不可判",
            "confidence": confidence_level_to_score(((runtime_map.get("anchor_assessment") or {}).get("confidence_level")) or "low"),
            "confidenceLevel": ((runtime_map.get("anchor_assessment") or {}).get("confidence_level")) or "low",
            "reasons": ((runtime_map.get("anchor_assessment") or {}).get("reasons")) or [],
        },
        "visibleReply": reply.get("visible_reply") or concept.get("summary", ""),
        "evidenceReference": reply.get("evidence_reference") or concept.get("excerpt") or concept.get("summary", ""),
        "teachingChunk": "\n\n".join(teaching_paragraphs) if teaching_paragraphs else "",
        "teachingParagraphs": teaching_paragraphs,
        "nextQuestion": reply.get("next_prompt", "") or "",
        "takeaway": reply.get("takeaway") or concept.get("summary", ""),
        "confirmedUnderstanding": reply.get("confirmed_understanding", "") or "",
        "remainingGap": reply.get("remaining_gap", "") or "",
        "revisitReason": reply.get("revisit_reason", "") or "",
        "completeCurrentUnit": bool(reply.get("complete_current_unit")),
        "requiresResponse": bool(reply.get("requires_response")),
        "nextMove": next_move,
        "runtimeMap": runtime_map,
        "writebackSuggestion": envelope.get("writeback_suggestion"),
    }
