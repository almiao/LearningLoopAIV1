from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException

from app.engine.context_packet import build_context_packet
from app.engine.control_intents import detect_control_intent
from app.engine.tutor_intelligence import create_tutor_intelligence, describe_tutor_intelligence
from app.engine.tutor_policy import (
    build_prompt_for_action,
    choose_next_action,
    normalize_interaction_preference,
)
from app.engine.turn_envelope import (
    assert_consistent_turn_envelope,
    assert_valid_turn_envelope,
    build_control_verdict,
    create_empty_runtime_map,
    merge_runtime_maps,
    score_to_confidence_level,
    turn_envelope_to_tutor_move,
)

STATE_SCORE = {
    "不可判": 0.18,
    "weak": 0.34,
    "partial": 0.68,
    "solid": 0.92,
}

STATE_RANK = {
    "不可判": 0,
    "weak": 1,
    "partial": 2,
    "solid": 3,
}

SESSIONS: Dict[str, Dict[str, Any]] = {}
_TUTOR_INTELLIGENCE = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_tutor_intelligence():
    global _TUTOR_INTELLIGENCE
    if _TUTOR_INTELLIGENCE is None:
        _TUTOR_INTELLIGENCE = create_tutor_intelligence()
    return _TUTOR_INTELLIGENCE


def create_question_meta(concept: Dict[str, Any]) -> Dict[str, Any]:
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
        }
    return {
        "type": "system-generated",
        "label": "系统生成诊断题",
        "company": "",
        "stage": "",
        "questionFamily": concept.get("questionFamily", ""),
    }


def initial_probe(concept: Dict[str, Any]) -> str:
    return concept.get("diagnosticQuestion") or concept.get("retryQuestion") or f"讲讲 {concept['title']}。"


def rank_state(state: str) -> int:
    return STATE_RANK.get(state, STATE_RANK["weak"])


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
    scores = []
    for concept in session["concepts"]:
        item = session["memoryProfile"]["abilityItems"].get(concept["id"], {})
        scores.append(STATE_SCORE.get(item.get("state", "不可判"), 0.18) if item.get("evidenceCount", 0) > 0 else 0.0)
    percentage = round(sum(scores) / max(len(scores), 1) * 100)
    percentage = max(10, min(96, percentage))
    label = "接近目标线" if percentage >= 75 else "有通过可能，但仍有明显缺口" if percentage >= 55 else "离目标线还有明显距离"
    return {
        "percentage": percentage,
        "percent": percentage,
        "label": label,
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
    current_concept_id = session["currentConceptId"]
    return {
        "sessionId": session["id"],
        "userId": session.get("userId", ""),
        "source": {
            "title": session["source"]["title"],
            "kind": session["source"].get("kind", "baseline-pack"),
            "url": session["source"].get("url", ""),
        },
        "summary": session["summary"],
        "concepts": session["concepts"],
        "currentConceptId": current_concept_id,
        "currentProbe": session.get("currentProbe", ""),
        "currentQuestionMeta": session.get("currentQuestionMeta"),
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
        return concept["id"] == scope["id"]
    return True


def choose_next_concept(session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for concept in session["concepts"]:
        if session["conceptStates"][concept["id"]]["completed"]:
            continue
        if not is_concept_in_scope(session, concept):
            continue
        return concept
    return None


def choose_next_unit(session: Dict[str, Any]) -> Dict[str, Any]:
    next_concept = choose_next_concept(session)
    if next_concept:
        return {"concept": next_concept, "revisit": False}

    revisit = next((item for item in session["revisitQueue"] if not item.get("done")), None)
    if revisit:
        concept = next((item for item in session["concepts"] if item["id"] == revisit["conceptId"]), None)
        if concept and is_concept_in_scope(session, concept):
            revisit["done"] = True
            session["conceptStates"][concept["id"]]["completed"] = False
            return {"concept": concept, "revisit": True, "revisitReason": revisit.get("reason", "")}

    if get_workspace_scope(session)["type"] != "pack":
        return {"concept": None, "revisit": False, "scopeExhausted": True}
    return {"concept": None, "revisit": False}


def resolve_prompt_for_concept(*, concept: Dict[str, Any], revisit: bool = False) -> str:
    if revisit:
        return f"我们回到刚才先放下的这个点：{concept['title']}。先用你自己的话把这一轮最关键的结论说出来。"
    return initial_probe(concept)


def build_turn_resolution(*, concept: Dict[str, Any], next_concept: Optional[Dict[str, Any]], switched_concept: bool, final_prompt: str, final_question_meta: Optional[Dict[str, Any]], control_verdict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if switched_concept and next_concept:
        return {
            "mode": "switch",
            "reason": "concept_completed",
            "finalPrompt": final_prompt,
            "finalConceptId": next_concept["id"],
            "finalConceptTitle": next_concept["title"],
            "finalQuestionMeta": final_question_meta,
        }
    if final_prompt:
        return {
            "mode": "stay",
            "reason": (control_verdict or {}).get("reason") or "continue_on_current_concept",
            "finalPrompt": final_prompt,
            "finalConceptId": concept["id"],
            "finalConceptTitle": concept["title"],
            "finalQuestionMeta": final_question_meta,
        }
    return {
        "mode": "stop",
        "reason": (control_verdict or {}).get("reason") or "no_followup_prompt",
        "finalPrompt": "",
        "finalConceptId": concept["id"],
        "finalConceptTitle": concept["title"],
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
        "evidenceReference": evidence_reference or concept.get("excerpt", ""),
        "timestamp": timestamp or now_iso(),
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
    snapshot = {
        "signal": (tutor_move.get("runtimeMap") or {}).get("turn_signal", tutor_move.get("signal", "noise")),
        "answer": answer,
        "prompt": context_packet.get("draft_evidence", {}).get("prompt", session.get("currentProbe", "")),
        "explanation": tutor_move.get("visibleReply", ""),
        "whyJudgedThisWay": "；".join((tutor_move.get("judge") or {}).get("reasons", [])),
        "evidenceReference": tutor_move.get("evidenceReference", ""),
        "sourceRefs": context_packet.get("draft_evidence", {}).get("sourceRefs", []),
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
    }
    return {"applied": True, "assessmentHandle": assessment_handle}


def evaluate_answer(concept: Dict[str, Any], answer: str, attempts: int) -> Dict[str, Any]:
    normalized = (answer or "").strip()
    lower = normalized.lower()
    keywords = [str(item).lower() for item in concept.get("keywords", [])]
    hits = sum(1 for keyword in keywords if keyword and keyword in lower)
    if not normalized:
        state = "weak"
        confidence = 0.2
        reasons = ["用户没有提供可判断内容。"]
    elif hits >= 2 or (hits >= 1 and len(normalized) >= 24):
        state = "solid" if attempts >= 1 or hits >= 3 else "partial"
        confidence = 0.82 if state == "solid" else 0.62
        reasons = [f"回答命中了 {hits} 个关键机制线索。"]
    elif hits == 1 or len(normalized) >= 16:
        state = "partial"
        confidence = 0.48
        reasons = ["回答有方向，但机制链路还不够完整。"]
    else:
        state = "weak"
        confidence = 0.28
        reasons = ["回答过于笼统，还没形成可验证的机制表达。"]
    return {
        "state": state,
        "confidence": confidence,
        "confidenceLevel": "high" if confidence >= 0.75 else "medium" if confidence >= 0.45 else "low",
        "reasons": reasons,
    }


def build_fallback_runtime_map(concept: Dict[str, Any], judge: Dict[str, Any], next_question: str = "") -> Dict[str, Any]:
    return {
        "anchor_id": concept["id"],
        "turn_signal": "positive" if judge["state"] in {"partial", "solid"} else "negative",
        "anchor_assessment": {
            "state": judge["state"],
            "confidence_level": judge.get("confidenceLevel") or score_to_confidence_level(judge.get("confidence", 0)),
            "reasons": judge.get("reasons", []),
        },
        "hypotheses": [],
        "misunderstandings": [],
        "open_questions": [next_question] if next_question else [],
        "verification_targets": (
            [{"id": f"{concept['id']}-legacy-verify", "question": next_question, "why": concept.get("summary", "")}] if next_question else []
        ),
        "info_gain_level": "low" if judge["state"] == "solid" else "medium",
    }


def fallback_turn_envelope(*, session: Dict[str, Any], concept: Dict[str, Any], answer: str, burden_signal: str) -> Dict[str, Any]:
    attempt_index = session["conceptStates"][concept["id"]]["attempts"]
    judge = evaluate_answer(concept, answer, attempt_index)
    move_type = choose_next_action(
        concept,
        session["conceptStates"][concept["id"]],
        judge,
        burden_signal,
        session["interactionPreference"],
    )
    next_question = build_prompt_for_action(move_type, concept)
    if move_type == "advance":
        visible_reply = "这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。"
        next_question = ""
        requires_response = False
        complete_current_unit = True
        teaching_paragraphs: List[str] = []
    elif move_type == "teach":
        visible_reply = f"你前面的方向有一点接近，但还差最关键的一层。 我先把这一层讲清楚：{concept.get('summary', '')}"
        teaching_paragraphs = [concept.get("summary", "")]
        requires_response = True
        complete_current_unit = False
    elif move_type in {"deepen", "affirm"}:
        visible_reply = "你这轮已经抓住了关键点。如果再补完整一点，会更像面试里的高质量表达。"
        teaching_paragraphs = []
        requires_response = True
        complete_current_unit = False
    elif move_type == "abstain":
        visible_reply = "这一轮暂时还没法稳定判断，我们先换个点继续推进。"
        next_question = ""
        teaching_paragraphs = []
        requires_response = False
        complete_current_unit = True
    else:
        visible_reply = f"你的方向不算离谱，但还没把关键机制讲完整。 我们先收窄到一个点：{concept.get('retryQuestion') or concept.get('checkQuestion') or ''}"
        teaching_paragraphs = []
        requires_response = True
        complete_current_unit = False

    signal = "positive" if judge["state"] in {"partial", "solid"} else "negative"
    return {
        "runtime_map": build_fallback_runtime_map(concept, judge, next_question),
        "next_move": {
            "intent": "继续围绕当前点推进。" if requires_response else "这个点先收口，继续推进整体节奏。",
            "reason": "根据当前回答继续收口或深化。",
            "expected_gain": "medium" if requires_response else "low",
            "ui_mode": "teach" if move_type == "teach" else "advance" if move_type in {"advance", "abstain"} else "verify" if move_type in {"deepen", "affirm"} else "probe",
        },
        "reply": {
            "visible_reply": visible_reply,
            "teaching_paragraphs": teaching_paragraphs,
            "evidence_reference": concept.get("excerpt", ""),
            "next_prompt": next_question,
            "takeaway": concept.get("summary", ""),
            "confirmed_understanding": "你已经抓到主要方向。" if move_type in {"affirm", "deepen", "advance"} else "",
            "remaining_gap": "" if judge["state"] in {"partial", "solid"} else "回答还不够具体。",
            "revisit_reason": "",
            "requires_response": requires_response,
            "complete_current_unit": complete_current_unit,
        },
        "writeback_suggestion": {
            "should_write": True,
            "mode": "append_conflict" if signal == "negative" else "update",
            "reason": "legacy_positive_signal" if signal == "positive" else "legacy_partial_signal",
            "anchor_patch": {
                "state": judge["state"],
                "confidence_level": judge.get("confidenceLevel") or score_to_confidence_level(judge.get("confidence", 0)),
                "derived_principle": concept.get("summary", ""),
            },
        },
    }


def create_session(payload: Any) -> Dict[str, Any]:
    concepts = deepcopy(payload.decomposition["concepts"])
    concept_states = {}
    for concept in concepts:
        remembered = payload.memoryProfile.get("abilityItems", {}).get(concept["id"], {})
        concept_states[concept["id"]] = {
            "attempts": 0,
            "completed": False,
            "teachCount": 0,
            "lastAction": "probe",
            "judge": {
                "state": remembered.get("state", "不可判"),
                "confidence": remembered.get("confidence", 0.16),
                "confidenceLevel": remembered.get("confidenceLevel", "low"),
                "reasons": remembered.get("reasons", ["当前还没有足够证据，先保持保守判断"]),
            },
        }
    first_concept = concepts[0]
    session_id = str(uuid4())
    initial_question = {
        "role": "tutor",
        "kind": "question",
        "action": "probe",
        "conceptId": first_concept["id"],
        "conceptTitle": first_concept["title"],
        "content": initial_probe(first_concept),
        "questionMeta": create_question_meta(first_concept),
        "revisitReason": "",
        "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
    }
    session = {
        "id": session_id,
        "mode": "target",
        "userId": payload.userId,
        "source": deepcopy(payload.source),
        "summary": deepcopy(payload.decomposition["summary"]),
        "concepts": concepts,
        "conceptStates": concept_states,
        "ledger": create_evidence_ledger(concepts),
        "currentConceptId": first_concept["id"],
        "currentProbe": initial_probe(first_concept),
        "currentQuestionMeta": create_question_meta(first_concept),
        "turns": [initial_question],
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
        "memoryProfile": deepcopy(payload.memoryProfile),
        "memoryEvents": [],
        "latestMemoryEvents": [],
        "runtimeMaps": {concept["id"]: create_empty_runtime_map(concept["id"]) for concept in concepts},
        "latestControlVerdict": None,
    }
    SESSIONS[session_id] = session
    return session


def apply_focus_domain(session: Dict[str, Any], domain_id: str) -> Dict[str, Any]:
    candidates = [concept for concept in session["concepts"] if (concept.get("abilityDomainId") or concept.get("domainId")) == domain_id]
    if not candidates:
        raise HTTPException(status_code=404, detail="Unknown domain.")
    concept = next((item for item in candidates if not session["conceptStates"][item["id"]]["completed"]), candidates[0])
    session["workspaceScope"] = {"type": "domain", "id": domain_id}
    session["currentConceptId"] = concept["id"]
    session["currentProbe"] = initial_probe(concept)
    session["currentQuestionMeta"] = create_question_meta(concept)
    return project_session(session)


def apply_focus_concept(session: Dict[str, Any], concept_id: str) -> Dict[str, Any]:
    concept = next((item for item in session["concepts"] if item["id"] == concept_id), None)
    if not concept:
        raise HTTPException(status_code=404, detail="Unknown concept.")
    session["workspaceScope"] = {"type": "concept", "id": concept_id}
    session["currentConceptId"] = concept_id
    session["currentProbe"] = initial_probe(concept)
    session["currentQuestionMeta"] = create_question_meta(concept)
    return project_session(session)


def handle_teach_control(*, session: Dict[str, Any], concept: Dict[str, Any], answer: str, burden_signal: str) -> Dict[str, Any]:
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
    intelligence = get_tutor_intelligence()
    learning_card = None
    if intelligence and intelligence.configured:
        learning_card = intelligence.explain_concept(session=session, concept=concept, context_packet=context_packet)

    explanation = (
        learning_card["visibleReply"]
        if learning_card
        else f"好，我先不让你继续猜了。你先带走这一层，再按学习模式过一遍。 {concept.get('summary', '')}"
    )
    teaching_chunk = learning_card["teachingChunk"] if learning_card else concept.get("summary", "")
    teaching_paragraphs = learning_card["teachingParagraphs"] if learning_card else [concept.get("summary", "")]
    coaching_step = (learning_card or {}).get("checkQuestion") or concept.get("checkQuestion") or concept.get("retryQuestion") or ""

    session["currentProbe"] = coaching_step
    session["currentQuestionMeta"] = create_question_meta(concept)

    latest_feedback = {
        "conceptId": concept["id"],
        "conceptTitle": concept["title"],
        "signal": "noise",
        "action": "teach",
        "explanation": explanation,
        "gap": "",
        "evidenceReference": concept.get("excerpt", ""),
        "coachingStep": coaching_step,
        "candidateCoachingStep": coaching_step,
        "strength": "",
        "takeaway": (learning_card or {}).get("takeaway") or concept.get("summary", ""),
        "teachingChunk": teaching_chunk,
        "teachingParagraphs": teaching_paragraphs,
        "judge": session["conceptStates"][concept["id"]]["judge"],
        "runtimeMap": session["runtimeMaps"][concept["id"]],
        "nextMove": {"intent": "先把当前缺口讲清楚，再做 teach-back。", "reason": "用户直接请求讲解。", "ui_mode": "teach"},
        "modelNextMove": {"intent": "先把当前缺口讲清楚，再做 teach-back。", "reason": "用户直接请求讲解。", "ui_mode": "teach"},
        "writebackSuggestion": None,
        "controlVerdict": None,
        "turnResolution": {
            "mode": "stay",
            "reason": "continue_on_current_concept",
            "finalPrompt": coaching_step,
            "finalConceptId": concept["id"],
            "finalConceptTitle": concept["title"],
            "finalQuestionMeta": session["currentQuestionMeta"],
        },
        "memoryAnchor": session["memoryProfile"]["abilityItems"].get(concept["id"]),
        "remediationMaterial": (concept.get("remediationMaterials") or [None])[0],
        "learningSources": concept.get("javaGuideSources") or [],
    }
    return latest_feedback


def handle_advance_control(*, session: Dict[str, Any], concept: Dict[str, Any]) -> Dict[str, Any]:
    session["engagement"]["controlCount"] += 1
    session["engagement"]["skipCount"] += 1
    session["engagement"]["consecutiveControlCount"] += 1
    session["engagement"]["lastControlIntent"] = "advance"
    session["conceptStates"][concept["id"]]["completed"] = True
    session["conceptStates"][concept["id"]]["lastAction"] = "advance"
    session["revisitQueue"].append(
        {
            "conceptId": concept["id"],
            "conceptTitle": concept["title"],
            "reason": "skipped-by-user",
            "takeaway": concept.get("summary", ""),
            "queuedAt": now_iso(),
            "done": False,
        }
    )
    next_unit = choose_next_unit(session)
    next_concept = next_unit.get("concept")
    session["currentConceptId"] = next_concept["id"] if next_concept else concept["id"]
    session["currentProbe"] = resolve_prompt_for_concept(concept=next_concept, revisit=bool(next_unit.get("revisit"))) if next_concept else ""
    session["currentQuestionMeta"] = create_question_meta(next_concept) if next_concept else None
    return {
        "conceptId": concept["id"],
        "conceptTitle": concept["title"],
        "signal": "noise",
        "action": "advance",
        "explanation": "好，这个点先不继续卡住你了，我们直接进下一题。",
        "gap": "",
        "evidenceReference": concept.get("excerpt", ""),
        "coachingStep": "",
        "candidateCoachingStep": "",
        "strength": "",
        "takeaway": concept.get("summary", ""),
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
            "finalConceptId": next_concept["id"] if next_concept else concept["id"],
            "finalConceptTitle": next_concept["title"] if next_concept else concept["title"],
            "finalQuestionMeta": session["currentQuestionMeta"],
        },
        "memoryAnchor": session["memoryProfile"]["abilityItems"].get(concept["id"]),
        "remediationMaterial": (concept.get("remediationMaterials") or [None])[0],
        "learningSources": concept.get("javaGuideSources") or [],
    }


def answer_session(session: Dict[str, Any], payload: Any) -> Dict[str, Any]:
    concept = next(item for item in session["concepts"] if item["id"] == session["currentConceptId"])
    if payload.interactionPreference:
        session["interactionPreference"] = normalize_interaction_preference(payload.interactionPreference)
    session["burdenSignal"] = payload.burdenSignal
    answer = payload.answer.strip()
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    session["turns"].append(
        {
            "role": "learner",
            "kind": "answer",
            "conceptId": concept["id"],
            "conceptTitle": concept["title"],
            "content": answer,
            "timestamp": now_ms,
        }
    )

    control_intent = detect_control_intent(answer)
    if control_intent == "teach":
        latest_feedback = handle_teach_control(session=session, concept=concept, answer=answer, burden_signal=payload.burdenSignal)
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

        intelligence = get_tutor_intelligence()
        if intelligence and intelligence.configured:
            decision_envelope = intelligence.generate_turn_envelope(concept=concept, context_packet=context_packet, answer=answer)
        else:
            decision_envelope = fallback_turn_envelope(session=session, concept=concept, answer=answer, burden_signal=payload.burdenSignal)

        assert_valid_turn_envelope(decision_envelope, concept["id"])
        assert_consistent_turn_envelope(decision_envelope, context_packet)
        tutor_move = turn_envelope_to_tutor_move(decision_envelope, concept)
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
                "explanation": tutor_move["visibleReply"],
                "whyJudgedThisWay": "；".join((tutor_move["judge"] or {}).get("reasons", [])),
                "sourceRefs": context_packet["draft_evidence"]["sourceRefs"],
                "confidenceLevel": tutor_move["judge"].get("confidenceLevel") or score_to_confidence_level(tutor_move["judge"].get("confidence", 0)),
                "evidenceReference": tutor_move["evidenceReference"],
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
                    "conceptId": concept["id"],
                    "conceptTitle": concept["title"],
                    "reason": tutor_move["revisitReason"],
                    "takeaway": tutor_move.get("takeaway", concept.get("summary", "")),
                    "queuedAt": now_iso(),
                    "done": False,
                }
            )

        control_verdict = build_control_verdict(
            envelope={
                "runtime_map": tutor_move["runtimeMap"],
                "next_move": tutor_move.get("nextMove") or {"ui_mode": tutor_move["moveType"]},
                "reply": {"requires_response": tutor_move["requiresResponse"]},
            },
            context_packet=context_packet,
            scope_type=get_workspace_scope(session)["type"],
        )

        should_complete = (
            tutor_move["completeCurrentUnit"]
            or tutor_move["judge"]["state"] in {"solid", "不可判"}
            or tutor_move["moveType"] in {"advance", "abstain"}
        )
        if should_complete:
            session["conceptStates"][concept["id"]]["completed"] = True

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

        next_unit = choose_next_unit(session)
        next_concept = next_unit.get("concept")
        switched = bool(next_concept and next_concept["id"] != concept["id"])
        session["currentConceptId"] = next_concept["id"] if next_concept else session["currentConceptId"]
        session["currentProbe"] = (
            resolve_prompt_for_concept(concept=next_concept, revisit=bool(next_unit.get("revisit")))
            if next_concept and switched
            else (tutor_move["nextQuestion"] if tutor_move["requiresResponse"] else "")
            if next_concept
            else ""
        )
        session["currentQuestionMeta"] = create_question_meta(next_concept) if session["currentProbe"] and next_concept else None
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
            "conceptTitle": concept["title"],
            "signal": tutor_move["signal"],
            "action": tutor_move["moveType"],
            "explanation": tutor_move["visibleReply"],
            "gap": tutor_move["remainingGap"],
            "evidenceReference": tutor_move["evidenceReference"],
            "coachingStep": tutor_move["nextQuestion"] if turn_resolution["mode"] == "stay" else "",
            "candidateCoachingStep": tutor_move["nextQuestion"],
            "strength": tutor_move["confirmedUnderstanding"],
            "takeaway": tutor_move["takeaway"],
            "teachingChunk": tutor_move["teachingChunk"],
            "teachingParagraphs": tutor_move["teachingParagraphs"],
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

    session["turns"].append(
        {
            "role": "tutor",
            "kind": "feedback",
            "action": latest_feedback["action"],
            "conceptId": concept["id"],
            "conceptTitle": concept["title"],
            "content": latest_feedback["explanation"],
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
        current_concept = next(item for item in session["concepts"] if item["id"] == session["currentConceptId"])
        session["turns"].append(
            {
                "role": "tutor",
                "kind": "question",
                "action": "probe",
                "conceptId": current_concept["id"],
                "conceptTitle": current_concept["title"],
                "content": session["currentProbe"],
                "questionMeta": session["currentQuestionMeta"],
                "revisitReason": "",
                "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
            }
        )
    if control_intent in {"teach", "advance"}:
        session["latestMemoryEvents"] = latest_memory_events
    return project_session(session, latest_feedback)


def get_session(session_id: str) -> Dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Unknown session.")
    return project_session(session)
