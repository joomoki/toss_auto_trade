"""
종목별 일별 주가 이력 API

POST /api/v1/stock-prices/backfill         — 3개월 과거 데이터 일괄 적재
GET  /api/v1/stock-prices/{code}/chart     — 일봉 차트 데이터
GET  /api/v1/stock-prices/codes            — 추적 종목 목록 + 최신 종가
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query, BackgroundTasks
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.stock_price import StockDailyPrice
from app.models.watchlist import Watchlist

router = APIRouter(prefix="/stock-prices", tags=["stock-prices"])


@router.post("/backfill")
async def backfill(
    background_tasks: BackgroundTasks,
    trading_days: int = Query(90, ge=20, le=250),
    db: AsyncSession = Depends(get_db),
):
    """최근 N 거래일 일봉 데이터 일괄 적재 (백그라운드 실행)"""
    from app.core.database import AsyncSessionLocal
    from app.services.daily_price_updater import backfill_historical_prices

    async def _run():
        async with AsyncSessionLocal() as bg_db:
            result = await backfill_historical_prices(bg_db, trading_days)
            import logging
            logging.getLogger(__name__).info(f"[backfill] 완료: {result}")

    background_tasks.add_task(_run)
    return {"message": f"백그라운드에서 최근 {trading_days} 거래일 적재를 시작했습니다."}


@router.get("/codes")
async def list_codes(db: AsyncSession = Depends(get_db)):
    """추적 종목 목록 + 각 종목 최신 종가"""
    wl = (await db.execute(select(Watchlist).where(Watchlist.is_active == True))).scalars().all()

    result = []
    for w in wl:
        latest = (await db.execute(
            select(StockDailyPrice)
            .where(StockDailyPrice.stock_code == w.stock_code)
            .order_by(desc(StockDailyPrice.trade_date))
            .limit(1)
        )).scalar_one_or_none()

        result.append({
            "stock_code":    w.stock_code,
            "stock_name":    w.stock_name,
            "market":        w.market,
            "latest_date":   str(latest.trade_date)  if latest else None,
            "latest_close":  latest.close_price       if latest else None,
        })

    return {"codes": result, "total": len(result)}


@router.get("/{code}/chart")
async def get_chart(
    code: str,
    days: int = Query(90, ge=5, le=365),
    db: AsyncSession = Depends(get_db),
):
    """일봉 차트 데이터 — close/open/high/low/volume 포함"""
    cutoff = date.today() - timedelta(days=days)
    rows = (await db.execute(
        select(StockDailyPrice)
        .where(
            StockDailyPrice.stock_code == code,
            StockDailyPrice.trade_date >= cutoff,
        )
        .order_by(StockDailyPrice.trade_date)
    )).scalars().all()

    candles = [
        {
            "date":   str(r.trade_date),
            "open":   r.open_price  or r.close_price,
            "high":   r.high_price  or r.close_price,
            "low":    r.low_price   or r.close_price,
            "close":  r.close_price,
            "volume": r.volume or 0,
        }
        for r in rows
        if r.close_price
    ]

    # 단순 통계
    closes = [r.close_price for r in rows if r.close_price]
    stats = {}
    if closes:
        stats = {
            "latest_close": closes[-1],
            "high_3m":      max(r.high_price or r.close_price for r in rows),
            "low_3m":       min(r.low_price  or r.close_price for r in rows),
            "change_pct":   round((closes[-1] - closes[0]) / closes[0] * 100, 2) if closes[0] else 0,
        }

    name_row = rows[0] if rows else None
    return {
        "stock_code": code,
        "stock_name": name_row.stock_name if name_row else "",
        "days":       days,
        "candles":    candles,
        "stats":      stats,
    }
