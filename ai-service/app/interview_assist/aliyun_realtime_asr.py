from __future__ import annotations

import os
import queue
import ssl
import threading
from dataclasses import dataclass
from typing import Any, Dict, Optional

import aiohttp
import certifi
import dashscope
from dashscope.api_entities import websocket_request as dashscope_websocket_request
from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult


DEFAULT_MODEL = os.environ.get("ALIYUN_REALTIME_ASR_MODEL", "fun-asr-realtime")
DEFAULT_WS_URL = os.environ.get("ALIYUN_REALTIME_ASR_WS_URL", "wss://dashscope.aliyuncs.com/api-ws/v1/inference")
DEFAULT_SAMPLE_RATE = int(os.environ.get("ALIYUN_REALTIME_ASR_SAMPLE_RATE", "16000"))
DEFAULT_AUDIO_FORMAT = os.environ.get("ALIYUN_REALTIME_ASR_FORMAT", "pcm")
ALLOW_INSECURE_SSL = os.environ.get("ALIYUN_REALTIME_ASR_ALLOW_INSECURE_SSL", "").lower() in {"1", "true", "yes"}

_PATCHED_DASHSCOPE_SSL = False


def _patch_dashscope_websocket_ssl(cert_path: str) -> None:
    global _PATCHED_DASHSCOPE_SSL
    if _PATCHED_DASHSCOPE_SSL:
        return

    original_client_session = dashscope_websocket_request.aiohttp.ClientSession

    def patched_client_session(*args, **kwargs):
        if "connector" not in kwargs:
            if ALLOW_INSECURE_SSL:
                connector = aiohttp.TCPConnector(ssl=False)
            else:
                connector = aiohttp.TCPConnector(ssl=ssl.create_default_context(cafile=cert_path))
            kwargs["connector"] = connector
        return original_client_session(*args, **kwargs)

    dashscope_websocket_request.aiohttp.ClientSession = patched_client_session
    _PATCHED_DASHSCOPE_SSL = True


def configure_dashscope() -> None:
    cert_path = certifi.where()
    os.environ.setdefault("SSL_CERT_FILE", cert_path)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", cert_path)
    os.environ.setdefault("CURL_CA_BUNDLE", cert_path)
    _patch_dashscope_websocket_ssl(cert_path)
    dashscope.api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    dashscope.base_websocket_api_url = DEFAULT_WS_URL


@dataclass
class AliyunRealtimeEvent:
    event: str
    data: Dict[str, Any]


def sentence_text(sentence: Dict[str, Any]) -> str:
    if not sentence:
        return ""
    for key in ("text", "sentence", "transcript"):
        value = sentence.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


class Callback(RecognitionCallback):
    def __init__(self, output_queue: "queue.Queue[AliyunRealtimeEvent]"):
        self.output_queue = output_queue

    def on_open(self) -> None:
        self.output_queue.put(AliyunRealtimeEvent("asr_open", {}))

    def on_complete(self) -> None:
        self.output_queue.put(AliyunRealtimeEvent("asr_complete", {}))

    def on_close(self) -> None:
        self.output_queue.put(AliyunRealtimeEvent("asr_close", {}))

    def on_error(self, result: RecognitionResult) -> None:
        self.output_queue.put(
            AliyunRealtimeEvent(
                "asr_error",
                {
                    "code": result.code,
                    "message": result.message,
                    "requestId": result.get_request_id(),
                },
            )
        )

    def on_event(self, result: RecognitionResult) -> None:
        sentence = result.get_sentence()
        if isinstance(sentence, list):
            for item in sentence:
                self._publish_sentence(item, result)
        elif isinstance(sentence, dict):
            self._publish_sentence(sentence, result)

    def _publish_sentence(self, sentence: Dict[str, Any], result: RecognitionResult) -> None:
        text = sentence_text(sentence)
        if not text:
            return
        is_final = RecognitionResult.is_sentence_end(sentence)
        payload = {
            "text": text,
            "isFinal": is_final,
            "sentence": sentence,
            "requestId": result.get_request_id(),
        }
        self.output_queue.put(
            AliyunRealtimeEvent(
                "asr_final" if is_final else "asr_partial",
                payload,
            )
        )


class AliyunRealtimeRecognizer:
    def __init__(
        self,
        *,
        model: str = DEFAULT_MODEL,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        audio_format: str = DEFAULT_AUDIO_FORMAT,
    ):
        configure_dashscope()
        self.output_queue: "queue.Queue[AliyunRealtimeEvent]" = queue.Queue()
        self.callback = Callback(self.output_queue)
        self.recognition = Recognition(
            model=model,
            callback=self.callback,
            format=audio_format,
            sample_rate=sample_rate,
        )
        self._started = False
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(os.environ.get("DASHSCOPE_API_KEY", ""))

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self.recognition.start(
                semantic_punctuation_enabled=False,
                diarization_enabled=False,
            )
            self._started = True

    def send_audio(self, data: bytes) -> None:
        if not data:
            return
        self.recognition.send_audio_frame(data)

    def stop(self) -> None:
        with self._lock:
            if not self._started:
                return
            self.recognition.stop()
            self._started = False

    def poll_event(self, timeout: float = 0.05) -> Optional[AliyunRealtimeEvent]:
        try:
            return self.output_queue.get(timeout=timeout)
        except queue.Empty:
            return None
