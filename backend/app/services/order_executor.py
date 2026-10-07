from datetime import date, datetime
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.trade import Trade
from app.models.signal import TradeSignal
from app.services.toss_api import TossApiClient
from app.core.config import settings


class OrderExecutor:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.api = TossApiClient.get_instance()

    async def execute(
        self,
        signal: TradeSignal,
        quantity: int,
        price: int,
    ) -> Optional[Trade]:
        """
        신호 기반 주문 실행. AUTO_TRADE_ENABLED=false 시 모의 처리.
        signal_id 기반 중복 주문 방지.
        """
        existing = await self.db.execute(
            select(Trade).where(Trade.signal_id == signal.id)
        )
        if existing.scalar_one_or_none():
            return None

        trade = Trade(
            signal_id=signal.id,
            stock_code=signal.stock_code,
            stock_name=signal.stock_name,
            trade_type=signal.signal_type,
            order_qty=quantity,
            order_price=price,
            status="PENDING",
            trade_date=date.today(),
        )

        if not settings.auto_trade_enabled:
            trade.order_id = f"MOCK-{signal.id}-{int(datetime.now().timestamp())}"
            trade.filled_qty = quantity
            trade.filled_price = price
            trade.filled_amount = quantity * price
            trade.status = "FILLED"
            trade.filled_at = datetime.now()
        else:
            try:
                result = await self.api.place_order(
                    stock_code=signal.stock_code,
                    order_type=signal.signal_type,
                    quantity=quantity,
                    price=price,
                )
                trade.order_id = result.get("orderId") or result.get("order_id")
            except Exception as e:
                trade.status = "CANCELLED"
                trade.order_id = f"ERR-{signal.id}"

        async with self.db.begin_nested():
            self.db.add(trade)
        await self.db.flush()
        return trade

    async def check_and_update_fills(self, trade_date: str):
        """당일 PENDING 주문 체결 상태 업데이트."""
        if not settings.auto_trade_enabled:
            return

        result = await self.db.execute(
            select(Trade).where(Trade.trade_date == trade_date, Trade.status == "PENDING")
        )
        pending_trades = result.scalars().all()
        if not pending_trades:
            return

        filled_orders = await self.api.get_filled_orders(trade_date)
        filled_map = {o["orderId"]: o for o in filled_orders}

        for trade in pending_trades:
            if trade.order_id in filled_map:
                fill = filled_map[trade.order_id]
                trade.filled_qty = fill.get("filledQty", 0)
                trade.filled_price = fill.get("filledPrice")
                trade.filled_amount = fill.get("filledAmount")
                trade.status = "FILLED"
                trade.filled_at = datetime.now()
        await self.db.flush()
