"""
수급 분석 서비스

데이터 소스:
- 네이버 금융  : KOSPI/KOSDAQ 지수 (실시간, 무인증) — 1분 캐시 (장중)
- yfinance    : 지수 폴백 (네이버 실패 시)
- pykrx       : 외국인/기관 순매수 — KRX 로그인(KRX_ID/KRX_PW) 필요, 현재 미설정
                 → available=False 로 graceful degradation

pykrx 호출은 블로킹이므로 asyncio.run_in_executor 로 스레드 풀에서 실행.
지수 캐시: 장중(09:00-15:30 평일) 60초, 장외 300초.
수급 캐시: 1800초(30분).
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import date, datetime as _dt, time as _time, timedelta
from typing import Optional

import pytz as _pytz

logger = logging.getLogger(__name__)

_SEOUL_TZ = _pytz.timezone("Asia/Seoul")
_CACHE: dict[str, tuple[float, object]] = {}
_CACHE_TTL = 1800  # 수급 데이터 30분


def _index_cache_ttl() -> int:
    """장중(평일 09:00~15:30) 30초, 장외 300초"""
    now = _dt.now(_SEOUL_TZ)
    if now.weekday() < 5 and _time(9, 0) <= now.time() <= _time(15, 30):
        return 30
    return 300


def _cache_get(key: str) -> Optional[object]:
    if key in _CACHE:
        ts, data = _CACHE[key]
        if time.time() - ts < _CACHE_TTL:
            return data
    return None


def _cache_set(key: str, data: object) -> None:
    _CACHE[key] = (time.time(), data)


def _score_from_net(foreign_net: float, institution_net: float) -> float:
    """외국인 0.6 + 기관 0.4 가중합 → tanh 정규화 → 0~1 (레거시 폴백용)"""
    combined = foreign_net * 0.6 + institution_net * 0.4
    normalized = math.tanh(combined / 1_000_000_000)
    return round(max(0.0, min(1.0, (normalized + 1) / 2)), 4)


def _score_enhanced(
    foreign_net: float,
    institution_net: float,
    individual_net: float,
    daily: list[dict],
) -> float:
    """
    강화 수급 점수 (Phase 3).

    구성:
      - 외국인(0.55) + 기관(0.35) − 개인 역지표(0.10) → tanh 정규화 → base_score
      - 지속성 보너스 ±0.05:
          최근 3일 외국인+기관 순매수 합 > 이전 평균의 1.2×3배 → +0.05 (가속 매집)
          최근 3일 모두 음수이고 이전도 음수 → −0.05 (지속 매도)

    개인 순매수는 역지표:
      개인이 대거 매수할수록 단기 고점 가능성 → 점수 하향 압력.
    """
    combined = foreign_net * 0.55 + institution_net * 0.35 - individual_net * 0.10
    normalized = math.tanh(combined / 1_000_000_000)
    base_score = max(0.0, min(1.0, (normalized + 1) / 2))

    persist_bonus = 0.0
    if len(daily) >= 4:
        recent_sum = sum(
            d.get("foreign_net", 0) + d.get("institution_net", 0)
            for d in daily[-3:]
        )
        n_earlier = len(daily) - 3
        earlier_avg = sum(
            d.get("foreign_net", 0) + d.get("institution_net", 0)
            for d in daily[:-3]
        ) / max(1, n_earlier)
        if earlier_avg > 0 and recent_sum > earlier_avg * 1.2 * 3:
            persist_bonus = 0.05   # 최근 가속 매집
        elif recent_sum < 0 and earlier_avg < 0:
            persist_bonus = -0.05  # 지속 매도

    return round(max(0.0, min(1.0, base_score + persist_bonus)), 4)


# ── pykrx: 종목별 수급 ───────────────────────────────────────────────────────

def _set_krx_env() -> None:
    """pykrx 호출 전 KRX 인증 환경변수 설정 (settings에서 읽어서 os.environ에 주입)"""
    import os
    from app.core.config import settings
    if settings.krx_id and "KRX_ID" not in os.environ:
        os.environ["KRX_ID"] = settings.krx_id
    if settings.krx_pw and "KRX_PW" not in os.environ:
        os.environ["KRX_PW"] = settings.krx_pw


def _supply_sync(stock_code: str, days: int) -> dict:
    """외국인/기관 순매수 — pykrx KRX 인증 (KRX_ID/KRX_PW 설정 시 동작)"""
    key = f"supply_{stock_code}_{days}"
    cached = _cache_get(key)
    if cached is not None:
        return cached  # type: ignore

    neutral = {
        "stock_code": stock_code, "foreign_net": 0, "institution_net": 0,
        "supply_score": 0.5, "days": days, "daily": [], "available": False,
    }

    try:
        _set_krx_env()
        from pykrx import stock as krx
        todate   = date.today().strftime("%Y%m%d")
        fromdate = (date.today() - timedelta(days=days * 3 + 10)).strftime("%Y%m%d")

        df = krx.get_market_trading_value_by_date(fromdate, todate, stock_code)
        if df is None or df.empty:
            logger.warning(
                f"pykrx 수급 데이터 없음 [{stock_code}]: KRX 로그인(KRX_ID/KRX_PW) 필요"
            )
            _cache_set(key, neutral)
            return neutral

        df = df.tail(days)

        foreign_col     = next((c for c in df.columns if "외국인" in c), None)
        institution_col = next((c for c in df.columns if "기관" in c and "합계" in c), None)
        individual_col  = next((c for c in df.columns if "개인" in c), None)

        foreign_net     = float(df[foreign_col].sum())     if foreign_col     else 0.0
        institution_net = float(df[institution_col].sum()) if institution_col else 0.0
        individual_net  = float(df[individual_col].sum())  if individual_col  else 0.0

        daily = []
        for dt_idx, row in df.iterrows():
            daily.append({
                "date":            str(dt_idx)[:10],
                "foreign_net":     int(row[foreign_col])     if foreign_col     else 0,
                "institution_net": int(row[institution_col]) if institution_col else 0,
                "individual_net":  int(row[individual_col])  if individual_col  else 0,
            })

        result: dict = {
            "stock_code":      stock_code,
            "foreign_net":     int(foreign_net),
            "institution_net": int(institution_net),
            "individual_net":  int(individual_net),
            "supply_score":    _score_enhanced(foreign_net, institution_net, individual_net, daily),
            "days":            days,
            "daily":           daily,
            "available":       True,
        }
        _cache_set(key, result)
        return result

    except Exception as e:
        logger.warning(f"pykrx 수급 조회 실패 [{stock_code}]: {e}")
        _cache_set(key, neutral)
        return neutral


# ── pykrx: 시장별 외국인 순매수 상위 종목 ────────────────────────────────────

def _top_foreign_sync(market: str, top_n: int) -> list[dict]:
    """외국인 순매수 상위 — pykrx KRX 인증 필요 (미설정 시 빈 목록)"""
    key = f"top_foreign_{market}_{top_n}"
    cached = _cache_get(key)
    if cached is not None:
        return cached  # type: ignore

    try:
        _set_krx_env()
        from pykrx import stock as krx
        today = date.today().strftime("%Y%m%d")

        # pykrx 1.2.x 실제 존재하는 함수 사용 (KRX 인증 필요)
        df = krx.get_market_net_purchases_of_equities_by_ticker(today, today, market, "외국인")
        if df is None or df.empty:
            logger.warning(
                f"pykrx 외국인 상위 데이터 없음 [{market}]: KRX 로그인(KRX_ID/KRX_PW) 필요"
            )
            _cache_set(key, [])
            return []

        # 순매수거래대금 컬럼 찾기 (pykrx 1.2.x: "순매수거래대금")
        net_col = next(
            (c for c in df.columns if "순매수" in c and "대금" in c),
            next((c for c in df.columns if "순매수" in c), None),
        )
        if not net_col:
            logger.warning(f"pykrx 외국인 상위: 순매수 컬럼 없음, columns={list(df.columns)}")
            _cache_set(key, [])
            return []

        df_top = df.nlargest(top_n, net_col)
        result = []
        for ticker, row in df_top.iterrows():
            # 종목명 컬럼이 있으면 사용, 없으면 ticker API 호출
            name_col = next((c for c in df.columns if "종목명" in c), None)
            name = str(row[name_col]) if name_col else str(ticker)
            result.append({
                "stock_code":  str(ticker),
                "stock_name":  name,
                "foreign_net": int(row[net_col]),
            })

        _cache_set(key, result)
        return result

    except Exception as e:
        logger.warning(f"pykrx 외국인 상위 조회 실패 [{market}]: {e}")
        _cache_set(key, [])
        return []


# ── 네이버 금융: KOSPI/KOSDAQ 지수 (실시간, 무인증) ──────────────────────────

async def _fetch_naver_index() -> dict:
    """네이버 금융 모바일 API — 실시간 지수 (delayTime=0, KRX 직접 연동)"""
    import httpx
    neutral = {
        "kospi": 0.0, "kospi_change_pct": 0.0,
        "kosdaq": 0.0, "kosdaq_change_pct": 0.0,
        "market_score": 0.5, "available": False,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            kospi_r, kosdaq_r = await asyncio.gather(
                client.get("https://m.stock.naver.com/api/index/KOSPI/basic"),
                client.get("https://m.stock.naver.com/api/index/KOSDAQ/basic"),
            )
        kp = kospi_r.json()
        kq = kosdaq_r.json()

        kospi_val = float(str(kp.get("closePrice", "0")).replace(",", "") or 0)
        kospi_chg = float(kp.get("fluctuationsRatio", 0) or 0)
        kosdaq_val = float(str(kq.get("closePrice", "0")).replace(",", "") or 0)
        kosdaq_chg = float(kq.get("fluctuationsRatio", 0) or 0)

        if kospi_val == 0 and kosdaq_val == 0:
            return neutral

        score = max(0.0, min(1.0, (kospi_chg + 3) / 6))
        return {
            "kospi":             round(kospi_val, 2),
            "kospi_change_pct":  round(kospi_chg, 4),
            "kosdaq":            round(kosdaq_val, 2),
            "kosdaq_change_pct": round(kosdaq_chg, 4),
            "market_score":      round(score, 4),
            "available":         True,
        }
    except Exception as e:
        logger.warning(f"[지수] 네이버 금융 조회 실패: {e}")
        return neutral


def _fetch_yfinance_index() -> dict:
    """yfinance 폴백 — 네이버 실패 시 사용"""
    neutral = {
        "kospi": 0.0, "kospi_change_pct": 0.0,
        "kosdaq": 0.0, "kosdaq_change_pct": 0.0,
        "market_score": 0.5, "available": False,
    }
    try:
        import yfinance as yf

        def _fetch(ticker: str) -> tuple[float, float]:
            t = yf.Ticker(ticker)
            try:
                fi = t.fast_info
                current = float(fi.last_price or 0)
                prev    = float(fi.previous_close or 0)
                if current > 0 and prev > 0:
                    return current, (current - prev) / prev * 100
            except Exception:
                pass
            hist = t.history(period="5d")
            if hist is None or len(hist) < 2:
                return 0.0, 0.0
            last = float(hist["Close"].iloc[-1])
            prev = float(hist["Close"].iloc[-2])
            return last, (last - prev) / (prev + 1e-9) * 100

        kospi,  kospi_chg  = _fetch("^KS11")
        kosdaq, kosdaq_chg = _fetch("^KQ11")
        if kospi == 0 and kosdaq == 0:
            return neutral
        score = max(0.0, min(1.0, (kospi_chg + 3) / 6))
        return {
            "kospi":             round(kospi,  2),
            "kospi_change_pct":  round(kospi_chg, 4),
            "kosdaq":            round(kosdaq, 2),
            "kosdaq_change_pct": round(kosdaq_chg, 4),
            "market_score":      round(score, 4),
            "available":         True,
        }
    except Exception as e:
        logger.warning(f"[지수] yfinance 조회 실패: {e}")
        return neutral


# ── 비동기 공개 API ──────────────────────────────────────────────────────────

async def get_supply_score(stock_code: str, days: int = 5) -> float:
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _supply_sync, stock_code, days)
    return result.get("supply_score", 0.5)  # type: ignore


async def get_supply_detail(stock_code: str, days: int = 5) -> dict:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _supply_sync, stock_code, days)  # type: ignore


async def get_top_foreign_buy(market: str = "KOSPI", top_n: int = 10) -> list[dict]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _top_foreign_sync, market, top_n)  # type: ignore


async def get_market_index() -> dict:
    """KOSPI/KOSDAQ 지수 — 네이버 금융(실시간) 우선, 실패 시 yfinance 폴백.
    캐시: 장중(09:00-15:30 평일) 60초, 장외 300초."""
    key = "market_index"
    ttl = _index_cache_ttl()
    if key in _CACHE:
        ts, cached = _CACHE[key]
        if time.time() - ts < ttl:
            return cached  # type: ignore

    # 1. 네이버 금융 (실시간)
    result = await _fetch_naver_index()
    if result["available"]:
        _CACHE[key] = (time.time(), result)
        return result

    # 2. yfinance 폴백
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _fetch_yfinance_index)
    _CACHE[key] = (time.time(), result)
    return result  # type: ignore
