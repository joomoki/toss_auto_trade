from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.models.strategy import Strategy

router = APIRouter(prefix="/strategy", tags=["strategy"])


class StrategyUpdate(BaseModel):
    name: Optional[str] = None
    buy_threshold: Optional[float] = None
    sell_threshold: Optional[float] = None
    stop_loss_pct: Optional[float] = None
    take_profit_pct: Optional[float] = None
    max_position_amt: Optional[float] = None
    max_daily_loss_pct: Optional[float] = None
    dynamic_tp_enabled: Optional[bool] = None
    dynamic_tp_supply_threshold: Optional[float] = None
    dynamic_tp_multiplier: Optional[float] = None
    total_deposited: Optional[float] = None


def _strategy_to_dict(s: Strategy) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "model_version": s.model_version,
        "buy_threshold": float(s.buy_threshold) if s.buy_threshold else 0.6,
        "sell_threshold": float(s.sell_threshold) if s.sell_threshold else 0.6,
        "stop_loss_pct": float(s.stop_loss_pct) if s.stop_loss_pct else 3.0,
        "take_profit_pct": float(s.take_profit_pct) if s.take_profit_pct else 5.0,
        "max_position_amt": float(s.max_position_amt) if s.max_position_amt else None,
        "max_daily_loss_pct": float(s.max_daily_loss_pct) if s.max_daily_loss_pct else 5.0,
        "kill_switch_active": bool(s.kill_switch_active),
        "model_weights": s.model_weights or {},
        "is_active": s.is_active,
        "dynamic_tp_enabled": bool(s.dynamic_tp_enabled) if s.dynamic_tp_enabled is not None else False,
        "dynamic_tp_supply_threshold": float(s.dynamic_tp_supply_threshold) if s.dynamic_tp_supply_threshold else 0.65,
        "dynamic_tp_multiplier": float(s.dynamic_tp_multiplier) if s.dynamic_tp_multiplier else 1.5,
        "total_deposited": float(s.total_deposited) if s.total_deposited else 0.0,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


async def _get_active_or_first(db: AsyncSession) -> Optional[Strategy]:
    result = await db.execute(
        select(Strategy).where(Strategy.is_active == True).limit(1)
    )
    s = result.scalar_one_or_none()
    if not s:
        result = await db.execute(select(Strategy).order_by(Strategy.id).limit(1))
        s = result.scalar_one_or_none()
    return s


@router.get("")
async def get_strategy(db: AsyncSession = Depends(get_db)):
    s = await _get_active_or_first(db)
    if not s:
        raise HTTPException(status_code=404, detail="전략이 없습니다. 먼저 전략을 생성하세요.")
    return _strategy_to_dict(s)


@router.put("")
async def update_strategy(body: StrategyUpdate, db: AsyncSession = Depends(get_db)):
    s = await _get_active_or_first(db)
    if not s:
        raise HTTPException(status_code=404, detail="전략이 없습니다.")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(s, field, value)
    await db.commit()
    await db.refresh(s)
    return _strategy_to_dict(s)


@router.post("/toggle")
async def toggle_auto_trade(db: AsyncSession = Depends(get_db)):
    s = await _get_active_or_first(db)
    if not s:
        raise HTTPException(status_code=404, detail="전략이 없습니다.")
    s.is_active = not s.is_active
    await db.commit()
    return {"is_active": s.is_active, "message": f"자동매매 {'활성화' if s.is_active else '비활성화'}"}


class ModelWeightsBody(BaseModel):
    weights: Dict[str, float]


@router.post("/model-weights")
async def save_model_weights(body: ModelWeightsBody, db: AsyncSession = Depends(get_db)):
    """모델별 가중치 저장 (적중률 기반 — 엔진에서 model_score 산출 시 사용)"""
    s = await _get_active_or_first(db)
    if not s:
        raise HTTPException(status_code=404, detail="전략이 없습니다.")
    s.model_weights = body.weights
    await db.commit()
    return {"model_weights": s.model_weights, "message": "가중치가 저장되었습니다."}


@router.post("/kill-switch/reset")
async def reset_kill_switch(db: AsyncSession = Depends(get_db)):
    """킬스위치 수동 해제 (오늘 손실 확인 후 직접 해제)"""
    s = await _get_active_or_first(db)
    if not s:
        raise HTTPException(status_code=404, detail="전략이 없습니다.")
    s.kill_switch_active = False
    await db.commit()
    return {"kill_switch_active": False, "message": "킬스위치가 해제되었습니다."}


@router.post("/init")
async def init_strategy(db: AsyncSession = Depends(get_db)):
    """기본 전략이 없을 때 초기 생성"""
    result = await db.execute(select(Strategy).limit(1))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 전략이 존재합니다.")
    s = Strategy(
        name="기본 LightGBM 전략",
        model_version="lgbm_v1",
        buy_threshold=0.6,
        sell_threshold=0.6,
        stop_loss_pct=3.0,
        take_profit_pct=5.0,
        max_position_amt=1_000_000,
        max_daily_loss_pct=5.0,
        kill_switch_active=False,
        is_active=False,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _strategy_to_dict(s)
