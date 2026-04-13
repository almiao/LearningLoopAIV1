from __future__ import annotations

from typing import Any, Dict

ALLOWED_INTERACTION_PREFERENCES = {"probe-heavy", "balanced", "explain-first"}


def normalize_interaction_preference(value: str = "balanced") -> str:
    return value if value in ALLOWED_INTERACTION_PREFERENCES else "balanced"


def estimate_fatigue(burden_signal: str, attempts: int) -> str:
    if burden_signal == "high":
        return "high"
    if attempts >= 2:
        return "medium"
    return "low"


def estimate_question_headroom(concept: Dict[str, Any], attempts: int, judge: Dict[str, Any]) -> str:
    if concept.get("coverage") == "low":
        return "low"
    if attempts >= 2:
        return "low"
    if judge["state"] == "solid" or judge["confidence"] >= 0.8:
        return "low"
    if concept.get("coverage") == "high" and attempts == 0:
        return "high"
    return "medium"


def choose_next_action(
    concept: Dict[str, Any],
    concept_state: Dict[str, Any],
    judge: Dict[str, Any],
    burden_signal: str = "normal",
    interaction_preference: str = "balanced",
) -> str:
    preference = normalize_interaction_preference(interaction_preference)
    attempts = concept_state["attempts"]
    fatigue = estimate_fatigue(burden_signal, attempts)
    headroom = estimate_question_headroom(concept, attempts, judge)
    importance = concept.get("importance") or "secondary"
    teach_count = concept_state.get("teachCount", 0)
    signal = "positive" if judge["state"] in {"partial", "solid"} else "negative"

    if judge["state"] == "不可判":
        return "advance"

    if signal == "positive":
        if fatigue == "high" or headroom == "low" or (importance != "core" and judge["confidence"] >= 0.6):
            return "advance"
        return "affirm" if preference == "explain-first" else "deepen"

    if attempts >= 2 or fatigue == "high" or headroom == "low" or preference == "explain-first":
        if teach_count >= 1 and (importance != "core" or headroom == "low" or fatigue != "low"):
            return "advance"
        return "teach"

    return "repair"


def build_prompt_for_action(action: str, concept: Dict[str, Any]) -> str:
    if action in {"affirm", "deepen"}:
        return concept.get("stretchQuestion") or concept.get("checkQuestion") or concept.get("retryQuestion") or ""
    if action == "repair":
        return concept.get("retryQuestion") or concept.get("checkQuestion") or ""
    if action == "teach":
        return concept.get("checkQuestion") or concept.get("retryQuestion") or ""
    return ""
