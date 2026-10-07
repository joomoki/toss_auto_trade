"""
매크로 섹터 로테이션 — 메인 파이프라인

[이벤트 감지] → [섹터 매핑] → [신호 정규화] → [종목 선정] → [리스크 체크] → [주문 실행]

PAPER 모드: 로그만, 실주문 없음
LIVE  모드: 키움 REST API로 실주문
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from app.macro.schemas import (
    MacroEvent, MacroOrder, PipelineResult, SectorSignal, TradeMode,
)

logger = logging.getLogger(__name__)

# 관망 구간 — |net_score| < 이 값이면 거래하지 않음
NEUTRAL_THRESHOLD = 0.20

# 오버웨이트 섹터 최대 수
MAX_OVERWEIGHT_SECTORS = 3


async def run_pipeline(mode: TradeMode = TradeMode.PAPER) -> PipelineResult:
    """
    전체 파이프라인 1회 실행.
    APScheduler에서 30분마다 호출하거나 API에서 수동 실행.
    자동매매(auto_trade)가 LIVE 상태이면 매크로는 PAPER로 강제 전환.
    """
    from app.macro.event_detector import detect_events
    from app.macro.sector_mapper import compute_sector_signals, explain_signal, get_sector_stocks, load_map_config
    from app.macro.stock_selector import select_stocks
    from app.macro.risk_guard import RiskGuard, RiskViolation, calc_order_quantity, calc_position_budget
    from app.services.kiwoom_api import KiwoomApiClient
    from app.core.config import settings

    log: list[str] = []
    now = datetime.now(timezone.utc)

    # 자동매매와 매크로가 동시에 LIVE 실행되면 주문 충돌 → 매크로는 항상 PAPER 처리
    if mode == TradeMode.LIVE and settings.auto_trade_enabled:
        mode = TradeMode.PAPER
        log.append("[경고] 자동매매 활성화 중 — 매크로 LIVE 주문 차단 (PAPER 모드로 전환)")

    # ── 1. 이벤트 감지 ────────────────────────────────────────
    cfg = load_map_config()
    events: list[MacroEvent] = await detect_events(cfg)
    log.append(f"[이벤트] {len(events)}개 감지")
    for ev in events:
        log.append(f"  · {ev.name}: 강도={ev.magnitude:.2f}, 신뢰={ev.confidence:.2f}, 점수={ev.score:.2f}")
        for ev_ev in ev.evidence:
            log.append(f"    근거: {ev_ev}")

    if not events:
        log.append("[종료] 활성 이벤트 없음 — 관망")
        return PipelineResult(run_at=now, mode=mode, events=[], sector_signals=[], orders_placed=[], log=log)

    # ── 2. 섹터 신호 산출 ──────────────────────────────────────
    sector_signals: list[SectorSignal] = compute_sector_signals(events)
    for sig in sector_signals:
        log.extend(explain_signal(sig))

    # ── 3. 오버웨이트 섹터 필터 ────────────────────────────────
    overweight = [
        s for s in sector_signals
        if s.net_score >= NEUTRAL_THRESHOLD
    ][:MAX_OVERWEIGHT_SECTORS]

    if not overweight:
        log.append("[종료] 모든 섹터 관망 구간 — 거래 없음")
        return PipelineResult(
            run_at=now, mode=mode,
            events=events, sector_signals=sector_signals,
            orders_placed=[], log=log,
        )

    log.append(f"[오버웨이트] {[s.sector_name for s in overweight]}")

    # ── 4. 포트폴리오 상태 조회 ────────────────────────────────
    try:
        api = KiwoomApiClient.get_instance()
        balance = await api.get_balance()
        holdings_raw = await api.get_holdings()
        cash        = float(balance.get("cash", 0))
        total_equity = float(balance.get("total_equity", cash))
    except Exception as e:
        log.append(f"[경고] 잔고 조회 실패: {e} — 현금 0으로 진행")
        cash, total_equity = 0.0, 0.0
        holdings_raw = []

    existing_codes = {h["stock_code"] for h in holdings_raw}

    from app.macro.risk_guard import PortfolioState, RiskConfig
    state = PortfolioState(
        total_equity=total_equity,
        cash=cash,
        realized_pnl=0.0,
        positions={h["stock_code"]: h.get("quantity", 0) for h in holdings_raw},
        pending_orders=set(),
    )
    guard = RiskGuard(RiskConfig())

    # ── 5. 종목 선정 + 주문 실행 ──────────────────────────────
    orders_placed: list[MacroOrder] = []

    for sig in overweight:
        candidates = get_sector_stocks(sig.sector_id)
        selected   = await select_stocks(sig.sector_id, candidates, existing_codes)

        if not selected:
            log.append(f"[{sig.sector_name}] 선정 종목 없음")
            continue

        # 섹터 예산 = 포트폴리오의 (net_score × 15%)
        sector_budget = calc_position_budget(total_equity, sig.net_score)
        per_stock_budget = sector_budget / len(selected)

        for stock in selected:
            code = stock["code"]
            name = stock["name"]

            try:
                price_info = await api.get_current_price(code)
                price = int(price_info.get("price", 0))
                if price <= 0:
                    log.append(f"  [{name}] 현재가 조회 실패")
                    continue

                qty = calc_order_quantity(price, per_stock_budget)
                if qty <= 0:
                    log.append(f"  [{name}] 예산 부족 (예산={per_stock_budget:,.0f}원, 현재가={price:,})")
                    continue

                order_amt = price * qty
                guard.pre_trade_check(state, code, order_amt)

                order = MacroOrder(
                    order_id=str(uuid.uuid4())[:8],
                    stock_code=code,
                    stock_name=name,
                    action="BUY",
                    quantity=qty,
                    price=price,
                    mode=mode,
                    reason=f"매크로[{sig.sector_name}] 순점수={sig.net_score:+.2f} {stock['reason']}",
                    created_at=now,
                )

                if mode == TradeMode.LIVE:
                    result = await api.place_order(code, "BUY", qty, price)
                    order.filled = bool(result.get("order_no"))
                    log.append(f"  [LIVE 매수] {name} {qty}주 @{price:,}원 → {result}")
                else:
                    order.filled = True  # 페이퍼는 즉시 체결로 간주
                    log.append(f"  [PAPER 매수] {name} {qty}주 @{price:,}원 (모의)")

                orders_placed.append(order)
                state.cash -= order_amt
                state.pending_orders.add(code)
                existing_codes.add(code)

            except RiskViolation as rv:
                log.append(f"  [{name}] 리스크 차단: {rv}")
            except Exception as e:
                log.append(f"  [{name}] 오류: {e}")

    # ── 6. 결과 DB 저장 ────────────────────────────────────────
    await _save_run(events, sector_signals, orders_placed, mode)

    return PipelineResult(
        run_at=now, mode=mode,
        events=events,
        sector_signals=sector_signals,
        orders_placed=orders_placed,
        log=log,
    )


async def _save_run(
    events: list[MacroEvent],
    signals: list[SectorSignal],
    orders: list[MacroOrder],
    mode: TradeMode,
) -> None:
    """실행 결과를 DB에 기록"""
    try:
        from app.core.database import AsyncSessionLocal
        from app.models.macro import MacroRunLog
        import json

        async with AsyncSessionLocal() as db:
            run = MacroRunLog(
                mode=mode.value,
                events_json=[
                    {"id": e.event_id, "name": e.name, "score": e.score}
                    for e in events
                ],
                signals_json=[
                    {"sector": s.sector_id, "net": s.net_score, "dir": s.direction.value}
                    for s in signals
                ],
                orders_count=len(orders),
            )
            db.add(run)
            await db.commit()
    except Exception as e:
        logger.warning(f"매크로 실행 로그 저장 실패: {e}")


# ── 이벤트 소멸 시 자동 청산 ─────────────────────────────────────────────────

async def auto_liquidate_on_event_reversal(
    mode: TradeMode = TradeMode.PAPER,
) -> list[str]:
    """
    현재 이벤트 신호가 진입 당시와 반전되면 보유 포지션 청산.
    (일 1회 또는 신호 변경 시 호출)
    """
    from app.macro.event_detector import detect_events
    from app.macro.sector_mapper import compute_sector_signals, load_map_config
    from app.services.kiwoom_api import KiwoomApiClient

    log = []
    cfg = load_map_config()

    try:
        events  = await detect_events(cfg)
        signals = compute_sector_signals(events)
        underweight = {s.sector_id for s in signals if s.net_score <= -NEUTRAL_THRESHOLD}

        if not underweight:
            return log

        api      = KiwoomApiClient.get_instance()
        holdings = await api.get_holdings()

        for h in holdings:
            code = h.get("stock_code", "")
            # 메타에서 섹터 찾기
            sector = _find_stock_sector(code, load_map_config())
            if sector and sector in underweight:
                qty = h.get("quantity", 0)
                if qty > 0:
                    price_info = await api.get_current_price(code)
                    price = int(price_info.get("price", 0))
                    if mode == TradeMode.LIVE:
                        await api.place_order(code, "SELL", qty, price)
                    log.append(f"[청산] {code} {qty}주 — 섹터 {sector} 신호 반전")
    except Exception as e:
        log.append(f"자동 청산 오류: {e}")

    return log


def _find_stock_sector(stock_code: str, cfg: dict) -> str | None:
    for sid, sec in cfg.get("sectors", {}).items():
        for stock in sec.get("representative_stocks", []):
            if stock.get("code") == stock_code:
                return sid
    return None
