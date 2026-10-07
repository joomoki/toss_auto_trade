"""
매크로 섹터 로테이션 백테스트 러너

워크포워드 방식:
  1. 백테스트 시작 시 VIX / KRW 전체 기간 데이터를 한 번에 pre-fetch
  2. 각 거래일에 pre-fetch된 데이터를 인덱싱해 이벤트 시뮬레이션
  3. 섹터 선택 → 종목 매수 → 보유 기간 청산
  4. 슬리피지·수수료·증권거래세 반영
  5. MDD, 샤프비율, 벤치마크 대비 초과수익 산출
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

COMMISSION   = 0.00015   # 0.015% 수수료
TAX_RATE     = 0.002     # 0.2% 증권거래세 (매도 시)
SLIPPAGE_PCT = 0.001     # 0.1% 슬리피지


@dataclass
class BacktestConfig:
    start_date:     date
    end_date:       date
    initial_capital: float = 10_000_000
    hold_days:       int   = 5
    top_sectors:     int   = 2
    max_stocks:      int   = 2
    stop_loss_pct:   float = 5.0
    take_profit_pct: float = 10.0


@dataclass
class BacktestTrade:
    date:       date
    stock_code: str
    action:     str
    quantity:   int
    price:      float
    pnl:        float = 0.0
    reason:     str   = ""


@dataclass
class BacktestResult:
    config:          BacktestConfig
    trades:          list[BacktestTrade] = field(default_factory=list)
    equity_curve:    list[dict]          = field(default_factory=list)
    total_return:    float = 0.0
    annualized_return: float = 0.0
    max_drawdown:    float = 0.0
    sharpe_ratio:    float = 0.0
    win_rate:        float = 0.0
    total_trades:    int   = 0
    benchmark_return: float = 0.0
    excess_return:   float = 0.0


# ── 시장 데이터 pre-fetch (run_backtest 내에서 1회만 호출) ─────────────────────

def _prefetch_market_series(start: date, end: date) -> dict[str, pd.Series]:
    """
    VIX, KRW=X 종가 시리즈를 전체 기간 한 번에 내려받아 date → float 딕셔너리로 반환.
    """
    import yfinance as yf

    fetch_start = (start - timedelta(days=10)).isoformat()
    fetch_end   = (end + timedelta(days=2)).isoformat()

    result: dict[str, pd.Series] = {}
    for ticker in ("^VIX", "KRW=X"):
        try:
            hist = yf.Ticker(ticker).history(start=fetch_start, end=fetch_end)
            if hist is not None and not hist.empty:
                s = hist["Close"].dropna()
                s.index = s.index.tz_localize(None) if s.index.tz is not None else s.index
                result[ticker] = s
            else:
                result[ticker] = pd.Series(dtype=float)
        except Exception as e:
            logger.warning(f"[백테스트] {ticker} pre-fetch 실패: {e}")
            result[ticker] = pd.Series(dtype=float)
    return result


def _get_value_on_date(series: pd.Series, d: date) -> Optional[float]:
    """날짜 이하 가장 가까운 값 반환 (없으면 None)."""
    if series.empty:
        return None
    target = pd.Timestamp(d)
    idx    = series.index[series.index <= target]
    if idx.empty:
        return None
    return float(series.loc[idx[-1]])


def _get_prev_value(series: pd.Series, d: date) -> Optional[float]:
    """d 직전 거래일 값 반환."""
    if series.empty:
        return None
    target = pd.Timestamp(d)
    idx    = series.index[series.index < target]
    if idx.empty:
        return None
    return float(series.loc[idx[-1]])


# ── pykrx OHLCV 캐시 (종목당 1회만 호출) ──────────────────────────────────────

_ohlcv_cache: dict[str, pd.DataFrame] = {}


def _fetch_ohlcv_sync(stock_code: str) -> Optional[pd.DataFrame]:
    try:
        from pykrx import stock as krx
        df = krx.get_market_ohlcv_by_date(
            "20230101", date.today().strftime("%Y%m%d"), stock_code,
        )
        if df is None or df.empty:
            return None
        df.index = pd.to_datetime(df.index).tz_localize(None)
        return df
    except Exception as e:
        logger.debug(f"pykrx OHLCV 조회 실패 [{stock_code}]: {e}")
        return None


async def _ensure_ohlcv(stock_code: str) -> Optional[pd.DataFrame]:
    if stock_code in _ohlcv_cache:
        return _ohlcv_cache[stock_code]
    loop = asyncio.get_running_loop()
    df = await loop.run_in_executor(None, _fetch_ohlcv_sync, stock_code)
    if df is not None:
        _ohlcv_cache[stock_code] = df
    return df


async def _get_close(stock_code: str, d: date) -> Optional[float]:
    df = await _ensure_ohlcv(stock_code)
    if df is None:
        return None
    close_col = next((c for c in df.columns if "종가" in c), None)
    if close_col is None:
        return None
    target = pd.Timestamp(d)
    idx    = df.index[df.index <= target]
    if idx.empty:
        return None
    return float(df.loc[idx[-1], close_col])


# ── 이벤트 시뮬레이션 (pre-fetch된 시리즈 사용) ───────────────────────────────

def _simulate_events(
    d: date,
    vix_s: pd.Series,
    krw_s: pd.Series,
) -> list:
    from app.macro.schemas import MacroEvent, EventCategory
    from datetime import datetime, timezone

    events: list[MacroEvent] = []
    now = datetime.combine(d, datetime.min.time()).replace(tzinfo=timezone.utc)

    vix_now  = _get_value_on_date(vix_s, d)
    vix_prev = _get_prev_value(vix_s, d)

    if vix_now is not None and vix_prev is not None and vix_prev > 0:
        vix_chg = (vix_now - vix_prev) / vix_prev * 100
        if vix_now >= 25 or vix_chg >= 15:
            mag = min(1.0, vix_now / 40)
            events.append(MacroEvent(
                event_id="geopolitical", name="지정학 리스크",
                category=EventCategory.RISK,
                magnitude=mag, confidence=0.70, persistence=0.50,
                score=round(mag * 0.4 + 0.70 * 0.35 + 0.50 * 0.25, 4),
                detected_at=now,
                evidence=[f"VIX {vix_now:.1f} (+{vix_chg:.1f}%)"],
            ))

    krw_now  = _get_value_on_date(krw_s, d)
    krw_prev = _get_prev_value(krw_s, d)

    if krw_now is not None and krw_prev is not None and krw_prev > 0:
        krw_chg = (krw_now - krw_prev) / krw_prev * 100
        if krw_chg >= 0.7:
            mag = min(1.0, krw_chg / 2)
            events.append(MacroEvent(
                event_id="krw_weak", name="원화 약세",
                category=EventCategory.MARKET,
                magnitude=mag, confidence=0.85, persistence=0.50,
                score=round(mag * 0.4 + 0.85 * 0.35 + 0.50 * 0.25, 4),
                detected_at=now,
                evidence=[f"USD/KRW +{krw_chg:.2f}%"],
            ))
        elif krw_chg <= -0.7:
            mag = min(1.0, abs(krw_chg) / 2)
            events.append(MacroEvent(
                event_id="krw_strong", name="원화 강세",
                category=EventCategory.MARKET,
                magnitude=mag, confidence=0.85, persistence=0.50,
                score=round(mag * 0.4 + 0.85 * 0.35 + 0.50 * 0.25, 4),
                detected_at=now,
                evidence=[f"USD/KRW {krw_chg:.2f}%"],
            ))

    return events


# ── 메인 백테스트 ──────────────────────────────────────────────────────────────

async def run_backtest(cfg: BacktestConfig) -> BacktestResult:
    result  = BacktestResult(config=cfg)
    capital = cfg.initial_capital
    positions: dict[str, dict] = {}
    equity_history: list[float] = [capital]
    peak_equity = capital

    from app.macro.sector_mapper import compute_sector_signals, get_sector_stocks

    # ── 시장 데이터 1회 pre-fetch ─────────────────────────────
    loop   = asyncio.get_running_loop()
    series = await loop.run_in_executor(
        None, _prefetch_market_series, cfg.start_date, cfg.end_date,
    )
    vix_s = series.get("^VIX", pd.Series(dtype=float))
    krw_s = series.get("KRW=X", pd.Series(dtype=float))
    logger.info(f"[백테스트] VIX {len(vix_s)}일, KRW {len(krw_s)}일 pre-fetch 완료")

    current = cfg.start_date

    while current <= cfg.end_date:
        if current.weekday() >= 5:
            current += timedelta(days=1)
            continue

        # ── 보유 종목 청산 체크 ───────────────────────
        to_sell: list[str] = []
        for code, pos in positions.items():
            current_price = await _get_close(code, current)
            if current_price is None:
                continue
            pnl_pct  = (current_price - pos["price"]) / pos["price"] * 100
            hold_days = (current - pos["buy_date"]).days

            reason = ""
            if pnl_pct <= -cfg.stop_loss_pct:
                reason = f"손절 {pnl_pct:.1f}%"
            elif pnl_pct >= cfg.take_profit_pct:
                reason = f"익절 {pnl_pct:.1f}%"
            elif hold_days >= cfg.hold_days:
                reason = f"보유기간 {hold_days}일"

            if reason:
                sell_price = current_price * (1 - SLIPPAGE_PCT) * (1 - COMMISSION - TAX_RATE)
                pnl        = (sell_price - pos["price"]) * pos["qty"]
                capital   += sell_price * pos["qty"]
                result.trades.append(BacktestTrade(
                    date=current, stock_code=code, action="SELL",
                    quantity=pos["qty"], price=sell_price, pnl=pnl, reason=reason,
                ))
                to_sell.append(code)

        for code in to_sell:
            del positions[code]

        # ── 신규 매수 ───────────────────────────────
        pseudo_events = _simulate_events(current, vix_s, krw_s)
        if pseudo_events:
            signals = compute_sector_signals(pseudo_events)
            top = [s for s in signals if s.net_score >= 0.20][:cfg.top_sectors]

            for sig in top:
                candidates = get_sector_stocks(sig.sector_id)
                budget_per_stock = (capital * 0.15 * sig.net_score) / max(1, cfg.max_stocks)

                for stock in candidates[:cfg.max_stocks]:
                    code = stock["code"]
                    if code in positions:
                        continue

                    close = await _get_close(code, current)
                    if close is None:
                        continue

                    price = close * (1 + SLIPPAGE_PCT + COMMISSION)
                    qty   = int(budget_per_stock // price)
                    if qty <= 0:
                        continue

                    cost = price * qty
                    if cost > capital:
                        continue

                    capital -= cost
                    positions[code] = {
                        "price": price, "qty": qty,
                        "buy_date": current, "sector": sig.sector_id,
                    }
                    result.trades.append(BacktestTrade(
                        date=current, stock_code=code, action="BUY",
                        quantity=qty, price=price,
                        reason=f"섹터:{sig.sector_name}",
                    ))

        # ── 에쿼티 곡선 ──────────────────────────────
        pos_vals = []
        for code, pos in positions.items():
            c = await _get_close(code, current)
            pos_vals.append((c if c is not None else pos["price"]) * pos["qty"])
        portfolio_value = capital + sum(pos_vals)

        equity_history.append(portfolio_value)
        if portfolio_value > peak_equity:
            peak_equity = portfolio_value
        drawdown = (peak_equity - portfolio_value) / peak_equity

        result.equity_curve.append({
            "date":     current.isoformat(),
            "equity":   round(portfolio_value, 0),
            "drawdown": round(drawdown, 4),
        })

        current += timedelta(days=1)

    # ── 성과 계산 ────────────────────────────────────
    final_equity = equity_history[-1] if equity_history else cfg.initial_capital
    result.total_return = (final_equity - cfg.initial_capital) / cfg.initial_capital

    n_years = max((cfg.end_date - cfg.start_date).days / 365, 0.1)
    result.annualized_return = (1 + result.total_return) ** (1 / n_years) - 1

    peak = equity_history[0]
    max_dd = 0.0
    for eq in equity_history:
        if eq > peak:
            peak = eq
        dd = (peak - eq) / peak
        if dd > max_dd:
            max_dd = dd
    result.max_drawdown = max_dd

    if len(equity_history) > 1:
        daily_rets = pd.Series(equity_history).pct_change().dropna()
        rf_daily   = 0.035 / 252
        excess     = daily_rets - rf_daily
        if excess.std() > 0:
            result.sharpe_ratio = float(excess.mean() / excess.std() * (252 ** 0.5))

    sell_trades = [t for t in result.trades if t.action == "SELL"]
    result.total_trades = len(sell_trades)
    if sell_trades:
        wins = sum(1 for t in sell_trades if t.pnl > 0)
        result.win_rate = wins / len(sell_trades)

    # 벤치마크 (KOSPI)
    try:
        import yfinance as yf
        kospi = await loop.run_in_executor(
            None,
            lambda: yf.Ticker("^KS11").history(
                start=cfg.start_date.isoformat(),
                end=cfg.end_date.isoformat(),
            ),
        )
        if kospi is not None and len(kospi) >= 2:
            bm_start = float(kospi["Close"].iloc[0])
            bm_end   = float(kospi["Close"].iloc[-1])
            result.benchmark_return = (bm_end - bm_start) / bm_start
            result.excess_return    = result.total_return - result.benchmark_return
    except Exception as e:
        logger.debug(f"벤치마크 조회 실패: {e}")

    return result
