"""
KOSPI/KOSDAQ 전종목 마스터 갱신 서비스
- FinanceDataReader 단일 호출로 KOSPI+KOSDAQ 전종목 수집 (~5초)
- 서버 최초 기동 시 호출 (오늘 이미 갱신했으면 스킵)
- pykrx는 per-ticker 호출로 매우 느리므로 FDR 실패 시 fallback으로만 사용
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timezone, timedelta

from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# 청크 단위 upsert (메모리 안전)
_CHUNK = 500


def _sync_fetch_fdr() -> list[dict]:
    """FinanceDataReader로 KOSPI+KOSDAQ 전종목 단일 호출 수집."""
    import io
    import sys
    import FinanceDataReader as fdr

    results: list[dict] = []
    for market in ("KOSPI", "KOSDAQ"):
        try:
            _buf = io.StringIO()
            _old_out, _old_err = sys.stdout, sys.stderr
            sys.stdout = sys.stderr = _buf
            try:
                df = fdr.StockListing(market)
            finally:
                sys.stdout, sys.stderr = _old_out, _old_err
            if df is None or df.empty:
                logger.warning(f"[StockMaster] {market} → 빈 응답")
                continue

            cols = [c.strip() for c in df.columns]
            logger.info(f"[StockMaster] {market} 컬럼: {cols}")

            # 코드 컬럼 탐색
            code_col = next(
                (c for c in df.columns if c.strip().lower() in ("code", "symbol", "단축코드", "종목코드")),
                None,
            )
            # 이름 컬럼 탐색
            name_col = next(
                (c for c in df.columns if c.strip().lower() in ("name", "isuabrvtnrnm", "종목명", "한글 종목명", "corp_name", "회사명")),
                None,
            )

            if code_col is None or name_col is None:
                logger.error(f"[StockMaster] {market}: 코드/이름 컬럼 탐색 실패. 컬럼={df.columns.tolist()}")
                continue

            for _, row in df.iterrows():
                code = str(row[code_col]).strip().zfill(6)
                name = str(row[name_col]).strip()
                if len(code) == 6 and name and name != "nan":
                    results.append({"stock_code": code, "stock_name": name, "market": market})

            logger.info(f"[StockMaster] {market}: {len([r for r in results if r['market']==market])}종목 수집")
        except Exception as e:
            logger.error(f"[StockMaster] FDR {market} 실패: {e}")

    return results


def _sync_fetch_pykrx() -> list[dict]:
    """pykrx fallback — KRX 자격증명(KRX_ID/KRX_PW) 필요."""
    import io
    import os
    import sys

    if not (os.environ.get("KRX_ID") or os.environ.get("KRX_PW")):
        logger.warning("[StockMaster] KRX 자격증명 미설정 — pykrx fallback 스킵")
        return []

    from pykrx import stock as krx

    results: list[dict] = []
    today_str = date.today().strftime("%Y%m%d")
    prev_str  = (date.today() - timedelta(days=1)).strftime("%Y%m%d")

    for market in ("KOSPI", "KOSDAQ"):
        try:
            _buf = io.StringIO()
            _old_out, _old_err = sys.stdout, sys.stderr
            sys.stdout = sys.stderr = _buf
            try:
                tickers = krx.get_market_ticker_list(today_str, market=market)
                if not tickers:
                    tickers = krx.get_market_ticker_list(prev_str, market=market)
                names = [(t, krx.get_market_ticker_name(t)) for t in tickers]
            finally:
                sys.stdout, sys.stderr = _old_out, _old_err
            for t, name in names:
                if name:
                    results.append({"stock_code": t, "stock_name": name, "market": market})
        except Exception as e:
            logger.error(f"[StockMaster] pykrx {market} 실패: {e}")

    return results


def _sync_fetch_all_stocks() -> list[dict]:
    """FDR 우선, 실패 시 pykrx fallback."""
    try:
        result = _sync_fetch_fdr()
        if result:
            return result
        logger.warning("[StockMaster] FDR 결과 없음 → pykrx fallback")
    except Exception as e:
        logger.error(f"[StockMaster] FDR 예외 → pykrx fallback: {e}")

    return _sync_fetch_pykrx()


async def maybe_refresh_stock_master(db: AsyncSession) -> int:
    """오늘 이미 갱신된 경우 스킵. 갱신된 종목 수 반환."""
    from app.models.stock_master import StockMaster

    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    r = await db.execute(
        select(func.count(StockMaster.stock_code)).where(
            StockMaster.updated_at >= today_start
        )
    )
    count_today = r.scalar() or 0
    if count_today > 0:
        logger.info(f"[StockMaster] 오늘 이미 갱신됨 ({count_today}종목) — 스킵")
        return count_today

    logger.info("[StockMaster] KOSPI/KOSDAQ 종목 갱신 시작…")
    try:
        stocks = await asyncio.to_thread(_sync_fetch_all_stocks)
    except Exception as e:
        logger.error(f"[StockMaster] 갱신 실패: {e}")
        return 0

    if not stocks:
        logger.warning("[StockMaster] 종목을 가져오지 못했습니다.")
        return 0

    # SQLAlchemy ORM upsert (청크 단위)
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.sql import func as sqlfunc
    from app.models.stock_master import StockMaster as SM

    total = 0
    for i in range(0, len(stocks), _CHUNK):
        chunk = stocks[i : i + _CHUNK]
        stmt = pg_insert(SM).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["stock_code"],
            set_={
                "stock_name": stmt.excluded.stock_name,
                "market":     stmt.excluded.market,
                "updated_at": sqlfunc.now(),
            },
        )
        await db.execute(stmt)
        total += len(chunk)

    await db.commit()
    logger.info(f"[StockMaster] 갱신 완료: {total}종목 (KOSPI+KOSDAQ)")
    return total


async def search_stocks(db: AsyncSession, query: str, limit: int = 20) -> list[dict]:
    """종목명 또는 종목코드로 검색."""
    from app.models.stock_master import StockMaster
    from sqlalchemy import case

    q = query.strip()
    if not q:
        return []

    priority = case(
        (StockMaster.stock_code == q, 0),
        (StockMaster.stock_name.ilike(f"{q}%"), 1),
        else_=2,
    )

    r = await db.execute(
        select(StockMaster)
        .where(
            or_(
                StockMaster.stock_name.ilike(f"%{q}%"),
                StockMaster.stock_code.ilike(f"%{q}%"),
            )
        )
        .order_by(priority, StockMaster.stock_name)
        .limit(limit)
    )
    return [
        {"stock_code": s.stock_code, "stock_name": s.stock_name, "market": s.market}
        for s in r.scalars().all()
    ]


async def get_status(db: AsyncSession) -> dict:
    """종목 수 + 마지막 갱신 시각 반환 (모달 상태 표시용)."""
    from app.models.stock_master import StockMaster

    r = await db.execute(
        select(func.count(StockMaster.stock_code), func.max(StockMaster.updated_at))
    )
    count, last_updated = r.one()
    return {
        "count": count or 0,
        "last_updated": last_updated.isoformat() if last_updated else None,
    }
