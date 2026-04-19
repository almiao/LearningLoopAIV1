# Local LiveKit Server

This directory contains the local self-hosted LiveKit development setup for the interview-assist voice path.

## What This Runs

- `livekit-server` on `ws://127.0.0.1:7880`
- local development API credentials:
  - `LIVEKIT_API_KEY=devkey`
  - `LIVEKIT_API_SECRET=secret`
- `livekit-agent` session server + LiveKit Agents worker on `http://127.0.0.1:4200`
- AI service on `http://127.0.0.1:8000`
- frontend preview on `http://127.0.0.1:3002`

The local LiveKit server is started in `--dev` mode and is not intended for production.

## One-Time Setup

Install the server binary:

```bash
brew install livekit
```

Download LiveKit Agents local model files:

```bash
cd livekit-agent
node src/worker.js download-files
```

The model files are cached under `~/.cache/huggingface`.

## Start Only LiveKit Server

```bash
bash infra/livekit-local/start-livekit-server.sh
```

## Start The Full Interview Assist Stack

```bash
bash infra/livekit-local/start-interview-assist-stack.sh
```

This starts all pieces needed for the in-app browser URL:

```text
http://127.0.0.1:3002/interview-assist
```

## Stop Local Services

Use Ctrl+C in each running terminal, or stop by port:

```bash
kill $(lsof -tiTCP:7880 -sTCP:LISTEN) 2>/dev/null || true
kill $(lsof -tiTCP:8000 -sTCP:LISTEN) 2>/dev/null || true
kill $(lsof -tiTCP:4200 -sTCP:LISTEN) 2>/dev/null || true
kill $(lsof -tiTCP:3002 -sTCP:LISTEN) 2>/dev/null || true
```

## Notes

- The API key/secret here are local dev credentials only.
- The frontend no longer uses browser `SpeechRecognition`; mic audio is published to LiveKit over WebRTC.
- The LiveKit Agent does server-side STT and turn detection, then calls the interview-assist LLM stream.
