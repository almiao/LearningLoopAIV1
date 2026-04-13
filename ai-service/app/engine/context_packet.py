from __future__ import annotations

import time
from typing import Any, Dict, List


DEFAULT_LAYER_BUDGETS = {
    "stable": 1800,
    "dynamic": 3200,
    "reference": 2200,
}


def normalize_whitespace(value: Any = "") -> str:
    return " ".join(str(value or "").split()).strip()


def trim_text(value: Any, max_chars: int) -> str:
    normalized = normalize_whitespace(value)
    if not normalized:
        return ""
    if len(normalized) <= max_chars:
        return normalized
    return f"{normalized[: max(0, max_chars - 1)].strip()}…"


def pick_recent_turns(turns: List[Dict[str, Any]] | None = None, max_turns: int = 6, max_chars: int = 240) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for turn in (turns or []):
        if turn.get("role") == "system":
            continue
        result.append(
            {
                "role": turn.get("role", ""),
                "kind": turn.get("kind", ""),
                "action": turn.get("action", ""),
                "conceptId": turn.get("conceptId", ""),
                "content": trim_text(turn.get("content", ""), max_chars),
            }
        )
    return result[-max_turns:]


def pick_recent_evidence(entries: List[Dict[str, Any]] | None = None, max_entries: int = 4, max_chars: int = 180) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for index, entry in enumerate((entries or [])[-max_entries:]):
        result.append(
            {
                "id": entry.get("id") or f"ev-{index + 1}",
                "signal": entry.get("signal", "noise"),
                "answer": trim_text(entry.get("answer", ""), max_chars),
                "explanation": trim_text(entry.get("explanation", ""), max_chars),
                "evidenceReference": trim_text(entry.get("evidenceReference", ""), max_chars),
                "timestamp": entry.get("timestamp") or entry.get("at") or "",
            }
        )
    return result


def pick_recent_anchor_turns(turns: List[Dict[str, Any]] | None = None, concept_id: str = "", max_turns: int = 4, max_chars: int = 220) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for turn in (turns or []):
        if turn.get("role") == "system":
            continue
        if turn.get("conceptId") != concept_id:
            continue
        result.append(
            {
                "role": turn.get("role", ""),
                "kind": turn.get("kind", ""),
                "action": turn.get("action", ""),
                "content": trim_text(turn.get("content", ""), max_chars),
                "takeaway": trim_text(turn.get("takeaway", ""), 140),
            }
        )
    return result[-max_turns:]


def build_anchor_state_snapshot(session: Dict[str, Any], concept_id: str) -> Dict[str, Any]:
    concept_state = ((session.get("conceptStates") or {}).get(concept_id, {}) or {})
    anchor_state = concept_state.get("anchorState") or {}
    return {
        "confirmed_understanding": trim_text(anchor_state.get("confirmedUnderstanding", ""), 180),
        "last_followup_goal": trim_text(anchor_state.get("lastFollowupGoal", ""), 180),
        "last_learner_intent": trim_text(anchor_state.get("lastLearnerIntent", ""), 80),
        "last_tutor_action": trim_text(anchor_state.get("lastTutorAction", ""), 80),
    }


def build_source_references(concept: Dict[str, Any], max_sources: int = 4) -> List[Dict[str, Any]]:
    references: List[Dict[str, Any]] = []
    interview_question = concept.get("interviewQuestion") or {}

    if concept.get("provenanceLabel") or interview_question.get("label"):
        references.append(
            {
                "kind": "provenance",
                "title": concept.get("provenanceLabel") or interview_question.get("label") or concept.get("title", ""),
                "snippet": trim_text(
                    interview_question.get("prompt")
                    or interview_question.get("label")
                    or concept.get("provenanceLabel")
                    or concept.get("summary", ""),
                    220,
                ),
                "url": "",
            }
        )

    for source in concept.get("javaGuideSources") or []:
        references.append(
            {
                "kind": "knowledge",
                "title": trim_text(source.get("title", ""), 80),
                "snippet": trim_text(source.get("path") or source.get("url") or source.get("title", ""), 220),
                "url": source.get("url", ""),
            }
        )

    for material in concept.get("remediationMaterials") or []:
        references.append(
            {
                "kind": "remediation",
                "title": trim_text(material.get("title", ""), 80),
                "snippet": trim_text(
                    material.get("description") or material.get("summary") or material.get("title", ""),
                    220,
                ),
                "url": material.get("url", ""),
            }
        )

    return references[:max_sources]


def build_anchor_identity(concept: Dict[str, Any]) -> Dict[str, Any]:
    anchor_identity = concept.get("anchorIdentity") or {}
    return {
        "canonicalId": concept.get("id", ""),
        "stableDescription": concept.get("summary", ""),
        "inclusionBoundary": trim_text(anchor_identity.get("inclusionBoundary") or concept.get("summary", ""), 220),
        "exclusionBoundary": trim_text(
            anchor_identity.get("exclusionBoundary")
            or concept.get("misconception")
            or f"不要把“{concept.get('title', '')}”泛化成整个能力域。",
            220,
        ),
        "allowedEvidenceTypes": anchor_identity.get("allowedEvidenceTypes")
        or ["diagnostic-answer", "teach-back", "migration-answer", "contradiction"],
        "typicalMisunderstandingFamilies": anchor_identity.get("typicalMisunderstandingFamilies")
        or ([concept.get("misconception")] if concept.get("misconception") else []),
        "sourceFamilies": anchor_identity.get("sourceFamilies") or ["knowledge", "provenance", "interaction"],
    }


def _describe_scope(session: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    scope = session.get("workspaceScope") or {
        "type": "pack",
        "id": (session.get("targetBaseline") or {}).get("id") or (session.get("source") or {}).get("kind", ""),
    }
    return {
        "type": scope.get("type", "pack"),
        "id": scope.get("id", ""),
        "currentConceptId": concept.get("id", ""),
    }


def _create_raw_evidence_point(session: Dict[str, Any], concept: Dict[str, Any], answer: str, source_refs: List[Dict[str, Any]]) -> Dict[str, Any]:
    attempt = ((session.get("conceptStates") or {}).get(concept.get("id"), {}) or {}).get("attempts", 0) + 1
    return {
        "id": f"ev-{concept.get('id', '')}-{attempt}",
        "anchorId": concept.get("id", ""),
        "type": "learner_answer",
        "prompt": trim_text(session.get("currentProbe", ""), 220),
        "answer": trim_text(answer, 320),
        "sourceRefs": [source.get("title") or source.get("id") or source.get("url") for source in source_refs if source],
        "timestamp": int(time.time() * 1000),
    }


def build_context_packet(
    *,
    session: Dict[str, Any],
    concept: Dict[str, Any],
    answer: str,
    burden_signal: str = "normal",
    prior_evidence: List[Dict[str, Any]] | None = None,
    raw_evidence_point: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    source_refs = build_source_references(concept)
    effective_raw_evidence_point = raw_evidence_point or _create_raw_evidence_point(session, concept, answer, source_refs)
    anchor_identity = build_anchor_identity(concept)
    memory_anchor = ((session.get("memoryProfile") or {}).get("abilityItems") or {}).get(concept.get("id"))
    stable_scope = _describe_scope(session, concept)
    previous_runtime_map = ((session.get("runtimeMaps") or {}).get(concept.get("id"))) or None
    anchor_turns = pick_recent_anchor_turns(session.get("turns") or [], concept.get("id", ""))
    anchor_state = build_anchor_state_snapshot(session, concept.get("id", ""))

    has_reference_content = len(source_refs) > 0
    budgets = dict(DEFAULT_LAYER_BUDGETS)
    if not has_reference_content:
        budgets["dynamic"] = DEFAULT_LAYER_BUDGETS["dynamic"] + DEFAULT_LAYER_BUDGETS["reference"]
        budgets["reference"] = 0

    max_probe_turns = 3 if concept.get("importance", "secondary") == "core" else 2
    probe_turns_used = (((session.get("conceptStates") or {}).get(concept.get("id"), {}) or {}).get("attempts", 0))
    teach_turns_used = (((session.get("conceptStates") or {}).get(concept.get("id"), {}) or {}).get("teachCount", 0))

    return {
        "stable": {
            "target": {
                "id": (session.get("targetBaseline") or {}).get("id") or (session.get("source") or {}).get("kind", ""),
                "title": (session.get("targetBaseline") or {}).get("title") or (session.get("source") or {}).get("title", ""),
                "mode": session.get("mode", "target"),
            },
            "scope": stable_scope,
            "anchorIdentity": anchor_identity,
            "memoryAnchor": memory_anchor,
        },
        "dynamic": {
            "currentQuestion": trim_text(session.get("currentProbe", ""), 220),
            "learnerAnswer": trim_text(answer, 320),
            "burdenSignal": burden_signal,
            "interactionPreference": session.get("interactionPreference", "balanced"),
            "engagement": dict(session.get("engagement") or {}),
            "previousRuntimeMap": previous_runtime_map,
            "recentTurns": pick_recent_turns(session.get("turns") or []),
            "anchorState": anchor_state,
            "anchorHistory": {
                "recentTurns": anchor_turns,
                "teachCount": teach_turns_used,
                "hasRecentTeaching": any(
                    turn.get("role") == "tutor" and (turn.get("action") == "teach" or turn.get("kind") == "feedback")
                    for turn in anchor_turns
                ),
                "recentTakeaways": [turn.get("takeaway", "") for turn in anchor_turns if turn.get("takeaway")][-2:],
            },
            "recentEvidence": pick_recent_evidence(prior_evidence or []),
            "rawEvidencePoint": effective_raw_evidence_point,
        },
        "reference": {
            "sources": source_refs,
            "sourceSummary": {
                "title": (session.get("source") or {}).get("title", ""),
                "framing": trim_text(((session.get("summary") or {}).get("framing")), 220),
            },
        },
        "budgets": budgets,
        "target": {
            "id": (session.get("targetBaseline") or {}).get("id") or (session.get("source") or {}).get("kind", ""),
            "title": (session.get("targetBaseline") or {}).get("title") or (session.get("source") or {}).get("title", ""),
            "mode": session.get("mode", "target"),
        },
        "scope": {
            "type": stable_scope["type"],
            "id": stable_scope["id"],
            "current_anchor_id": concept.get("id", ""),
            "current_domain_id": concept.get("abilityDomainId") or concept.get("domainId") or "general",
            "current_domain_title": concept.get("abilityDomainTitle") or concept.get("domainTitle") or "通用能力",
        },
        "anchor": {
            "canonical_id": anchor_identity["canonicalId"],
            "title": concept.get("title", ""),
            "stable_description": anchor_identity["stableDescription"],
            "inclusion_boundary": anchor_identity["inclusionBoundary"],
            "exclusion_boundary": anchor_identity["exclusionBoundary"],
            "allowed_evidence_types": anchor_identity["allowedEvidenceTypes"],
            "typical_misunderstanding_families": anchor_identity["typicalMisunderstandingFamilies"],
            "source_families": anchor_identity["sourceFamilies"],
        },
        "memory_anchor_summary": memory_anchor,
        "recent_evidence": pick_recent_evidence(prior_evidence or []),
        "recent_turns": pick_recent_turns(session.get("turns") or []),
        "anchor_state": anchor_state,
        "anchor_history": {
            "recent_turns": anchor_turns,
            "teach_count": teach_turns_used,
            "has_recent_teaching": any(
                turn.get("role") == "tutor" and (turn.get("action") == "teach" or turn.get("kind") == "feedback")
                for turn in anchor_turns
            ),
            "recent_takeaways": [turn.get("takeaway", "") for turn in anchor_turns if turn.get("takeaway")][-2:],
        },
        "source_refs": source_refs[:2],
        "runtime_understanding_map": previous_runtime_map,
        "budget": {
            "max_probe_turns": max_probe_turns,
            "probe_turns_used": probe_turns_used,
            "remaining_probe_turns": max(0, max_probe_turns - probe_turns_used),
            "max_teach_turns": 2,
            "teach_turns_used": teach_turns_used,
            "remaining_teach_turns": max(0, 2 - teach_turns_used),
        },
        "friction_signals": {
            "burden_signal": burden_signal,
            "answer_length": len(trim_text(answer, 320)),
            "answer_is_blank": not trim_text(answer, 320),
            "teach_request_count": (session.get("engagement") or {}).get("teachRequestCount", 0),
            "skip_count": (session.get("engagement") or {}).get("skipCount", 0),
            "repeated_control_count": (session.get("engagement") or {}).get("consecutiveControlCount", 0),
            "fatigue_level": (
                "high"
                if burden_signal == "high"
                else "medium"
                if (session.get("engagement") or {}).get("consecutiveControlCount", 0) >= 2
                else "low"
            ),
        },
        "stop_conditions": {
            "probe_budget_reached": probe_turns_used >= max_probe_turns,
            "teach_budget_reached": teach_turns_used >= 2,
            "friction_high": burden_signal == "high",
            "recent_info_gain_level": ((previous_runtime_map or {}).get("info_gain_level")) or "medium",
            "should_discourage_more_probe": (
                burden_signal == "high"
                or probe_turns_used >= max_probe_turns
                or ((previous_runtime_map or {}).get("info_gain_level") == "negligible")
            ),
        },
        "draft_evidence": effective_raw_evidence_point,
    }
