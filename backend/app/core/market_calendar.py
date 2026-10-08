"""
KRX 거래일 달력.

holidays 패키지의 XKRX(한국거래소) 휴장일 달력을 사용한다.
설·추석·대체공휴일·선거일·노동절·연말휴장일(12/31)까지 포함.
달력에 없는 임시 휴장일은 .env 의 MARKET_EXTRA_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD 로 추가.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from functools import lru_cache

import pytz

from app.core.config import settings

logger = logging.getLogger(__name__)

SEOUL_TZ = pytz.timezone("Asia/Seoul")


@lru_cache(maxsize=8)
def _krx_holidays(year: int) -> frozenset[date]:
    days: set[date] = set()
    try:
        import holidays
        days.update(holidays.financial_holidays("XKRX", years=year).keys())
    except Exception as e:
        logger.warning(f"[거래일달력] KRX 휴장일 로드 실패 — 주말만 휴장 처리: {e}")
    for raw in (settings.market_extra_holidays or "").split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            d = date.fromisoformat(raw)
        except ValueError:
            logger.warning(f"[거래일달력] MARKET_EXTRA_HOLIDAYS 형식 오류 무시: {raw!r}")
            continue
        if d.year == year:
            days.add(d)
    return frozenset(days)


def today_kst() -> date:
    return datetime.now(SEOUL_TZ).date()


def is_trading_day(d: date | None = None) -> bool:
    """KRX 정규장이 열리는 날이면 True (주말·휴장일 False)."""
    d = d or today_kst()
    if d.weekday() >= 5:
        return False
    return d not in _krx_holidays(d.year)


def business_days_ago(d: date, n: int) -> date:
    """d 기준 n 거래일 전 날짜."""
    cur = d
    remaining = n
    while remaining > 0:
        cur -= timedelta(days=1)
        if is_trading_day(cur):
            remaining -= 1
    return cur
