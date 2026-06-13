from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine.interview_decompose import (
    build_interview_decompose_prompt,
    decompose_interview,
)


class InterviewDecomposeTests(unittest.TestCase):
    def test_decompose_uses_injected_llm_and_keeps_theme(self):
        prompts = []

        def fake_complete(prompt):
            prompts.append(prompt)
            return {
                "topics": [
                    {"topic": "Transformer Decoder 的结构", "importance": "core", "theme": "大模型"},
                    {"topic": "RAG 检索精度怎么提", "importance": "core", "theme": "大模型"},
                    {"topic": "B+ 树的理解", "importance": "secondary", "theme": "数据结构"},
                ],
            }

        result = decompose_interview(
            report_text="1. Transformer 的 Decoder 介绍一下？\n2. RAG 怎么做？",
            role="算法",
            complete_json=fake_complete,
        )
        topics = result["topics"]
        self.assertEqual(len(topics), 3)
        self.assertEqual(topics[0]["theme"], "大模型")
        self.assertEqual(topics[2]["importance"], "secondary")
        self.assertIn("算法", prompts[0])
        self.assertIn("面经原文", prompts[0])

    def test_empty_report_rejected(self):
        with self.assertRaises(ValueError):
            decompose_interview(report_text="   ")

    def test_falls_back_to_heuristic_when_llm_returns_nothing(self):
        result = decompose_interview(
            report_text="1. CUDA 并行性与并发性区别\n2. C++ 三大特性\n3. std::map 底层",
            complete_json=lambda prompt: {"topics": []},
        )
        topics = [entry["topic"] for entry in result["topics"]]
        self.assertIn("CUDA 并行性与并发性区别", topics)
        self.assertIn("C++ 三大特性", topics)

    def test_prompt_includes_report_body(self):
        prompt = build_interview_decompose_prompt(report_text="问了 Kafka 重平衡")
        self.assertIn("Kafka 重平衡", prompt)


if __name__ == "__main__":
    unittest.main()
