from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine.session_engine import create_session, project_session


def make_payload(*, target_progress=None) -> SimpleNamespace:
    return SimpleNamespace(
        userId="u-1",
        source={
            "title": "Spring 事务详解",
            "kind": "knowledge-document",
            "url": "",
            "metadata": {
                "docPath": "docs/system-design/framework/spring/spring-transaction.md",
            },
        },
        decomposition={
            "summary": {
                "sourceTitle": "Spring 事务详解",
                "keyThemes": ["事务边界"],
                "framing": "围绕代理边界和失效场景拆题。",
            },
            "trainingPoints": [
                {
                    "id": "spring-transaction-boundary",
                    "title": "Spring 事务边界与失效场景",
                    "summary": "能解释事务代理边界、自调用失效和传播行为的含义。",
                    "importance": "core",
                    "abilityDomainId": "spring-runtime",
                    "abilityDomainTitle": "Spring 运行时与事务边界",
                    "javaGuideSources": [
                        {
                            "path": "docs/system-design/framework/spring/spring-transaction.md",
                            "title": "Spring 事务详解",
                        }
                    ],
                    "checkpoints": [
                        {
                            "id": "spring-transaction-boundary-cp-1",
                            "statement": "解释事务代理边界为什么决定 @Transactional 是否生效",
                            "successCriteria": "能说明代理入口和自调用失效的关系",
                            "diagnosticQuestion": "为什么同一个类里自调用 @Transactional 方法可能不生效？",
                            "checkQuestion": "重新用一句话解释事务失效的边界。",
                        }
                    ],
                }
            ],
            "concepts": [
                {
                    "id": "spring-transaction-boundary-cp-1",
                    "trainingPointId": "spring-transaction-boundary",
                    "trainingPointTitle": "Spring 事务边界与失效场景",
                    "title": "解释事务代理边界为什么决定 @Transactional 是否生效",
                    "summary": "能说明代理入口和自调用失效的关系。",
                    "importance": "core",
                    "abilityDomainId": "spring-runtime",
                    "abilityDomainTitle": "Spring 运行时与事务边界",
                    "javaGuideSources": [
                        {
                            "path": "docs/system-design/framework/spring/spring-transaction.md",
                            "title": "Spring 事务详解",
                        }
                    ],
                    "diagnosticQuestion": "为什么同一个类里自调用 @Transactional 方法可能不生效？",
                    "retryQuestion": "先只讲代理边界这一点。",
                    "checkQuestion": "重新用一句话解释事务失效的边界。",
                    "questionFamily": "concept",
                }
            ],
        },
        interactionPreference="balanced",
        targetBaseline={"id": "baseline-1", "title": "Java Backend"},
        memoryProfile={"id": "memory-1", "abilityItems": {}},
        targetProgress=target_progress
        or {
            "readingProgress": {
                "docs": {
                    "docs/system-design/framework/spring/spring-transaction.md": {
                        "docPath": "docs/system-design/framework/spring/spring-transaction.md",
                        "progressPercentage": 100,
                        "status": "completed",
                        "dwellMs": 50_000,
                        "completedReadCount": 1,
                    }
                }
            }
        },
    )


class MasteryScoringTests(unittest.TestCase):
    def test_project_session_uses_reading_progress_in_target_match(self) -> None:
        session = create_session(make_payload())
        projected = project_session(session)

        self.assertGreater(projected["targetMatch"]["percentage"], 10)
        self.assertIn("readinessScore", projected["targetMatch"])


if __name__ == "__main__":
    unittest.main()
