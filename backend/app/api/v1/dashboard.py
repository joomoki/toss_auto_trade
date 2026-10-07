from datetime import date
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.config import settings
from app.models.holding import Holding
from app.models.news import AutoTradeLog
from app.services.performance import PerformanceService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary")
async def get_summary(db: AsyncSession = Depends(get_db)):
    perf = PerformanceService(db)
    today = date.today()
    daily = await perf.get_daily_summary(today)
    stats = await perf.get_cumulative_stats()

    holdings_result = await db.execute(select(Holding))
    holdings_count = len(holdings_result.scalars().all())

    # 계좌번호 — 환경변수 우선, 없으면 API에서 시도
    account_no = settings.kiwoom_account_no or ""
    account_name = ""
    if not account_no:
        try:
            from app.services.toss_api import TossApiClient
            api = TossApiClient.get_instance()
            bal = await api.get_balance()
            account_name = bal.get("accountName", "")
        except Exception:
            pass

    return {
        "today_pnl": daily["realized_pnl"],
        "cumulative_pnl": stats["total_pnl"],
        "win_rate": stats["win_rate"],
        "holdings_count": holdings_count,
        "today_trade_count": daily["trade_count"],
        "account_no": account_no,
        "account_name": account_name,
    }


@router.get("/pnl-chart")
async def get_pnl_chart(
    range: str = Query("30d", pattern="^(7d|30d|90d|all)$"),
    db: AsyncSession = Depends(get_db),
):
    days_map = {"7d": 7, "30d": 30, "90d": 90, "all": 3650}
    days = days_map.get(range, 30)
    perf = PerformanceService(db)
    return await perf.get_pnl_chart(days)


@router.get("/performance-split")
async def get_performance_split(db: AsyncSession = Depends(get_db)):
    """장기/단기 분리 실적 — 실현손익 + 현재 보유 평가손익"""

    # ── 매도 체결 내역 전체 조회 ──────────────────────────────────
    sells_r = await db.execute(
        select(
            AutoTradeLog.stock_code,
            AutoTradeLog.stock_name,
            AutoTradeLog.realized_pnl,
            AutoTradeLog.trigger_models,
            AutoTradeLog.trade_date,
        )
        .where(
            AutoTradeLog.action == "SELL",
            AutoTradeLog.status.in_(["FILLED", "MOCK"]),
            AutoTradeLog.realized_pnl.isnot(None),
        )
        .order_by(AutoTradeLog.trade_date.desc())
    )
    sell_rows = sells_r.all()

    def _is_lt(row) -> bool:
        return "장기가치주" in (row[3] or [])

    def _realized_stats(rows):
        pnls = [float(r[2]) for r in rows]
        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p <= 0]
        # 최근 20건 날짜별 누적 PnL (차트용)
        daily: dict[str, float] = {}
        for r in reversed(rows):
            d = str(r[4])
            daily[d] = daily.get(d, 0) + float(r[2])
        cumulative, running = [], 0.0
        for d, v in sorted(daily.items()):
            running += v
            cumulative.append({"date": d, "pnl": round(running, 0)})
        return {
            "total_pnl":   round(sum(pnls), 0),
            "trade_count": len(pnls),
            "win_count":   len(wins),
            "loss_count":  len(losses),
            "win_rate":    round(len(wins) / max(len(pnls), 1) * 100, 1),
            "avg_win":     round(sum(wins)   / max(len(wins),   1), 0),
            "avg_loss":    round(sum(losses) / max(len(losses), 1), 0),
            "cumulative_chart": cumulative[-60:],   # 최근 60 거래일
        }

    lt_sells = [r for r in sell_rows if _is_lt(r)]
    st_sells = [r for r in sell_rows if not _is_lt(r)]

    # ── 현재 보유 ────────────────────────────────────────────────
    holdings_r = await db.execute(select(Holding))
    holdings = holdings_r.scalars().all()

    def _holding_stats(hs):
        items = sorted(
            [
                {
                    "stock_code":        h.stock_code,
                    "stock_name":        h.stock_name or h.stock_code,
                    "quantity":          int(h.quantity or 0),
                    "avg_buy_price":     float(h.avg_buy_price or 0),
                    "current_price":     float(h.current_price or h.avg_buy_price or 0),
                    "unrealized_pnl":    float(h.unrealized_pnl or 0),
                    "unrealized_pnl_pct":float(h.unrealized_pnl_pct or 0),
                }
                for h in hs
            ],
            key=lambda x: x["unrealized_pnl_pct"],
            reverse=True,
        )
        return {
            "total_value": round(sum(
                float(h.current_price or h.avg_buy_price or 0) * int(h.quantity or 0)
                for h in hs
            ), 0),
            "total_unrealized_pnl": round(sum(float(h.unrealized_pnl or 0) for h in hs), 0),
            "holdings": items,
        }

    lt_holdings = [h for h in holdings if h.is_long_term]
    st_holdings = [h for h in holdings if not h.is_long_term and not h.is_manual]

    return {
        "long_term": {
            "realized":   _realized_stats(lt_sells),
            "unrealized": _holding_stats(lt_holdings),
        },
        "short_term": {
            "realized":   _realized_stats(st_sells),
            "unrealized": _holding_stats(st_holdings),
        },
    }


@router.get("/top-stocks")
async def get_top_stocks(db: AsyncSession = Depends(get_db)):
    from sqlalchemy import text
    result = await db.execute(text("""
        SELECT stock_code, stock_name,
               SUM(CASE WHEN trade_type = 'SELL' THEN filled_amount ELSE -filled_amount END) AS pnl,
               COUNT(*) AS trade_count
        FROM trades
        WHERE status = 'FILLED'
        GROUP BY stock_code, stock_name
        ORDER BY pnl DESC
        LIMIT 10
    """))
    rows = result.fetchall()
    return [
        {"stock_code": r[0], "stock_name": r[1], "pnl": float(r[2] or 0), "trade_count": r[3]}
        for r in rows
    ]
