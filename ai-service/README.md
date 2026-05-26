# AI Service

`ai-service/` contains the Python FastAPI service used by the split runtime.

## Runtime boundary

- Training content generation, question generation, answer diagnosis, and answer evaluation belong here.
- Document decomposition produces compact concept anchors only: title, summary, evidence snippet, misconception anchors, discriminators, and importance.
- Learner-facing questions are generated at runtime from the current session state; any pre-authored diagnostic/check questions are compatibility fallbacks, not the primary prompt source.
- A configured LLM provider is required in production.
- Heuristic tutor intelligence is available only as a test double under test-only environment flags.
- LoopAssist TTS is optional, runs in its own local worker process so synthesis setup does not block the main AI service, and now supports either local Qwen3-TTS or Alibaba Cloud speech synthesis over WebSocket. Install `requirements-tts-qwen3.txt` for local Qwen, or `requirements-tts-aliyun.txt` plus Alibaba Cloud credentials for managed speech synthesis.

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
| `app/loopassist/tts_worker.py` | LoopAssist TTS worker with `/api/health`, `/api/warmup`, and `/api/tts` |
| `app/observability/` | Logging and event emission |
| `tests/` | Python-side verification for the tutor flow |

## Notes

- The Python service mirrors part of the shared JS domain model, but it is a separate runtime surface.
- Shared contract docs live in [`../contracts/README.md`](../contracts/README.md).
- `LOOPASSIST_TTS_PROVIDER=auto` prefers Alibaba Cloud ordinary speech synthesis when `ALIYUN_AK_ID`, `ALIYUN_AK_SECRET`, and `ALIYUN_ISI_APP_KEY` are configured; otherwise it falls back to local Qwen3-TTS.
- Qwen3-TTS defaults to `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` plus `Uncle_Fu`; override with `QWEN3_TTS_MODEL` and `QWEN3_TTS_SPEAKER` when you want a different interviewer voice.
- Alibaba Cloud ordinary speech synthesis defaults to `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1` with `xiaoyun` voice and `wav/16000Hz`; override with `ALIYUN_STANDARD_TTS_WS_URL`, `ALIYUN_STANDARD_TTS_VOICE`, `ALIYUN_STANDARD_TTS_FORMAT`, and `ALIYUN_STANDARD_TTS_SAMPLE_RATE`.
- Alibaba Cloud CosyVoice flowing TTS remains available with `LOOPASSIST_TTS_PROVIDER=aliyun-cosyvoice`; it requires commercial flowing text-to-speech. Override with `ALIYUN_COSYVOICE_WS_URL`, `ALIYUN_COSYVOICE_VOICE`, `ALIYUN_COSYVOICE_FORMAT`, and `ALIYUN_COSYVOICE_SAMPLE_RATE`.
- Start the worker alone with `npm run dev:tts` from the repository root, then warm it with `curl -X POST http://127.0.0.1:4300/api/warmup`. On Windows, use the same npm script after installing SoX and Python dependencies.
