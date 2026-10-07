"""
수급 분석 API
GET /supply/market          — KOSPI/KOSDAQ 지수 + 외국인 순매수 상위 종목
GET /supply/stock/{code}    — 개별 종목 수급 상세
GET /supply/watchlist       — 워치리스트 전 종목 수급 일괄 조회
"""
from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.watchlist import Watchlist
from app.services.supply_demand_service import (
    get_supply_detail,
    get_top_foreign_buy,
    get_market_index,
)

router = APIRouter(prefix="/supply", tags=["supply"])


@router.get("/market")
async def market_overview():
    """KOSPI/KOSDAQ 지수 + 외국인 순매수 상위 10종목"""
    index, top_kospi, top_kosdaq = await asyncio.gather(
        get_market_index(),
        get_top_foreign_buy("KOSPI",  10),
        get_top_foreign_buy("KOSDAQ", 10),
    )
    return {
        "index":               index,
        "top_foreign_kospi":   top_kospi,
        "top_foreign_kosdaq":  top_kosdaq,
    }


@router.get("/stock/{stock_code}")
async def stock_supply(
    stock_code: str,
    days: int = Query(5, ge=3, le=20),
):
    """개별 종목 외국인/기관 순매수 상세 (최근 N거래일)"""
    return await get_supply_detail(stock_code, days)


@router.get("/watchlist")
async def watchlist_supply(
    days: int = Query(5, ge=3, le=20),
    db: AsyncSession = Depends(get_db),
):
    """워치리스트 활성 종목 전체 수급 일괄 조회"""
    wl_r = await db.execute(select(Watchlist).where(Watchlist.is_active == True))
    watchlist = wl_r.scalars().all()
    if not watchlist:
        return {"items": []}

    tasks = [get_supply_detail(w.stock_code, days) for w in watchlist]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    name_map = {w.stock_code: w.stock_name for w in watchlist}
    items = []
    for code, r in zip([w.stock_code for w in watchlist], results):
        if isinstance(r, dict):
            r["stock_name"] = name_map.get(code, code)
            items.append(r)

    items.sort(key=lambda x: x.get("supply_score", 0.5), reverse=True)
    return {"items": items, "days": days}
