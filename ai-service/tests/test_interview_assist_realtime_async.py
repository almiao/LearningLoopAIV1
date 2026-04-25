from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import poll_realtime_asr_event, stream_realtime_assist_answer_events


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

    async def test_realtime_answer_events_are_forwarded_before_worker_finishes(self):
        events = []
        framework_seen = asyncio.Event()

        def fake_stream_assist_answer(*, emit, **_kwargs):
            emit("core_done", {"coreMarkdown": "**确认范围**"})
            time.sleep(0.2)
            emit("answer_ready", {"coreMarkdown": "**确认范围**", "detailMarkdown": "逐层排查"})

        async def send_json_event(event, data):
            events.append((event, data))
            if event == "core_done":
                framework_seen.set()

        with patch("app.main.stream_assist_answer", side_effect=fake_stream_assist_answer):
            task = asyncio.create_task(
                stream_realtime_assist_answer_events(
                    session_id="assist_test",
                    question_text="怎么排查接口超时？",
                    question_ended_at=None,
                    send_json_event=send_json_event,
                )
            )

            await asyncio.wait_for(framework_seen.wait(), timeout=0.1)
            self.assertEqual([event for event, _data in events], ["core_done"])

            await task
            self.assertEqual([event for event, _data in events], ["core_done", "answer_ready"])


if __name__ == "__main__":
    unittest.main()
