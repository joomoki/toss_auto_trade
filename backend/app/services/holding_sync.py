"""
kt00004 실잔고 ↔ DB holdings 동기화 (자동매매 엔진 사이클 · 5분 동기화 잡 공용).

- 보유 종목 현재가·평가손익·평균단가·수량 갱신
- PENDING BUY 중 실잔고에 있는 종목 → FILLED
- PENDING SELL 중 실잔고에서 사라진 종목 → FILLED (Holding 삭제)
- 실잔고에 없는 DB holding → 수동 매도 감지 후 삭제
- 실잔고에 있지만 DB에 없는 종목 → Holding 재생성
  (미체결 매도 등으로 Holding 이 사라져 손절 감시에서 빠지는 것을 방지)
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.market_calendar import today_kst
from app.models.holding import Holding
from app.models.news import AutoTradeLog
from app.services import telegram_notifier as tg

logger = logging.getLogger(__name__)

# 자동매매 사이클(매수·매도)과 잔고 동기화가 동시에 돌면 오래된 잔고로
# 방금 체결된 Holding 을 지우거나 되살리는 경합이 생긴다 → 같은 락으로 직렬화
TRADE_CYCLE_LOCK = asyncio.Lock()


async def _holding_flags(db: AsyncSession, stock_code: str) -> tuple[bool, bool]:
    """재생성할 Holding 의 (is_manual, is_long_term) — 마지막 BUY 로그로 판단.
    자동매매 BUY 기록이 없으면 외부(수동) 매수로 보고 자동 청산 대상에서 제외."""
    r = await db.execute(
        select(AutoTradeLog.trigger_models)
        .where(
            AutoTradeLog.stock_code == stock_code,
            AutoTradeLog.action == "BUY",
            AutoTradeLog.status != "CANCELLED",
        )
        .order_by(AutoTradeLog.created_at.desc())
        .limit(1)
    )
    row = r.first()
    if row is None:
        return True, False
    triggers = list(row[0] or [])
    return "수동매수" in triggers, "장기가치주" in triggers


async def sync_holdings_with_balance(db: AsyncSession, kt4_map: dict[str, dict]) -> None:
    """kt4_map: {종목코드: get_balance()['stockHoldings'] 항목}.
    잔고 조회에 성공했을 때만 호출할 것. kt4_map 이 비어 있으면 조회 이상과
    전량 매도를 구분할 수 없으므로 PENDING SELL 정리만 수행한다."""
    now = datetime.now(timezone.utc)

    # ── 1. 보유 종목 갱신 ─────────────────────────────────
    db_holdings = {h.stock_code: h for h in (await db.execute(select(Holding))).scalars().all()}
    for code, kt4 in kt4_map.items():
        h_obj = db_holdings.get(code)
        if not h_obj:
            continue
        if kt4.get("current_price"):
            h_obj.current_price = kt4["current_price"]
        if kt4.get("pnl") is not None:
            h_obj.unrealized_pnl = kt4["pnl"]
        if kt4.get("pnl_pct") is not None:
            h_obj.unrealized_pnl_pct = kt4["pnl_pct"]
        if kt4.get("avg_price"):
            h_obj.avg_buy_price = kt4["avg_price"]
        if int(kt4.get("quantity") or 0) > 0:
            h_obj.quantity = int(kt4["quantity"])   # 부분 체결 반영

    # ── 2. PENDING BUY → 실잔고 보유 시 FILLED ────────────
    pending_buys = (await db.execute(
        select(AutoTradeLog).where(AutoTradeLog.action == "BUY", AutoTradeLog.status == "PENDING")
    )).scalars().all()
    for pb in pending_buys:
        kt4 = kt4_map.get(pb.stock_code)
        if not kt4:
            continue
        filled_p = float(kt4.get("avg_price") or kt4.get("current_price") or pb.order_price or 0)
        filled_qty = int(pb.quantity or 0)
        pb.status = "FILLED"
        pb.filled_price = filled_p
        pb.filled_amount = filled_p * filled_qty if filled_p and filled_qty else pb.order_amount
        pb.filled_at = now
        logger.info(
            f"[잔고동기화] PENDING→FILLED 자동처리: {pb.stock_name}({pb.stock_code})"
            f" {filled_qty}주 @{filled_p:,.0f}원"
        )

    # ── 3. PENDING SELL → 실잔고에서 사라졌으면 FILLED ────
    sold_codes: set[str] = set()
    pending_sells = (await db.execute(
        select(AutoTradeLog).where(
            AutoTradeLog.action == "SELL",
            AutoTradeLog.status == "PENDING",
            AutoTradeLog.trade_date == today_kst(),   # 지난 주문은 장 마감으로 소멸 — 이력 변경 안 함
        )
    )).scalars().all()
    for ps in pending_sells:
        if ps.stock_code in kt4_map:
            continue
        ps.status = "FILLED"
        ps.filled_price = ps.order_price
        ps.filled_amount = ps.order_amount
        ps.filled_at = now
        sold_codes.add(ps.stock_code)
        logger.info(f"[잔고동기화] 매도 PENDING→FILLED 자동처리: {ps.stock_name}({ps.stock_code})")

    # ── 4. 실잔고에 없는 DB holding 삭제 ──────────────────
    for code, h in db_holdings.items():
        if code in kt4_map:
            continue
        if code in sold_codes:
            await db.delete(h)
            continue
        if not kt4_map:
            continue   # 잔고가 비어 보이면 수동매도 판단 보류
        avg = float(h.avg_buy_price or 0)
        cur = float(h.current_price or avg)
        qty = int(h.quantity or 0)
        pnl = (cur - avg) * qty
        ppct = (cur - avg) / (avg + 1e-9) * 100
        sign = "📈" if pnl >= 0 else "📉"
        logger.warning(
            f"[잔고동기화] 수동매도 감지: {h.stock_name}({code})"
            f" {qty}주 | 추정손익 {pnl:+,.0f}원 ({ppct:+.2f}%) → DB 삭제"
        )
        if tg.is_configured():
            await tg.send_message(
                f"{sign} 수동 매도 완료 감지\n"
                f"종목: {h.stock_name} ({code})\n"
                f"수량: {qty:,}주\n"
                f"평균단가: {avg:,.0f}원\n"
                f"추정 매도가: {cur:,.0f}원\n"
                f"──────────────\n"
                f"추정 손익: {pnl:+,.0f}원 ({ppct:+.2f}%)\n"
                f"※ 마지막 갱신 현재가 기준 추정값",
                msg_type="sell",
                force=True,
            )
        await db.delete(h)

    # ── 5. 실잔고에만 있는 종목 → Holding 재생성 ──────────
    for code, kt4 in kt4_map.items():
        qty = int(kt4.get("quantity") or 0)
        if code in db_holdings or qty <= 0:
            continue
        avg = float(kt4.get("avg_price") or kt4.get("current_price") or 0)
        if avg <= 0:
            continue
        is_manual, is_long_term = await _holding_flags(db, code)
        db.add(Holding(
            stock_code=code,
            stock_name=kt4.get("stock_name") or code,
            quantity=qty,
            avg_buy_price=avg,
            current_price=kt4.get("current_price") or avg,
            unrealized_pnl=kt4.get("pnl"),
            unrealized_pnl_pct=kt4.get("pnl_pct"),
            is_manual=is_manual,
            is_long_term=is_long_term,
        ))
        logger.warning(
            f"[잔고동기화] DB 누락 보유종목 복구: {kt4.get('stock_name') or code}({code}) {qty}주 "
            f"(수동={is_manual}, 장기={is_long_term})"
        )

    await db.commit()
