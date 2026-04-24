from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.interview_assist.service import _create_interview_assist_intelligence, describe_interview_assist


class InterviewAssistProviderConfigTests(unittest.TestCase):
    def test_interview_assist_inherits_global_deepseek_provider_by_default(self):
        with patch.dict(
            os.environ,
            {
                "LLAI_LLM_PROVIDER": "DEEPSEEK",
                "LLAI_DEEPSEEK_API_KEY": "deepseek-key",
                "LLAI_DEEPSEEK_MODEL": "deepseek-chat",
                "LLAI_DEEPSEEK_BASE_URL": "https://api.deepseek.com",
            },
            clear=True,
        ):
            intelligence = _create_interview_assist_intelligence()

        self.assertEqual(intelligence.provider, "DEEPSEEK")
        self.assertEqual(intelligence.api_key, "deepseek-key")
        self.assertEqual(intelligence.model, "deepseek-chat")
        self.assertEqual(intelligence.base_url, "https://api.deepseek.com")
        self.assertTrue(intelligence.configured)

    def test_interview_assist_specific_provider_override_still_wins(self):
        with patch.dict(
            os.environ,
            {
                "LLAI_LLM_PROVIDER": "DEEPSEEK",
                "LLAI_DEEPSEEK_API_KEY": "deepseek-key",
                "INTERVIEW_ASSIST_LLM_PROVIDER": "OPENAI",
                "INTERVIEW_ASSIST_OPENAI_API_KEY": "openai-key",
                "INTERVIEW_ASSIST_OPENAI_MODEL": "gpt-5-mini",
            },
            clear=True,
        ):
            intelligence = _create_interview_assist_intelligence()

        self.assertEqual(intelligence.provider, "OPENAI")
        self.assertEqual(intelligence.api_key, "openai-key")
        self.assertEqual(intelligence.model, "gpt-5-mini")
        self.assertTrue(intelligence.configured)

    def test_describe_interview_assist_reports_global_provider_fallback(self):
        with patch.dict(
            os.environ,
            {
                "LLAI_LLM_PROVIDER": "DEEPSEEK",
                "LLAI_DEEPSEEK_API_KEY": "deepseek-key",
            },
            clear=True,
        ):
            info = describe_interview_assist()

        self.assertEqual(info["provider"], "DEEPSEEK")
        self.assertTrue(info["configured"])


if __name__ == "__main__":
    unittest.main()
