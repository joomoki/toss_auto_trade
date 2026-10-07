"""
리스크 가드

매매 실행 전 다음을 검사:
1. 일일 최대 손실 한도 (circuit breaker)
2. 종목당 최대 비중
3. 섹터당 최대 비중
4. 현금 비중 하한
5. 중복 주문 방지
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class RiskConfig:
    max_position_pct: float = 0.20    # 종목당 포트폴리오의 최대 20%
    max_sector_pct:   float = 0.40    # 섹터당 최대 40%
    min_cash_pct:     float = 0.20    # 최소 현금 비중 20%
    max_daily_loss:   float = 0.05    # 일일 최대 손실 5%
    max_open_orders:  int   = 3       # 동시 최대 주문 수


@dataclass
class PortfolioState:
    total_equity:     float           # 총 평가금액
    cash:             float           # 예수금
    realized_pnl:     float           # 오늘 실현손익
    positions:        dict[str, int]  # {stock_code: quantity}
    pending_orders:   set[str]        # 대기 중 주문 종목코드


class RiskViolation(Exception):
    pass


class RiskGuard:
    def __init__(self, cfg: RiskConfig | None = None):
        self.cfg = cfg or RiskConfig()

    def check_daily_loss(self, state: PortfolioState) -> None:
        if state.total_equity <= 0:
            return
        loss_pct = abs(min(0, state.realized_pnl)) / state.total_equity
        if loss_pct >= self.cfg.max_daily_loss:
            raise RiskViolation(
                f"일일 손실 한도 초과: {loss_pct*100:.1f}% ≥ {self.cfg.max_daily_loss*100:.1f}%"
            )

    def check_cash(self, state: PortfolioState, order_amount: float) -> None:
        after_cash = state.cash - order_amount
        if after_cash < 0:
            raise RiskViolation(f"예수금 부족: {state.cash:,.0f}원 < 주문금액 {order_amount:,.0f}원")
        if state.total_equity > 0:
            cash_pct_after = after_cash / state.total_equity
            if cash_pct_after < self.cfg.min_cash_pct:
                raise RiskViolation(
                    f"현금 비중 미달: 매수 후 {cash_pct_after*100:.1f}% < 최소 {self.cfg.min_cash_pct*100:.1f}%"
                )

    def check_position_size(self, state: PortfolioState, order_amount: float) -> None:
        if state.total_equity > 0:
            pct = order_amount / state.total_equity
            if pct > self.cfg.max_position_pct:
                raise RiskViolation(
                    f"종목 비중 초과: {pct*100:.1f}% > {self.cfg.max_position_pct*100:.1f}%"
                )

    def check_duplicate(self, state: PortfolioState, stock_code: str) -> None:
        if stock_code in state.pending_orders:
            raise RiskViolation(f"중복 주문 방지: {stock_code} 이미 대기 중")
        if stock_code in state.positions:
            raise RiskViolation(f"이미 보유 종목: {stock_code}")

    def check_open_orders(self, state: PortfolioState) -> None:
        if len(state.pending_orders) >= self.cfg.max_open_orders:
            raise RiskViolation(
                f"최대 동시 주문 수 초과: {len(state.pending_orders)} ≥ {self.cfg.max_open_orders}"
            )

    def pre_trade_check(
        self,
        state: PortfolioState,
        stock_code: str,
        order_amount: float,
    ) -> None:
        """모든 리스크 체크 통과해야 주문 실행"""
        self.check_daily_loss(state)
        self.check_duplicate(state, stock_code)
        self.check_open_orders(state)
        self.check_cash(state, order_amount)
        self.check_position_size(state, order_amount)
        logger.info(f"리스크 체크 통과: {stock_code} {order_amount:,.0f}원")


def calc_order_quantity(price: int, budget: float) -> int:
    """예산 내 최대 구매 가능 수량 (정수)"""
    if price <= 0 or budget <= 0:
        return 0
    return int(budget // price)


def calc_position_budget(
    total_equity: float,
    net_score: float,
    max_pct: float = 0.15,
) -> float:
    """
    섹터 순점수에 비례한 포지션 예산.
    net_score ∈ [0, 1] → budget ∈ [0, max_pct × equity]
    """
    return total_equity * min(1.0, net_score) * max_pct
