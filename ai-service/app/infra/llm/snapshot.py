from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from app.core.config import observability
from app.observability import events
from app.observability.logger import logger


REPO_ROOT = Path(__file__).resolve().parents[4]


class SnapshotStore:
    def __init__(self, root: str | None = None):
        base = root or observability.snapshot_root
        self.root = (REPO_ROOT / base).resolve()

    def _trace_dir(self, trace_id: str) -> Path:
        path = self.root / trace_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def save_bundle(self, trace_id: str, llm_call_id: str, bundle: Dict[str, Any]) -> Path:
        trace_dir = self._trace_dir(trace_id)
        call_path = trace_dir / f"{llm_call_id}.debug_bundle.json"
        latest_path = trace_dir / "debug_bundle.json"
        serialized = json.dumps(bundle, ensure_ascii=False, indent=2)
        call_path.write_text(serialized, encoding="utf-8")
        latest_path.write_text(serialized, encoding="utf-8")
        logger.event(events.SNAPSHOT_SAVED, snapshot_path=str(latest_path), llm_call_id=llm_call_id)
        return latest_path

    def annotate_error(self, trace_id: str, error_message: str) -> Path | None:
        latest_path = self._trace_dir(trace_id) / "debug_bundle.json"
        if not latest_path.exists():
            return None
        payload = json.loads(latest_path.read_text(encoding="utf-8"))
        payload["error"] = error_message
        latest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return latest_path
