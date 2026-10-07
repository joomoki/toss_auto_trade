from datetime import date, timedelta
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_

from app.models.trade import Trade
from app.models.holding import DailyPnl


class PerformanceService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_daily_summary(self, trade_date: date) -> dict:
        result = await self.db.execute(
            select(DailyPnl).where(DailyPnl.trade_date == str(trade_date))
        )
        row = result.scalar_one_or_none()
        if not row:
            return {
                "trade_date": str(trade_date),
                "realized_pnl": 0,
                "total_buy_amt": 0,
                "total_sell_amt": 0,
                "trade_count": 0,
                "win_count": 0,
                "lose_count": 0,
                "win_rate": 0.0,
            }
        total = row.win_count + row.lose_count
        win_rate = row.win_count / total * 100 if total > 0 else 0.0
        return {
            "trade_date": str(row.trade_date),
            "realized_pnl": float(row.realized_pnl or 0),
            "total_buy_amt": float(row.total_buy_amt or 0),
            "total_sell_amt": float(row.total_sell_amt or 0),
            "trade_count": row.trade_count,
            "win_count": row.win_count,
            "lose_count": row.lose_count,
            "win_rate": round(win_rate, 2),
        }

    async def get_pnl_chart(self, days: int = 30) -> list[dict]:
        from app.models.news import AutoTradeLog
        start_date = date.today() - timedelta(days=days)
        result = await self.db.execute(
            select(
                AutoTradeLog.trade_date,
                func.sum(AutoTradeLog.realized_pnl).label("daily_pnl"),
            )
            .where(
                AutoTradeLog.trade_date >= start_date,
                AutoTradeLog.action == "SELL",
                AutoTradeLog.realized_pnl.isnot(None),
                AutoTradeLog.status != "CANCELLED",
            )
            .group_by(AutoTradeLog.trade_date)
            .order_by(AutoTradeLog.trade_date)
        )
        rows = result.all()
        chart = []
        cumulative = 0.0
        for row in rows:
            daily = float(row.daily_pnl or 0)
            cumulative += daily
            chart.append({
                "date": str(row.trade_date),
                "daily_pnl": round(daily, 2),
                "cumulative_pnl": round(cumulative, 2),
            })
        return chart

    async def get_cumulative_stats(self) -> dict:
        result = await self.db.execute(select(DailyPnl))
        rows = result.scalars().all()
        total_pnl = sum(float(r.realized_pnl or 0) for r in rows)
        total_wins = sum(r.win_count for r in rows)
        total_losses = sum(r.lose_count for r in rows)
        total_trades = total_wins + total_losses
        win_rate = total_wins / total_trades * 100 if total_trades > 0 else 0.0
        return {
            "total_pnl": round(total_pnl, 2),
            "win_rate": round(win_rate, 2),
            "total_trades": total_trades,
        }

    async def upsert_daily_pnl(self, trade_date: date):
        """SELL 거래들을 집계하여 daily_pnl을 갱신한다."""
        result = await self.db.execute(
            select(Trade).where(
                and_(Trade.trade_date == trade_date, Trade.status == "FILLED")
            )
        )
        trades = result.scalars().all()

        total_buy = sum(float(t.filled_amount or 0) for t in trades if t.trade_type == "BUY")
        total_sell = sum(float(t.filled_amount or 0) for t in trades if t.trade_type == "SELL")
        realized_pnl = total_sell - total_buy
        trade_count = len(trades)
        win_count = sum(1 for t in trades if t.trade_type == "SELL" and float(t.filled_amount or 0) > float(t.order_price * t.order_qty))
        lose_count = len([t for t in trades if t.trade_type == "SELL"]) - win_count

        existing = await self.db.execute(
            select(DailyPnl).where(DailyPnl.trade_date == str(trade_date))
        )
        row = existing.scalar_one_or_none()
        if row:
            row.realized_pnl = realized_pnl
            row.total_buy_amt = total_buy
            row.total_sell_amt = total_sell
            row.trade_count = trade_count
            row.win_count = win_count
            row.lose_count = lose_count
        else:
            self.db.add(DailyPnl(
                trade_date=str(trade_date),
                realized_pnl=realized_pnl,
                total_buy_amt=total_buy,
                total_sell_amt=total_sell,
                trade_count=trade_count,
                win_count=win_count,
                lose_count=lose_count,
            ))
        await self.db.flush()
