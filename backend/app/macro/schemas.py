"""
매크로 섹터 로테이션 — 핵심 Pydantic 스키마

Event         : 감지된 거시 이벤트 (이름·강도·신뢰도·지속성)
SectorSignal  : 섹터별 최종 신호 (netting 후)
MappingRule   : 이벤트 → 섹터 매핑 규칙
MacroPosition : 매크로 시스템이 보유한 포지션
MacroOrder    : 매크로 시스템이 제출한 주문
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class TradeMode(str, Enum):
    PAPER = "paper"   # 모의(로그만)
    LIVE  = "live"    # 실거래


class EventCategory(str, Enum):
    MARKET = "market"   # 시장 지표
    RISK   = "risk"     # 리스크 이벤트
    MACRO  = "macro"    # 거시 경제
    POLICY = "policy"   # 정책


class SignalDirection(str, Enum):
    LONG    = "long"    # 매수
    SHORT   = "short"   # 공매도(미지원 시 회피)
    NEUTRAL = "neutral" # 관망


# ── 이벤트 ────────────────────────────────────────────────────────────────────

class MacroEvent(BaseModel):
    event_id:    str              # oil_rise, geopolitical ...
    name:        str
    category:    EventCategory
    magnitude:   float = Field(ge=0, le=1)   # 강도
    confidence:  float = Field(ge=0, le=1)   # 신뢰도
    persistence: float = Field(ge=0, le=1)   # 지속성
    score:       float = Field(ge=0, le=1)   # 종합 = f(m,c,p)
    detected_at: datetime
    evidence:    list[str] = []              # 근거 텍스트


# ── 매핑 규칙 ─────────────────────────────────────────────────────────────────

class MappingRule(BaseModel):
    event:    str
    sector:   str
    weight:   float  # +: 수혜, -: 피해
    rationale: str


# ── 섹터 신호 ─────────────────────────────────────────────────────────────────

class EventContribution(BaseModel):
    event_id:    str
    event_name:  str
    weight:      float
    event_score: float
    contribution: float   # weight × event_score


class SectorSignal(BaseModel):
    sector_id:    str
    sector_name:  str
    net_score:    float               # netting 후 최종 점수 (-1 ~ +1)
    direction:    SignalDirection
    contributions: list[EventContribution] = []
    stocks:        list[str] = []    # 선정된 종목코드
    computed_at:  datetime


# ── 포지션 ────────────────────────────────────────────────────────────────────

class MacroPosition(BaseModel):
    stock_code:    str
    stock_name:    str
    sector_id:     str
    quantity:      int
    avg_buy_price: float
    current_price: float
    return_pct:    float
    opened_at:     datetime
    events:        list[str] = []   # 진입 근거 이벤트들


# ── 주문 ──────────────────────────────────────────────────────────────────────

class MacroOrder(BaseModel):
    order_id:   str
    stock_code: str
    stock_name: str
    action:     str    # BUY / SELL
    quantity:   int
    price:      int
    mode:       TradeMode
    reason:     str
    created_at: datetime
    filled:     bool = False


# ── 파이프라인 실행 결과 ──────────────────────────────────────────────────────

class PipelineResult(BaseModel):
    run_at:       datetime
    mode:         TradeMode
    events:       list[MacroEvent]
    sector_signals: list[SectorSignal]
    orders_placed: list[MacroOrder]
    log:          list[str] = []
