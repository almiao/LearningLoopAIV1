from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine.jd_decompose import (
    MAX_TOPICS,
    build_jd_decompose_prompt,
    decompose_jd,
    normalize_jd_topics,
)


class JdDecomposeTests(unittest.TestCase):
    def test_decompose_uses_injected_llm_and_normalizes(self):
        prompts = []

        def fake_complete(prompt):
            prompts.append(prompt)
            return {
                "topics": [
                    {"topic": "线程池参数与拒绝策略的取舍", "importance": "core"},
                    {"topic": "线程池参数与拒绝策略的取舍", "importance": "core"},
                    {"topic": "JVM 垃圾回收器选型", "importance": "加分"},
                    {"topic": "", "importance": "core"},
                    "Kafka 重平衡的影响与规避",
                ]
            }

        result = decompose_jd(
            jd_text="负责高并发服务端开发……",
            resume_text="三年 Java 服务端，做过订单系统。",
            role="Java 后端",
            complete_json=fake_complete,
        )

        topics = result["topics"]
        self.assertEqual(len(topics), 3)
        self.assertEqual(topics[0], {"topic": "线程池参数与拒绝策略的取舍", "importance": "core"})
        self.assertEqual(topics[1]["importance"], "core")
        self.assertEqual(topics[2], {"topic": "Kafka 重平衡的影响与规避", "importance": "core"})
        self.assertIn("Java 后端", prompts[0])
        self.assertIn("订单系统", prompts[0])

    def test_normalize_caps_topic_count(self):
        raw = {"topics": [{"topic": f"话题 {index}", "importance": "secondary"} for index in range(40)]}
        self.assertEqual(len(normalize_jd_topics(raw)), MAX_TOPICS)

    def test_empty_jd_rejected(self):
        with self.assertRaises(ValueError):
            decompose_jd(jd_text="   ")

    def test_falls_back_to_heuristic_when_llm_returns_nothing(self):
        result = decompose_jd(
            jd_text="- 熟悉 MySQL 索引与事务\n- 熟悉 Redis 缓存一致性\n- 了解消息队列",
            complete_json=lambda prompt: {"topics": []},
        )
        topics = [entry["topic"] for entry in result["topics"]]
        self.assertIn("熟悉 MySQL 索引与事务", topics)
        self.assertIn("熟悉 Redis 缓存一致性", topics)

    def test_prompt_omits_resume_block_when_missing(self):
        prompt = build_jd_decompose_prompt(jd_text="JD 内容")
        self.assertNotIn("候选人简历", prompt)


if __name__ == "__main__":
    unittest.main()
