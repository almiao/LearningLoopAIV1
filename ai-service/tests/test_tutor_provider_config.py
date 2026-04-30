from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.engine.tutor_intelligence import HeuristicTutorIntelligence, create_tutor_intelligence


class TutorProviderConfigTests(unittest.TestCase):
    def test_missing_provider_does_not_fallback_in_production(self):
        with patch.dict(
            os.environ,
            {
                "LLAI_LLM_ENABLED": "true",
                "LLAI_LLM_PROVIDER": "OPENAI",
                "LLAI_ALLOW_HEURISTIC_FALLBACK": "1",
                "LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE": "1",
            },
            clear=True,
        ):
            intelligence = create_tutor_intelligence()

        self.assertIsNone(intelligence)

    def test_missing_provider_can_use_heuristic_only_in_test_runtime(self):
        with patch.dict(
            os.environ,
            {
                "LLAI_LLM_ENABLED": "true",
                "LLAI_LLM_PROVIDER": "OPENAI",
                "APP_ENV": "test",
                "LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE": "1",
            },
            clear=True,
        ):
            intelligence = create_tutor_intelligence()

        self.assertIsInstance(intelligence, HeuristicTutorIntelligence)


if __name__ == "__main__":
    unittest.main()
