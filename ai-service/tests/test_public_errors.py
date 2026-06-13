from __future__ import annotations

import unittest

from app.core.public_errors import build_public_error_payload


class PublicErrorPayloadTest(unittest.TestCase):
    def test_provider_http_errors_are_normalized_for_clients(self) -> None:
        payload = build_public_error_payload(
            'Provider request failed: 402 {"error":{"message":"Insufficient Balance","type":"unknown_error"}}'
        )

        self.assertEqual(payload["code"], "llm_provider_http_error")
        self.assertEqual(payload["source"], "llm-provider")
        self.assertEqual(payload["retryable"], False)
        self.assertEqual(payload["statusCode"], 503)
        self.assertEqual(payload["upstreamStatusCode"], 402)
        self.assertIn("配置或配额", payload["message"])

    def test_timeout_errors_stay_retryable(self) -> None:
        payload = build_public_error_payload("LLM request timed out (>60s).")

        self.assertEqual(payload["code"], "llm_timeout")
        self.assertEqual(payload["retryable"], True)
        self.assertIn("超时", payload["message"])


if __name__ == "__main__":
    unittest.main()
