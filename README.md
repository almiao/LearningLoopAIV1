# Learning Loop AI

AI interview tutoring project with a split runtime:

- `frontend/`: Next.js web client
- `bff/`: Node.js BFF and orchestration layer
- `ai-service/`: FastAPI-based AI service
- `src/`: shared JavaScript domain helpers still used by BFF, tests, scripts, and parts of the frontend

## Runtime boundary

Training content generation, question generation, answer diagnosis, and answer evaluation are LLM responsibilities and run through the Python `ai-service/` with a configured provider. Progress, aggregation, sorting, and status display can stay deterministic rule logic.

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
- AI service: [http://127.0.0.1:8000](http://127.0.0.1:8000)

Logs:

- `.omx/logs/split-services/frontend.log`
- `.omx/logs/split-services/bff.log`
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
