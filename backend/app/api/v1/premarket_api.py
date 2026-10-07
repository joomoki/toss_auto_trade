from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, desc

from app.core.database import get_db
from app.models.premarket_scan import PremarketScanLog
from app.services.premarket_scanner import run_premarket_scan

router = APIRouter(prefix="/premarket", tags=["premarket"])

_SIGNAL_ORDER = {"STRONG_BUY": 0, "BUY": 1, "WATCH": 2, "PASS": 3}


@router.post("/scan")
async def trigger_scan(db: AsyncSession = Depends(get_db)):
    """프리장 스캔 수동 실행"""
    return await run_premarket_scan(db)


@router.get("/today")
async def get_today(db: AsyncSession = Depends(get_db)):
    """오늘 프리장 스캔 결과"""
    today = date.today()
    r = await db.execute(
        select(PremarketScanLog)
        .where(PremarketScanLog.scan_date == today)
        .order_by(desc(PremarketScanLog.combined_score))
    )
    items = r.scalars().all()
    return _serialize(items)


@router.get("/history")
async def get_history(
    days: int = Query(7, ge=1, le=90),
    signal: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """프리장 스캔 이력"""
    since = date.today() - timedelta(days=days)
    q = select(PremarketScanLog).where(PremarketScanLog.scan_date >= since)
    if signal:
        q = q.where(PremarketScanLog.signal == signal)
    q = q.order_by(desc(PremarketScanLog.scan_date), desc(PremarketScanLog.combined_score))
    r = await db.execute(q)
    return _serialize(r.scalars().all())


def _serialize(items) -> list[dict]:
    return [
        {
            "id":               item.id,
            "scan_date":        str(item.scan_date),
            "stock_code":       item.stock_code,
            "stock_name":       item.stock_name,
            "premarket_price":  item.premarket_price,
            "premarket_volume": item.premarket_volume,
            "prev_close":       item.prev_close,
            "prev_avg_volume":  item.prev_avg_volume,
            "vol_ratio":        float(item.vol_ratio) if item.vol_ratio else None,
            "price_change_pct": float(item.price_change_pct) if item.price_change_pct else None,
            "news_sentiment":   float(item.news_sentiment) if item.news_sentiment else None,
            "model_score":      float(item.model_score) if item.model_score else None,
            "combined_score":   float(item.combined_score) if item.combined_score else None,
            "signal":           item.signal,
            "signal_reasons":   item.signal_reasons or [],
            "priority_boost":   item.priority_boost,
            "was_traded":       item.was_traded,
        }
        for item in items
    ]
