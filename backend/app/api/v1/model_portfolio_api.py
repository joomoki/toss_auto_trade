"""
모델별 가상 포트폴리오 수익률 분석 API

GET    /api/v1/model-portfolio                    — 전체 (모델별 그룹)
GET    /api/v1/model-portfolio/{model_id}         — 특정 모델 종목 목록
POST   /api/v1/model-portfolio                    — 종목 추가
PATCH  /api/v1/model-portfolio/{id}               — 수정 (가격/수량/메모)
DELETE /api/v1/model-portfolio/{id}               — 제거
POST   /api/v1/model-portfolio/refresh-prices     — 현재가 일괄 업데이트
GET    /api/v1/model-portfolio/summary            — 모델별 수익률 요약
"""
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.news import ModelPortfolioStock
from app.services.toss_api import TossApiClient

router = APIRouter(prefix="/model-portfolio", tags=["model-portfolio"])


# ── 직렬화 ───────────────────────────────────────────────

def _s(r: ModelPortfolioStock) -> dict:
    buy_amt = (r.buy_price or 0) * (r.quantity or 1)
    return {
        "id":               r.id,
        "model_id":         r.model_id,
        "stock_code":       r.stock_code,
        "stock_name":       r.stock_name or r.stock_code,
        "buy_date":         str(r.buy_date),
        "buy_price":        r.buy_price,
        "quantity":         r.quantity,
        "buy_amount":       buy_amt,
        "current_price":    r.current_price,
        "return_pct":       float(r.return_pct)  if r.return_pct  is not None else None,
        "return_amt":       float(r.return_amt)  if r.return_amt  is not None else None,
        "is_active":        r.is_active,
        "memo":             r.memo,
        "price_updated_at": r.price_updated_at.isoformat() if r.price_updated_at else None,
        "created_at":       r.created_at.isoformat()       if r.created_at       else None,
    }


# ── Pydantic 스키마 ───────────────────────────────────────

class StockAdd(BaseModel):
    model_id:   str
    stock_code: str
    stock_name: Optional[str] = None
    buy_date:   str           # "YYYY-MM-DD"
    buy_price:  int
    quantity:   int = 1
    memo:       Optional[str] = None


class StockPatch(BaseModel):
    buy_date:   Optional[str] = None
    buy_price:  Optional[int] = None
    quantity:   Optional[int] = None
    stock_name: Optional[str] = None
    is_active:  Optional[bool] = None
    memo:       Optional[str] = None


# ── 엔드포인트 ───────────────────────────────────────────

@router.get("/summary")
async def get_summary(db: AsyncSession = Depends(get_db)):
    """모델별 수익률 요약 — 평균 수익률 / 평가손익 합계"""
    r = await db.execute(
        select(ModelPortfolioStock).where(ModelPortfolioStock.is_active == True)
    )
    rows = r.scalars().all()

    by_model: dict[str, list] = {}
    for row in rows:
        by_model.setdefault(row.model_id, []).append(row)

    summary = []
    for model_id, stocks in sorted(by_model.items()):
        priced = [s for s in stocks if s.return_pct is not None]
        avg_return = (
            sum(float(s.return_pct) for s in priced) / len(priced)
            if priced else None
        )
        total_return_amt = sum(float(s.return_amt or 0) for s in stocks)
        total_buy_amt    = sum((s.buy_price or 0) * (s.quantity or 1) for s in stocks)
        best  = max(priced, key=lambda s: float(s.return_pct), default=None)
        worst = min(priced, key=lambda s: float(s.return_pct), default=None)
        summary.append({
            "model_id":         model_id,
            "stock_count":      len(stocks),
            "avg_return_pct":   round(avg_return, 4) if avg_return is not None else None,
            "total_return_amt": round(total_return_amt, 2),
            "total_buy_amt":    total_buy_amt,
            "best_stock":       _s(best)  if best  is not None else None,
            "worst_stock":      _s(worst) if worst is not None else None,
        })

    # 평균 수익률 내림차순
    summary.sort(key=lambda x: (x["avg_return_pct"] or -999), reverse=True)
    return {"summary": summary}


@router.get("")
async def list_all(db: AsyncSession = Depends(get_db)):
    """전체 종목을 모델별로 그룹화하여 반환"""
    r = await db.execute(
        select(ModelPortfolioStock).order_by(
            ModelPortfolioStock.model_id,
            ModelPortfolioStock.buy_date.desc(),
        )
    )
    rows = r.scalars().all()

    by_model: dict[str, list] = {}
    for row in rows:
        by_model.setdefault(row.model_id, []).append(_s(row))

    return {"by_model": by_model, "total": len(rows)}


@router.get("/{model_id}")
async def list_by_model(model_id: str, db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        select(ModelPortfolioStock)
        .where(ModelPortfolioStock.model_id == model_id)
        .order_by(ModelPortfolioStock.buy_date.desc())
    )
    rows = r.scalars().all()

    priced = [s for s in rows if s.return_pct is not None and s.is_active]
    avg_return = (
        sum(float(s.return_pct) for s in priced) / len(priced) if priced else None
    )
    return {
        "model_id":       model_id,
        "stocks":         [_s(r) for r in rows],
        "avg_return_pct": round(avg_return, 4) if avg_return is not None else None,
    }


@router.post("")
async def add_stock(body: StockAdd, db: AsyncSession = Depends(get_db)):
    """종목 추가 — 모델당 최대 10개 (경고만)"""
    # 중복 체크 (같은 모델 + 종목 + 매수일)
    existing = await db.execute(
        select(ModelPortfolioStock).where(
            ModelPortfolioStock.model_id   == body.model_id,
            ModelPortfolioStock.stock_code == body.stock_code,
            ModelPortfolioStock.buy_date   == date.fromisoformat(body.buy_date),
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 동일 종목/날짜로 등록되어 있습니다.")

    row = ModelPortfolioStock(
        model_id=body.model_id,
        stock_code=body.stock_code.strip(),
        stock_name=body.stock_name,
        buy_date=date.fromisoformat(body.buy_date),
        buy_price=body.buy_price,
        quantity=body.quantity,
        memo=body.memo,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    # 즉시 현재가 조회 시도
    try:
        api = TossApiClient.get_instance()
        price_info = await api.get_current_price(body.stock_code)
        price = int(price_info.get("price", 0))
        if price > 0:
            row.current_price = price
            row.return_pct = (price - body.buy_price) / body.buy_price * 100
            row.return_amt = (price - body.buy_price) * body.quantity
            row.price_updated_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(row)
    except Exception:
        pass

    return _s(row)


@router.patch("/{item_id}")
async def patch_stock(item_id: int, body: StockPatch, db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        select(ModelPortfolioStock).where(ModelPortfolioStock.id == item_id)
    )
    row = r.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")

    if body.buy_date  is not None: row.buy_date  = date.fromisoformat(body.buy_date)
    if body.buy_price is not None: row.buy_price = body.buy_price
    if body.quantity  is not None: row.quantity  = body.quantity
    if body.stock_name is not None: row.stock_name = body.stock_name
    if body.is_active is not None: row.is_active = body.is_active
    if body.memo      is not None: row.memo      = body.memo

    # 수익률 재계산
    if row.current_price and row.buy_price:
        row.return_pct = (row.current_price - row.buy_price) / row.buy_price * 100
        row.return_amt = (row.current_price - row.buy_price) * row.quantity

    await db.commit()
    await db.refresh(row)
    return _s(row)


@router.delete("/{item_id}")
async def delete_stock(item_id: int, db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        select(ModelPortfolioStock).where(ModelPortfolioStock.id == item_id)
    )
    row = r.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    await db.delete(row)
    await db.commit()
    return {"message": "삭제됨", "id": item_id}


@router.post("/refresh-prices")
async def refresh_prices(db: AsyncSession = Depends(get_db)):
    """활성 종목 현재가 일괄 조회 후 수익률 갱신"""
    r = await db.execute(
        select(ModelPortfolioStock).where(ModelPortfolioStock.is_active == True)
    )
    rows = r.scalars().all()
    if not rows:
        return {"updated": 0, "errors": []}

    api = TossApiClient.get_instance()
    updated, errors = 0, []

    for row in rows:
        try:
            price_info = await api.get_current_price(row.stock_code)
            price = int(price_info.get("price", 0))
            if price > 0:
                row.current_price    = price
                row.return_pct       = (price - row.buy_price) / row.buy_price * 100
                row.return_amt       = (price - row.buy_price) * row.quantity
                row.price_updated_at = datetime.now(timezone.utc)
                updated += 1
        except Exception as e:
            errors.append({"stock_code": row.stock_code, "error": str(e)})

    await db.commit()
    return {"updated": updated, "total": len(rows), "errors": errors}
