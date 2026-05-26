from __future__ import annotations

import asyncio
import io
import json
import os
import ssl
import threading
import time
import uuid
from functools import lru_cache
from typing import Any, Dict, Tuple

import websockets


_ALIYUN_SUCCESS_STATUS = 20000000
_ALIYUN_COSYVOICE_NAMESPACE = "FlowingSpeechSynthesizer"
_ALIYUN_STANDARD_NAMESPACE = "SpeechSynthesizer"
_ALIYUN_ERROR_HINTS = {
    40000010: (
        "Alibaba Cloud returned 40000010. Flowing text-to-speech is commercial-only; "
        "enable Intelligent Speech Interaction commercial TTS or check billing."
    ),
}
_MODEL_LOCK = threading.Lock()
_MODEL_READY = False
_ALIYUN_TOKEN_LOCK = threading.Lock()
_ALIYUN_TOKEN = ""
_ALIYUN_TOKEN_EXPIRE_AT = 0


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_int(name: str, default: int) -> int:
    value = _env(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError(f"Environment variable {name} must be an integer.") from exc


def _first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = _env(name)
        if value:
            return value
    return default


def _aliyun_app_key() -> str:
    return _first_env("ALIYUN_ISI_APP_KEY", "ALIYUN_TTS_APP_KEY", "ALIYUN_NLS_APP_KEY", "ALIYUN_APP_KEY")


def _aliyun_tts_configured() -> bool:
    return bool(_env("ALIYUN_AK_ID") and _env("ALIYUN_AK_SECRET") and _aliyun_app_key())


def _normalized_tts_provider() -> str:
    raw = _env("LOOPASSIST_TTS_PROVIDER", "auto").lower()
    if raw in {"", "auto"}:
        return "aliyun-standard" if _aliyun_tts_configured() else "qwen3-tts"
    if raw in {"aliyun", "aliyun-standard", "aliyun-speech", "aliyun-tts", "speech-synthesizer"}:
        return "aliyun-standard"
    if raw in {"aliyun-cosyvoice", "cosyvoice", "flowing-speech-synthesizer"}:
        return "aliyun-cosyvoice"
    if raw in {"qwen3", "qwen3-tts"}:
        return "qwen3-tts"
    raise RuntimeError(f"Unsupported LOOPASSIST_TTS_PROVIDER: {raw}")


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


def _fetch_aliyun_token() -> Tuple[str, int]:
    try:
        from aliyunsdkcore.client import AcsClient
        from aliyunsdkcore.request import CommonRequest
    except ImportError as exc:
        raise RuntimeError(
            "Alibaba Cloud SDK is not installed. Run `python3 -m pip install -r ai-service/requirements-tts-aliyun.txt`."
        ) from exc

    access_key_id = _env("ALIYUN_AK_ID")
    access_key_secret = _env("ALIYUN_AK_SECRET")
    if not access_key_id or not access_key_secret:
        raise RuntimeError("ALIYUN_AK_ID and ALIYUN_AK_SECRET are required for Alibaba Cloud TTS.")

    client = AcsClient(access_key_id, access_key_secret, _env("ALIYUN_ISI_REGION_ID", "cn-shanghai"))
    request = CommonRequest()
    request.set_method("POST")
    request.set_domain(_env("ALIYUN_ISI_TOKEN_DOMAIN", "nls-meta.cn-shanghai.aliyuncs.com"))
    request.set_version("2019-02-28")
    request.set_action_name("CreateToken")

    try:
        response = client.do_action_with_exception(request)
    except Exception as exc:  # pragma: no cover - SDK exceptions vary by runtime.
        raise RuntimeError(f"Failed to obtain Alibaba Cloud TTS token: {exc}") from exc

    payload = json.loads(response.decode("utf-8") if isinstance(response, (bytes, bytearray)) else response)
    token = str(((payload.get("Token") or {}).get("Id") or "")).strip()
    expire_time = int(((payload.get("Token") or {}).get("ExpireTime") or 0))
    if not token or not expire_time:
        raise RuntimeError("Alibaba Cloud TTS token response did not include Token.Id / Token.ExpireTime.")
    return token, expire_time


def _get_aliyun_token() -> Tuple[str, int]:
    global _ALIYUN_TOKEN, _ALIYUN_TOKEN_EXPIRE_AT
    now = int(time.time())
    with _ALIYUN_TOKEN_LOCK:
        if _ALIYUN_TOKEN and _ALIYUN_TOKEN_EXPIRE_AT - 60 > now:
            return _ALIYUN_TOKEN, _ALIYUN_TOKEN_EXPIRE_AT
        _ALIYUN_TOKEN, _ALIYUN_TOKEN_EXPIRE_AT = _fetch_aliyun_token()
        return _ALIYUN_TOKEN, _ALIYUN_TOKEN_EXPIRE_AT


def _aliyun_header(task_id: str, name: str, namespace: str) -> Dict[str, Any]:
    return {
        "message_id": uuid.uuid4().hex,
        "task_id": task_id,
        "namespace": namespace,
        "name": name,
        "appkey": _aliyun_app_key(),
    }


def _aliyun_error_message(event_name: str, status: int, status_message: str) -> str:
    detail = status_message or _ALIYUN_ERROR_HINTS.get(status, "")
    suffix = f": {detail}" if detail else ""
    return f"Alibaba Cloud TTS event {event_name or 'unknown'} failed: {status}{suffix}"


def _aliyun_ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


async def _receive_aliyun_audio(
    websocket: Any,
    *,
    timeout_seconds: int,
    send_after_started: Any = None,
) -> list[bytes]:
    audio_chunks: list[bytes] = []
    started = False

    while True:
        try:
            message = await asyncio.wait_for(websocket.recv(), timeout=timeout_seconds)
        except TimeoutError as exc:
            raise RuntimeError("Alibaba Cloud TTS timed out while waiting for audio.") from exc

        if isinstance(message, (bytes, bytearray)):
            audio_chunks.append(bytes(message))
            continue

        try:
            event = json.loads(message)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Alibaba Cloud TTS returned a non-JSON text frame.") from exc

        header = event.get("header") or {}
        status = int(header.get("status") or _ALIYUN_SUCCESS_STATUS)
        status_message = str(header.get("status_message") or "")
        event_name = str(header.get("name") or "")
        if status != _ALIYUN_SUCCESS_STATUS:
            raise RuntimeError(_aliyun_error_message(event_name, status, status_message))

        if event_name == "SynthesisStarted" and send_after_started is not None and not started:
            await send_after_started()
            started = True
            continue

        if event_name == "SynthesisCompleted":
            return audio_chunks


async def _synthesize_aliyun_standard_async(
    *,
    text: str,
    speaker: str = "",
) -> Tuple[bytes, Dict[str, Any]]:
    token, token_expire_at = _get_aliyun_token()
    app_key = _aliyun_app_key()
    if not app_key:
        raise RuntimeError("ALIYUN_ISI_APP_KEY (or ALIYUN_TTS_APP_KEY / ALIYUN_NLS_APP_KEY) is required for Alibaba Cloud TTS.")

    task_id = uuid.uuid4().hex
    uri = _first_env(
        "ALIYUN_STANDARD_TTS_WS_URL",
        "ALIYUN_TTS_WS_URL",
        default="wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1",
    )
    active_voice = speaker or _env("ALIYUN_STANDARD_TTS_VOICE", "xiaoyun")
    active_format = _env("ALIYUN_STANDARD_TTS_FORMAT", "wav")
    sample_rate = _env_int("ALIYUN_STANDARD_TTS_SAMPLE_RATE", 16000)
    volume = _env_int("ALIYUN_STANDARD_TTS_VOLUME", 50)
    speech_rate = _env_int("ALIYUN_STANDARD_TTS_SPEECH_RATE", 0)
    pitch_rate = _env_int("ALIYUN_STANDARD_TTS_PITCH_RATE", 0)
    enable_subtitle = _env("ALIYUN_STANDARD_TTS_ENABLE_SUBTITLE", "false").lower() == "true"

    command = {
        "header": _aliyun_header(task_id, "StartSynthesis", _ALIYUN_STANDARD_NAMESPACE),
        "payload": {
            "text": text,
            "voice": active_voice,
            "format": active_format,
            "sample_rate": sample_rate,
            "volume": volume,
            "speech_rate": speech_rate,
            "pitch_rate": pitch_rate,
            "enable_subtitle": enable_subtitle,
        },
    }

    async with websockets.connect(
        uri,
        additional_headers={"X-NLS-Token": token},
        ssl=_aliyun_ssl_context(),
        max_size=None,
        ping_interval=20,
        ping_timeout=20,
    ) as websocket:
        await websocket.send(json.dumps(command, ensure_ascii=False))
        audio_chunks = await _receive_aliyun_audio(websocket, timeout_seconds=60)

    audio = b"".join(audio_chunks)
    if not audio:
        raise RuntimeError("Alibaba Cloud TTS completed without returning audio frames.")

    return audio, {
        "provider": "aliyun-standard",
        "voice": active_voice,
        "speaker": active_voice,
        "format": active_format,
        "sampleRate": sample_rate,
        "tokenExpireTime": token_expire_at,
    }


async def _synthesize_aliyun_cosyvoice_async(
    *,
    text: str,
    speaker: str = "",
) -> Tuple[bytes, Dict[str, Any]]:
    token, token_expire_at = _get_aliyun_token()
    app_key = _aliyun_app_key()
    if not app_key:
        raise RuntimeError("ALIYUN_ISI_APP_KEY (or ALIYUN_TTS_APP_KEY / ALIYUN_NLS_APP_KEY) is required for Alibaba Cloud TTS.")

    task_id = uuid.uuid4().hex
    uri = _env("ALIYUN_COSYVOICE_WS_URL", "wss://nls-gateway-cn-beijing.aliyuncs.com/ws/v1")
    active_voice = speaker or _env("ALIYUN_COSYVOICE_VOICE", "longxiaochun_v2")
    active_format = _env("ALIYUN_COSYVOICE_FORMAT", "wav")
    sample_rate = _env_int("ALIYUN_COSYVOICE_SAMPLE_RATE", 16000)
    volume = _env_int("ALIYUN_COSYVOICE_VOLUME", 50)
    speech_rate = _env_int("ALIYUN_COSYVOICE_SPEECH_RATE", 0)
    pitch_rate = _env_int("ALIYUN_COSYVOICE_PITCH_RATE", 0)
    enable_ssml = _env("ALIYUN_COSYVOICE_ENABLE_SSML", "false").lower() == "true"

    start_command = {
        "header": _aliyun_header(task_id, "StartSynthesis", _ALIYUN_COSYVOICE_NAMESPACE),
        "payload": {
            "voice": active_voice,
            "format": active_format,
            "sample_rate": sample_rate,
            "volume": volume,
            "speech_rate": speech_rate,
            "pitch_rate": pitch_rate,
            "enable_ssml": enable_ssml,
        },
    }
    run_command = {
        "header": _aliyun_header(task_id, "RunSynthesis", _ALIYUN_COSYVOICE_NAMESPACE),
        "payload": {
            "text": text,
        },
    }
    stop_command = {
        "header": _aliyun_header(task_id, "StopSynthesis", _ALIYUN_COSYVOICE_NAMESPACE),
    }

    async with websockets.connect(
        uri,
        additional_headers={"X-NLS-Token": token},
        ssl=_aliyun_ssl_context(),
        max_size=None,
        ping_interval=20,
        ping_timeout=20,
    ) as websocket:
        await websocket.send(json.dumps(start_command, ensure_ascii=False))
        async def send_stream_text() -> None:
            await websocket.send(json.dumps(run_command, ensure_ascii=False))
            await websocket.send(json.dumps(stop_command, ensure_ascii=False))

        audio_chunks = await _receive_aliyun_audio(
            websocket,
            timeout_seconds=60,
            send_after_started=send_stream_text,
        )

    audio = b"".join(audio_chunks)
    if not audio:
        raise RuntimeError("Alibaba Cloud TTS completed without returning audio frames.")

    return audio, {
        "provider": "aliyun-cosyvoice",
        "voice": active_voice,
        "speaker": active_voice,
        "format": active_format,
        "sampleRate": sample_rate,
        "tokenExpireTime": token_expire_at,
    }


def _synthesize_qwen3_tts(
    *,
    text: str,
    speaker: str = "",
    language: str = "",
    instruct: str = "",
) -> Tuple[bytes, Dict[str, Any]]:
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
            text=text,
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


def warmup_loopassist_tts() -> Dict[str, Any]:
    provider = _normalized_tts_provider()
    if provider in {"aliyun-standard", "aliyun-cosyvoice"}:
        _get_aliyun_token()
        return loopassist_tts_status()

    with _MODEL_LOCK:
        _load_qwen3_tts_model()
    return loopassist_tts_status()


def loopassist_tts_status() -> Dict[str, Any]:
    provider = _normalized_tts_provider()
    if provider == "aliyun-standard":
        return {
            "provider": "aliyun-standard",
            "voice": _env("ALIYUN_STANDARD_TTS_VOICE", "xiaoyun"),
            "format": _env("ALIYUN_STANDARD_TTS_FORMAT", "wav"),
            "sampleRate": _env_int("ALIYUN_STANDARD_TTS_SAMPLE_RATE", 16000),
            "appKeyConfigured": bool(_aliyun_app_key()),
            "endpoint": _first_env(
                "ALIYUN_STANDARD_TTS_WS_URL",
                "ALIYUN_TTS_WS_URL",
                default="wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1",
            ),
            "ready": _aliyun_tts_configured(),
            "tokenCached": bool(_ALIYUN_TOKEN and _ALIYUN_TOKEN_EXPIRE_AT > int(time.time())),
        }

    if provider == "aliyun-cosyvoice":
        return {
            "provider": "aliyun-cosyvoice",
            "voice": _env("ALIYUN_COSYVOICE_VOICE", "longxiaochun_v2"),
            "format": _env("ALIYUN_COSYVOICE_FORMAT", "wav"),
            "sampleRate": _env_int("ALIYUN_COSYVOICE_SAMPLE_RATE", 16000),
            "appKeyConfigured": bool(_aliyun_app_key()),
            "endpoint": _env("ALIYUN_COSYVOICE_WS_URL", "wss://nls-gateway-cn-beijing.aliyuncs.com/ws/v1"),
            "ready": _aliyun_tts_configured(),
            "tokenCached": bool(_ALIYUN_TOKEN and _ALIYUN_TOKEN_EXPIRE_AT > int(time.time())),
        }

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

    provider = _normalized_tts_provider()
    if provider == "aliyun-standard":
        return asyncio.run(
            _synthesize_aliyun_standard_async(
                text=normalized_text,
                speaker=speaker,
            )
        )

    if provider == "aliyun-cosyvoice":
        return asyncio.run(
            _synthesize_aliyun_cosyvoice_async(
                text=normalized_text,
                speaker=speaker,
            )
        )

    return _synthesize_qwen3_tts(
        text=normalized_text,
        speaker=speaker,
        language=language,
        instruct=instruct,
    )
