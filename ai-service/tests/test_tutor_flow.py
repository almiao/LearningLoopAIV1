from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine.context_packet import build_context_packet
from app.engine.session_engine import answer_session, create_session
from app.engine.tutor_intelligence import build_turn_diagnosis_prompt, build_turn_envelope_prompt


def make_concept() -> dict:
    return {
        "id": "mvcc-boundary",
        "title": "MVCC 和当前读边界",
        "summary": "MVCC 主要负责快照读一致视图，当前读和锁边界还要单独处理。",
        "excerpt": "面试里常追问 MVCC 为什么不等于所有并发问题都解决了。",
        "keywords": ["mvcc", "快照读", "当前读", "锁"],
        "sourceAnchors": ["MVCC 主要负责快照读一致视图。"],
        "misconception": "容易把 MVCC 说成对所有读写冲突都自动生效。",
        "importance": "core",
        "coverage": "high",
        "diagnosticQuestion": "你先说说 MVCC 主要解决什么问题？",
        "retryQuestion": "只收窄回答一个点：MVCC 主要管快照读还是当前读？",
        "checkQuestion": "现在用你自己的话说一下：为什么有了 MVCC 还要关心当前读和锁？",
        "remediationHint": "先分清快照读和当前读，再说锁的边界。",
        "remediationMaterials": [],
        "javaGuideSources": [],
        "questionFamily": "concept",
    }


def make_session_payload() -> SimpleNamespace:
    concept = make_concept()
    return SimpleNamespace(
        userId="u-1",
        source={"title": "InnoDB MVCC", "kind": "baseline-pack", "url": ""},
        decomposition={
            "summary": {
                "sourceTitle": "InnoDB MVCC",
                "keyThemes": ["MVCC", "当前读"],
                "framing": "围绕快照读和当前读边界来拆题。",
            },
            "concepts": [concept],
        },
        interactionPreference="balanced",
        targetBaseline={"id": "baseline-1", "title": "Java Backend"},
        memoryProfile={"id": "memory-1", "abilityItems": {}},
    )


class FakeTeachIntelligence:
    configured = True

    def __init__(self) -> None:
        self.calls = []

    def generate_turn_envelope(self, *, concept, context_packet, answer, forced_action=None):
        self.calls.append(
            {
                "concept_id": concept["id"],
                "answer": answer,
                "forced_action": forced_action,
                "anchor_state": context_packet.get("anchor_state"),
            }
        )
        return {
            "runtime_map": {
                "anchor_id": concept["id"],
                "turn_signal": "noise",
                "anchor_assessment": {
                    "state": "partial",
                    "confidence_level": "medium",
                    "reasons": ["用户请求讲解，当前还缺少边界链路。"],
                },
                "hypotheses": [],
                "misunderstandings": [],
                "open_questions": ["为什么当前读不能只靠 MVCC"],
                "verification_targets": [],
                "info_gain_level": "medium",
            },
            "next_move": {
                "intent": "先把快照读和当前读边界讲清，再用一句 teach-back 确认。",
                "reason": "用户显式请求讲解。",
                "expected_gain": "medium",
                "ui_mode": "teach",
                "follow_up_question": "那你现在用自己的话说一句：为什么当前读不能只靠 MVCC？",
            },
            "writeback_suggestion": {
                "should_write": False,
                "mode": "noop",
                "reason": "teach_control_no_new_evidence",
                "anchor_patch": {
                    "state": "partial",
                    "confidence_level": "medium",
                    "derived_principle": concept["summary"],
                },
            },
        }

    def generate_reply_stream(self, *, concept, context_packet, answer):
        return (
            "先别整段重背。你现在真正缺的是一句边界：MVCC 主要解决快照读一致视图，不会替当前读把锁问题消掉。\n\n"
            "很多人会把 MVCC 讲成“并发万能药”，但它更准确的工作面其实是快照读。一旦你是在做当前读，读到的是要参与竞争的最新版本，就不能只靠历史版本链。"
        )

    def explain_concept(self, *args, **kwargs):
        raise AssertionError("teach control should use generate_turn_envelope, not explain_concept")


class TutorFlowTests(unittest.TestCase):
    def test_context_packet_exposes_anchor_state(self):
        session = create_session(make_session_payload())
        concept = session["concepts"][0]
        session["conceptStates"][concept["id"]]["anchorState"] = {
            "confirmedUnderstanding": "已经知道 MVCC 和历史版本有关。",
            "lastFollowupGoal": "让用户用自己的话复述当前读为什么还要看锁。",
            "lastLearnerIntent": "answer",
            "lastTutorAction": "teach",
        }

        packet = build_context_packet(
            session=session,
            concept=concept,
            answer="我觉得 MVCC 主要是历史版本。",
            prior_evidence=[],
        )

        self.assertEqual(packet["anchor_state"]["confirmed_understanding"], "已经知道 MVCC 和历史版本有关。")
        self.assertNotIn("current_gap", packet["anchor_state"])
        self.assertNotIn("last_teaching_point", packet["anchor_state"])

    def test_prompt_builders_include_contract_priority_and_examples(self):
        concept = make_concept()
        context_packet = {
            "anchor_state": {
                "confirmed_understanding": "知道 MVCC 和快照读有关。",
            },
            "dynamic": {"currentQuestion": concept["diagnosticQuestion"]},
            "stop_conditions": {},
            "friction_signals": {},
        }
        diagnosis_prompt = build_turn_diagnosis_prompt(
            concept=concept,
            context_packet=context_packet,
            answer="是不是主要解决快照读？",
        )
        envelope_prompt = build_turn_envelope_prompt(
            context_packet=context_packet,
            answer="是不是主要解决快照读？",
            diagnosis={
                "input_type": "answer",
                "evidence_quality": "partial",
                "key_claim": "用户知道 MVCC 和快照读有关。",
                "confirmed_understanding": "知道 MVCC 和快照读有关。",
                "has_misconception": False,
                "misconception_detail": "",
            },
            concept=concept,
        )

        self.assertIn("TOP-LEVEL TUTOR CONTRACT", diagnosis_prompt)
        self.assertIn("CONFLICT RESOLUTION ORDER", envelope_prompt)
        self.assertIn("GOOD / BAD BEHAVIOR EXAMPLES", envelope_prompt)
        self.assertIn("Follow the learner's explicit intent before inferred intent.", envelope_prompt)
        self.assertIn("one highest-value missing link > listing multiple gaps at once", envelope_prompt)

    def test_answer_session_requires_configured_ai_instead_of_fallback(self):
        session = create_session(make_session_payload())
        payload = SimpleNamespace(
            answer="我只知道这是并发控制的一部分。",
            interactionPreference=None,
            burdenSignal="normal",
            intent="",
        )

        with patch("app.engine.session_engine.get_tutor_intelligence", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "AI tutor intelligence is required"):
                answer_session(session, payload)

    def test_teach_control_uses_unified_turn_generation_and_updates_anchor_state(self):
        session = create_session(make_session_payload())
        fake_intelligence = FakeTeachIntelligence()
        payload = SimpleNamespace(
            answer="",
            interactionPreference=None,
            burdenSignal="normal",
            intent="teach",
        )

        with patch("app.engine.session_engine.get_tutor_intelligence", return_value=fake_intelligence):
            projected = answer_session(session, payload)

        self.assertEqual(fake_intelligence.calls[0]["forced_action"], "teach")
        self.assertEqual(projected["latestFeedback"]["action"], "teach")
        self.assertEqual(projected["currentProbe"], "那你现在用自己的话说一句：为什么当前读不能只靠 MVCC？")
        self.assertEqual(projected["currentAnchorState"]["lastLearnerIntent"], "teach")
        self.assertEqual(projected["currentAnchorState"]["lastTutorAction"], "teach")
        self.assertNotIn("lastTeachingPoint", projected["currentAnchorState"])
        self.assertEqual(
            projected["currentAnchorState"]["lastFollowupGoal"],
            "先把快照读和当前读边界讲清，再用一句 teach-back 确认。",
        )


if __name__ == "__main__":
    unittest.main()
