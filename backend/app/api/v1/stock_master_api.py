"""
종목 마스터 API
GET /stocks/search?q=삼성   — 종목명/코드 검색 (최대 20건)
POST /stocks/refresh        — 수동 갱신 트리거
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.stock_master_service import search_stocks

router = APIRouter(prefix="/stocks", tags=["stocks"])


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1, description="종목명 또는 종목코드"),
    limit: int = Query(20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
):
    return await search_stocks(db, q, limit)


@router.get("/status")
async def get_status(db: AsyncSession = Depends(get_db)):
    """종목 마스터 상태 (종목 수, 마지막 갱신 시각)"""
    from app.services.stock_master_service import get_status as _get_status
    return await _get_status(db)


@router.post("/refresh")
async def manual_refresh(db: AsyncSession = Depends(get_db)):
    """수동으로 종목 마스터 강제 갱신 (updated_at을 어제로 리셋 후 재갱신)"""
    from app.models.stock_master import StockMaster
    from app.services.stock_master_service import maybe_refresh_stock_master
    # updated_at을 어제로 밀어서 갱신 조건 통과
    await db.execute(
        text("UPDATE stock_master SET updated_at = now() - interval '2 day'")
    )
    await db.commit()
    count = await maybe_refresh_stock_master(db)
    return {"message": f"갱신 완료: {count}종목"}
