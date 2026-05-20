# AI Service

`ai-service/` contains the Python FastAPI service used by the split runtime.

## Runtime boundary

- Training content generation, question generation, answer diagnosis, and answer evaluation belong here.
- Document decomposition produces compact concept anchors only: title, summary, evidence snippet, misconception anchors, discriminators, and importance.
- Learner-facing questions are generated at runtime from the current session state; any pre-authored diagnostic/check questions are compatibility fallbacks, not the primary prompt source.
- A configured LLM provider is required in production.
- Heuristic tutor intelligence is available only as a test double under test-only environment flags.
- LoopAssist TTS is optional, open-source-first, lazy-loaded, and runs in its own local worker process so model loading does not block the main AI service. Install system `sox` plus `requirements-tts-qwen3.txt` only on machines that need local Qwen3-TTS interviewer audio.

## Folder map

| Directory | Purpose |
| --- | --- |
| `app/` | Application package and HTTP entrypoint |
| `app/core/` | Configuration and tracing bootstrap |
| `app/domain/` | Domain-level parsing and validation rules |
| `app/domain/interview/` | Interview request parsing and validation helpers |
| `app/engine/` | Python-side tutor engine modules and session logic |
| `app/infra/` | Infrastructure adapters |
| `app/infra/llm/` | LLM client and snapshot handling |
| `app/loopassist/tts_worker.py` | Local Qwen3-TTS worker with `/api/health`, `/api/warmup`, and `/api/tts` |
| `app/observability/` | Logging and event emission |
| `tests/` | Python-side verification for the tutor flow |

## Notes

- The Python service mirrors part of the shared JS domain model, but it is a separate runtime surface.
- Shared contract docs live in [`../contracts/README.md`](../contracts/README.md).
- Qwen3-TTS defaults to `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` plus `Uncle_Fu`; override with `QWEN3_TTS_MODEL` and `QWEN3_TTS_SPEAKER` when you want a different interviewer voice.
- Start the worker alone with `npm run dev:tts` from the repository root, then warm it with `curl -X POST http://127.0.0.1:4300/api/warmup`. On Windows, use the same npm script after installing SoX and Python dependencies.
