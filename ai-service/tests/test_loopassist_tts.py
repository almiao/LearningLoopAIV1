from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.loopassist import tts


class LoopAssistTtsTests(unittest.TestCase):
    def setUp(self) -> None:
        tts._ALIYUN_TOKEN = ""
        tts._ALIYUN_TOKEN_EXPIRE_AT = 0

    def test_auto_provider_prefers_aliyun_when_credentials_exist(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "LOOPASSIST_TTS_PROVIDER": "auto",
                "ALIYUN_AK_ID": "ak",
                "ALIYUN_AK_SECRET": "secret",
                "ALIYUN_ISI_APP_KEY": "app-key",
            },
            clear=False,
        ):
            self.assertEqual(tts._normalized_tts_provider(), "aliyun-standard")

    def test_auto_provider_falls_back_to_qwen_without_aliyun_credentials(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "LOOPASSIST_TTS_PROVIDER": "auto",
                "ALIYUN_AK_ID": "",
                "ALIYUN_AK_SECRET": "",
                "ALIYUN_ISI_APP_KEY": "",
            },
            clear=False,
        ):
            self.assertEqual(tts._normalized_tts_provider(), "qwen3-tts")

    def test_synthesize_dispatches_to_standard_aliyun_provider(self) -> None:
        async def fake_aliyun(*, text: str, speaker: str = ""):
            return b"aliyun-audio", {"provider": "aliyun-standard", "speaker": speaker or "voice"}

        with patch.dict(
            "os.environ",
            {
                "LOOPASSIST_TTS_PROVIDER": "aliyun-standard",
                "ALIYUN_AK_ID": "ak",
                "ALIYUN_AK_SECRET": "secret",
                "ALIYUN_ISI_APP_KEY": "app-key",
            },
            clear=False,
        ), patch.object(tts, "_synthesize_aliyun_standard_async", side_effect=fake_aliyun):
            audio, metadata = tts.synthesize_loopassist_tts(text="面试官问题", speaker="xiaoyun")

        self.assertEqual(audio, b"aliyun-audio")
        self.assertEqual(metadata["provider"], "aliyun-standard")
        self.assertEqual(metadata["speaker"], "xiaoyun")

    def test_synthesize_dispatches_to_cosyvoice_provider(self) -> None:
        async def fake_aliyun(*, text: str, speaker: str = ""):
            return b"aliyun-audio", {"provider": "aliyun-cosyvoice", "speaker": speaker or "voice"}

        with patch.dict(
            "os.environ",
            {
                "LOOPASSIST_TTS_PROVIDER": "aliyun-cosyvoice",
                "ALIYUN_AK_ID": "ak",
                "ALIYUN_AK_SECRET": "secret",
                "ALIYUN_ISI_APP_KEY": "app-key",
            },
            clear=False,
        ), patch.object(tts, "_synthesize_aliyun_cosyvoice_async", side_effect=fake_aliyun):
            audio, metadata = tts.synthesize_loopassist_tts(text="面试官问题", speaker="longxiaochun_v2")

        self.assertEqual(audio, b"aliyun-audio")
        self.assertEqual(metadata["provider"], "aliyun-cosyvoice")
        self.assertEqual(metadata["speaker"], "longxiaochun_v2")

    def test_synthesize_dispatches_to_qwen_provider(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "LOOPASSIST_TTS_PROVIDER": "qwen3-tts",
            },
            clear=False,
        ), patch.object(
            tts,
            "_synthesize_qwen3_tts",
            return_value=(b"qwen-audio", {"provider": "qwen3-tts", "speaker": "Uncle_Fu"}),
        ) as synth_mock:
            audio, metadata = tts.synthesize_loopassist_tts(text="面试官问题")

        self.assertEqual(audio, b"qwen-audio")
        self.assertEqual(metadata["provider"], "qwen3-tts")
        synth_mock.assert_called_once()

    def test_aliyun_error_message_explains_commercial_tts_failure(self) -> None:
        message = tts._aliyun_error_message("TaskFailed", 40000010, "")

        self.assertIn("40000010", message)
        self.assertIn("commercial-only", message)


if __name__ == "__main__":
    unittest.main()
