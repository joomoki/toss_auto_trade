from datetime import date as date_cls
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from app.core.database import get_db
from app.models.trade import Trade

router = APIRouter(prefix="/trades", tags=["trades"])


def _trade_to_dict(t: Trade) -> dict:
    return {
        "id": t.id,
        "signal_id": t.signal_id,
        "order_id": t.order_id,
        "stock_code": t.stock_code,
        "stock_name": t.stock_name,
        "trade_type": t.trade_type,
        "order_qty": t.order_qty,
        "order_price": float(t.order_price),
        "filled_qty": t.filled_qty,
        "filled_price": float(t.filled_price) if t.filled_price else None,
        "filled_amount": float(t.filled_amount) if t.filled_amount else None,
        "commission": float(t.commission or 0),
        "status": t.status,
        "trade_date": str(t.trade_date),
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "filled_at": t.filled_at.isoformat() if t.filled_at else None,
    }


@router.get("")
async def get_trades(
    date: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    td = date_cls.fromisoformat(date) if date else date_cls.today()
    result = await db.execute(
        select(Trade)
        .where(Trade.trade_date == td)
        .order_by(Trade.created_at.desc())
    )
    return [_trade_to_dict(t) for t in result.scalars().all()]


@router.get("/history")
async def get_history(
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    stock_code: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    conditions = []
    if from_date:
        conditions.append(Trade.trade_date >= date_cls.fromisoformat(from_date))
    if to_date:
        conditions.append(Trade.trade_date <= date_cls.fromisoformat(to_date))
    if stock_code:
        conditions.append(Trade.stock_code == stock_code)

    query = select(Trade).order_by(Trade.trade_date.desc(), Trade.created_at.desc())
    if conditions:
        query = query.where(and_(*conditions))
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    return [_trade_to_dict(t) for t in result.scalars().all()]


@router.get("/{trade_id}")
async def get_trade(trade_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Trade).where(Trade.id == trade_id))
    trade = result.scalar_one_or_none()
    if not trade:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Trade not found")
    return _trade_to_dict(trade)
