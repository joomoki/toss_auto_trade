"""
일별 종가 업데이트 서비스
- 매일 장 마감 후 (15:35 KST) 한 번 실행
- watchlist + holdings + model_portfolio_stocks 의 모든 종목 가격 일괄 갱신
- stock_daily_prices 에 종가 이력 적재
"""
import asyncio
import logging
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.stock_price import StockDailyPrice
from app.models.watchlist import Watchlist
from app.models.holding import Holding
from app.models.news import ModelPortfolioStock
from app.services.toss_api import TossApiClient

logger = logging.getLogger(__name__)


async def run_daily_price_update(db: AsyncSession) -> dict:
    """
    1) 추적 대상 종목 수집 (watchlist + holdings + model_portfolio_stocks)
    2) Kiwoom API 현재가 조회
    3) stock_daily_prices upsert
    4) holdings.current_price + unrealized_pnl 갱신
    5) model_portfolio_stocks.current_price + return_pct + return_amt 갱신
    """
    today = date.today()
    api = TossApiClient.get_instance()

    # ── 추적 종목 수집 ─────────────────────────────────────
    name_map: dict[str, str] = {}

    wl_rows = (await db.execute(select(Watchlist))).scalars().all()
    for w in wl_rows:
        name_map[w.stock_code] = w.stock_name or w.stock_code

    holding_rows = (await db.execute(select(Holding))).scalars().all()
    for h in holding_rows:
        name_map.setdefault(h.stock_code, h.stock_name or h.stock_code)

    port_rows = (await db.execute(
        select(ModelPortfolioStock).where(ModelPortfolioStock.is_active == True)
    )).scalars().all()
    for p in port_rows:
        name_map.setdefault(p.stock_code, p.stock_name or p.stock_code)

    codes = list(name_map.keys())
    if not codes:
        return {"updated": 0, "errors": [], "date": str(today)}

    # ── 가격 조회 ────────────────────────────────────────
    price_map: dict[str, int] = {}
    errors: list[str] = []

    for code in codes:
        try:
            info = await api.get_current_price(code)
            price = int(info.get("price", 0))
            if price > 0:
                price_map[code] = price
            await asyncio.sleep(0.05)   # API 과호출 방지
        except Exception as e:
            logger.warning(f"[daily_price] {code} 가격 조회 실패: {e}")
            errors.append(code)

    # ── stock_daily_prices upsert ────────────────────────
    for code, price in price_map.items():
        stmt = pg_insert(StockDailyPrice).values(
            stock_code=code,
            stock_name=name_map.get(code, ""),
            trade_date=today,
            close_price=price,
        ).on_conflict_do_update(
            constraint="uq_stock_daily_price",
            set_={"close_price": price, "stock_name": name_map.get(code, "")},
        )
        await db.execute(stmt)

    # ── holdings 갱신 ────────────────────────────────────
    for h in holding_rows:
        price = price_map.get(h.stock_code)
        if price and price > 0:
            avg = float(h.avg_buy_price or 0)
            qty = int(h.quantity or 0)
            h.current_price     = price                              # type: ignore
            h.unrealized_pnl    = (price - avg) * qty               # type: ignore
            h.unrealized_pnl_pct = (price - avg) / avg * 100 if avg > 0 else 0  # type: ignore

    # ── model_portfolio_stocks 갱신 ──────────────────────
    now_utc = datetime.now(timezone.utc)
    for p in port_rows:
        price = price_map.get(p.stock_code)
        if price and price > 0:
            buy = int(p.buy_price or 0)
            qty = int(p.quantity or 1)
            p.current_price     = price                              # type: ignore
            p.return_pct        = (price - buy) / buy * 100 if buy > 0 else 0  # type: ignore
            p.return_amt        = (price - buy) * qty                # type: ignore
            p.price_updated_at  = now_utc                           # type: ignore

    await db.commit()
    logger.info(f"[daily_price] {today} 완료 — {len(price_map)}종목 갱신, 오류 {len(errors)}건")
    return {
        "date":    str(today),
        "updated": len(price_map),
        "total":   len(codes),
        "errors":  errors,
    }


async def backfill_historical_prices(db: AsyncSession, trading_days: int = 90) -> dict:
    """
    최근 N 거래일 일봉 데이터를 stock_daily_prices 에 일괄 적재 (초기 적재 / 누락 보정)
    - get_ohlcv(D, count) 로 일봉 조회 → trade_date 별 upsert
    """
    api = TossApiClient.get_instance()

    # 추적 종목 수집
    name_map: dict[str, str] = {}
    for w in (await db.execute(select(Watchlist))).scalars().all():
        name_map[w.stock_code] = w.stock_name or w.stock_code
    for h in (await db.execute(select(Holding))).scalars().all():
        name_map.setdefault(h.stock_code, h.stock_name or h.stock_code)
    for p in (await db.execute(select(ModelPortfolioStock))).scalars().all():
        name_map.setdefault(p.stock_code, p.stock_name or p.stock_code)

    codes = list(name_map.keys())
    total_rows = 0
    errors: list[dict] = []

    for code in codes:
        try:
            df = await api.get_ohlcv(code, period="D", count=trading_days)
            if df.empty:
                errors.append({"code": code, "reason": "OHLCV 데이터 없음"})
                continue

            name = name_map.get(code, "")
            rows_inserted = 0

            for _, row in df.iterrows():
                # datetime 컬럼: "YYYYMMDD" 문자열
                raw_dt = str(row.get("datetime", ""))
                if len(raw_dt) < 8:
                    continue
                try:
                    from datetime import date as date_cls
                    trade_date = date_cls(int(raw_dt[:4]), int(raw_dt[4:6]), int(raw_dt[6:8]))
                except ValueError:
                    continue

                close  = int(row.get("close", 0))
                open_  = int(row.get("open",  0))
                high   = int(row.get("high",  0))
                low    = int(row.get("low",   0))
                volume = int(row.get("volume", 0))

                if close <= 0:
                    continue

                stmt = pg_insert(StockDailyPrice).values(
                    stock_code  = code,
                    stock_name  = name,
                    trade_date  = trade_date,
                    close_price = close,
                    open_price  = open_  or None,
                    high_price  = high   or None,
                    low_price   = low    or None,
                    volume      = volume or None,
                ).on_conflict_do_update(
                    constraint="uq_stock_daily_price",
                    set_={
                        "close_price": close,
                        "open_price":  open_  or None,
                        "high_price":  high   or None,
                        "low_price":   low    or None,
                        "volume":      volume or None,
                        "stock_name":  name,
                    },
                )
                await db.execute(stmt)
                rows_inserted += 1

            await db.commit()
            total_rows += rows_inserted
            logger.info(f"[backfill] {code} ({name}) — {rows_inserted}일 적재")
            await asyncio.sleep(0.1)   # API rate limit 방지

        except Exception as e:
            logger.error(f"[backfill] {code} 오류: {e}")
            errors.append({"code": code, "reason": str(e)})
            await db.rollback()

    return {
        "codes":      len(codes),
        "total_rows": total_rows,
        "errors":     errors,
    }
