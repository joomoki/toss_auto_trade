"""
섹터 내 종목 선정

1. YAML 대표 종목 풀 로드
2. 유동성 필터 (최근 5일 평균 거래대금)
3. 수급 점수 상위 종목 선정
4. 보유 종목 중복 제거
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_MIN_AVG_VOLUME_WON = 5_000_000_000  # 50억원 이상 (일평균 거래대금)
_MAX_STOCKS_PER_SECTOR = 3


async def select_stocks(
    sector_id: str,
    candidate_codes: list[dict],   # [{code, name}, ...]
    existing_holdings: set[str],   # 이미 보유 중인 종목코드
    top_n: int = _MAX_STOCKS_PER_SECTOR,
) -> list[dict]:
    """
    수급 점수 + 거래대금 기반으로 섹터 내 상위 N 종목 반환.
    반환: [{code, name, supply_score, reason}, ...]
    """
    from app.services.supply_demand_service import get_supply_score

    scored: list[dict] = []

    for stock in candidate_codes:
        code = stock["code"]
        name = stock["name"]

        if code in existing_holdings:
            logger.debug(f"{code} 이미 보유 — 스킵")
            continue

        # 수급 점수 조회
        try:
            supply = await get_supply_score(code, days=5)
        except Exception:
            supply = 0.5

        # 거래대금 필터 (pykrx OHLCV — 인증 불필요)
        try:
            volume_ok = await _check_volume(code)
        except Exception:
            volume_ok = True  # 조회 실패 시 통과

        if not volume_ok:
            logger.debug(f"{code} 거래대금 미달 — 제외")
            continue

        scored.append({
            "code":         code,
            "name":         name,
            "supply_score": supply,
            "reason":       f"수급={supply:.2f}",
        })

    # 수급 점수 내림차순
    scored.sort(key=lambda x: x["supply_score"], reverse=True)
    return scored[:top_n]


async def _check_volume(stock_code: str) -> bool:
    """최근 5거래일 평균 거래대금이 기준 이상인지 확인"""
    try:
        from pykrx import stock as krx
        from datetime import date, timedelta
        import asyncio

        todate   = date.today().strftime("%Y%m%d")
        fromdate = (date.today() - timedelta(days=10)).strftime("%Y%m%d")

        loop = asyncio.get_running_loop()
        df = await loop.run_in_executor(
            None,
            lambda: krx.get_market_ohlcv_by_date(fromdate, todate, stock_code),
        )
        if df is None or df.empty:
            return True

        # 거래대금 컬럼 찾기
        val_col = next((c for c in df.columns if "거래대금" in c), None)
        if not val_col:
            return True

        avg_vol = df[val_col].tail(5).mean()
        return float(avg_vol) >= _MIN_AVG_VOLUME_WON
    except Exception as e:
        logger.debug(f"거래대금 조회 실패 [{stock_code}]: {e}")
        return True
