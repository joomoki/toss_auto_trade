"""
이벤트 → 섹터 매핑 + 신호 정규화 (netting)

1. YAML에서 매핑 룰 로드
2. 감지된 이벤트 × 룰 → 섹터별 기여도 합산
3. 순값(net) 기준 섹터 랭킹 반환
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from pathlib import Path

import yaml

from app.macro.schemas import (
    EventContribution, MacroEvent, MappingRule, SectorSignal, SignalDirection,
)

logger = logging.getLogger(__name__)

_MAP_PATH = Path(__file__).parent.parent.parent / "config" / "event_sector_map.yaml"
_LOADED_CFG: dict | None = None


def load_map_config() -> dict:
    global _LOADED_CFG
    if _LOADED_CFG is None:
        with open(_MAP_PATH, encoding="utf-8") as f:
            _LOADED_CFG = yaml.safe_load(f)
    return _LOADED_CFG


def get_mapping_rules() -> list[MappingRule]:
    cfg = load_map_config()
    return [MappingRule(**m) for m in cfg.get("mappings", [])]


def get_sector_stocks(sector_id: str) -> list[dict]:
    cfg = load_map_config()
    sector = cfg.get("sectors", {}).get(sector_id, {})
    return sector.get("representative_stocks", [])


# ── 핵심 정규화 ────────────────────────────────────────────────────────────────

def compute_sector_signals(events: list[MacroEvent]) -> list[SectorSignal]:
    """
    각 섹터의 최종 점수 = Σ(이벤트.score × 매핑.weight)
    상충 신호(+/-)는 자동 상쇄(netting).
    """
    cfg   = load_map_config()
    rules = get_mapping_rules()
    sectors_cfg = cfg.get("sectors", {})

    event_by_id = {e.event_id: e for e in events}

    # 섹터별 기여도 누적
    sector_contributions: dict[str, list[EventContribution]] = {
        sid: [] for sid in sectors_cfg
    }

    for rule in rules:
        ev = event_by_id.get(rule.event)
        if ev is None:
            continue
        contrib = EventContribution(
            event_id=ev.event_id,
            event_name=ev.name,
            weight=rule.weight,
            event_score=ev.score,
            contribution=round(rule.weight * ev.score, 4),
        )
        sector_contributions.setdefault(rule.sector, []).append(contrib)

    signals: list[SectorSignal] = []
    now = datetime.now(timezone.utc)

    for sid, contribs in sector_contributions.items():
        if not contribs:
            continue
        net = sum(c.contribution for c in contribs)
        net = max(-1.0, min(1.0, net))  # 클램프

        # 방향 결정
        if net >= 0.15:
            direction = SignalDirection.LONG
        elif net <= -0.15:
            direction = SignalDirection.SHORT
        else:
            direction = SignalDirection.NEUTRAL

        name = sectors_cfg.get(sid, {}).get("name", sid)
        signals.append(SectorSignal(
            sector_id=sid,
            sector_name=name,
            net_score=round(net, 4),
            direction=direction,
            contributions=contribs,
            computed_at=now,
        ))

    # 순점수 내림차순 정렬
    signals.sort(key=lambda s: s.net_score, reverse=True)
    return signals


def explain_signal(signal: SectorSignal) -> list[str]:
    """섹터 신호 근거 로그 생성"""
    lines = [
        f"[{signal.sector_name}] 순점수={signal.net_score:+.3f} → {signal.direction.value.upper()}"
    ]
    for c in sorted(signal.contributions, key=lambda x: abs(x.contribution), reverse=True):
        sign = "▲" if c.contribution >= 0 else "▼"
        lines.append(
            f"  {sign} {c.event_name}: {c.event_score:.2f} × {c.weight:+.2f} = {c.contribution:+.3f}"
        )
    return lines
