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
from app.engine.tutor_intelligence import build_turn_diagnosis_prompt, build_turn_envelope_prompt, normalize_decomposition_payload


def make_concept() -> dict:
    return {
        "id": "mvcc-boundary",
        "title": "MVCC 和当前读边界",
        "summary": "MVCC 主要负责快照读一致视图，当前读和锁边界还要单独处理。",
        "evidenceSnippet": "面试里常追问 MVCC 为什么不等于所有并发问题都解决了。",
        "misconception": "容易把 MVCC 说成对所有读写冲突都自动生效。",
        "importance": "core",
        "diagnosticQuestion": "你先说说 MVCC 主要解决什么问题？",
        "retryQuestion": "只收窄回答一个点：MVCC 主要管快照读还是当前读？",
        "checkQuestion": "现在用你自己的话说一下：为什么有了 MVCC 还要关心当前读和锁？",
        "remediationHint": "先分清快照读和当前读，再说锁的边界。",
        "remediationMaterials": [],
        "javaGuideSources": [],
        "questionFamily": "concept",
    }


def make_second_concept() -> dict:
    return {
        **make_concept(),
        "id": "next-anchor",
        "title": "下一训练点",
        "summary": "第二个训练点用于验证当前概念收口后会推进。",
        "diagnosticQuestion": "进入下一题：请说明第二个训练点是什么？",
        "retryQuestion": "先说第二个训练点的关键边界。",
        "checkQuestion": "用一句话复述第二个训练点。",
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


def make_multi_concept_session_payload() -> SimpleNamespace:
    payload = make_session_payload()
    payload.decomposition = {
        **payload.decomposition,
        "concepts": [make_concept(), make_second_concept()],
    }
    return payload


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


class FakeQuestionIntelligence:
    configured = True

    def __init__(self) -> None:
        self.calls = []

    def generate_probe_question(self, *, concept, context_packet, phase="diagnostic", revisit=False):
        self.calls.append(
            {
                "concept_id": concept["id"],
                "phase": phase,
                "revisit": revisit,
                "current_question": context_packet["dynamic"]["currentQuestion"],
            }
        )
        return {
            "question": f"动态生成：请解释 {concept['title']} 的关键判别点。",
            "intent": "test_dynamic_question",
        }


class FakeVerifyForeverIntelligence:
    configured = True

    def generate_turn_envelope(self, *, concept, context_packet, answer, forced_action=None):
        return {
            "runtime_map": {
                "anchor_id": concept["id"],
                "turn_signal": "positive",
                "anchor_assessment": {
                    "state": "partial",
                    "confidence_level": "medium",
                    "reasons": ["用户答对了主线，但模型仍想继续确认。"],
                },
                "hypotheses": [],
                "misunderstandings": [],
                "open_questions": [],
                "verification_targets": [],
                "info_gain_level": "medium",
            },
            "next_move": {
                "intent": "继续确认当前概念。",
                "reason": "模型仍认为还可以追问。",
                "expected_gain": "medium",
                "ui_mode": "verify",
                "follow_up_question": "继续围绕同一个概念追问一句？",
            },
            "writeback_suggestion": {
                "should_write": True,
                "mode": "update",
                "reason": "partial_signal",
                "anchor_patch": {
                    "state": "partial",
                    "confidence_level": "medium",
                    "derived_principle": concept["summary"],
                },
            },
        }

    def generate_reply_stream(self, *, concept, context_packet, answer):
        return "你已经抓到主线，我补一句后准备推进。"


class FakeWrongIntelligence:
    configured = True

    def generate_turn_envelope(self, *, concept, context_packet, answer, forced_action=None):
        return {
            "runtime_map": {
                "anchor_id": concept["id"],
                "turn_signal": "negative",
                "anchor_assessment": {
                    "state": "weak",
                    "confidence_level": "medium",
                    "reasons": ["用户回答存在明确误解。"],
                },
                "hypotheses": [],
                "misunderstandings": [{"label": "把结论说反了"}],
                "open_questions": [],
                "verification_targets": [],
                "info_gain_level": "medium",
            },
            "next_move": {
                "intent": "先纠正误解，再追问一次确认。",
                "reason": "当前回答方向错了，需要一次矫正性追问。",
                "expected_gain": "medium",
                "ui_mode": "verify",
                "follow_up_question": "你再试一次：把正确结论重讲一遍。",
            },
            "writeback_suggestion": {
                "should_write": True,
                "mode": "update",
                "reason": "wrong_signal",
                "anchor_patch": {
                    "state": "weak",
                    "confidence_level": "medium",
                    "derived_principle": concept["summary"],
                },
            },
            "turn_diagnosis": {
                "input_type": "answer",
                "evidence_quality": "partial",
                "key_claim": "",
                "confirmed_understanding": "",
                "has_misconception": True,
                "misconception_detail": "把结论说反了",
            },
        }

    def generate_reply_stream(self, *, concept, context_packet, answer):
        return "这里方向反了，我先把正确链路讲清楚。"


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
        self.assertIn("fully answered the current learner-facing question", envelope_prompt)

    def test_decomposition_accepts_structural_units_without_prebaked_questions(self):
        payload = {
            "summary": {
                "sourceTitle": "AQS",
                "keyThemes": ["AQS 主链路"],
                "framing": "拆成结构锚点，问题运行时生成。",
            },
            "units": [
                {
                    "id": f"unit-{index}",
                    "title": f"结构锚点 {index}",
                    "summary": "只描述要教什么，不预生成题目。",
                    "evidenceSnippet": "材料里的证据片段。",
                    "misconceptionAnchors": ["容易泛泛回答。"],
                    "discriminators": ["能说清关键链路。"],
                    "importance": "core",
                }
                for index in range(1, 4)
            ],
        }

        decomposition = normalize_decomposition_payload(payload, {"title": "AQS"})

        self.assertEqual(len(decomposition["concepts"]), 3)
        self.assertEqual(decomposition["concepts"][0]["diagnosticQuestion"], "")
        self.assertEqual(decomposition["concepts"][0]["misconception"], "容易泛泛回答。")

    def test_session_start_generates_runtime_question_when_concept_has_no_prebaked_question(self):
        payload = make_session_payload()
        concept = {
            **make_concept(),
            "diagnosticQuestion": "",
            "retryQuestion": "",
            "checkQuestion": "",
            "misconceptionAnchors": ["容易泛泛回答。"],
            "discriminators": ["能说清关键链路。"],
        }
        payload.decomposition = {
            **payload.decomposition,
            "concepts": [concept],
        }
        fake_intelligence = FakeQuestionIntelligence()

        with patch("app.engine.session_engine.get_tutor_intelligence", return_value=fake_intelligence):
            session = create_session(payload)

        self.assertEqual(session["currentProbe"], "动态生成：请解释 MVCC 和当前读边界 的关键判别点。")
        self.assertEqual(fake_intelligence.calls[0]["phase"], "diagnostic")
        self.assertEqual(fake_intelligence.calls[0]["current_question"], "")

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

    def test_projected_session_keeps_source_metadata_for_document_matching(self):
        payload = make_session_payload()
        payload.source = {
            **payload.source,
            "metadata": {
                "docPath": "docs/java/concurrent/threadlocal.md",
            },
        }

        projected = create_session(payload)

        self.assertEqual(projected["source"]["metadata"]["docPath"], "docs/java/concurrent/threadlocal.md")

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
        self.assertEqual(projected["currentProbe"], "")
        self.assertIsNone(projected["currentQuestionMeta"])
        self.assertEqual(projected["latestFeedback"]["turnResolution"]["mode"], "stop")
        self.assertEqual(projected["currentAnchorState"]["lastLearnerIntent"], "teach")
        self.assertEqual(projected["currentAnchorState"]["lastTutorAction"], "teach")
        self.assertNotIn("lastTeachingPoint", projected["currentAnchorState"])
        self.assertEqual(projected["currentAnchorState"]["lastFollowupGoal"], "")

    def test_partial_answer_advances_without_waiting_for_budget(self):
        session = create_session(make_multi_concept_session_payload())
        fake_intelligence = FakeVerifyForeverIntelligence()
        payload = SimpleNamespace(
            answer="这个点我已经知道主线了。",
            interactionPreference=None,
            burdenSignal="normal",
            intent="",
        )

        with patch("app.engine.session_engine.get_tutor_intelligence", return_value=fake_intelligence):
            first = answer_session(session, payload)

        self.assertEqual(first["currentTrainingPointId"], "next-anchor")
        self.assertEqual(first["currentProbe"], "进入下一题：请说明第二个训练点是什么？")
        self.assertEqual(first["latestFeedback"]["turnResolution"]["mode"], "switch")
        self.assertEqual(first["currentQuestionMeta"]["phase"], "diagnostic")

    def test_teach_turn_counts_toward_round_budget(self):
        session = create_session(make_multi_concept_session_payload())
        teach_payload = SimpleNamespace(
            answer="查看解析",
            interactionPreference=None,
            burdenSignal="normal",
            intent="teach",
        )
        answer_payload = SimpleNamespace(
            answer="这个点我已经知道主线了。",
            interactionPreference=None,
            burdenSignal="normal",
            intent="",
        )

        with patch("app.engine.session_engine.get_tutor_intelligence", return_value=FakeTeachIntelligence()):
            taught = answer_session(session, teach_payload)

        self.assertEqual(taught["currentTrainingPointId"], "next-anchor")
        self.assertEqual(taught["currentQuestionMeta"]["progress"]["currentRound"], 1)

        with patch("app.engine.session_engine.get_tutor_intelligence", return_value=FakeVerifyForeverIntelligence()):
            first = answer_session(session, answer_payload)

        self.assertEqual(first["currentTrainingPointId"], "next-anchor")
        self.assertEqual(first["latestFeedback"]["turnResolution"]["mode"], "stop")

    def test_wrong_answer_only_gets_one_followup_before_advancing(self):
        session = create_session(make_multi_concept_session_payload())
        payload = SimpleNamespace(
            answer="我把这个点说反了。",
            interactionPreference=None,
            burdenSignal="normal",
            intent="",
        )

        with patch("app.engine.session_engine.get_tutor_intelligence", return_value=FakeWrongIntelligence()):
            first = answer_session(session, payload)
            second = answer_session(session, payload)

        self.assertEqual(first["currentTrainingPointId"], "mvcc-boundary")
        self.assertEqual(first["currentCheckpointId"], "mvcc-boundary-cp-1")
        self.assertEqual(first["latestFeedback"]["turnResolution"]["mode"], "stay")
        self.assertEqual(first["currentProbe"], "你再试一次：把正确结论重讲一遍。")
        self.assertEqual(second["currentTrainingPointId"], "next-anchor")
        self.assertEqual(second["latestFeedback"]["turnResolution"]["mode"], "switch")


if __name__ == "__main__":
    unittest.main()
