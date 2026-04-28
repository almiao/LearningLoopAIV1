# Local LiveKit Server

This directory contains the local self-hosted LiveKit development setup for the interview-assist voice path.

## What This Runs

- `livekit-server` on `ws://127.0.0.1:7880`
- local development API credentials:
  - `LIVEKIT_API_KEY=devkey`
  - `LIVEKIT_API_SECRET=secret`
- `livekit-agent` bridge server on `http://127.0.0.1:4200`
- AI service on `http://127.0.0.1:8000`
- frontend preview on `http://127.0.0.1:3002`

The local LiveKit server is started in `--dev` mode and is not intended for production.

## Repository Default Behavior

The main project split-services launcher now auto-detects whether LiveKit is configured.

- If `LIVEKIT_URL`/`LIVEKIT_WS_URL` plus `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are already set, it uses that configured LiveKit deployment.
- If not, it automatically downloads a local `livekit-server` binary into `.tools/livekit-runtime/`, starts it on `ws://127.0.0.1:7880`, and injects the local dev credentials at runtime.

This means `./start-services.ps1` on Windows and the shared Node split-services entrypoint can bring up a local LiveKit-backed development stack without hand-editing `.env.local`.

## One-Time Setup

Install the server binary:

```bash
brew install livekit
```

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
- The LiveKit bridge relays browser audio to the interview-assist realtime service and returns structured events.
