import json
import logging
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.daily_snapshot import DailyAccountSnapshot
from app.models.news import AutoTradeLog

log = logging.getLogger(__name__)


async def save_daily_snapshot(db: AsyncSession) -> bool:
    """오늘자 계좌 잔고·보유종목을 DB에 저장. 이미 오늘 스냅샷이 있으면 덮어씀."""
    from app.services.kiwoom_api import KiwoomApiClient

    today = date.today().strftime("%Y-%m-%d")
    try:
        api = KiwoomApiClient.get_instance()
        bal = await api.get_balance()
    except Exception as e:
        log.error(f"[snapshot] 잔고 조회 실패: {e}")
        return False

    holdings_raw = bal.get("stockHoldings", [])
    holdings_json = json.dumps(holdings_raw, ensure_ascii=False)

    existing_r = await db.execute(
        select(DailyAccountSnapshot).where(DailyAccountSnapshot.trade_date == today)
    )
    snap = existing_r.scalar_one_or_none()
    if snap is None:
        snap = DailyAccountSnapshot(trade_date=today)
        db.add(snap)

    snap.cash             = bal.get("cash", 0)
    snap.available_cash   = bal.get("availableCash", 0)
    snap.total_asset      = bal.get("totalAsset", 0)
    snap.total_buy_amount = bal.get("totalBuyAmount", 0)
    snap.total_pnl        = bal.get("totalPnl", 0)
    snap.total_pnl_rate   = bal.get("totalPnlRate", 0)
    snap.holdings_json    = holdings_json

    await db.commit()
    log.info(f"[snapshot] {today} 스냅샷 저장 완료 — 총자산 {snap.total_asset:,.0f}원")
    return True


async def get_snapshot_history(db: AsyncSession, days: int = 90) -> list[dict]:
    """최근 N일 일별 잔고 이력 반환 (날짜 오름차순)."""
    from sqlalchemy import func as sqlfunc
    from datetime import timedelta

    since = (date.today() - timedelta(days=days)).strftime("%Y-%m-%d")
    r = await db.execute(
        select(DailyAccountSnapshot)
        .where(DailyAccountSnapshot.trade_date >= since)
        .order_by(DailyAccountSnapshot.trade_date)
    )
    rows = r.scalars().all()

    result = []
    for s in rows:
        holdings = []
        try:
            holdings = json.loads(s.holdings_json or "[]")
        except Exception:
            pass

        # 당일 실현손익은 AutoTradeLog에서 집계 (trade_date는 DATE 컬럼 → date 객체로 비교)
        from datetime import date as _date
        trade_date_obj = _date.fromisoformat(s.trade_date)
        pnl_r = await db.execute(
            select(sqlfunc.sum(AutoTradeLog.realized_pnl)).where(
                AutoTradeLog.trade_date == trade_date_obj,
                AutoTradeLog.action == "SELL",
                AutoTradeLog.status.in_(("FILLED", "MOCK", "PENDING")),
                AutoTradeLog.realized_pnl.isnot(None),
            )
        )
        realized_pnl = float(pnl_r.scalar() or 0)

        result.append({
            "trade_date":      s.trade_date,
            "cash":            float(s.cash or 0),
            "available_cash":  float(s.available_cash or 0),
            "total_asset":     float(s.total_asset or 0),
            "total_buy_amount":float(s.total_buy_amount or 0),
            "total_pnl":       float(s.total_pnl or 0),
            "total_pnl_rate":  float(s.total_pnl_rate or 0),
            "realized_pnl":    realized_pnl,
            "holdings_count":  len(holdings),
            "holdings":        holdings,
        })
    return result
