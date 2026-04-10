# Learning Loop AI

Split architecture version of the AI interview tutoring platform.

## Services

- `frontend/`: Next.js web app
- `bff/`: Node.js BFF
- `ai-service/`: Python FastAPI AI service

## Prerequisites

- Node.js 20+
- npm
- Python 3.11+

## First-time install

```bash
npm install --prefix frontend
python3 -m pip install --user -r ai-service/requirements.txt
```

## One-click start

Run from the repository root:

```bash
bash start-services.sh
```

This will:

- build the frontend production bundle
- start the Python AI service on `8000`
- start the Node BFF on `4000`
- start the frontend on `3000`
- wait for health checks before returning

After startup, open:

- Frontend: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- BFF: [http://127.0.0.1:4000](http://127.0.0.1:4000)
- AI service: [http://127.0.0.1:8000](http://127.0.0.1:8000)

Logs are written to:

- `.omx/logs/split-services/frontend.log`
- `.omx/logs/split-services/bff.log`
- `.omx/logs/split-services/ai-service.log`

## Stop services

```bash
bash stop-services.sh
```

## Alternative npm entrypoints

These delegate to the same split-service startup flow:

```bash
npm start
npm run dev
```

## Verification

Smoke test the split main flow:

```bash
npm run smoke:split
```

Run the default split-focused tests:

```bash
npm test
```

Run legacy reference tests if needed:

```bash
npm run legacy:test
```
