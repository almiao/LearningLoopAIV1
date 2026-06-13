from __future__ import annotations

import json
import re
from typing import Any, Dict


_PROVIDER_HTTP_ERROR_RE = re.compile(r"Provider request failed:\s*(\d+)\s*(.*)", re.DOTALL)


def _extract_provider_message(raw_body: str = "") -> str:
    text = str(raw_body or "").strip()
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    error_payload = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error_payload, dict):
        return str(error_payload.get("message") or "").strip()
    return text


def build_public_error_payload(error: Any) -> Dict[str, Any]:
    debug_message = str(error or "").strip() or "Unexpected backend error."
    lowered = debug_message.lower()
    payload: Dict[str, Any] = {
        "code": "internal_error",
        "message": "后台处理失败了，请稍后重试。",
        "retryable": True,
        "source": "ai-service",
        "statusCode": 503,
        "debugMessage": debug_message,
    }

    provider_match = _PROVIDER_HTTP_ERROR_RE.match(debug_message)
    if provider_match:
        upstream_status = int(provider_match.group(1))
        provider_message = _extract_provider_message(provider_match.group(2))
        retryable = upstream_status >= 500 or upstream_status in {408, 409, 423, 425, 429}
        payload.update({
            "code": "llm_provider_http_error",
            "message": (
                "AI 训练服务当前不可用，请检查模型服务配置或配额后重试。"
                if 400 <= upstream_status < 500
                else "AI 训练服务暂时不可用，请稍后重试。"
            ),
            "retryable": retryable,
            "source": "llm-provider",
            "statusCode": 503,
            "upstreamStatusCode": upstream_status,
            "providerMessage": provider_message or debug_message,
        })
        return payload

    if "timed out" in lowered:
        payload.update({
            "code": "llm_timeout",
            "message": "AI 训练服务响应超时了，请稍后重试。",
            "retryable": True,
            "source": "llm-provider",
        })
        return payload

    if "not configured" in lowered:
        payload.update({
            "code": "llm_not_configured",
            "message": "AI 训练服务尚未配置完成，请联系维护者处理。",
            "retryable": False,
            "source": "ai-service",
        })
        return payload

    return payload

