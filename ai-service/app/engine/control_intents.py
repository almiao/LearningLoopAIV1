from __future__ import annotations

from typing import Optional

ADVANCE_INTENTS = {"下一题", "跳过", "skip", "next"}
TEACH_INTENTS = {"讲一下", "先讲一下", "直接讲", "给答案", "解释一下"}
ALLOWED_CONTROL_INTENTS = {"advance", "teach"}


def normalize_whitespace(value: str = "") -> str:
    return " ".join(str(value or "").split()).strip()


def normalize_control_intent(intent: str = "") -> Optional[str]:
    normalized = normalize_whitespace(intent).lower()
    return normalized if normalized in ALLOWED_CONTROL_INTENTS else None


def detect_control_intent(answer: str = "", explicit_intent: str = "") -> Optional[str]:
    normalized_intent = normalize_control_intent(explicit_intent)
    if normalized_intent:
        return normalized_intent

    normalized = normalize_whitespace(answer).lower()
    if not normalized:
        return None
    if normalized in {item.lower() for item in ADVANCE_INTENTS}:
        return "advance"
    if normalized in {item.lower() for item in TEACH_INTENTS}:
        return "teach"
    return None
