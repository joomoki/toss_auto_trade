"""
수동 매수 예약 API
GET  /manual-buy          — 전체 주문 목록 (pending + 오늘 완료)
POST /manual-buy          — 예약 추가
DELETE /manual-buy/{id}   — 대기 주문 취소
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.manual_buy_order import ManualBuyOrder

router = APIRouter(prefix="/manual-buy", tags=["manual-buy"])


class ManualBuyCreate(BaseModel):
    stock_code: str
    stock_name: str = ""
    quantity: Optional[int] = None      # 수량 지정 (None이면 budget 사용)
    budget: Optional[int] = None        # 예산(원) 지정


def _to_dict(o: ManualBuyOrder) -> dict:
    return {
        "id":             o.id,
        "stock_code":     o.stock_code,
        "stock_name":     o.stock_name or o.stock_code,
        "quantity":       o.quantity,
        "budget":         int(o.budget) if o.budget else None,
        "status":         o.status,
        "created_at":     o.created_at.isoformat() if o.created_at else None,
        "executed_at":    o.executed_at.isoformat() if o.executed_at else None,
        "executed_price": o.executed_price,
        "executed_qty":   o.executed_qty,
        "error_msg":      o.error_msg,
    }


@router.get("")
async def list_orders(db: AsyncSession = Depends(get_db)):
    """pending 전체 + 오늘 완료/실패 주문 반환"""
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    r = await db.execute(
        select(ManualBuyOrder)
        .where(
            or_(
                ManualBuyOrder.status == "pending",
                ManualBuyOrder.created_at >= today_start,
            )
        )
        .order_by(ManualBuyOrder.created_at.desc())
    )
    return [_to_dict(o) for o in r.scalars().all()]


@router.post("", status_code=201)
async def create_order(body: ManualBuyCreate, db: AsyncSession = Depends(get_db)):
    code = body.stock_code.strip().zfill(6)
    if not code:
        raise HTTPException(status_code=400, detail="종목 코드를 입력하세요.")
    if not body.quantity and not body.budget:
        raise HTTPException(status_code=400, detail="수량 또는 예산 중 하나를 입력하세요.")

    # 이미 대기 중인 동일 종목이 있으면 중복 방지
    dup = await db.execute(
        select(ManualBuyOrder).where(
            ManualBuyOrder.stock_code == code,
            ManualBuyOrder.status == "pending",
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"{code} 종목이 이미 대기 중입니다.")

    order = ManualBuyOrder(
        stock_code=code,
        stock_name=body.stock_name.strip() or None,
        quantity=body.quantity,
        budget=body.budget,
        status="pending",
    )
    db.add(order)
    await db.commit()
    await db.refresh(order)
    return _to_dict(order)


@router.delete("/{order_id}", status_code=200)
async def cancel_order(order_id: int, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(ManualBuyOrder).where(ManualBuyOrder.id == order_id))
    order = r.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="주문을 찾을 수 없습니다.")
    if order.status != "pending":
        raise HTTPException(status_code=400, detail=f"대기 중인 주문만 취소할 수 있습니다. (현재: {order.status})")
    order.status = "cancelled"
    await db.commit()
    return {"message": "주문이 취소되었습니다.", "id": order_id}
