# Learning Loop AI

AI interview tutoring project with a split runtime:

- `frontend/`: Next.js web client
- `bff/`: Node.js BFF and orchestration layer
- `ai-service/`: FastAPI-based AI service
- `tts-worker`: local FastAPI worker for LoopAssist Qwen3-TTS audio, started from `ai-service/app/loopassist/tts_worker.py`
- `src/`: shared JavaScript domain helpers still used by BFF, tests, scripts, and parts of the frontend

## Runtime boundary

Training content generation, question generation, answer diagnosis, and answer evaluation are LLM responsibilities and run through the Python `ai-service/` with a configured provider. Progress, aggregation, sorting, and status display can stay deterministic rule logic.

Document decomposition is intentionally structural: it extracts compact concept anchors instead of pre-generating the full question set. The active question for each training turn is generated from the current session state so it can adapt to the learner's answer, memory, revisit state, and recent teaching.

The old JavaScript heuristic tutor has been removed. If no LLM provider is configured, production training fails clearly instead of generating rule-based tutor content.

## Quick start

Requirements:

- Node.js 20+
- npm
- Python 3.11+

The start script bootstraps missing frontend and Python dependencies automatically on first run.
If you prefer to install them manually:

```bash
npm install --prefix frontend
python -m pip install -r ai-service/requirements.txt
```

LoopAssist interviewer voice uses open-source Qwen3-TTS as an optional local TTS runtime. The upstream project is Apache-2.0 licensed. Install it separately because it pulls large ML/audio dependencies and downloads model weights on first synthesis:

```bash
brew install sox
python3 -m pip install -r ai-service/requirements-tts-qwen3.txt
```

The default local voice model is `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` with speaker `Uncle_Fu`. You can override runtime settings with `QWEN3_TTS_MODEL`, `QWEN3_TTS_SPEAKER`, `QWEN3_TTS_LANGUAGE`, `QWEN3_TTS_INSTRUCT`, `QWEN3_TTS_DEVICE_MAP`, `QWEN3_TTS_DTYPE`, and `QWEN3_TTS_ATTN_IMPLEMENTATION`. The upstream Qwen3-TTS README recommends a fresh Python 3.12 environment for fewer dependency conflicts; this project keeps the dependency in a separate requirements file so the core AI service can still start without loading TTS. SoX is required by the Qwen3-TTS audio stack; Linux users can install the equivalent `sox` system package. Windows users should install SoX and ensure `sox.exe` is on `PATH`.

Qwen3-TTS runs in a separate local worker so model loading and first-time weight downloads do not block the main AI service:

```bash
npm run dev:tts
curl http://127.0.0.1:4300/api/health
curl -X POST http://127.0.0.1:4300/api/warmup
```

`npm start` / `bash start-services.sh` / `.\start-services.ps1` start this worker automatically on `TTS_WORKER_PORT` (default `4300`). BFF proxies browser audio requests to `TTS_SERVICE_URL` (default `http://127.0.0.1:4300`). The first warmup may take a long time while Hugging Face downloads model weights into `~/.cache/huggingface`.

Start all services from the repository root:

```bash
npm start
```

Windows PowerShell:

```powershell
./start-services.ps1
```

Unix shell:

```bash
bash start-services.sh
```

Endpoints:

- Frontend: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- BFF: [http://127.0.0.1:4000](http://127.0.0.1:4000)
- TTS worker: [http://127.0.0.1:4300](http://127.0.0.1:4300)
- AI service: [http://127.0.0.1:8000](http://127.0.0.1:8000)

Logs:

- `.omx/logs/split-services/frontend.log`
- `.omx/logs/split-services/bff.log`
- `.omx/logs/split-services/tts-worker.log`
- `.omx/logs/split-services/ai-service.log`

Stop services:

```bash
npm run stop
```

Windows PowerShell:

```powershell
./stop-services.ps1
```

## Common commands

```bash
npm test
npm run build
npm run smoke:split
npm run eval:auto
npm run eval:auto
npm run validate:cases
```

## Repository map

| Directory | Purpose |
| --- | --- |
| `ai-service/` | Python service, request parsing, tutor engine bridge, observability |
| `ai-service/app/loopassist/tts_worker.py` | Local Qwen3-TTS worker process for LoopAssist interviewer audio |
| `archive/` | Archived historical scripts, legacy artifacts, and old generated review snapshots |
| `bff/` | BFF API layer, profile persistence, knowledge-doc lookup, and AI service proxying |
| `contracts/` | API contracts and cross-service interface documents |
| `frontend/` | Next.js routes, UI shell, and browser-side API helpers |
| `scripts/` | Manual utilities, smoke scripts, evaluation runners, and maintenance scripts |
| `src/` | Shared JS domain helpers for baseline packs, ingestion, user profiles, and view projection |
| `tests/` | Unit, integration, e2e, evaluation, personas, and fixtures |

Each main directory now has its own `README.md` with a more detailed folder breakdown.

## Documentation conventions

- Active docs use descriptive kebab-case names.
- Generated review outputs are no longer kept in the active tree by default.
- Historical or one-off artifacts live under `archive/`.

## Notes

- `src/` is still active, but it no longer contains a JavaScript tutor engine. Production training generation and answer evaluation live in `ai-service/`.
- `tests/eval/generated/` is treated as a runtime output directory. The previously committed snapshots were moved to `archive/`.
