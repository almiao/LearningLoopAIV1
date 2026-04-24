from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import poll_realtime_asr_event


class BlockingRecognizer:
    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.calls = 0

    def poll_event(self, timeout: float = 0.1):
        self.calls += 1
        time.sleep(self.delay)
        return None


class InterviewAssistRealtimeAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_poll_realtime_asr_event_does_not_block_event_loop(self):
        recognizer = BlockingRecognizer(delay=0.2)
        task = asyncio.create_task(poll_realtime_asr_event(recognizer, timeout=0.1))

        started = time.perf_counter()
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.05)
        sleep_elapsed = time.perf_counter() - started

        self.assertLess(sleep_elapsed, 0.05)
        self.assertIsNone(await task)
        self.assertEqual(recognizer.calls, 1)


if __name__ == "__main__":
    unittest.main()
