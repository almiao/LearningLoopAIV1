from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from app.loopassist.tts import (
    loopassist_tts_status,
    synthesize_loopassist_tts,
    warmup_loopassist_tts,
)


class LoopAssistTtsRequest(BaseModel):
    text: str
    speaker: str = ""
    language: str = ""
    instruct: str = ""


app = FastAPI(title="LoopAssist Local TTS Worker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3002",
        "http://localhost:3000",
        "http://localhost:3002",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "tts": loopassist_tts_status(),
    }


@app.post("/api/warmup")
def warmup() -> Dict[str, Any]:
    try:
        return {
            "ok": True,
            "tts": warmup_loopassist_tts(),
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/tts")
def tts(payload: LoopAssistTtsRequest) -> Response:
    try:
        audio, metadata = synthesize_loopassist_tts(
            text=payload.text,
            speaker=payload.speaker,
            language=payload.language,
            instruct=payload.instruct,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "x-loopassist-tts-provider": str(metadata.get("provider") or "qwen3-tts"),
            "x-loopassist-tts-speaker": str(metadata.get("speaker") or ""),
        },
    )
