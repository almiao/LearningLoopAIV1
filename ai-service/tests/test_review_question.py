from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine import session_engine


class ReviewQuestionGenerationTests(unittest.TestCase):
    def test_generates_review_question_with_existing_probe_generator(self):
        calls = []

        class StubIntelligence:
            configured = True

            def generate_probe_question(self, **kwargs):
                calls.append(kwargs)
                return {
                    "question": "请换个支付超时场景讲清幂等键如何兜底？",
                    "intent": "stub_review",
                }

        with patch.object(session_engine, "_TUTOR_INTELLIGENCE", StubIntelligence()):
            result = session_engine.generate_review_question(
                review_item={
                    "id": "item-1",
                    "handle": "讲清接口幂等的边界",
                    "state": "shaky",
                    "evidence": {
                        "question": "重复提交为什么不能只靠前端禁用按钮？",
                        "missedAnchors": ["服务端幂等键", "超时重试后的状态查询"],
                    },
                },
                source_excerpt="支付回调可能重复到达，服务端需要以业务幂等键保证一次性落账。",
            )

        self.assertEqual(result["question"], "请换个支付超时场景讲清幂等键如何兜底？")
        self.assertEqual(result["intent"], "stub_review")
        self.assertEqual(calls[0]["phase"], "revisit")
        self.assertTrue(calls[0]["revisit"])
        self.assertEqual(calls[0]["concept"]["title"], "讲清接口幂等的边界")
        self.assertIn("服务端幂等键", calls[0]["concept"]["misconceptionAnchors"])
        self.assertEqual(calls[0]["context_packet"]["review_item"]["prior_question"], "重复提交为什么不能只靠前端禁用按钮？")

    def test_falls_back_without_configured_llm(self):
        with patch.object(session_engine, "_TUTOR_INTELLIGENCE", SimpleNamespace(configured=False)):
            result = session_engine.generate_review_question(
                review_item={
                    "id": "item-2",
                    "handle": "讲清 AQS 释放锁后的唤醒链路",
                    "evidence": {
                        "question": "释放锁后队列怎么继续推进？",
                        "missedAnchors": ["唤醒后继节点"],
                    },
                },
                source_excerpt="",
            )

        self.assertIn("AQS", result["question"])
        self.assertEqual(result["intent"], "review_item_revisit")


if __name__ == "__main__":
    unittest.main()
