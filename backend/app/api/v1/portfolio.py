from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.models.portfolio import PortfolioHolding, PortfolioTransaction
from app.services.toss_api import TossApiClient

router = APIRouter(prefix="/portfolio", tags=["portfolio"])


@router.get("/accounts")
async def get_broker_accounts():
    """키움증권 계좌 목록 조회"""
    api = TossApiClient.get_instance()
    try:
        accounts = await api.get_accounts()
        active_no = getattr(api, "_account_no", None) or (
            accounts[0].get("acnt_no") or accounts[0].get("accountNo", "") if accounts else ""
        )
        return {"accounts": accounts, "active_no": active_no}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"키움증권 API 오류: {e}")


# ── Pydantic 스키마 ─────────────────────────────────────

class HoldingCreate(BaseModel):
    stock_code: str
    stock_name: Optional[str] = None
    quantity: int
    avg_buy_price: float
    buy_date: Optional[str] = None
    memo: Optional[str] = None


class HoldingUpdate(BaseModel):
    stock_name: Optional[str] = None
    quantity: Optional[int] = None
    avg_buy_price: Optional[float] = None
    buy_date: Optional[str] = None
    memo: Optional[str] = None


class TransactionCreate(BaseModel):
    stock_code: str
    stock_name: Optional[str] = None
    transaction_type: str          # BUY / SELL
    quantity: int
    price: float
    commission: float = 0
    transaction_date: str
    memo: Optional[str] = None


# ── 직렬화 헬퍼 ────────────────────────────────────────

def _h(h: PortfolioHolding) -> dict:
    return {
        "id": h.id,
        "stock_code": h.stock_code,
        "stock_name": h.stock_name,
        "quantity": float(h.quantity),
        "avg_buy_price": float(h.avg_buy_price),
        "current_price": float(h.current_price) if h.current_price else None,
        "unrealized_pnl": float(h.unrealized_pnl) if h.unrealized_pnl else None,
        "unrealized_pnl_pct": float(h.unrealized_pnl_pct) if h.unrealized_pnl_pct else None,
        "buy_date": str(h.buy_date) if h.buy_date else None,
        "memo": h.memo,
        "source": h.source,
        "updated_at": h.updated_at.isoformat() if h.updated_at else None,
        "created_at": h.created_at.isoformat() if h.created_at else None,
    }


def _t(t: PortfolioTransaction) -> dict:
    return {
        "id": t.id,
        "stock_code": t.stock_code,
        "stock_name": t.stock_name,
        "transaction_type": t.transaction_type,
        "quantity": float(t.quantity),
        "price": float(t.price),
        "amount": float(t.amount),
        "commission": float(t.commission or 0),
        "transaction_date": str(t.transaction_date),
        "memo": t.memo,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def _recalc(h: PortfolioHolding):
    """현재가 기준으로 평가손익 재계산"""
    if h.current_price and h.avg_buy_price:
        cp = float(h.current_price)
        ap = float(h.avg_buy_price)
        qty = float(h.quantity)
        h.unrealized_pnl = (cp - ap) * qty
        h.unrealized_pnl_pct = (cp - ap) / ap * 100 if ap > 0 else 0


# ── 보유 종목 CRUD ──────────────────────────────────────

@router.get("")
async def list_holdings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(PortfolioHolding).order_by(PortfolioHolding.stock_code)
    )
    holdings = result.scalars().all()
    rows = [_h(h) for h in holdings]

    total_invest = sum(float(h.avg_buy_price) * float(h.quantity) for h in holdings)
    total_eval = sum(
        (float(h.current_price) if h.current_price else float(h.avg_buy_price)) * float(h.quantity)
        for h in holdings
    )
    total_pnl = total_eval - total_invest

    return {
        "holdings": rows,
        "summary": {
            "total_invest": round(total_invest, 2),
            "total_eval": round(total_eval, 2),
            "total_pnl": round(total_pnl, 2),
            "total_pnl_pct": round(total_pnl / total_invest * 100, 4) if total_invest > 0 else 0,
            "count": len(rows),
        },
    }


@router.post("")
async def add_holding(body: HoldingCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(
        select(PortfolioHolding).where(PortfolioHolding.stock_code == body.stock_code)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"{body.stock_code} 이미 등록된 종목입니다.")

    h = PortfolioHolding(
        stock_code=body.stock_code.strip().upper(),
        stock_name=body.stock_name,
        quantity=body.quantity,
        avg_buy_price=body.avg_buy_price,
        buy_date=date.fromisoformat(body.buy_date) if body.buy_date else None,
        memo=body.memo,
        source="MANUAL",
    )
    db.add(h)

    # 거래 내역에도 BUY 기록
    tx = PortfolioTransaction(
        stock_code=h.stock_code,
        stock_name=body.stock_name,
        transaction_type="BUY",
        quantity=body.quantity,
        price=body.avg_buy_price,
        amount=body.quantity * body.avg_buy_price,
        transaction_date=date.fromisoformat(body.buy_date) if body.buy_date else date.today(),
        memo=body.memo,
    )
    db.add(tx)
    await db.commit()
    await db.refresh(h)
    return _h(h)


@router.put("/{holding_id}")
async def update_holding(
    holding_id: int, body: HoldingUpdate, db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(PortfolioHolding).where(PortfolioHolding.id == holding_id)
    )
    h = result.scalar_one_or_none()
    if not h:
        raise HTTPException(status_code=404, detail="종목을 찾을 수 없습니다.")

    for field, value in body.model_dump(exclude_none=True).items():
        if field == "buy_date" and value:
            value = date.fromisoformat(value)
        setattr(h, field, value)

    _recalc(h)
    await db.commit()
    await db.refresh(h)
    return _h(h)


@router.delete("/{holding_id}")
async def delete_holding(holding_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(PortfolioHolding).where(PortfolioHolding.id == holding_id)
    )
    h = result.scalar_one_or_none()
    if not h:
        raise HTTPException(status_code=404, detail="종목을 찾을 수 없습니다.")
    await db.delete(h)
    await db.commit()
    return {"message": "삭제됨"}


# ── 시세 동기화 ──────────────────────────────────────────

@router.post("/refresh-prices")
async def refresh_prices(db: AsyncSession = Depends(get_db)):
    """토스증권 API로 현재가 일괄 업데이트"""
    result = await db.execute(select(PortfolioHolding))
    holdings = result.scalars().all()

    api = TossApiClient.get_instance()
    updated = 0
    errors = []

    for h in holdings:
        try:
            price_info = await api.get_current_price(h.stock_code)
            # 토스증권 응답 필드: lastPrice 또는 price
            price = float(
                price_info.get("lastPrice",
                price_info.get("price",
                price_info.get("currentPrice", 0)))
            )
            if price > 0:
                h.current_price = price
                _recalc(h)
                updated += 1
        except Exception as e:
            errors.append({"stock_code": h.stock_code, "error": str(e)})

    await db.commit()
    return {
        "updated": updated,
        "total": len(holdings),
        "errors": errors,
    }


@router.post("/sync-from-toss")
async def sync_from_toss(db: AsyncSession = Depends(get_db)):
    """
    토스증권 GET /api/v1/holdings 으로 보유 종목 동기화.
    응답 필드: symbol, name, quantity, averagePurchasePrice, lastPrice, profitLoss
    """
    api = TossApiClient.get_instance()
    try:
        positions = await api.get_holdings()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"토스증권 API 오류: {e}")

    if not positions:
        return {"synced": 0, "message": "보유 종목이 없습니다."}

    synced = 0
    skipped = 0

    for pos in positions:
        # 실제 API 필드명 매핑
        code = pos.get("symbol", "")
        if not code:
            skipped += 1
            continue

        name = pos.get("name", "")
        qty_raw = pos.get("quantity", 0)
        qty = float(qty_raw) if qty_raw else 0  # 소수 수량(해외주식 분할매수) 허용
        avg_price = float(pos.get("averagePurchasePrice") or 0)
        last_price = pos.get("lastPrice")
        current_price = float(last_price) if last_price else avg_price

        if qty <= 0:
            # 수량이 0이면 보유 종목에서 제거
            result = await db.execute(
                select(PortfolioHolding).where(PortfolioHolding.stock_code == code)
            )
            h = result.scalar_one_or_none()
            if h:
                await db.delete(h)
            skipped += 1
            continue

        result = await db.execute(
            select(PortfolioHolding).where(PortfolioHolding.stock_code == code)
        )
        h = result.scalar_one_or_none()

        if h:
            # 기존 종목 업데이트 (종목명은 비어있을 때만 덮어씀)
            h.quantity = qty
            h.avg_buy_price = avg_price
            h.current_price = current_price
            if not h.stock_name:
                h.stock_name = name
            h.source = "TOSS_SYNC"
            _recalc(h)
        else:
            h = PortfolioHolding(
                stock_code=code,
                stock_name=name,
                quantity=qty,
                avg_buy_price=avg_price,
                current_price=current_price,
                source="TOSS_SYNC",
            )
            _recalc(h)
            db.add(h)

        synced += 1

    await db.commit()
    return {
        "synced": synced,
        "skipped": skipped,
        "message": f"{synced}개 종목 동기화 완료",
    }


# ── 거래 내역 ────────────────────────────────────────────

@router.get("/transactions")
async def list_transactions(
    stock_code: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(PortfolioTransaction).order_by(
        PortfolioTransaction.transaction_date.desc(),
        PortfolioTransaction.created_at.desc(),
    )
    if stock_code:
        query = query.where(PortfolioTransaction.stock_code == stock_code)
    result = await db.execute(query)
    return [_t(t) for t in result.scalars().all()]


@router.post("/transactions")
async def add_transaction(body: TransactionCreate, db: AsyncSession = Depends(get_db)):
    amount = body.quantity * body.price
    tx = PortfolioTransaction(
        stock_code=body.stock_code.strip().upper(),
        stock_name=body.stock_name,
        transaction_type=body.transaction_type,
        quantity=body.quantity,
        price=body.price,
        amount=amount,
        commission=body.commission,
        transaction_date=date.fromisoformat(body.transaction_date),
        memo=body.memo,
    )
    db.add(tx)

    # 보유 종목 평균단가 재계산 (BUY인 경우)
    if body.transaction_type == "BUY":
        result = await db.execute(
            select(PortfolioHolding).where(PortfolioHolding.stock_code == tx.stock_code)
        )
        h = result.scalar_one_or_none()
        if h:
            old_amt = float(h.avg_buy_price) * h.quantity
            new_amt = body.price * body.quantity
            total_qty = h.quantity + body.quantity
            h.avg_buy_price = (old_amt + new_amt) / total_qty
            h.quantity = total_qty
            _recalc(h)
        else:
            h = PortfolioHolding(
                stock_code=tx.stock_code,
                stock_name=body.stock_name,
                quantity=body.quantity,
                avg_buy_price=body.price,
                buy_date=date.fromisoformat(body.transaction_date),
                source="MANUAL",
            )
            db.add(h)

    elif body.transaction_type == "SELL":
        result = await db.execute(
            select(PortfolioHolding).where(PortfolioHolding.stock_code == tx.stock_code)
        )
        h = result.scalar_one_or_none()
        if h:
            h.quantity = max(0, h.quantity - body.quantity)
            if h.quantity == 0:
                await db.delete(h)

    await db.commit()
    await db.refresh(tx)
    return _t(tx)
