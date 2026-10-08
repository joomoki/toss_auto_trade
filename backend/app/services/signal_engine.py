from datetime import date
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.signal import TradeSignal
from app.models.strategy import Strategy
from app.models.holding import Holding
from app.models.watchlist import Watchlist
from app.services.toss_api import TossApiClient
from app.services.order_executor import OrderExecutor
from app.services.risk_manager import RiskManager
from app.ml.feature_engineering import compute
from app.ml.predict import predict
from app.core.config import settings


class SignalEngine:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.api = TossApiClient.get_instance()
        self.risk_mgr = RiskManager()
        self.ws_broadcast = None  # set by main.py

    async def run(self):
        """APScheduler에서 주기적으로 호출. 장중에만 실행."""
        if not self.risk_mgr.is_market_open():
            return

        strategy = await self._get_active_strategy()
        if not strategy:
            return

        holdings_result = await self.db.execute(select(Holding))
        holdings = [{"stock_code": h.stock_code, "avg_buy_price": float(h.avg_buy_price), "current_price": float(h.current_price or 0)} for h in holdings_result.scalars().all()]

        balance = {}
        try:
            balance = await self.api.get_balance()
        except Exception:
            pass
        available_cash = float(balance.get("cash", balance.get("availableCash", 0)))
        budget = float(strategy.max_position_amt or 1_000_000)

        # 손절/익절 체크
        executor = OrderExecutor(self.db)
        for holding in holdings:
            action = self.risk_mgr.check_stop_loss_take_profit(
                holding,
                float(strategy.stop_loss_pct or 3.0),
                float(strategy.take_profit_pct or 5.0),
            )
            if action:
                price_info = await self.api.get_current_price(holding["stock_code"])
                current_price = int(price_info.get("price", holding["current_price"]))
                signal = await self._insert_signal(
                    stock_code=holding["stock_code"],
                    signal_type="SELL",
                    confidence=1.0,
                    price=current_price,
                    features={},
                    strategy_id=strategy.id,
                )
                qty = next((h.get("quantity", 0) for h in holdings if h["stock_code"] == holding["stock_code"]), 0)
                if qty:
                    await executor.execute(signal, qty, current_price)

        # DB에서 활성 관심 종목 로드
        wl_result = await self.db.execute(
            select(Watchlist).where(Watchlist.is_active == True)
        )
        watchlist_codes = [w.stock_code for w in wl_result.scalars().all()]

        # 신규 매수 신호 생성
        for stock_code in watchlist_codes:
            try:
                df = await self.api.get_ohlcv(stock_code, count=200)
                if df.empty or len(df) < 60:
                    continue
                df = compute(df)
                result = predict(df)
                buy_proba = result["buy_proba"]

                signal_type = "HOLD"
                confidence = buy_proba
                if buy_proba >= float(strategy.buy_threshold or 0.6):
                    signal_type = "BUY"
                elif result["sell_proba"] >= float(strategy.sell_threshold or 0.6):
                    signal_type = "SELL"

                price_info = await self.api.get_current_price(stock_code)
                current_price = int(price_info.get("price", 0))

                signal = await self._insert_signal(
                    stock_code=stock_code,
                    signal_type=signal_type,
                    confidence=confidence,
                    price=current_price,
                    features=result["features"],
                    strategy_id=strategy.id,
                )

                if signal_type == "BUY":
                    allowed, reason = self.risk_mgr.check_buy_conditions(
                        stock_code, confidence, holdings, available_cash, budget
                    )
                    qty = self.risk_mgr.calculate_order_quantity(current_price, budget) if allowed else 0
                    if qty > 0:
                        trade = await executor.execute(signal, qty, current_price)
                        if trade and self.ws_broadcast:
                            await self.ws_broadcast({"type": "signal", "data": {
                                "stock_code": stock_code,
                                "signal_type": signal_type,
                                "confidence": confidence,
                                "price": current_price,
                            }})

            except Exception as e:
                print(f"Signal generation error for {stock_code}: {e}")

        await self.db.commit()

    async def _get_active_strategy(self) -> Optional[Strategy]:
        result = await self.db.execute(
            select(Strategy).where(Strategy.is_active == True).limit(1)
        )
        return result.scalar_one_or_none()

    async def _insert_signal(
        self,
        stock_code: str,
        signal_type: str,
        confidence: float,
        price: int,
        features: dict,
        strategy_id: int,
    ) -> TradeSignal:
        signal = TradeSignal(
            stock_code=stock_code,
            signal_type=signal_type,
            confidence=confidence,
            price_at_signal=price,
            features=features,
            strategy_id=strategy_id,
        )
        self.db.add(signal)
        await self.db.flush()
        return signal
