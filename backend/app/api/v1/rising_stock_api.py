from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func, case, desc

from app.core.database import get_db
from app.models.rising_stock import RisingStockLog
from app.services.rising_stock_analyzer import collect_rising_stocks

router = APIRouter(prefix="/rising-stocks", tags=["rising-stocks"])


@router.post("/collect")
async def collect(
    analysis_date: Optional[str] = Query(None, description="YYYY-MM-DD, 기본=어제"),
    min_change_pct: float = Query(3.0, ge=0.5, le=30.0),
    max_stocks: int = Query(50, ge=10, le=200),
    compute_vol_ratio: bool = Query(False, description="거래량 비율 계산 (종목별 추가 API, 느림)"),
    db: AsyncSession = Depends(get_db),
):
    """지정 날짜의 상승 종목 수집 및 분석"""
    if analysis_date:
        try:
            d = date.fromisoformat(analysis_date)
        except ValueError:
            raise HTTPException(400, "날짜 형식 오류 (YYYY-MM-DD)")
    else:
        d = date.today() - timedelta(days=1)

    result = await collect_rising_stocks(
        db=db,
        analysis_date=d,
        min_change_pct=min_change_pct,
        max_stocks=max_stocks,
        compute_vol_ratio=compute_vol_ratio,
    )
    return result


@router.get("/")
async def list_rising_stocks(
    date_from: Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_to:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    days:      int  = Query(7, ge=1, le=365),
    market:    Optional[str] = Query(None, description="KOSPI / KOSDAQ"),
    category:  Optional[str] = Query(None, description="news / supply / volume / momentum / unknown"),
    min_change: float = Query(0.0),
    was_bought: Optional[bool] = Query(None),
    limit:     int  = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    """상승 종목 분석 이력 조회"""
    if date_from:
        try:
            df = date.fromisoformat(date_from)
        except ValueError:
            raise HTTPException(400, "date_from 형식 오류")
    else:
        df = date.today() - timedelta(days=days)

    if date_to:
        try:
            dt = date.fromisoformat(date_to)
        except ValueError:
            raise HTTPException(400, "date_to 형식 오류")
    else:
        dt = date.today()

    q = select(RisingStockLog).where(
        and_(
            RisingStockLog.analysis_date >= df,
            RisingStockLog.analysis_date <= dt,
            RisingStockLog.change_pct >= min_change,
        )
    )
    if market:
        q = q.where(RisingStockLog.market == market)
    if category:
        q = q.where(RisingStockLog.rise_category == category)
    if was_bought is not None:
        q = q.where(RisingStockLog.was_bought == was_bought)

    q = q.order_by(desc(RisingStockLog.analysis_date), desc(RisingStockLog.change_pct)).limit(limit)

    rows = await db.execute(q)
    items = rows.scalars().all()

    return [
        {
            "id":              item.id,
            "analysis_date":   str(item.analysis_date),
            "stock_code":      item.stock_code,
            "stock_name":      item.stock_name,
            "market":          item.market,
            "open_price":      item.open_price,
            "close_price":     item.close_price,
            "high_price":      item.high_price,
            "low_price":       item.low_price,
            "change_pct":      float(item.change_pct) if item.change_pct else 0,
            "volume":          item.volume,
            "trading_value":   item.trading_value,
            "volume_ratio":    float(item.volume_ratio) if item.volume_ratio else None,
            "news_sentiment":  float(item.news_sentiment) if item.news_sentiment else None,
            "news_count":      item.news_count or 0,
            "top_news":        item.top_news,
            "rise_causes":     item.rise_causes or [],
            "rise_category":   item.rise_category or "unknown",
            "was_in_watchlist": item.was_in_watchlist,
            "was_bought":      item.was_bought,
            "ai_score":        float(item.ai_score) if item.ai_score else None,
        }
        for item in items
    ]


@router.get("/summary")
async def summary(
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """기간별 상승 원인 분포 및 집계 통계"""
    since = date.today() - timedelta(days=days)

    # 원인 카테고리별 건수
    cat_r = await db.execute(
        select(
            RisingStockLog.rise_category,
            func.count().label("cnt"),
            func.avg(RisingStockLog.change_pct).label("avg_change"),
        )
        .where(RisingStockLog.analysis_date >= since)
        .group_by(RisingStockLog.rise_category)
        .order_by(desc("cnt"))
    )
    category_dist = [
        {"category": r[0] or "unknown", "count": r[1], "avg_change": round(float(r[2] or 0), 2)}
        for r in cat_r
    ]

    # 일별 집계
    daily_r = await db.execute(
        select(
            RisingStockLog.analysis_date,
            func.count().label("total"),
            func.sum(case((RisingStockLog.was_bought == True, 1), else_=0)).label("bought"),
            func.avg(RisingStockLog.change_pct).label("avg_change"),
            func.max(RisingStockLog.change_pct).label("max_change"),
        )
        .where(RisingStockLog.analysis_date >= since)
        .group_by(RisingStockLog.analysis_date)
        .order_by(RisingStockLog.analysis_date)
    )
    daily = [
        {
            "date":       str(r[0]),
            "total":      r[1],
            "bought":     int(r[2] or 0),
            "avg_change": round(float(r[3] or 0), 2),
            "max_change": round(float(r[4] or 0), 2),
        }
        for r in daily_r
    ]

    # 총 통계
    total_r = await db.execute(
        select(
            func.count().label("total"),
            func.sum(case((RisingStockLog.was_bought == True, 1), else_=0)).label("total_bought"),
            func.sum(case((RisingStockLog.was_in_watchlist == True, 1), else_=0)).label("total_watched"),
            func.avg(RisingStockLog.change_pct).label("avg_change"),
        )
        .where(RisingStockLog.analysis_date >= since)
    )
    tot = total_r.one()

    return {
        "days":           days,
        "total_records":  tot[0] or 0,
        "total_bought":   int(tot[1] or 0),
        "total_watched":  int(tot[2] or 0),
        "avg_change_pct": round(float(tot[3] or 0), 2),
        "category_dist":  category_dist,
        "daily":          daily,
    }


@router.get("/dates")
async def collected_dates(
    days: int = Query(90, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """수집 완료된 날짜 목록"""
    since = date.today() - timedelta(days=days)
    r = await db.execute(
        select(RisingStockLog.analysis_date, func.count().label("cnt"))
        .where(RisingStockLog.analysis_date >= since)
        .group_by(RisingStockLog.analysis_date)
        .order_by(desc(RisingStockLog.analysis_date))
    )
    return [{"date": str(row[0]), "count": row[1]} for row in r]
