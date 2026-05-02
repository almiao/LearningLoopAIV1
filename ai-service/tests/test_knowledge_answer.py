from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine.tutor_intelligence import HeuristicTutorIntelligence, build_knowledge_answer_prompt


class KnowledgeAnswerTests(unittest.TestCase):
    def test_reading_answer_prompt_excludes_training_decisions(self) -> None:
        prompt = build_knowledge_answer_prompt(
            question="请用 3 句话总结全文。",
            context="Agent Loop 会让模型观察、规划、调用工具并根据结果继续迭代。",
        )

        self.assertIn("只回答用户正在阅读的这篇材料", prompt)
        self.assertIn("不评估用户掌握度", prompt)
        self.assertIn("不要输出训练状态", prompt)

    def test_heuristic_reading_summary_answers_request_directly(self) -> None:
        content = HeuristicTutorIntelligence().answer_knowledge_question(
            question="请只基于这篇文档，用 3 句话总结核心内容。",
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


if __name__ == "__main__":
    unittest.main()
