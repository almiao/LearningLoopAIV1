from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine.tutor_intelligence import (
    ProviderTutorIntelligence,
    HeuristicTutorIntelligence,
    build_knowledge_answer_prompt,
    build_turn_diagnosis_prompt,
    build_teach_reply_prompt,
    call_provider_text,
)


class KnowledgeAnswerTests(unittest.TestCase):
    def test_reading_answer_prompt_keeps_only_minimal_context_rules(self) -> None:
        prompt = build_knowledge_answer_prompt(
            question="请用 3 句话总结全文。",
            context="Agent Loop 会让模型观察、规划、调用工具并根据结果继续迭代。",
        )

        self.assertIn("可以结合可靠的通用技术知识回答", prompt)
        self.assertIn("不要因为材料没有直接展开就拒答", prompt)
        self.assertIn("如果用户要求总结，直接给出总结", prompt)
        self.assertIn("当前用户目标：面试准备", prompt)
        self.assertIn("不要固定输出数量", prompt)
        self.assertIn("用中文回答", prompt)
        self.assertNotIn("不评估用户掌握度", prompt)
        self.assertNotIn("不要输出训练状态", prompt)
        self.assertNotIn("尽量短", prompt)
        self.assertNotIn("只基于【材料】回答", prompt)

    def test_reading_task_prompts_are_goal_directed_without_fixed_counts(self) -> None:
        prompt = build_knowledge_answer_prompt(
            question="生成自测问题",
            context="AES 适合大量数据加密。RSA 常用于密钥交换和签名验签。",
            goal="interview",
            task_type="question_points",
        )

        self.assertIn("当前用户目标：面试准备", prompt)
        self.assertIn("当前能力：生成自测问题", prompt)
        self.assertIn("问题不要停留在标题复述", prompt)
        self.assertIn("根据文章内容自行决定问题数量", prompt)
        self.assertNotIn("5-8", prompt)

    def test_text_llm_calls_preserve_markdown_newlines(self) -> None:
        markdown_reply = "\n### 节点\n\n1. prepare 阶段\n2. commit 阶段\n\n- 异常时按 binlog 是否完整判断\n"

        with patch("app.engine.tutor_intelligence._post_json", return_value={"output_text": markdown_reply}):
            self.assertEqual(
                call_provider_text(provider="OPENAI", api_key="test-key", model="test-model", prompt="prompt"),
                markdown_reply,
            )

        with patch(
            "app.engine.tutor_intelligence._post_json",
            return_value={"choices": [{"message": {"content": markdown_reply}}]},
        ):
            self.assertEqual(
                call_provider_text(provider="DEEPSEEK", api_key="test-key", model="test-model", prompt="prompt"),
                markdown_reply,
            )

    def test_teach_reply_prompt_defines_explanation_mode_instead_of_answer_evaluation(self) -> None:
        prompt = build_teach_reply_prompt(
            answer="查看解析",
            context_packet={
                "dynamic": {
                    "currentQuestion": "以下哪个说法正确描述了 MCP 和 Function Calling 的关系？",
                }
            },
        )

        self.assertIn("The learner has explicitly requested an explanation", prompt)
        self.assertIn("Treat the current learner input as an explanation request, not as an answer to evaluate.", prompt)
        self.assertNotIn("Focus only on evaluating the learner's current answer", prompt)

    def test_runtime_question_generation_prompt_requires_chinese(self) -> None:
        intelligence = ProviderTutorIntelligence(provider="DEEPSEEK", model="test-model", api_key="test-key")
        captured = {}

        def fake_call(*, call_type, prompt, schema, validator):
            captured["prompt"] = prompt
            return type("Result", (), {"parsed": {"question": "请解释一下。", "intent": "ask"}})()

        with patch.object(intelligence, "_call_json_traced", side_effect=fake_call):
            intelligence.generate_probe_question(
                concept={
                    "id": "concept-1",
                    "title": "泛型的作用",
                    "summary": "summary",
                    "evidenceSnippet": "snippet",
                    "misconceptionAnchors": [],
                    "discriminators": [],
                    "importance": "core",
                },
                context_packet={},
            )

        self.assertIn("Write the learner-facing question in Chinese.", captured["prompt"])

    def test_turn_envelope_retries_when_follow_up_question_is_missing(self) -> None:
        intelligence = ProviderTutorIntelligence(provider="DEEPSEEK", model="test-model", api_key="test-key")
        concept = {
            "id": "concept-1",
            "title": "Test Concept",
            "summary": "Test Summary",
            "evidenceSnippet": "snippet",
            "misconceptionAnchors": [],
            "discriminators": [],
            "importance": "core",
        }
        calls = {"count": 0}

        def fake_call(*, call_type, prompt, schema, validator):
            calls["count"] += 1
            payload = {
                "runtime_map": {
                    "anchor_id": "concept-1",
                    "turn_signal": "noise",
                    "anchor_assessment": {
                        "state": "partial",
                        "score": 72,
                        "reasons": ["need follow-up"],
                    },
                    "hypotheses": [],
                    "misunderstandings": [],
                    "open_questions": [],
                    "verification_targets": [],
                    "info_gain_level": "medium",
                },
                "next_move": {
                    "intent": "继续确认。",
                    "reason": "还差一步。",
                    "expected_gain": "medium",
                    "ui_mode": "verify",
                    "follow_up_question": "" if calls["count"] == 1 else "你再用自己的话解释一次。",
                },
                "writeback_suggestion": {
                    "should_write": False,
                    "mode": "noop",
                    "reason": "no_change",
                    "anchor_patch": {
                        "state": "partial",
                        "score": 72,
                        "derived_principle": "summary",
                    },
                },
            }
            validator(payload)
            return type("Result", (), {"parsed": payload})()

        with patch.object(intelligence, "_call_json_traced", side_effect=fake_call):
            envelope = intelligence.generate_turn_envelope(
                concept=concept,
                context_packet={"anchor_state": {}, "stop_conditions": {}, "budget": {}},
                answer="查看解析",
                forced_action="teach",
            )

        self.assertEqual(calls["count"], 2)
        self.assertEqual(envelope["next_move"]["follow_up_question"], "你再用自己的话解释一次。")

    def test_heuristic_reading_summary_answers_request_directly(self) -> None:
        content = HeuristicTutorIntelligence().answer_knowledge_question(
            question="请参考这篇文档，用 3 句话总结核心内容。",
            context="""
# 一文搞懂 AI Agent 核心概念
Agent Loop 是智能体观察、思考、行动、反馈的闭环。
Context Engineering 负责把任务目标、历史状态和外部信息组织成可用上下文。
Tools 注册让模型可以安全调用外部能力来完成真实任务。
""",
        )

        self.assertIn("Agent Loop", content)
        self.assertIn("Context Engineering", content)
        self.assertNotIn("正在评估", content)
        self.assertNotIn("你是在提出请求", content)

    def test_heuristic_reading_question_points_use_goal_and_task_type(self) -> None:
        content = HeuristicTutorIntelligence().answer_knowledge_question(
            question="生成自测问题",
            task_type="question_points",
            goal="interview",
            context="""
# 常见加密算法总结
哈希算法适合完整性校验和密码存储，但不是可逆加密。
对称加密适合大量数据加密，非对称加密适合密钥交换和签名验签。
""",
        )

        self.assertIn("当前目标：面试准备", content)
        self.assertIn("问题：", content)
        self.assertIn("考察点：", content)


if __name__ == "__main__":
    unittest.main()
