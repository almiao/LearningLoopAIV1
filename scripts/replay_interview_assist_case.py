from __future__ import annotations

import argparse
import pathlib
import sys
import time
import wave


ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ai-service"))

from app.interview_assist.aliyun_realtime_asr import AliyunRealtimeRecognizer  # noqa: E402


def pcm_chunks_from_file(path: pathlib.Path, chunk_size: int = 3200):
    with path.open("rb") as source:
        while True:
            chunk = source.read(chunk_size)
            if not chunk:
                break
            yield chunk


def pcm_chunks_from_wav(path: pathlib.Path, chunk_size: int = 3200):
    with wave.open(str(path), "rb") as wav_file:
        if wav_file.getnchannels() != 1 or wav_file.getsampwidth() != 2:
            raise ValueError("Expected mono 16-bit WAV input.")
        while True:
            chunk = wav_file.readframes(chunk_size // 2)
            if not chunk:
                break
            yield chunk


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay a captured interview assist audio case into Aliyun realtime ASR.")
    parser.add_argument("path", help="Path to .pcm or .wav case file")
    parser.add_argument("--chunk-bytes", type=int, default=3200, help="Bytes per send_audio_frame call")
    parser.add_argument("--sleep-ms", type=int, default=100, help="Delay between chunks in milliseconds")
    args = parser.parse_args()

    case_path = pathlib.Path(args.path).expanduser().resolve()
    if not case_path.exists():
      raise SystemExit(f"Case file not found: {case_path}")

    recognizer = AliyunRealtimeRecognizer()
    if not recognizer.configured:
        raise SystemExit("DASHSCOPE_API_KEY is not configured.")

    recognizer.start()
    try:
        if case_path.suffix.lower() == ".wav":
            iterator = pcm_chunks_from_wav(case_path, args.chunk_bytes)
        else:
            iterator = pcm_chunks_from_file(case_path, args.chunk_bytes)

        stopped_early = False
        for chunk in iterator:
            while True:
                event = recognizer.poll_event(timeout=0.01)
                if not event:
                    break
                print(event.event, event.data)
                if event.event in {"asr_error", "asr_close"}:
                    stopped_early = True
            if stopped_early:
                break

            try:
                recognizer.send_audio(chunk)
            except Exception as exc:
                print("send_audio_error", repr(exc))
                stopped_early = True
                break
            time.sleep(args.sleep_ms / 1000)

        try:
            recognizer.stop()
        except Exception as exc:
            print("stop_error", repr(exc))

        deadline = time.time() + 10
        while time.time() < deadline:
            event = recognizer.poll_event(timeout=0.2)
            if not event:
                continue
            print(event.event, event.data)
    finally:
        try:
            recognizer.stop()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
