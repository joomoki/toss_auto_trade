from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.account_snapshot_service import get_snapshot_history, save_daily_snapshot

router = APIRouter(prefix="/account-snapshots", tags=["account-snapshots"])


@router.get("/")
async def list_snapshots(
    days: int = Query(90, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """일별 잔고 이력 (최근 N일, 오름차순)"""
    return await get_snapshot_history(db, days=days)


@router.post("/save")
async def save_snapshot_now(db: AsyncSession = Depends(get_db)):
    """즉시 오늘 스냅샷 저장 (수동 트리거용)"""
    ok = await save_daily_snapshot(db)
    return {"ok": ok}
