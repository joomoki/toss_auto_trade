"""
자동매매 사이클 로그 버퍼

run() 실행 중 주요 단계를 메모리에 보관하고 /api/v1/auto-trade/cycle-log 로 제공.
최근 MAX_CYCLES개 사이클, 사이클당 MAX_LINES줄 제한.
"""
from __future__ import annotations

import uuid
from collections import deque
from datetime import datetime
from typing import Optional

MAX_CYCLES = 10
MAX_LINES  = 300

_cycles: deque[dict] = deque(maxlen=MAX_CYCLES)
_current: Optional[dict] = None


def _ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def start_cycle() -> None:
    global _current
    if _current:
        _end_orphan()
    _current = {
        "id":         str(uuid.uuid4())[:8],
        "started_at": datetime.now().isoformat(),
        "ended_at":   None,
        "status":     "running",
        "lines":      [],
        "summary":    None,
    }


def log(level: str, step: str, msg: str, data: Optional[dict] = None) -> None:
    """
    level : "info" | "warn" | "error" | "success"
    step  : "start" | "collect" | "exit" | "score" | "rank" | "order" | "end"
    """
    if _current is None:
        return
    lines: list = _current["lines"]
    if len(lines) >= MAX_LINES:
        return
    lines.append({"ts": _ts(), "level": level, "step": step, "msg": msg, "data": data})


def end_cycle(summary: Optional[dict] = None) -> None:
    global _current
    if _current is None:
        return
    _current["ended_at"] = datetime.now().isoformat()
    _current["status"]   = "done"
    _current["summary"]  = summary
    _cycles.appendleft(dict(_current))
    _current = None


def _end_orphan() -> None:
    global _current
    if _current:
        _current["ended_at"] = datetime.now().isoformat()
        _current["status"]   = "done"
        _cycles.appendleft(dict(_current))
        _current = None


def get_cycles() -> list[dict]:
    """최신 사이클 먼저. 실행 중인 사이클은 맨 앞에 포함."""
    result: list[dict] = []
    if _current:
        result.append({**_current, "status": "running"})
    result.extend(_cycles)
    return result
