from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException

from app.engine.context_packet import build_context_packet
from app.core.config import versions
from app.engine.control_intents import detect_control_intent
from app.engine.mastery_scoring import (
    build_target_label,
    calculate_mastery_score,
    calculate_target_readiness_score,
    rank_state as score_rank_state,
)
from app.engine.tutor_intelligence import create_tutor_intelligence, describe_tutor_intelligence, normalize_decomposition_payload
from app.observability import events
from app.observability.logger import logger
from app.core.tracing import trace_id_var
from app.engine.turn_envelope import (
    assert_consistent_turn_envelope,
    assert_valid_turn_envelope,
    build_control_verdict,
    create_empty_runtime_map,
    merge_runtime_maps,
    score_to_confidence_level,
    turn_envelope_to_tutor_move,
)

SESSIONS: Dict[str, Dict[str, Any]] = {}
_TUTOR_INTELLIGENCE = None
ALLOWED_INTERACTION_PREFERENCES = {"probe-heavy", "balanced", "explain-first"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_tutor_intelligence():
    global _TUTOR_INTELLIGENCE
    if _TUTOR_INTELLIGENCE is None:
        _TUTOR_INTELLIGENCE = create_tutor_intelligence()
    return _TUTOR_INTELLIGENCE


def normalize_interaction_preference(value: str = "balanced") -> str:
    return value if value in ALLOWED_INTERACTION_PREFERENCES else "balanced"


def get_concept_round_budget(concept: Dict[str, Any]) -> int:
    return 3 if (concept.get("importance") or "secondary") == "core" else 2


def get_consumed_rounds(session: Optional[Dict[str, Any]], concept: Dict[str, Any]) -> int:
    concept_state = ((session or {}).get("conceptStates") or {}).get(concept.get("id", ""), {}) or {}
    return int(concept_state.get("attempts", 0) or 0) + int(concept_state.get("teachCount", 0) or 0)


def get_current_round(session: Optional[Dict[str, Any]], concept: Dict[str, Any]) -> int:
    consumed_rounds = get_consumed_rounds(session, concept)
    return min(get_concept_round_budget(concept), max(1, consumed_rounds + 1))


def build_concept_takeaway(concept: Dict[str, Any]) -> str:
    return str(concept.get("summary") or concept.get("title") or "").strip()


def get_training_point_map(session: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {point["id"]: point for point in session.get("trainingPoints") or []}


def get_checkpoint_point(session: Dict[str, Any], checkpoint_id: str) -> Optional[Dict[str, Any]]:
    for point in session.get("trainingPoints") or []:
        if any(checkpoint.get("id") == checkpoint_id for checkpoint in point.get("checkpoints") or []):
            return point
    return None


def get_checkpoint_from_point(point: Optional[Dict[str, Any]], checkpoint_id: str) -> Optional[Dict[str, Any]]:
    if not point:
        return None
    return next((checkpoint for checkpoint in point.get("checkpoints") or [] if checkpoint.get("id") == checkpoint_id), None)


def get_current_training_point(session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return get_training_point_map(session).get(session.get("currentTrainingPointId", ""))


def get_current_checkpoint_point(session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return get_checkpoint_point(session, session.get("currentCheckpointId", ""))


def get_current_checkpoint_concept(session: Dict[str, Any]) -> Dict[str, Any]:
    checkpoint_id = session["currentCheckpointId"]
    return next(item for item in session["concepts"] if item["id"] == checkpoint_id)


def terminal_checkpoint_status(checkpoint_state: Dict[str, Any]) -> bool:
    return bool(checkpoint_state.get("completed"))


def compute_training_point_state(session: Dict[str, Any], point: Dict[str, Any]) -> Dict[str, Any]:
    checkpoint_states = session.get("conceptStates") or {}
    checkpoint_ids = [checkpoint["id"] for checkpoint in point.get("checkpoints") or []]
    checkpoint_statuses = [checkpoint_states.get(checkpoint_id, {}) for checkpoint_id in checkpoint_ids]
    completed_count = sum(1 for state in checkpoint_statuses if terminal_checkpoint_status(state))
    if checkpoint_statuses and completed_count == len(checkpoint_statuses):
        result = "passed" if all((state.get("result") == "passed") for state in checkpoint_statuses) else "completed_with_gaps"
        completed = True
    elif any((state.get("attempts", 0) or state.get("teachCount", 0)) > 0 for state in checkpoint_statuses):
        result = "in_progress"
        completed = False
    else:
        result = "unseen"
        completed = False
    return {
        "pointId": point["id"],
        "completed": completed,
        "result": result,
        "completedCheckpoints": completed_count,
        "totalCheckpoints": len(checkpoint_ids),
    }


def classify_checkpoint_outcome(*, diagnosis: Dict[str, Any], tutor_move: Dict[str, Any], answer: str, burden_signal: str = "normal") -> str:
    normalized_answer = str(answer or "").strip()
    evidence_quality = str((diagnosis or {}).get("evidence_quality") or "weak")
    has_misconception = bool((diagnosis or {}).get("has_misconception"))
    signal = str((tutor_move or {}).get("signal") or "noise")
    misunderstandings = ((tutor_move or {}).get("runtimeMap") or {}).get("misunderstandings") or []

    if has_misconception or signal == "negative" or misunderstandings:
        return "wrong"
    if not normalized_answer or evidence_quality in {"none", "weak"} or burden_signal == "high":
        return "empty"
    if evidence_quality == "strong" or ((tutor_move.get("judge") or {}).get("state") == "solid"):
        return "full"
    return "partial"


def map_checkpoint_result(outcome: str = "") -> str:
    if outcome == "full":
        return "passed"
    if outcome in {"partial", "empty"}:
        return "partial"
    if outcome == "wrong":
        return "incomplete"
    return "partial"


def next_checkpoint_after_completion(session: Dict[str, Any], concept: Dict[str, Any], point: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    next_unit = choose_next_unit(session)
    next_concept = next_unit.get("concept")
    next_point = get_checkpoint_point(session, next_concept["id"]) if next_concept else None
    session["currentTrainingPointId"] = next_point["id"] if next_point else session.get("currentTrainingPointId", "")
    session["currentCheckpointId"] = next_concept["id"] if next_concept else session["currentCheckpointId"]
    session["currentConceptId"] = next_concept["id"] if next_concept else concept["id"]
    session["currentProbe"] = resolve_prompt_for_concept(session=session, concept=next_concept, revisit=bool(next_unit.get("revisit"))) if next_concept else ""
    session["currentQuestionMeta"] = create_question_meta(next_concept, session=session, phase="diagnostic" if not next_unit.get("revisit") else "revisit") if next_concept else None
    return {
        "next_unit": next_unit,
        "next_concept": next_concept,
        "next_point": next_point,
    }


def build_interview_wrap_up(
    *,
    concept: Dict[str, Any],
    judge: Optional[Dict[str, Any]] = None,
    gap: str = "",
    skipped: bool = False,
) -> Dict[str, str]:
    takeaway = build_concept_takeaway(concept)
    state = str((judge or {}).get("state") or "")
    if skipped:
        lead = "这题先不硬扛，但别空手离开。"
    elif state == "solid":
        lead = "这题主线已经够面试回答了，我帮你压成一句标准说法。"
    elif state == "partial":
        lead = "这题主线你已经抓到了，我帮你收成一句更稳的面试表述。"
    else:
        lead = "这题先别继续猜了，先把标准说法带走。"

    gap_line = str(gap or concept.get("remediationHint") or "").strip()
    explanation = "\n\n".join(
        [part for part in [lead, f"标准答案：{takeaway}" if takeaway else "", f"还要补一句：{gap_line}" if gap_line else ""] if part]
    )
    return {
        "takeaway": takeaway,
        "explanation": explanation,
    }


def create_question_meta(concept: Dict[str, Any], *, session: Optional[Dict[str, Any]] = None, phase: str = "") -> Dict[str, Any]:
    question = concept.get("interviewQuestion")
    provenance = concept.get("provenance") or {}
    if question or provenance:
        source = question or provenance
        return {
            "type": "provenance-backed",
            "label": source.get("label", ""),
            "company": source.get("company", ""),
            "stage": source.get("stage", ""),
            "questionFamily": concept.get("questionFamily", ""),
            "phase": phase or "diagnostic",
            "progress": {
                "currentRound": get_current_round(session, concept) if session else 1,
                "maxRounds": get_concept_round_budget(concept),
            },
        }
    return {
        "type": "system-generated",
        "label": "系统生成诊断题",
        "company": "",
        "stage": "",
        "questionFamily": concept.get("questionFamily", ""),
        "phase": phase or "diagnostic",
        "progress": {
            "currentRound": get_current_round(session, concept) if session else 1,
            "maxRounds": get_concept_round_budget(concept),
        },
    }


def static_probe_for_concept(concept: Dict[str, Any], session: Optional[Dict[str, Any]] = None, *, revisit: bool = False) -> str:
    if concept.get("interviewAnchor", {}).get("prompt"):
        return concept["interviewAnchor"]["prompt"]

    concept_state = ((session or {}).get("conceptStates") or {}).get(concept.get("id", ""), {})
    memory_anchor = ((session or {}).get("memoryProfile") or {}).get("abilityItems", {}).get(concept.get("id", ""), {})
    attempts = concept_state.get("attempts", 0)
    has_prior_interaction = (
        attempts > 0
        or concept_state.get("teachCount", 0) > 0
        or (concept_state.get("lastAction") and concept_state.get("lastAction") != "probe")
    )
    if revisit or memory_anchor or has_prior_interaction:
        question = concept.get("retryQuestion") or concept.get("checkQuestion") or concept.get("diagnosticQuestion")
        if not question:
            raise HTTPException(status_code=502, detail="AI tutor did not generate a follow-up question for this concept.")
        return question

    question = concept.get("diagnosticQuestion") or concept.get("retryQuestion")
    if not question:
        raise HTTPException(status_code=502, detail="AI tutor did not generate an initial question for this concept.")
    return question


def generate_prompt_for_concept(
    *,
    session: Optional[Dict[str, Any]],
    concept: Dict[str, Any],
    phase: str = "diagnostic",
    revisit: bool = False,
    intelligence_override: Any = None,
) -> str:
    if concept.get("interviewAnchor", {}).get("prompt"):
        return concept["interviewAnchor"]["prompt"]

    intelligence = intelligence_override or get_tutor_intelligence()
    if session and intelligence and getattr(intelligence, "configured", False) and hasattr(intelligence, "generate_probe_question"):
        context_packet = build_context_packet(
            session=session,
            concept=concept,
            answer="",
            burden_signal=session.get("burdenSignal", "normal"),
            prior_evidence=((session.get("ledger") or {}).get(concept.get("id", "")) or {}).get("entries", []),
        )
        generated = intelligence.generate_probe_question(
            concept=concept,
            context_packet=context_packet,
            phase=phase,
            revisit=revisit,
        )
        question = str((generated or {}).get("question") or "").strip()
        if question:
            return question
        raise HTTPException(status_code=502, detail="AI tutor did not generate a runtime question for this concept.")

    return static_probe_for_concept(concept, session, revisit=revisit)


def initial_probe(concept: Dict[str, Any], session: Optional[Dict[str, Any]] = None) -> str:
    return generate_prompt_for_concept(session=session, concept=concept, phase="diagnostic")


def rank_state(state: str) -> int:
    return score_rank_state(state)


def create_empty_anchor_state() -> Dict[str, Any]:
    return {
        "confirmedUnderstanding": "",
        "lastFollowupGoal": "",
        "lastLearnerIntent": "",
        "lastTutorAction": "",
    }


def update_anchor_state(
    *,
    session: Dict[str, Any],
    concept: Dict[str, Any],
    latest_feedback: Dict[str, Any],
    learner_intent: str,
) -> Dict[str, Any]:
    anchor_state = session["conceptStates"][concept["id"]].setdefault("anchorState", create_empty_anchor_state())
    strength = latest_feedback.get("strength") or ""
    model_next_move = latest_feedback.get("modelNextMove") or latest_feedback.get("nextMove") or {}

    if strength:
        anchor_state["confirmedUnderstanding"] = strength

    anchor_state["lastFollowupGoal"] = model_next_move.get("intent", "") if latest_feedback.get("coachingStep") else ""
    anchor_state["lastLearnerIntent"] = learner_intent
    anchor_state["lastTutorAction"] = latest_feedback.get("action", "")
    return anchor_state


def move_requires_response(move: Dict[str, Any] | None) -> bool:
    ui_mode = ((move or {}).get("nextMove") or {}).get("ui_mode", "")
    return ui_mode in {"probe", "teach", "verify"}


def get_move_follow_up_question(move: Dict[str, Any] | None) -> str:
    if not move_requires_response(move):
        return ""
    return str((move or {}).get("followUpQuestion") or "").strip()


def move_type_to_ui_mode(move_type: str = "") -> str:
    if move_type == "teach":
        return "teach"
    if move_type == "advance":
        return "advance"
    if move_type in {"deepen", "affirm", "check"}:
        return "verify"
    return "probe"


def create_evidence_ledger(concepts: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {
        concept["id"]: {
            "conceptId": concept["id"],
            "entries": [],
            "state": "weak",
            "confidence": 0,
            "reasons": [],
        }
        for concept in concepts
    }


def append_evidence(ledger: Dict[str, Any], concept_id: str, evidence: Dict[str, Any]) -> None:
    ledger[concept_id]["entries"].append({**evidence, "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000)})


def build_target_match(session: Dict[str, Any]) -> Dict[str, Any]:
    reading_docs = ((session.get("targetProgress") or {}).get("readingProgress") or {}).get("docs") or {}
    scored_items = []
    for concept in session["concepts"]:
        item = session["memoryProfile"]["abilityItems"].get(concept["id"], {})
        source = ((concept.get("javaGuideSources") or [{}])[0]).get("path", "")
        scored_items.append(
            {
                "title": concept["title"],
                "masteryScore": calculate_mastery_score(
                    reading_progress=reading_docs.get(source) or {},
                    memory_item=item,
                ),
            }
        )
    percentage = calculate_target_readiness_score(scored_items)
    return {
        "percentage": percentage,
        "percent": percentage,
        "readinessScore": percentage,
        "label": build_target_label(percentage),
        "explanation": "当前估计会随着更多作答证据继续收敛。",
    }


def build_ability_domains(session: Dict[str, Any]) -> List[Dict[str, Any]]:
    domains: Dict[str, Dict[str, Any]] = {}
    for concept in session["concepts"]:
        domain_id = concept.get("abilityDomainId") or concept.get("domainId") or "general"
        domain_title = concept.get("abilityDomainTitle") or concept.get("domainTitle") or "通用能力"
        domains.setdefault(domain_id, {"id": domain_id, "title": domain_title, "items": []})
        item = session["memoryProfile"]["abilityItems"].get(concept["id"], {})
        domains[domain_id]["items"].append(
            {
                "abilityItemId": concept["id"],
                "title": concept["title"],
                "state": item.get("state", "不可判"),
                "confidence": item.get("confidence", 0),
                "evidenceCount": item.get("evidenceCount", 0),
            }
        )
    return list(domains.values())


def build_next_steps(session: Dict[str, Any]) -> List[Dict[str, Any]]:
    candidates = []
    for concept in session["concepts"]:
        item = session["memoryProfile"]["abilityItems"].get(concept["id"], {})
        state = item.get("state", "weak")
        if state in {"weak", "partial", "不可判"}:
            candidates.append(
                {
                    "order": len(candidates) + 1,
                    "abilityItemId": concept["id"],
                    "abilityDomainId": concept.get("abilityDomainId") or concept.get("domainId") or "",
                    "domainId": concept.get("abilityDomainId") or concept.get("domainId") or "",
                    "title": concept["title"],
                    "state": state,
                    "recommendation": concept.get("remediationHint") or f"先补齐 {concept['title']} 的关键机制。",
                    "relatedInterviewPrompt": concept.get("provenanceLabel") or concept.get("interviewQuestion", {}).get("label") or "系统生成诊断题",
                    "materials": deepcopy(concept.get("remediationMaterials") or []),
                }
            )
    return candidates[:3]


def build_mastery_map(session: Dict[str, Any]) -> List[Dict[str, Any]]:
    items = []
    for concept in session["concepts"]:
        memory = session["memoryProfile"]["abilityItems"].get(concept["id"], {})
        items.append(
            {
                "conceptId": concept["id"],
                "title": concept["title"],
                "state": memory.get("state", "不可判"),
                "confidence": memory.get("confidence", 0),
                "reasons": memory.get("reasons", ["当前还没有足够证据"]),
                "domainId": concept.get("abilityDomainId") or concept.get("domainId") or "",
                "provenanceLabel": concept.get("provenanceLabel", ""),
                "evidence": memory.get("evidence", []),
            }
        )
    return items


def project_session(session: Dict[str, Any], latest_feedback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    current_concept_id = session["currentCheckpointId"]
    current_training_point_id = session.get("currentTrainingPointId", "")
    point_states = [compute_training_point_state(session, point) for point in session.get("trainingPoints") or []]
    return {
        "sessionId": session["id"],
        "userId": session.get("userId", ""),
        "source": {
            "title": session["source"]["title"],
            "kind": session["source"].get("kind", "baseline-pack"),
            "url": session["source"].get("url", ""),
            "metadata": deepcopy(session["source"].get("metadata") or {}),
        },
        "summary": session["summary"],
        "trainingPoints": session.get("trainingPoints") or [],
        "trainingPointStates": point_states,
        "currentTrainingPointId": current_training_point_id,
        "currentCheckpointId": current_concept_id,
        "concepts": session["concepts"],
        "currentConceptId": current_concept_id,
        "currentProbe": session.get("currentProbe", ""),
        "currentQuestionMeta": session.get("currentQuestionMeta"),
        "currentAnchorState": deepcopy((session["conceptStates"].get(current_concept_id) or {}).get("anchorState") or {}),
        "masteryMap": build_mastery_map(session),
        "nextSteps": build_next_steps(session),
        "turns": session["turns"],
        "engagement": session["engagement"],
        "revisitQueue": session["revisitQueue"],
        "burdenSignal": session.get("burdenSignal", "normal"),
        "interactionPreference": session["interactionPreference"],
        "memoryMode": "profile-scoped",
        "workspaceScope": session["workspaceScope"],
        "currentRuntimeMap": session["runtimeMaps"].get(current_concept_id),
        "currentMemoryAnchor": session["memoryProfile"]["abilityItems"].get(current_concept_id),
        "latestControlVerdict": session.get("latestControlVerdict"),
        "targetBaseline": session["targetBaseline"],
        "memoryProfileId": session["memoryProfile"]["id"],
        "targetMatch": build_target_match(session),
        "abilityDomains": build_ability_domains(session),
        "memoryEvents": session["memoryEvents"],
        "latestMemoryEvents": session.get("latestMemoryEvents", []),
        "interactionLog": session.get("interactionLog", []),
        "latestFeedback": latest_feedback,
        "memoryProfileSnapshot": deepcopy(session["memoryProfile"]),
        "tutorEngine": describe_tutor_intelligence(),
    }


def get_workspace_scope(session: Dict[str, Any]) -> Dict[str, Any]:
    return session.get("workspaceScope") or {"type": "pack", "id": (session.get("targetBaseline") or {}).get("id") or (session.get("source") or {}).get("kind", "")}


def is_concept_in_scope(session: Dict[str, Any], concept: Dict[str, Any]) -> bool:
    scope = get_workspace_scope(session)
    if scope["type"] == "pack":
        return True
    if scope["type"] == "domain":
        return (concept.get("abilityDomainId") or concept.get("domainId")) == scope["id"]
    if scope["type"] == "concept":
        return concept.get("trainingPointId") == scope["id"]
    return True


def choose_next_concept(session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for concept in session["concepts"]:
        if session["conceptStates"][concept["id"]]["completed"]:
            continue
        if not is_concept_in_scope(session, concept):
            continue
        return concept
    return None


def choose_next_unit(session: Dict[str, Any], *, allow_revisit: bool = True) -> Dict[str, Any]:
    next_concept = choose_next_concept(session)
    if next_concept:
        return {"concept": next_concept, "revisit": False}

    if get_workspace_scope(session)["type"] != "pack":
        return {"concept": None, "revisit": False, "scopeExhausted": True}

    if allow_revisit:
        revisit = next((item for item in session["revisitQueue"] if not item.get("done")), None)
        if revisit:
            concept = next((item for item in session["concepts"] if item["id"] == revisit["checkpointId"]), None)
            if concept and is_concept_in_scope(session, concept):
                revisit["done"] = True
                session["conceptStates"][concept["id"]]["completed"] = False
                return {"concept": concept, "revisit": True, "revisitReason": revisit.get("reason", "")}

    return {"concept": None, "revisit": False}


def resolve_prompt_for_concept(*, session: Optional[Dict[str, Any]] = None, concept: Dict[str, Any], revisit: bool = False) -> str:
    return generate_prompt_for_concept(
        session=session,
        concept=concept,
        phase="revisit" if revisit else "diagnostic",
        revisit=revisit,
    )


def build_turn_resolution(*, concept: Dict[str, Any], next_concept: Optional[Dict[str, Any]], switched_concept: bool, final_prompt: str, final_question_meta: Optional[Dict[str, Any]], control_verdict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    current_point_title = concept.get("trainingPointTitle") or concept.get("title", "")
    if switched_concept and next_concept:
        return {
            "mode": "switch",
            "reason": "concept_completed",
            "finalPrompt": final_prompt,
            "finalConceptId": next_concept.get("trainingPointId") or next_concept["id"],
            "finalConceptTitle": next_concept.get("trainingPointTitle") or next_concept["title"],
            "finalCheckpointId": next_concept["id"],
            "finalCheckpointStatement": next_concept.get("checkpointStatement", next_concept["title"]),
            "finalQuestionMeta": final_question_meta,
        }
    if final_prompt:
        return {
            "mode": "stay",
            "reason": (control_verdict or {}).get("reason") or "continue_on_current_concept",
            "finalPrompt": final_prompt,
            "finalConceptId": concept.get("trainingPointId") or concept["id"],
            "finalConceptTitle": current_point_title,
            "finalCheckpointId": concept["id"],
            "finalCheckpointStatement": concept.get("checkpointStatement", concept["title"]),
            "finalQuestionMeta": final_question_meta,
        }
    return {
        "mode": "stop",
        "reason": (control_verdict or {}).get("reason") or "no_followup_prompt",
        "finalPrompt": "",
        "finalConceptId": concept.get("trainingPointId") or concept["id"],
        "finalConceptTitle": current_point_title,
        "finalCheckpointId": concept["id"],
        "finalCheckpointStatement": concept.get("checkpointStatement", concept["title"]),
        "finalQuestionMeta": None,
    }


def build_assessment_handle(session: Dict[str, Any], concept: Dict[str, Any]) -> str:
    return f"{session['targetBaseline']['id']}:{concept['id']}:{session['conceptStates'][concept['id']]['attempts']}"


def create_memory_event(event_type: str, concept: Dict[str, Any], summary: str, timestamp: Optional[str] = None, assessment_handle: str = "", evidence_reference: str = "") -> Dict[str, Any]:
    return {
        "type": event_type,
        "abilityItemId": concept["id"],
        "title": concept["title"],
        "summary": summary,
        "message": summary,
        "assessmentHandle": assessment_handle,
        "evidenceReference": evidence_reference or concept.get("evidenceSnippet", ""),
        "timestamp": timestamp or now_iso(),
    }


def groom_pending_writebacks(session: Dict[str, Any], concept_id: str = "") -> List[Dict[str, Any]]:
    pending = session.get("pendingWritebacks") or []
    if concept_id:
        pending = [item for item in pending if item.get("conceptId") == concept_id]
    return []


def append_interaction_event(session: Dict[str, Any], *, event_type: str, concept: Optional[Dict[str, Any]] = None, payload: Optional[Dict[str, Any]] = None) -> None:
    session.setdefault("interactionLog", []).append(
        {
            "type": event_type,
            "traceId": trace_id_var.get(),
            "sessionId": session.get("id", ""),
            "conceptId": concept.get("id", "") if concept else "",
            "conceptTitle": concept.get("title", "") if concept else "",
            "timestamp": now_iso(),
            **(payload or {}),
        }
    )


def create_workspace_turn(*, action: str, concept: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "role": "system",
        "kind": "workspace",
        "action": action,
        "conceptId": concept["id"],
        "conceptTitle": concept["title"],
        "content": f"{action}:{concept['title']}",
        "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
    }


def build_visible_memory_events(*, concept: Dict[str, Any], previous_judge: Dict[str, Any], current_judge: Dict[str, Any], signal: str, revisit_reason: str = "", assessment_handle: str = "", evidence_reference: str = "") -> List[Dict[str, Any]]:
    timestamp = now_iso()
    events = [
        create_memory_event(
            "attempt_recorded",
            concept,
            f"已记录你在“{concept['title']}”上的一次作答证据。",
            timestamp=timestamp,
            assessment_handle=assessment_handle,
            evidence_reference=evidence_reference,
        )
    ]

    previous_rank = rank_state(previous_judge.get("state", "weak"))
    current_rank = rank_state(current_judge.get("state", "weak"))
    previous_confidence = previous_judge.get("confidence", 0)
    current_confidence = current_judge.get("confidence", 0)
    effective_signal = "positive" if signal == "noise" and (current_rank > previous_rank or current_confidence > previous_confidence) else signal

    if effective_signal == "positive" and current_rank >= previous_rank:
        events.append(create_memory_event("improvement_detected", concept, f"“{concept['title']}”这轮更稳了，系统会把这次提升记进长期记忆。", timestamp=timestamp, assessment_handle=assessment_handle, evidence_reference=evidence_reference))
    if current_rank < previous_rank:
        events.append(create_memory_event("contradiction_detected", concept, f"“{concept['title']}”出现了和旧判断不一致的新证据，匹配度会先保守回落。", timestamp=timestamp, assessment_handle=assessment_handle, evidence_reference=evidence_reference))
    if effective_signal != "positive" and current_rank <= rank_state("partial"):
        events.append(create_memory_event("weakness_confirmed", concept, f"系统确认“{concept['title']}”目前还是弱点，后续会继续优先补这个点。", timestamp=timestamp, assessment_handle=assessment_handle, evidence_reference=evidence_reference))
    if revisit_reason:
        events.append(create_memory_event("revisit_queued", concept, f"“{concept['title']}”已加入后续回访队列。", timestamp=timestamp, assessment_handle=assessment_handle, evidence_reference=evidence_reference))
    return events


def apply_writeback_suggestion(*, session: Dict[str, Any], concept: Dict[str, Any], suggestion: Dict[str, Any], tutor_move: Dict[str, Any], answer: str, context_packet: Dict[str, Any]) -> Dict[str, Any]:
    if not suggestion or suggestion.get("mode") == "noop" or suggestion.get("should_write") is False:
        return {"applied": False, "reason": "noop"}

    previous = deepcopy(session["memoryProfile"]["abilityItems"].get(concept["id"], {}))
    assessment_handle = build_assessment_handle(session, concept)
    source_metadata = (session.get("source") or {}).get("metadata") or {}
    source_doc_path = str(source_metadata.get("docPath") or "").strip()
    source_doc_title = str((session.get("source") or {}).get("title") or source_metadata.get("docTitle") or "").strip()
    snapshot = {
        "signal": (tutor_move.get("runtimeMap") or {}).get("turn_signal", tutor_move.get("signal", "noise")),
        "answer": answer,
        "prompt": context_packet.get("draft_evidence", {}).get("prompt", session.get("currentProbe", "")),
        "explanation": tutor_move.get("visibleReply", ""),
        "whyJudgedThisWay": "；".join((tutor_move.get("judge") or {}).get("reasons", [])),
        "evidenceReference": tutor_move.get("evidenceReference", ""),
        "sourceRefs": context_packet.get("draft_evidence", {}).get("sourceRefs", []),
        "sourceDocPath": source_doc_path,
        "sourceDocPaths": [source_doc_path] if source_doc_path else [],
        "sourceDocTitle": source_doc_title,
        "assessmentHandle": assessment_handle,
        "writeReason": suggestion.get("reason", "python_ai_service_update"),
        "at": now_iso(),
    }
    anchor_patch = suggestion.get("anchor_patch") or {}
    next_state = anchor_patch.get("state") or ((tutor_move.get("runtimeMap") or {}).get("anchor_assessment") or {}).get("state") or previous.get("state") or "不可判"
    next_confidence_level = anchor_patch.get("confidence_level") or ((tutor_move.get("runtimeMap") or {}).get("anchor_assessment") or {}).get("confidence_level") or previous.get("confidenceLevel") or "low"

    session["memoryProfile"]["abilityItems"][concept["id"]] = {
        "abilityItemId": concept["id"],
        "title": concept["title"],
        "abilityDomainId": concept.get("abilityDomainId") or concept.get("domainId") or "general",
        "abilityDomainTitle": concept.get("abilityDomainTitle") or concept.get("domainTitle") or "通用能力",
        "state": next_state,
        "confidence": (tutor_move.get("judge") or {}).get("confidence", 0.26),
        "confidenceLevel": next_confidence_level,
        "reasons": ((tutor_move.get("runtimeMap") or {}).get("anchor_assessment") or {}).get("reasons") or previous.get("reasons") or [],
        "derivedPrinciple": anchor_patch.get("derived_principle") or previous.get("derivedPrinciple") or concept.get("summary", ""),
        "evidenceCount": previous.get("evidenceCount", 0) + 1,
        "evidence": [*(previous.get("evidence") or [])[-3:], snapshot],
        "recentStrongEvidence": [*(previous.get("recentStrongEvidence") or [])[-2:], snapshot] if next_state in {"partial", "solid"} else (previous.get("recentStrongEvidence") or []),
        "recentConflictingEvidence": [*(previous.get("recentConflictingEvidence") or [])[-2:]],
        "lastUpdatedAt": snapshot["at"],
        "lastAssessmentHandle": assessment_handle,
        "remediationMaterials": concept.get("remediationMaterials") or [],
        "questionFamily": concept.get("questionFamily", ""),
        "provenanceLabel": concept.get("provenanceLabel", ""),
        "projectedTargets": [session["targetBaseline"]["id"]],
        "sourceDocPath": source_doc_path,
        "sourceDocPaths": [source_doc_path] if source_doc_path else [],
        "sourceDocTitle": source_doc_title,
    }
    return {"applied": True, "assessmentHandle": assessment_handle}


def _source_doc_reference(source: Dict[str, Any]) -> Dict[str, str] | None:
    metadata = source.get("metadata") or {}
    doc_path = str(metadata.get("docPath") or "").strip()
    if not doc_path:
        return None
    return {
        "path": doc_path,
        "title": str(source.get("title") or metadata.get("docTitle") or doc_path),
    }


def _attach_source_reference(concepts: list[Dict[str, Any]], source: Dict[str, Any]) -> list[Dict[str, Any]]:
    source_ref = _source_doc_reference(source)
    if not source_ref:
        return concepts
    for concept in concepts:
        existing = concept.get("javaGuideSources") or []
        if not any((item or {}).get("path") == source_ref["path"] for item in existing):
            concept["javaGuideSources"] = [source_ref, *existing]
    return concepts


def _attach_source_reference_to_points(training_points: list[Dict[str, Any]], source: Dict[str, Any]) -> list[Dict[str, Any]]:
    source_ref = _source_doc_reference(source)
    if not source_ref:
        return training_points
    for point in training_points:
        existing = point.get("javaGuideSources") or []
        if not any((item or {}).get("path") == source_ref["path"] for item in existing):
            point["javaGuideSources"] = [source_ref, *existing]
    return training_points


def _resolve_decomposition(payload: Any) -> Dict[str, Any]:
    if payload.decomposition:
        decomposition = deepcopy(payload.decomposition)
        if not decomposition.get("trainingPoints"):
            return normalize_decomposition_payload(decomposition, payload.source)
        return decomposition

    intelligence = get_tutor_intelligence()
    if not intelligence or not hasattr(intelligence, "decompose_source"):
        raise HTTPException(status_code=503, detail="AI tutor decomposition is required but no AI provider is configured.")
    decomposition = intelligence.decompose_source(payload.source)
    if not decomposition.get("trainingPoints"):
        return normalize_decomposition_payload(decomposition, payload.source)
    return decomposition


def create_session(payload: Any) -> Dict[str, Any]:
    decomposition = _resolve_decomposition(payload)
    training_points = _attach_source_reference_to_points(deepcopy(decomposition["trainingPoints"]), payload.source)
    concepts = _attach_source_reference(deepcopy(decomposition["concepts"]), payload.source)
    concept_states = {}
    for concept in concepts:
        remembered = payload.memoryProfile.get("abilityItems", {}).get(concept["id"], {})
        concept_states[concept["id"]] = {
            "attempts": 0,
            "completed": False,
            "teachCount": 0,
            "lastAction": "probe",
            "result": "unseen",
            "wrongFollowupCount": 0,
            "anchorState": create_empty_anchor_state(),
            "judge": {
                "state": remembered.get("state", "不可判"),
                "confidence": remembered.get("confidence", 0.16),
                "confidenceLevel": remembered.get("confidenceLevel", "low"),
                "reasons": remembered.get("reasons", ["当前还没有足够证据，先保持保守判断"]),
            },
        }
    first_concept = concepts[0]
    first_point = get_checkpoint_point({"trainingPoints": training_points}, first_concept["id"]) or training_points[0]
    session_id = str(uuid4())
    session = {
        "id": session_id,
        "mode": "target",
        "userId": payload.userId,
        "source": deepcopy(payload.source),
        "summary": deepcopy(decomposition["summary"]),
        "trainingPoints": training_points,
        "concepts": concepts,
        "conceptStates": concept_states,
        "ledger": create_evidence_ledger(concepts),
        "currentTrainingPointId": first_point["id"],
        "currentCheckpointId": first_concept["id"],
        "currentConceptId": first_concept["id"],
        "currentProbe": "",
        "currentQuestionMeta": None,
        "turns": [],
        "engagement": {
            "answerCount": 0,
            "controlCount": 0,
            "skipCount": 0,
            "teachRequestCount": 0,
            "consecutiveControlCount": 0,
            "lastControlIntent": "",
        },
        "revisitQueue": [],
        "burdenSignal": "normal",
        "interactionPreference": normalize_interaction_preference(payload.interactionPreference),
        "workspaceScope": {"type": "pack", "id": payload.targetBaseline["id"]},
        "targetBaseline": deepcopy(payload.targetBaseline),
        "targetProgress": deepcopy(getattr(payload, "targetProgress", {}) or {}),
        "memoryProfile": deepcopy(payload.memoryProfile),
        "memoryEvents": [],
        "latestMemoryEvents": [],
        "runtimeMaps": {concept["id"]: create_empty_runtime_map(concept["id"]) for concept in concepts},
        "latestControlVerdict": None,
        "interactionLog": [],
    }
    session["currentProbe"] = initial_probe(first_concept, session)
    session["currentQuestionMeta"] = create_question_meta(first_concept, session=session, phase="diagnostic")
    session["turns"] = [
        {
            "role": "tutor",
            "kind": "question",
            "action": "probe",
            "conceptId": first_point["id"],
            "conceptTitle": first_point["title"],
            "checkpointId": first_concept["id"],
            "checkpointStatement": first_concept.get("checkpointStatement", first_concept["title"]),
            "content": session["currentProbe"],
            "questionMeta": session["currentQuestionMeta"],
            "revisitReason": "",
            "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
    ]
    append_interaction_event(
        session,
        event_type="session_started",
        concept=first_concept,
        payload={
            "currentProbe": session["currentProbe"],
            "workspaceScope": session["workspaceScope"],
            "currentTrainingPointId": first_point["id"],
            "currentCheckpointId": first_concept["id"],
        },
    )
    SESSIONS[session_id] = session
    return session


def apply_focus_domain(session: Dict[str, Any], domain_id: str) -> Dict[str, Any]:
    candidates = [concept for concept in session["concepts"] if (concept.get("abilityDomainId") or concept.get("domainId")) == domain_id]
    if not candidates:
        raise HTTPException(status_code=404, detail="Unknown domain.")
    concept = next((item for item in candidates if not session["conceptStates"][item["id"]]["completed"]), candidates[0])
    point = get_checkpoint_point(session, concept["id"]) or get_current_checkpoint_point(session)
    session["workspaceScope"] = {"type": "domain", "id": domain_id}
    session["currentTrainingPointId"] = point["id"] if point else session.get("currentTrainingPointId", "")
    session["currentCheckpointId"] = concept["id"]
    session["currentConceptId"] = concept["id"]
    session["currentProbe"] = initial_probe(concept, session)
    session["currentQuestionMeta"] = create_question_meta(concept, session=session, phase="diagnostic")
    session["turns"].append(create_workspace_turn(action="focus-domain", concept=point or concept))
    session["turns"].append(
        {
            "role": "tutor",
            "kind": "question",
            "action": "probe",
            "conceptId": point["id"] if point else concept["id"],
            "conceptTitle": point["title"] if point else concept["title"],
            "checkpointId": concept["id"],
            "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
            "content": session["currentProbe"],
            "questionMeta": session["currentQuestionMeta"],
            "revisitReason": "",
            "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
    )
    append_interaction_event(
        session,
        event_type="focus_domain",
        concept=point or concept,
        payload={
            "domainId": domain_id,
            "currentProbe": session["currentProbe"],
            "workspaceScope": session["workspaceScope"],
            "currentCheckpointId": concept["id"],
        },
    )
    return project_session(session)


def apply_focus_concept(session: Dict[str, Any], concept_id: str) -> Dict[str, Any]:
    point = next((item for item in session.get("trainingPoints") or [] if item["id"] == concept_id), None)
    checkpoint_concepts = [item for item in session["concepts"] if item.get("trainingPointId") == concept_id]
    concept = next((item for item in checkpoint_concepts if not session["conceptStates"][item["id"]]["completed"]), checkpoint_concepts[0] if checkpoint_concepts else None)
    if not point or not concept:
        raise HTTPException(status_code=404, detail="Unknown concept.")
    session["workspaceScope"] = {"type": "concept", "id": concept_id}
    session["currentTrainingPointId"] = point["id"]
    session["currentCheckpointId"] = concept["id"]
    session["currentConceptId"] = concept["id"]
    session["currentProbe"] = initial_probe(concept, session)
    session["currentQuestionMeta"] = create_question_meta(concept, session=session, phase="diagnostic")
    session["turns"].append(create_workspace_turn(action="focus-concept", concept=point))
    session["turns"].append(
        {
            "role": "tutor",
            "kind": "question",
            "action": "probe",
            "conceptId": point["id"],
            "conceptTitle": point["title"],
            "checkpointId": concept["id"],
            "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
            "content": session["currentProbe"],
            "questionMeta": session["currentQuestionMeta"],
            "revisitReason": "",
            "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
    )
    append_interaction_event(
        session,
        event_type="focus_concept",
        concept=point,
        payload={
            "currentProbe": session["currentProbe"],
            "workspaceScope": session["workspaceScope"],
            "currentCheckpointId": concept["id"],
        },
    )
    return project_session(session)


def handle_teach_control(
    *,
    session: Dict[str, Any],
    concept: Dict[str, Any],
    answer: str,
    burden_signal: str,
    intelligence_override: Any = None,
) -> Dict[str, Any]:
    point = get_checkpoint_point(session, concept["id"]) or get_current_checkpoint_point(session)
    session["engagement"]["controlCount"] += 1
    session["engagement"]["teachRequestCount"] += 1
    session["engagement"]["consecutiveControlCount"] += 1
    session["engagement"]["lastControlIntent"] = "teach"
    session["conceptStates"][concept["id"]]["teachCount"] += 1
    session["conceptStates"][concept["id"]]["lastAction"] = "teach"

    context_packet = build_context_packet(
        session=session,
        concept=concept,
        answer=answer,
        burden_signal=burden_signal,
        prior_evidence=session["ledger"][concept["id"]]["entries"],
    )
    intelligence = intelligence_override or get_tutor_intelligence()
    tutor_move = None
    if not (intelligence and intelligence.configured):
        raise RuntimeError("AI tutor intelligence is required but not configured. Check .env.local.")

    with ThreadPoolExecutor(max_workers=2) as executor:
        decision_future = executor.submit(
            intelligence.generate_turn_envelope,
            concept=concept,
            context_packet=context_packet,
            answer=answer,
            forced_action="teach",
        )
        reply_future = executor.submit(
            intelligence.generate_reply_stream,
            concept=concept,
            context_packet=context_packet,
            answer=answer,
        )

        decision_envelope = decision_future.result()
        try:
            reply_text = reply_future.result()
        except Exception:
            reply_text = ""
    next_move = (decision_envelope or {}).get("next_move") or {}
    assert_valid_turn_envelope(decision_envelope, concept["id"])
    assert_consistent_turn_envelope(decision_envelope, context_packet)
    if not reply_text:
        reply_text = build_interview_wrap_up(
            concept=concept,
            judge=session["conceptStates"][concept["id"]]["judge"],
            gap=str(concept.get("remediationHint") or ""),
        )["explanation"]
    tutor_move = turn_envelope_to_tutor_move(decision_envelope, concept, reply_text=reply_text)
    tutor_move["runtimeMap"] = merge_runtime_maps(session["runtimeMaps"].get(concept["id"]), tutor_move["runtimeMap"], concept["id"])
    session["runtimeMaps"][concept["id"]] = tutor_move["runtimeMap"]

    explanation = (
        tutor_move["replyText"]
    )
    teaching_chunk = ""
    teaching_paragraphs: List[str] = []
    coaching_step = (tutor_move or {}).get("followUpQuestion") or ""
    wrap_up = build_interview_wrap_up(
        concept=concept,
        judge=tutor_move.get("judge") or session["conceptStates"][concept["id"]]["judge"],
        gap=(tutor_move.get("nextMove") or {}).get("reason", ""),
    )

    session["conceptStates"][concept["id"]]["completed"] = True
    session["conceptStates"][concept["id"]]["result"] = "partial"
    transition = next_checkpoint_after_completion(session, concept, point)
    next_concept = transition["next_concept"]
    next_point = transition["next_point"]

    latest_feedback = {
        "conceptId": concept["id"],
        "conceptTitle": point["title"] if point else concept["title"],
        "checkpointId": concept["id"],
        "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
        "signal": tutor_move.get("signal", "noise"),
        "action": "teach",
        "explanation": explanation,
        "gap": (tutor_move.get("nextMove") or {}).get("reason", ""),
        "evidenceReference": concept.get("evidenceSnippet", ""),
        "coachingStep": "",
        "candidateCoachingStep": "",
        "strength": "",
        "takeaway": wrap_up["takeaway"],
        "teachingChunk": teaching_chunk,
        "teachingParagraphs": teaching_paragraphs,
        "judge": tutor_move.get("judge") or session["conceptStates"][concept["id"]]["judge"],
        "runtimeMap": tutor_move.get("runtimeMap") or session["runtimeMaps"][concept["id"]],
        "nextMove": tutor_move.get("nextMove"),
        "modelNextMove": tutor_move.get("nextMove"),
        "writebackSuggestion": tutor_move.get("writebackSuggestion"),
        "controlVerdict": None,
        "turnResolution": {
            "mode": "switch" if next_concept else "stop",
            "reason": "teach_then_advance",
            "finalPrompt": session["currentProbe"],
            "finalConceptId": next_point["id"] if next_point else (point["id"] if point else concept["id"]),
            "finalConceptTitle": next_point["title"] if next_point else (point["title"] if point else concept["title"]),
            "finalCheckpointId": next_concept["id"] if next_concept else concept["id"],
            "finalCheckpointStatement": next_concept.get("checkpointStatement", next_concept["title"]) if next_concept else concept.get("checkpointStatement", concept["title"]),
            "finalQuestionMeta": session["currentQuestionMeta"],
        },
        "memoryAnchor": session["memoryProfile"]["abilityItems"].get(concept["id"]),
        "remediationMaterial": (concept.get("remediationMaterials") or [None])[0],
        "learningSources": concept.get("javaGuideSources") or [],
    }
    return latest_feedback


def handle_advance_control(*, session: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    point = get_checkpoint_point(session, concept["id"]) or get_current_checkpoint_point(session)
    session["engagement"]["controlCount"] += 1
    session["engagement"]["skipCount"] += 1
    session["engagement"]["consecutiveControlCount"] += 1
    session["engagement"]["lastControlIntent"] = "advance"
    session["conceptStates"][concept["id"]]["completed"] = True
    session["conceptStates"][concept["id"]]["lastAction"] = "advance"
    session["conceptStates"][concept["id"]]["result"] = "skipped"
    wrap_up = build_interview_wrap_up(
        concept=concept,
        judge=session["conceptStates"][concept["id"]]["judge"],
        gap=str(concept.get("remediationHint") or ""),
        skipped=True,
    )
    session["revisitQueue"].append(
        {
            "conceptId": point["id"] if point else concept["id"],
            "conceptTitle": point["title"] if point else concept["title"],
            "checkpointId": concept["id"],
            "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
            "reason": "skipped-by-user",
            "takeaway": wrap_up["takeaway"],
            "queuedAt": now_iso(),
            "done": False,
        }
    )
    next_unit = choose_next_unit(session, allow_revisit=False)
    next_concept = next_unit.get("concept")
    next_point = get_checkpoint_point(session, next_concept["id"]) if next_concept else None
    session["currentTrainingPointId"] = next_point["id"] if next_point else (point["id"] if point else session.get("currentTrainingPointId", ""))
    session["currentCheckpointId"] = next_concept["id"] if next_concept else concept["id"]
    session["currentConceptId"] = next_concept["id"] if next_concept else concept["id"]
    session["currentProbe"] = resolve_prompt_for_concept(session=session, concept=next_concept, revisit=bool(next_unit.get("revisit"))) if next_concept else ""
    session["currentQuestionMeta"] = create_question_meta(next_concept, session=session, phase="diagnostic" if not next_unit.get("revisit") else "revisit") if next_concept else None
    return {
        "conceptId": concept["id"],
        "conceptTitle": point["title"] if point else concept["title"],
        "checkpointId": concept["id"],
        "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
        "signal": "noise",
        "action": "advance",
        "explanation": f"好，这个点先不继续卡住你了，我们直接进下一题。\n\n{wrap_up['explanation']}",
        "gap": "",
        "evidenceReference": concept.get("evidenceSnippet", ""),
        "coachingStep": "",
        "candidateCoachingStep": "",
        "strength": "",
        "takeaway": wrap_up["takeaway"],
        "teachingChunk": "",
        "teachingParagraphs": [],
        "judge": session["conceptStates"][concept["id"]]["judge"],
        "runtimeMap": session["runtimeMaps"][concept["id"]],
        "nextMove": None,
        "modelNextMove": {"intent": "这个点先收口，继续推进整体节奏。", "reason": "用户要求切题。", "ui_mode": "advance"},
        "writebackSuggestion": None,
        "controlVerdict": None,
        "turnResolution": {
            "mode": "switch" if next_concept else "stop",
            "reason": "next_move_requests_stop",
            "finalPrompt": session["currentProbe"],
            "finalConceptId": next_point["id"] if next_point else (point["id"] if point else concept["id"]),
            "finalConceptTitle": next_point["title"] if next_point else (point["title"] if point else concept["title"]),
            "finalCheckpointId": next_concept["id"] if next_concept else concept["id"],
            "finalCheckpointStatement": next_concept.get("checkpointStatement", next_concept["title"]) if next_concept else concept.get("checkpointStatement", concept["title"]),
            "finalQuestionMeta": session["currentQuestionMeta"],
        },
        "memoryAnchor": session["memoryProfile"]["abilityItems"].get(concept["id"]),
        "remediationMaterial": (concept.get("remediationMaterials") or [None])[0],
        "learningSources": concept.get("javaGuideSources") or [],
    }


def answer_session(session: Dict[str, Any], payload: Any, intelligence_override: Any = None) -> Dict[str, Any]:
    concept = get_current_checkpoint_concept(session)
    point = get_current_checkpoint_point(session) or get_checkpoint_point(session, concept["id"])
    if payload.interactionPreference:
        session["interactionPreference"] = normalize_interaction_preference(payload.interactionPreference)
    session["burdenSignal"] = payload.burdenSignal
    answer = payload.answer.strip()
    control_intent = detect_control_intent(answer, payload.intent or "")
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    session["turns"].append(
        {
            "role": "learner",
            "kind": "control" if control_intent else "answer",
            "action": control_intent or "",
            "conceptId": point["id"] if point else concept["id"],
            "conceptTitle": point["title"] if point else concept["title"],
            "checkpointId": concept["id"],
            "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
            "content": answer,
            "timestamp": now_ms,
        }
    )
    append_interaction_event(
        session,
        event_type="answer_submitted",
        concept=concept,
        payload={
            "answer": answer,
            "controlIntent": control_intent or "",
            "burdenSignal": payload.burdenSignal,
            "currentProbe": session.get("currentProbe", ""),
            "currentCheckpointId": concept["id"],
        },
    )
    if control_intent == "teach":
        latest_feedback = handle_teach_control(
            session=session,
            concept=concept,
            answer=answer,
            burden_signal=payload.burdenSignal,
            intelligence_override=intelligence_override,
        )
        latest_memory_events: List[Dict[str, Any]] = []
    elif control_intent == "advance":
        latest_feedback = handle_advance_control(session=session, concept=concept)
        latest_memory_events = []
    else:
        session["engagement"]["answerCount"] += 1
        session["engagement"]["consecutiveControlCount"] = 0
        session["engagement"]["lastControlIntent"] = ""
        previous_judge = deepcopy(session["conceptStates"][concept["id"]]["judge"])
        prior_evidence = session["ledger"][concept["id"]]["entries"]
        context_packet = build_context_packet(
            session=session,
            concept=concept,
            answer=answer,
            burden_signal=payload.burdenSignal,
            prior_evidence=prior_evidence,
        )
        logger.event(
            events.CONTEXT_BUILT,
            step_name="context_build",
            step_version=versions.context_builder_version,
            input_token_estimate=max(1, len(str(context_packet)) // 4),
            latency_ms=0,
            status="success",
            current_concept_id=concept["id"],
        )

        intelligence = intelligence_override or get_tutor_intelligence()
        if not (intelligence and intelligence.configured):
            raise RuntimeError("AI tutor intelligence is required but not configured. Check .env.local.")

        with ThreadPoolExecutor(max_workers=2) as executor:
            decision_future = executor.submit(
                intelligence.generate_turn_envelope,
                concept=concept,
                context_packet=context_packet,
                answer=answer,
            )
            reply_future = executor.submit(
                intelligence.generate_reply_stream,
                concept=concept,
                context_packet=context_packet,
                answer=answer,
            )
            decision_envelope = decision_future.result()
            try:
                reply_text = reply_future.result()
            except Exception:
                reply_text = ""
        next_move = (decision_envelope or {}).get("next_move") or {}
        turn_diagnosis = (decision_envelope or {}).get("turn_diagnosis") or {}
        assert_valid_turn_envelope(decision_envelope, concept["id"])
        assert_consistent_turn_envelope(decision_envelope, context_packet)
        if not reply_text:
            reply_text = build_interview_wrap_up(
                concept=concept,
                judge=session["conceptStates"][concept["id"]]["judge"],
                gap=str(concept.get("remediationHint") or ""),
            )["explanation"]
        tutor_move = turn_envelope_to_tutor_move(decision_envelope, concept, reply_text=reply_text)
        if (
            session.get("interactionPreference") == "explain-first"
            and tutor_move["signal"] != "positive"
            and tutor_move["moveType"] in {"check", "repair"}
        ):
            tutor_move["moveType"] = "teach"
            tutor_move["nextMove"] = {
                **(tutor_move.get("nextMove") or {}),
                "ui_mode": "teach",
                "follow_up_question": get_move_follow_up_question(tutor_move)
                or concept.get("checkQuestion")
                or concept.get("retryQuestion")
                or concept.get("diagnosticQuestion")
                or "",
            }
        tutor_move["runtimeMap"] = merge_runtime_maps(session["runtimeMaps"].get(concept["id"]), tutor_move["runtimeMap"], concept["id"])
        session["runtimeMaps"][concept["id"]] = tutor_move["runtimeMap"]

        append_evidence(
            session["ledger"],
            concept["id"],
            {
                "id": context_packet["draft_evidence"]["id"],
                "prompt": context_packet["draft_evidence"]["prompt"],
                "answer": answer,
                "signal": tutor_move["signal"],
                "explanation": tutor_move["replyText"],
                "whyJudgedThisWay": "；".join((tutor_move["judge"] or {}).get("reasons", [])),
                "sourceRefs": context_packet["draft_evidence"]["sourceRefs"],
                "confidenceLevel": tutor_move["judge"].get("confidenceLevel") or score_to_confidence_level(tutor_move["judge"].get("confidence", 0)),
                "evidenceReference": concept["evidenceSnippet"],
                "sourceAligned": True,
            },
        )
        session["ledger"][concept["id"]]["state"] = tutor_move["judge"]["state"]
        session["ledger"][concept["id"]]["reasons"] = tutor_move["judge"]["reasons"]

        session["conceptStates"][concept["id"]]["attempts"] += 1
        session["conceptStates"][concept["id"]]["judge"] = tutor_move["judge"]
        session["conceptStates"][concept["id"]]["lastAction"] = tutor_move["moveType"]
        if tutor_move["moveType"] == "teach":
            session["conceptStates"][concept["id"]]["teachCount"] += 1
        if tutor_move.get("revisitReason"):
            session["revisitQueue"].append(
                {
                    "conceptId": point["id"] if point else concept["id"],
                    "conceptTitle": point["title"] if point else concept["title"],
                    "checkpointId": concept["id"],
                    "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
                    "reason": tutor_move["revisitReason"],
                    "takeaway": tutor_move.get("takeaway", ""),
                    "queuedAt": now_iso(),
                    "done": False,
                }
            )

        control_verdict = build_control_verdict(
            envelope={
                "runtime_map": tutor_move["runtimeMap"],
                "next_move": tutor_move.get("nextMove") or {"ui_mode": move_type_to_ui_mode(tutor_move["moveType"]), "follow_up_question": get_move_follow_up_question(tutor_move)},
            },
            context_packet=context_packet,
            scope_type=get_workspace_scope(session)["type"],
        )

        checkpoint_outcome = classify_checkpoint_outcome(
            diagnosis=turn_diagnosis,
            tutor_move=tutor_move,
            answer=answer,
            burden_signal=payload.burdenSignal,
        )
        probe_budget_forces_completion = get_consumed_rounds(session, concept) >= get_concept_round_budget(concept)
        wrong_followup_count = session["conceptStates"][concept["id"]].get("wrongFollowupCount", 0)
        should_followup_wrong = (
            checkpoint_outcome == "wrong"
            and wrong_followup_count < 1
            and not probe_budget_forces_completion
        )

        if should_followup_wrong:
            session["conceptStates"][concept["id"]]["wrongFollowupCount"] = wrong_followup_count + 1

        if should_followup_wrong:
            session["conceptStates"][concept["id"]]["completed"] = False
            session["conceptStates"][concept["id"]]["result"] = "wrong"
        else:
            session["conceptStates"][concept["id"]]["completed"] = True
            session["conceptStates"][concept["id"]]["result"] = map_checkpoint_result(checkpoint_outcome)

        writeback_result = apply_writeback_suggestion(
            session=session,
            concept=concept,
            suggestion=tutor_move.get("writebackSuggestion") or {},
            tutor_move=tutor_move,
            answer=answer,
            context_packet=context_packet,
        )
        assessment_handle = writeback_result.get("assessmentHandle") or build_assessment_handle(session, concept)
        latest_memory_events = build_visible_memory_events(
            concept=concept,
            previous_judge=previous_judge,
            current_judge=tutor_move["judge"],
            signal=tutor_move["signal"],
            revisit_reason=tutor_move.get("revisitReason", ""),
            assessment_handle=assessment_handle,
            evidence_reference=tutor_move["evidenceReference"],
        )
        if writeback_result.get("applied"):
            latest_memory_events.append(
                create_memory_event(
                    "memory_writeback_applied",
                    concept,
                    f"“{concept['title']}”这轮高价值证据已写入长期记忆。",
                    assessment_handle=assessment_handle,
                    evidence_reference=tutor_move["evidenceReference"],
                )
            )

        session["memoryEvents"].extend(latest_memory_events)
        session["memoryEvents"] = session["memoryEvents"][-10:]
        session["latestMemoryEvents"] = latest_memory_events

        if should_followup_wrong:
            next_unit = {"concept": concept, "revisit": False}
            next_concept = concept
            next_point = point
            switched = False
            session["currentTrainingPointId"] = point["id"] if point else session.get("currentTrainingPointId", "")
            session["currentCheckpointId"] = concept["id"]
            session["currentConceptId"] = concept["id"]
            session["currentProbe"] = (
                get_move_follow_up_question(tutor_move)
                or concept.get("checkQuestion")
                or concept.get("retryQuestion")
                or concept.get("diagnosticQuestion")
                or ""
            )
            session["currentQuestionMeta"] = create_question_meta(concept, session=session, phase="follow-up") if session["currentProbe"] else None
        else:
            transition = next_checkpoint_after_completion(session, concept, point)
            next_unit = transition["next_unit"]
            next_concept = transition["next_concept"]
            next_point = transition["next_point"]
            switched = bool(next_concept and next_concept["id"] != concept["id"])
        turn_resolution = build_turn_resolution(
            concept=concept,
            next_concept=next_concept,
            switched_concept=switched,
            final_prompt=session["currentProbe"],
            final_question_meta=session["currentQuestionMeta"],
            control_verdict=control_verdict,
        )
        latest_feedback = {
            "conceptId": concept["id"],
            "conceptTitle": point["title"] if point else concept["title"],
            "checkpointId": concept["id"],
            "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
            "signal": tutor_move["signal"],
            "action": tutor_move["moveType"] if tutor_move["moveType"] == "deepen" else ("teach" if checkpoint_outcome in {"full", "partial", "empty", "wrong"} else tutor_move["moveType"]),
            "explanation": tutor_move["replyText"],
            "replyStream": tutor_move["replyText"],
            "gap": (tutor_move.get("nextMove") or {}).get("reason", ""),
            "evidenceReference": concept["evidenceSnippet"],
            "coachingStep": session["currentProbe"] if should_followup_wrong else "",
            "candidateCoachingStep": session["currentProbe"] if should_followup_wrong else "",
            "strength": "",
            "takeaway": build_interview_wrap_up(
                concept=concept,
                judge=tutor_move["judge"],
                gap=(tutor_move.get("nextMove") or {}).get("reason", ""),
            )["takeaway"],
            "teachingChunk": "",
            "teachingParagraphs": [],
            "judge": tutor_move["judge"],
            "runtimeMap": tutor_move["runtimeMap"],
            "nextMove": tutor_move.get("nextMove") if turn_resolution["mode"] == "stay" else None,
            "modelNextMove": tutor_move.get("nextMove"),
            "writebackSuggestion": tutor_move.get("writebackSuggestion"),
            "controlVerdict": control_verdict,
            "turnResolution": turn_resolution,
            "memoryAnchor": session["memoryProfile"]["abilityItems"].get(concept["id"]),
            "remediationMaterial": (concept.get("remediationMaterials") or [None])[0],
            "learningSources": concept.get("javaGuideSources") or [],
        }
        session["latestControlVerdict"] = control_verdict

    update_anchor_state(
        session=session,
        concept=concept,
        latest_feedback=latest_feedback,
        learner_intent=control_intent or "answer",
    )

    session["turns"].append(
        {
            "role": "tutor",
            "kind": "feedback",
            "action": latest_feedback["action"],
            "conceptId": point["id"] if point else concept["id"],
            "conceptTitle": point["title"] if point else concept["title"],
            "checkpointId": concept["id"],
            "checkpointStatement": concept.get("checkpointStatement", concept["title"]),
            "content": latest_feedback["explanation"],
            "contentFormat": "markdown",
            "coachingStep": latest_feedback["coachingStep"],
            "candidateCoachingStep": latest_feedback["candidateCoachingStep"],
            "takeaway": latest_feedback["takeaway"],
            "teachingChunk": latest_feedback["teachingChunk"],
            "teachingParagraphs": latest_feedback["teachingParagraphs"],
            "runtimeMap": latest_feedback["runtimeMap"],
            "nextMove": latest_feedback["nextMove"],
            "modelNextMove": latest_feedback["modelNextMove"],
            "turnResolution": latest_feedback["turnResolution"],
            "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
    )
    if session["currentProbe"]:
        current_concept = get_current_checkpoint_concept(session)
        current_point = get_current_checkpoint_point(session) or get_checkpoint_point(session, current_concept["id"])
        session["turns"].append(
            {
                "role": "tutor",
                "kind": "question",
                "action": "probe",
                "conceptId": current_point["id"] if current_point else current_concept["id"],
                "conceptTitle": current_point["title"] if current_point else current_concept["title"],
                "checkpointId": current_concept["id"],
                "checkpointStatement": current_concept.get("checkpointStatement", current_concept["title"]),
                "content": session["currentProbe"],
                "questionMeta": session["currentQuestionMeta"],
                "revisitReason": "",
                "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
            }
        )
    logger.event(
        events.BUSINESS_RESULT_GENERATED,
        question_type=concept.get("questionFamily", "") or "general",
        difficulty=concept.get("importance", "secondary"),
        followup_triggered=bool(session.get("currentProbe")),
        followup_reason=latest_feedback.get("coachingStep") or latest_feedback.get("candidateCoachingStep") or "",
        scores={
            "state": latest_feedback.get("judge", {}).get("state", "不可判"),
            "confidence": latest_feedback.get("judge", {}).get("confidence", 0),
        },
        parse_failed_count=0,
        fallback_used=False,
        current_concept_id=concept["id"],
    )
    append_interaction_event(
        session,
        event_type="tutor_feedback_generated",
        concept=concept,
        payload={
            "action": latest_feedback.get("action", ""),
            "turnResolution": latest_feedback.get("turnResolution"),
            "currentProbe": session.get("currentProbe", ""),
            "currentCheckpointId": session.get("currentCheckpointId", ""),
        },
    )
    if control_intent in {"teach", "advance"}:
        session["latestMemoryEvents"] = latest_memory_events
    return project_session(session, latest_feedback)


def get_session(session_id: str) -> Dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    return project_session(session)
