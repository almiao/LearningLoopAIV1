from __future__ import annotations

import io
import os
import threading
from functools import lru_cache
from typing import Any, Dict, Tuple


_MODEL_LOCK = threading.Lock()
_MODEL_READY = False


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _torch_dtype(torch_module: Any, dtype_name: str) -> Any:
    if not dtype_name:
        return None
    dtype = getattr(torch_module, dtype_name, None)
    if dtype is None:
        raise RuntimeError(f"Unsupported Qwen3-TTS dtype: {dtype_name}")
    return dtype


@lru_cache(maxsize=1)
def _load_qwen3_tts_model() -> Any:
    global _MODEL_READY
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as exc:
        raise RuntimeError(
            "Qwen3-TTS is not installed. Run `python3 -m pip install -r ai-service/requirements-tts-qwen3.txt`."
        ) from exc

    kwargs: Dict[str, Any] = {}
    device_map = _env("QWEN3_TTS_DEVICE_MAP", "auto")
    dtype_name = _env("QWEN3_TTS_DTYPE")
    attention = _env("QWEN3_TTS_ATTN_IMPLEMENTATION")
    if device_map:
        kwargs["device_map"] = device_map
    dtype = _torch_dtype(torch, dtype_name)
    if dtype is not None:
        kwargs["dtype"] = dtype
    if attention:
        kwargs["attn_implementation"] = attention

    model_id = _env("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    model = Qwen3TTSModel.from_pretrained(model_id, **kwargs)
    _MODEL_READY = True
    return model


def warmup_loopassist_tts() -> Dict[str, Any]:
    with _MODEL_LOCK:
        _load_qwen3_tts_model()
    return loopassist_tts_status()


def loopassist_tts_status() -> Dict[str, Any]:
    return {
        "provider": "qwen3-tts",
        "model": _env("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"),
        "speaker": _env("QWEN3_TTS_SPEAKER", "Uncle_Fu"),
        "language": _env("QWEN3_TTS_LANGUAGE", "Chinese"),
        "ready": _MODEL_READY,
    }


def synthesize_loopassist_tts(
    *,
    text: str,
    speaker: str = "",
    language: str = "",
    instruct: str = "",
) -> Tuple[bytes, Dict[str, Any]]:
    normalized_text = str(text or "").strip()
    if not normalized_text:
        raise ValueError("text is required.")

    try:
        import soundfile as sf
    except ImportError as exc:
        raise RuntimeError(
            "soundfile is not installed. Run `python3 -m pip install -r ai-service/requirements-tts-qwen3.txt`."
        ) from exc

    with _MODEL_LOCK:
        model = _load_qwen3_tts_model()
        active_language = language or _env("QWEN3_TTS_LANGUAGE", "Chinese")
        active_speaker = speaker or _env("QWEN3_TTS_SPEAKER", "Uncle_Fu")
        active_instruct = instruct or _env(
            "QWEN3_TTS_INSTRUCT",
            "像一位克制、专业、真实的技术面试官，语速自然，语气有追问感但不夸张。",
        )
        wavs, sample_rate = model.generate_custom_voice(
            text=normalized_text,
            language=active_language,
            speaker=active_speaker,
            instruct=active_instruct,
        )

    buffer = io.BytesIO()
    sf.write(buffer, wavs[0], sample_rate, format="WAV")
    return buffer.getvalue(), {
        "provider": "qwen3-tts",
        "model": _env("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"),
        "speaker": active_speaker,
        "language": active_language,
        "sampleRate": sample_rate,
    }
