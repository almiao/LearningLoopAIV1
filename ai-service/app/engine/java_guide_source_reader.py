from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_JAVA_GUIDE_ROOT = os.environ.get("LLAI_JAVAGUIDE_ROOT", "/Users/lee/IdeaProjects/JavaGuide")


def _safe_snippet(text: str, limit: int = 900) -> str:
    normalized = " ".join(str(text or "").split()).strip()
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: max(0, limit - 1)].strip()}…"


def load_java_guide_source_snippets(sources: List[Dict[str, Any]] | None = None, limit: int = 2) -> List[Dict[str, Any]]:
    selected = (sources or [])[:limit]
    loaded: List[Dict[str, Any]] = []
    for source in selected:
        source_path = Path(DEFAULT_JAVA_GUIDE_ROOT) / str(source.get("path", ""))
        snippet = ""
        try:
            raw = source_path.read_text(encoding="utf-8")
            snippet = _safe_snippet(raw, 900)
        except Exception:
            snippet = ""
        loaded.append(
            {
                "path": source.get("path", ""),
                "title": source.get("title", ""),
                "url": source.get("url", ""),
                "snippet": snippet,
            }
        )
    return [item for item in loaded if item.get("title")]
