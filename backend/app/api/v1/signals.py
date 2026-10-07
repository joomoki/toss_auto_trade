from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, BackgroundTasks, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db, AsyncSessionLocal
from app.models.signal import TradeSignal

router = APIRouter(prefix="/signals", tags=["signals"])


def _signal_to_dict(s: TradeSignal) -> dict:
    return {
        "id": s.id,
        "stock_code": s.stock_code,
        "stock_name": s.stock_name,
        "signal_type": s.signal_type,
        "confidence": float(s.confidence),
        "price_at_signal": float(s.price_at_signal),
        "features": s.features,
        "strategy_id": s.strategy_id,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


@router.get("")
async def get_signals(
    signal_date: Optional[str] = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
):
    if signal_date is None:
        signal_date = str(date.today())

    from sqlalchemy import func, cast
    from sqlalchemy.types import Date
    result = await db.execute(
        select(TradeSignal)
        .where(cast(TradeSignal.created_at, Date) == signal_date)
        .order_by(TradeSignal.created_at.desc())
    )
    return [_signal_to_dict(s) for s in result.scalars().all()]


@router.post("/run")
async def run_signals(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """신호 생성 수동 트리거 (백그라운드 실행)"""
    async def _run():
        async with AsyncSessionLocal() as session:
            from app.services.signal_engine import SignalEngine
            engine = SignalEngine(session)
            await engine.run()

    background_tasks.add_task(_run)
    return {"message": "신호 생성 시작됨"}
