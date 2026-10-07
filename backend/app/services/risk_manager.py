from datetime import datetime, time
from typing import Optional
import pytz

from app.core.config import settings


SEOUL_TZ = pytz.timezone("Asia/Seoul")
MARKET_OPEN = time(9, 0)
MARKET_CLOSE = time(15, 30)
PRE_CLOSE_BUFFER_MINUTES = 5   # 15:25까지 신규 주문 허용 (마감 5분 전 컷오프)


class RiskManager:
    def __init__(self):
        self.max_holdings = settings.max_holdings

    def is_market_open(self) -> bool:
        now = datetime.now(SEOUL_TZ)
        if now.weekday() >= 5:
            return False
        current = now.time()
        cutoff = time(MARKET_CLOSE.hour, MARKET_CLOSE.minute - PRE_CLOSE_BUFFER_MINUTES)
        return MARKET_OPEN <= current <= cutoff

    def check_buy_conditions(
        self,
        stock_code: str,
        signal_confidence: float,
        current_holdings: list[dict],
        available_cash: float,
        strategy_budget: float,
    ) -> tuple[bool, str]:
        """
        Returns (allowed: bool, reason: str)
        """
        if not self.is_market_open():
            return False, "장 운영 시간 외"

        if len(current_holdings) >= self.max_holdings:
            return False, f"최대 보유 종목 수 초과 ({self.max_holdings}종목)"

        holding_codes = {h["stock_code"] for h in current_holdings}
        if stock_code in holding_codes:
            return False, "이미 보유 중인 종목"

        if available_cash < strategy_budget:
            return False, f"예수금 부족 (가용: {available_cash:,.0f}원)"

        return True, "OK"

    def check_stop_loss_take_profit(
        self, holding: dict, stop_loss_pct: float, take_profit_pct: float
    ) -> Optional[str]:
        """
        Returns 'STOP_LOSS', 'TAKE_PROFIT', or None.
        holding dict expects: avg_buy_price, current_price
        """
        avg_price = float(holding.get("avg_buy_price", 0))
        current = float(holding.get("current_price", 0))
        if avg_price <= 0 or current <= 0:
            return None

        pnl_pct = (current - avg_price) / avg_price * 100
        if pnl_pct <= -stop_loss_pct:
            return "STOP_LOSS"
        if pnl_pct >= take_profit_pct:
            return "TAKE_PROFIT"
        return None

    def calculate_order_quantity(self, price: float, budget_per_stock: float, atr: Optional[float] = None, **_) -> int:
        """레거시 호환용 — calculate_smart_quantity 로 위임."""
        return self.calculate_smart_quantity(price, budget_per_stock, atr=atr)

    def calculate_smart_quantity(
        self,
        price: float,
        budget: float,
        supply_score: float = 0.5,
        composite_score: float = 0.6,
        atr: Optional[float] = None,
        max_budget_mult: float = 1.5,
    ) -> int:
        """
        수급·AI점수 기반 스마트 포지션 사이징.

        ① 기본 수량 = budget // price
        ② 수급 승수: supply 0.5→1.0×, 0.65→1.15×, 0.75→1.30×, 0.85→1.45×, 0.9+→1.5×
        ③ AI점수 승수: score 0.6→1.0×, 0.75→1.15×, 0.85→1.25×, 0.9+→1.3×
        ④ ATR 상한: 허용손실(budget×5%) / ATR×2 — 1주 미만이면 최소 base_qty//2 보장
        ⑤ 최대 position = budget × max_budget_mult (현금 초과 여부는 호출부에서 체크)
        """
        if price <= 0 or budget <= 0:
            return 0

        base_qty = int(budget // price)
        if base_qty < 1:
            return 1

        # ── 수급 승수 (0.5 기준, 최대 +50%) ─────────────────
        supply_boost = max(0.0, min(0.5, (supply_score - 0.5) * 1.0))
        supply_mult  = 1.0 + supply_boost

        # ── AI 점수 승수 (0.6 기준, 최대 +30%) ──────────────
        score_boost = max(0.0, min(0.3, (composite_score - 0.6) * 1.5))
        score_mult  = 1.0 + score_boost

        smart_qty = int(base_qty * supply_mult * score_mult)

        # ── ATR 상한 (너무 제한적이지 않게 보정) ─────────────
        if atr and atr > 0:
            risk_amount   = budget * 0.05          # 허용 손실 5%
            risk_per_share = atr * 2.0
            atr_max = int(risk_amount / risk_per_share) if risk_per_share > 0 else smart_qty
            # ATR이 너무 보수적이면 최소 base_qty를 보장
            effective_max = max(base_qty, atr_max)
        else:
            effective_max = int(base_qty * max_budget_mult)

        # ── 최대 budget × 1.5 이내 ───────────────────────────
        budget_cap = int(budget * max_budget_mult // price)

        return max(1, min(smart_qty, effective_max, budget_cap))
