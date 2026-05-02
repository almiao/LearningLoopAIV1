from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


CONFIG_PATH = Path(__file__).resolve().parents[3] / "contracts" / "mastery-scoring-v1.json"
CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

STATE_RANK = CONFIG["stateRank"]
CONFIDENCE_LEVEL_SCORE = CONFIG["confidenceLevelScore"]
READING_SCORE = CONFIG["readingScore"]
TRAINING_SCORE = CONFIG["trainingScore"]
STABILITY_SCORE = CONFIG["stabilityScore"]
CONFLICT_PENALTY = CONFIG["conflictPenalty"]
TARGET_READINESS = CONFIG["targetReadiness"]
LABELS = CONFIG["labels"]


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def average(values: List[float]) -> int:
    if not values:
        return 0
    return round(sum(values) / len(values))


def rank_state(state: str = "不可判") -> int:
    return STATE_RANK.get(state, STATE_RANK["weak"])


def confidence_level_to_score(level: str = "low") -> float:
    return CONFIDENCE_LEVEL_SCORE.get(level, CONFIDENCE_LEVEL_SCORE["low"])


def score_to_confidence_level(score: float = 0.0) -> str:
    if score >= 0.75:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def build_mastery_label(score: float = 0.0, *, has_evidence: bool = False, has_reading: bool = False) -> str:
    if not has_evidence and not has_reading:
        return "未开始"
    for entry in LABELS["mastery"]:
        if score >= entry["min"]:
            return str(entry["label"])
    return "未开始"


def build_target_label(score: float = 0.0) -> str:
    for entry in LABELS["target"]:
        if score >= entry["min"]:
            return str(entry["label"])
    return "尚未建立证据"


def calculate_reading_score(reading_progress: Dict[str, Any] | None = None) -> int:
    reading_progress = reading_progress or {}
    progress_percentage = float(reading_progress.get("progressPercentage", 0) or 0)
    dwell_ms = float(reading_progress.get("dwellMs", 0) or 0)
    completed_read_count = int(reading_progress.get("completedReadCount", 0) or 0)

    score = 0
    if progress_percentage > 0:
        score += READING_SCORE["opened"]
    if progress_percentage >= 25:
        score += READING_SCORE["progress25"]
    if progress_percentage >= 50:
        score += READING_SCORE["progress50"]
    if progress_percentage >= 75:
        score += READING_SCORE["progress75"]
    if progress_percentage >= 90 and dwell_ms >= 45_000:
        score += READING_SCORE["progress90Complete"]
    if completed_read_count >= 2:
        score += READING_SCORE["secondFullReadBonus"]
    if completed_read_count >= 3:
        score += READING_SCORE["thirdPlusFullReadBonus"]
    return int(clamp(score, 0, READING_SCORE["max"]))


def calculate_training_score(memory_item: Dict[str, Any] | None = None) -> int:
    memory_item = memory_item or {}
    evidence_count = int(memory_item.get("evidenceCount", 0) or 0)
    if evidence_count <= 0:
        return 0

    state = str(memory_item.get("state", "weak"))
    config = TRAINING_SCORE.get(state, TRAINING_SCORE["weak"])
    score = config["base"] + max(0, evidence_count - 1) * config["repeat"]
    return int(clamp(score, 0, min(config["max"], TRAINING_SCORE["max"])))


def calculate_stability_score(memory_item: Dict[str, Any] | None = None) -> int:
    memory_item = memory_item or {}
    evidence_count = int(memory_item.get("evidenceCount", 0) or 0)
    if evidence_count <= 0:
        return 0

    state = str(memory_item.get("state", "不可判"))
    strong_evidence_count = len(memory_item.get("recentStrongEvidence") or [])
    if state == "solid" and strong_evidence_count >= 2:
        return int(STABILITY_SCORE["repeatedSolid"])
    if state == "solid" and strong_evidence_count >= 1:
        return int(STABILITY_SCORE["singleSolid"])
    if state in {"partial", "solid"} and evidence_count >= 2:
        return int(STABILITY_SCORE["repeatedPartialOrAbove"])
    if state in {"partial", "solid"}:
        return int(STABILITY_SCORE["partialOrAbove"])
    return 0


def calculate_conflict_penalty(memory_item: Dict[str, Any] | None = None) -> int:
    memory_item = memory_item or {}
    conflicts = len(memory_item.get("recentConflictingEvidence") or [])
    if conflicts <= 0:
        return 0

    penalty = conflicts * CONFLICT_PENALTY["perConflict"]
    if str(memory_item.get("state", "不可判")) == "weak":
        penalty += CONFLICT_PENALTY["weakStateExtra"]
    return int(clamp(penalty, 0, CONFLICT_PENALTY["max"]))


def calculate_mastery_score(*, reading_progress: Dict[str, Any] | None = None, memory_item: Dict[str, Any] | None = None) -> int:
    return int(
        clamp(
            calculate_reading_score(reading_progress)
            + calculate_training_score(memory_item)
            + calculate_stability_score(memory_item)
            - calculate_conflict_penalty(memory_item),
            0,
            100,
        )
    )


def calculate_target_readiness_score(items: List[Dict[str, Any]]) -> int:
    if not items:
        return int(TARGET_READINESS["min"])
    score = average([float(item.get("masteryScore", 0) or 0) for item in items])
    return int(clamp(score, TARGET_READINESS["min"], TARGET_READINESS["max"]))
