"""
백테스트 엔진.

비용 반영 (변경 후):
  - 매수: 수수료(commission_rate) + 슬리피지(slippage_rate)
  - 매도: 수수료 + 슬리피지 + 거래세(transaction_tax_rate, 기본 0.2%)
  - 체결 가정: 신호 발생 다음 날 시가(open) — 종가 체결 look-ahead 방지
    (ohlcv_data에 'open' 컬럼이 없으면 'close'로 폴백)

Point-in-time 준수:
  - 신호 계산 시 sim_date 당일 데이터까지만 사용 (미래 데이터 미포함)
  - 체결은 sim_date + 1 영업일 시가 → 미래 open 1개만 허용 (현실 반영)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd

from app.ml.multi_models import run_all_models


@dataclass
class BacktestConfig:
    stock_codes: list[str]
    start_date: str                          # "YYYY-MM-DD"
    end_date: str
    initial_capital: float = 10_000_000
    buy_threshold: float   = 0.55            # 변경: 0.6 → 0.55 (YAML 기본값에 맞춤)
    sell_threshold: float  = 0.45
    stop_loss_pct: float   = 3.0
    take_profit_pct: float = 5.0
    max_position_amt: float = 1_000_000
    max_holdings: int       = 10
    commission_rate: float  = 0.00015        # 0.015% 편도 수수료
    transaction_tax_rate: float = 0.002      # 0.2% 거래세 (매도 시)
    slippage_rate: float    = 0.0005         # 0.05% 슬리피지 (편도)


@dataclass
class Position:
    stock_code: str
    qty: int
    avg_price: float
    entry_date: str


@dataclass
class BacktestResult:
    total_return_pct: float
    cagr_pct: float
    max_drawdown_pct: float
    sharpe_ratio: float
    win_rate: float
    profit_factor: float
    total_trades: int
    win_trades: int
    lose_trades: int
    final_capital: float
    equity_curve: list[dict]    # [{date, value, cash, invested}]
    trade_log: list[dict]       # [{date, stock_code, type, price, qty, amount, pnl, pnl_pct}]


def _buy_cost(price: float, qty: int, cfg: BacktestConfig) -> float:
    """매수 총 비용 = 체결금액 + 수수료 + 슬리피지."""
    amount = price * qty
    return amount * (1 + cfg.commission_rate + cfg.slippage_rate)


def _sell_proceeds(price: float, qty: int, cfg: BacktestConfig) -> float:
    """매도 순수령 = 체결금액 - 수수료 - 슬리피지 - 거래세."""
    amount = price * qty
    return amount * (1 - cfg.commission_rate - cfg.slippage_rate - cfg.transaction_tax_rate)


def _sell_cost_total(price: float, qty: int, cfg: BacktestConfig) -> float:
    """매도 총 비용액 (수수료 + 슬리피지 + 거래세)."""
    amount = price * qty
    return amount * (cfg.commission_rate + cfg.slippage_rate + cfg.transaction_tax_rate)


def run_backtest(
    config: BacktestConfig,
    ohlcv_data: dict[str, pd.DataFrame],
) -> BacktestResult:
    """
    ohlcv_data: 각 DataFrame은 compute()까지 완료된 상태.
    날짜 컬럼명: 'datetime' (문자열 또는 날짜).
    'open' 컬럼이 있으면 익일 시가 체결, 없으면 당일 종가 체결.
    """
    cash = config.initial_capital
    positions: dict[str, Position] = {}
    equity_curve: list[dict] = []
    trade_log: list[dict] = []

    # 날짜 유니온
    all_dates: list[str] = sorted({
        str(d)[:10]
        for df in ohlcv_data.values()
        for d in df["datetime"].tolist()
        if config.start_date <= str(d)[:10] <= config.end_date
    })

    if not all_dates:
        raise ValueError("해당 기간의 데이터가 없습니다.")

    peak_value = config.initial_capital
    max_drawdown = 0.0

    # 체결가 결정: 익일 시가(open) 선호, 없으면 당일 종가
    def _entry_price(code: str, signal_date: str) -> Optional[float]:
        """signal_date 다음 거래일의 시가 (익일 시가 체결)."""
        df = ohlcv_data.get(code)
        if df is None:
            return None
        dates = sorted(df["datetime"].astype(str).str[:10].unique())
        if signal_date not in dates:
            return None
        # 익일이 존재하면 익일 시가, 없으면 당일 종가(폴백)
        next_dates = [d for d in dates if d > signal_date]
        target = next_dates[0] if next_dates else signal_date
        col    = "open" if "open" in df.columns else "close"
        mask   = df["datetime"].astype(str).str[:10] == target
        if not mask.any():
            return None
        return float(df[mask].iloc[-1][col])

    # 당일 가격 맵 (손절/익절 체크용 — 이 날 종가로 평가)
    for sim_date in all_dates:
        daily_prices: dict[str, float] = {}
        for code, df in ohlcv_data.items():
            mask = df["datetime"].astype(str).str[:10] == sim_date
            if not mask.any():
                continue
            daily_prices[code] = float(df[mask].iloc[-1]["close"])

        # ── 손절/익절 체크 (당일 종가 기준 평가, 다음 날 시가 체결) ──
        for code in list(positions.keys()):
            if code not in daily_prices:
                continue
            pos = positions[code]
            current_price = daily_prices[code]
            pnl_pct = (current_price - pos.avg_price) / (pos.avg_price + 1e-9) * 100

            should_sell = False
            sell_reason = ""
            if pnl_pct <= -config.stop_loss_pct:
                should_sell = True
                sell_reason = "STOP_LOSS"
            elif pnl_pct >= config.take_profit_pct:
                should_sell = True
                sell_reason = "TAKE_PROFIT"

            if should_sell:
                # 실제 체결: 익일 시가 (없으면 당일 종가)
                exec_price = _entry_price(code, sim_date) or current_price
                proceeds   = _sell_proceeds(exec_price, pos.qty, config)
                cost       = _sell_cost_total(exec_price, pos.qty, config)
                pnl        = (exec_price - pos.avg_price) * pos.qty - cost
                cash      += proceeds
                trade_log.append({
                    "date":       sim_date,
                    "stock_code": code,
                    "type":       f"SELL({sell_reason})",
                    "price":      exec_price,
                    "qty":        pos.qty,
                    "amount":     exec_price * pos.qty,
                    "pnl":        round(pnl, 2),
                    "pnl_pct":    round(pnl_pct, 2),
                })
                del positions[code]

        # ── 신호 생성 및 매수 ──────────────────────────────────────
        for code, df in ohlcv_data.items():
            if len(positions) >= config.max_holdings:
                break
            if code in positions:
                continue

            # point-in-time: sim_date 이하만
            mask = df["datetime"].astype(str).str[:10] <= sim_date
            sub  = df[mask]
            if len(sub) < 60:
                continue

            model_result = run_all_models(
                sub,
                buy_threshold=config.buy_threshold,
                sell_threshold=config.sell_threshold,
            )
            buy_proba = model_result.get("composite_score", 0.5)

            if buy_proba < config.buy_threshold:
                continue

            # 익일 시가 체결
            exec_price = _entry_price(code, sim_date)
            if not exec_price or exec_price <= 0:
                continue

            budget = min(config.max_position_amt, cash)
            if budget < exec_price:
                continue

            qty = int(budget // exec_price)
            if qty <= 0:
                continue

            total_cost = _buy_cost(exec_price, qty, config)
            if total_cost > cash:
                continue

            cash -= total_cost
            positions[code] = Position(
                stock_code=code,
                qty=qty,
                avg_price=exec_price,
                entry_date=sim_date,
            )
            trade_log.append({
                "date":       sim_date,
                "stock_code": code,
                "type":       "BUY",
                "price":      exec_price,
                "qty":        qty,
                "amount":     exec_price * qty,
                "pnl":        0.0,
                "pnl_pct":    0.0,
            })

        # ── 평가잔고 계산 ──────────────────────────────────────────
        invested = sum(
            positions[c].qty * daily_prices.get(c, positions[c].avg_price)
            for c in positions
        )
        total_value  = cash + invested
        peak_value   = max(peak_value, total_value)
        drawdown     = (peak_value - total_value) / (peak_value + 1e-9) * 100
        max_drawdown = max(max_drawdown, drawdown)

        equity_curve.append({
            "date":     sim_date,
            "value":    round(total_value, 2),
            "cash":     round(cash, 2),
            "invested": round(invested, 2),
        })

    # ── 잔여 포지션 청산 (마지막 날) ──────────────────────────
    last_date = all_dates[-1] if all_dates else config.end_date
    for code, pos in list(positions.items()):
        price     = daily_prices.get(code, pos.avg_price)
        proceeds  = _sell_proceeds(price, pos.qty, config)
        cost      = _sell_cost_total(price, pos.qty, config)
        pnl       = (price - pos.avg_price) * pos.qty - cost
        pnl_pct   = (price - pos.avg_price) / (pos.avg_price + 1e-9) * 100
        cash     += proceeds
        trade_log.append({
            "date":       last_date,
            "stock_code": code,
            "type":       "SELL(CLOSE)",
            "price":      price,
            "qty":        pos.qty,
            "amount":     price * pos.qty,
            "pnl":        round(pnl, 2),
            "pnl_pct":    round(pnl_pct, 2),
        })
    final_capital = cash

    # ── 성과 지표 ─────────────────────────────────────────────
    sell_trades = [t for t in trade_log if t["type"].startswith("SELL")]
    win_trades  = [t for t in sell_trades if t["pnl"] > 0]
    lose_trades = [t for t in sell_trades if t["pnl"] <= 0]

    total_return_pct = (final_capital - config.initial_capital) / config.initial_capital * 100

    days_elapsed = max(1, (
        datetime.strptime(config.end_date,   "%Y-%m-%d") -
        datetime.strptime(config.start_date, "%Y-%m-%d")
    ).days)
    years    = days_elapsed / 365.0
    cagr_pct = ((final_capital / config.initial_capital) ** (1 / years) - 1) * 100

    if len(equity_curve) > 1:
        vals         = [e["value"] for e in equity_curve]
        daily_ret    = np.diff(vals) / (np.array(vals[:-1]) + 1e-9)
        rf_daily     = 0.025 / 252
        excess       = daily_ret - rf_daily
        sharpe       = float(np.mean(excess) / (np.std(excess) + 1e-9) * math.sqrt(252))
    else:
        sharpe = 0.0

    gross_profit  = sum(t["pnl"] for t in win_trades)
    gross_loss    = abs(sum(t["pnl"] for t in lose_trades))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")
    win_rate      = len(win_trades) / len(sell_trades) * 100 if sell_trades else 0.0

    return BacktestResult(
        total_return_pct=round(total_return_pct, 4),
        cagr_pct=round(cagr_pct, 4),
        max_drawdown_pct=round(max_drawdown, 4),
        sharpe_ratio=round(sharpe, 4),
        win_rate=round(win_rate, 4),
        profit_factor=round(min(profit_factor, 999.0), 4),
        total_trades=len(trade_log),
        win_trades=len(win_trades),
        lose_trades=len(lose_trades),
        final_capital=round(final_capital, 2),
        equity_curve=equity_curve,
        trade_log=trade_log,
    )
