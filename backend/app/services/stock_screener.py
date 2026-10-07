"""종목 스크리너 — 스캘핑/스윙 후보 필터링 및 DB 저장"""
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.models.news import NewsItem
from app.models.watchlist import Watchlist
from app.models.screened_stock import ScreenedStock
from app.services.sentiment_analyzer import aggregate_scores


async def get_scalping_candidates(
    db: AsyncSession,
    min_sentiment: float = 0.1,
    top_n: int = 5,
) -> list[dict]:
    """
    스캘핑 후보: 활성 관심 종목 중 최근 2시간 뉴스 감성이 양호한 종목
    """
    from datetime import datetime, timezone, timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)

    wl_result = await db.execute(
        select(Watchlist).where(Watchlist.is_active == True)
    )
    watchlist = {w.stock_code: w.stock_name for w in wl_result.scalars().all()}

    if not watchlist:
        return []

    # 최근 2시간 뉴스
    news_result = await db.execute(
        select(NewsItem)
        .where(NewsItem.collected_at >= cutoff)
        .where(NewsItem.sentiment_label != None)
        .order_by(desc(NewsItem.collected_at))
        .limit(200)
    )
    recent_news = news_result.scalars().all()

    # 종목별 감성 집계
    code_scores: dict[str, list[float]] = {}
    for code in watchlist:
        scores = [
            float(n.sentiment_score)
            for n in recent_news
            if n.stock_codes and code in n.stock_codes and n.sentiment_score is not None
        ]
        if scores:
            code_scores[code] = scores

    candidates = []
    for code, scores in code_scores.items():
        agg = aggregate_scores(scores)
        if agg >= min_sentiment:
            candidates.append({
                "stock_code": code,
                "stock_name": watchlist.get(code, code),
                "sentiment_score": agg,
                "news_count": len(scores),
                "style": "scalping",
            })

    candidates.sort(key=lambda x: x["sentiment_score"], reverse=True)
    return candidates[:top_n]


async def get_swing_candidates(
    db: AsyncSession,
    min_sentiment: float = 0.05,
    top_n: int = 10,
) -> list[dict]:
    """
    스윙 후보: 활성 관심 종목 중 최근 24시간 뉴스 감성 + 공시 유무 종합
    """
    from datetime import datetime, timezone, timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    wl_result = await db.execute(
        select(Watchlist).where(Watchlist.is_active == True)
    )
    watchlist = {w.stock_code: w.stock_name for w in wl_result.scalars().all()}

    if not watchlist:
        return []

    news_result = await db.execute(
        select(NewsItem)
        .where(NewsItem.collected_at >= cutoff)
        .where(NewsItem.sentiment_score != None)
        .order_by(desc(NewsItem.collected_at))
        .limit(500)
    )
    recent_news = news_result.scalars().all()

    candidates = []
    for code, name in watchlist.items():
        news_for_code = [
            n for n in recent_news
            if n.stock_codes and code in n.stock_codes
        ]
        if not news_for_code:
            continue
        scores = [float(n.sentiment_score) for n in news_for_code if n.sentiment_score is not None]
        agg = aggregate_scores(scores) if scores else 0.0
        has_disclosure = any(n.is_disclosure for n in news_for_code)

        # 공시 있으면 가중치 부여
        if has_disclosure:
            agg = min(agg + 0.1, 1.0)

        if agg >= min_sentiment:
            candidates.append({
                "stock_code": code,
                "stock_name": name,
                "sentiment_score": agg,
                "news_count": len(news_for_code),
                "has_disclosure": has_disclosure,
                "style": "swing",
            })

    candidates.sort(key=lambda x: x["sentiment_score"], reverse=True)
    return candidates[:top_n]


async def save_screen_results(
    db: AsyncSession,
    candidates: list[dict],
) -> list[ScreenedStock]:
    """스크리닝 결과를 screened_stocks 테이블에 저장하고 ORM 객체 목록을 반환.

    candidates 항목은 get_scalping_candidates / get_swing_candidates 반환값,
    또는 auto_trade_engine._score_stock() 결과(composite_score 포함) 모두 지원.
    """
    now = datetime.now(timezone.utc)
    rows: list[ScreenedStock] = []
    for c in candidates:
        row = ScreenedStock(
            screened_at=now,
            stock_code=c["stock_code"],
            stock_name=c.get("stock_name"),
            screen_style=c.get("style", "full"),
            sentiment_score=c.get("sentiment_score"),
            news_count=c.get("news_count", 0),
            has_disclosure=c.get("has_disclosure", False),
            model_score=c.get("model_score"),
            news_score=c.get("news_score"),
            dart_score=c.get("dart_score"),
            supply_score=c.get("supply_score"),
            market_score=c.get("market_score"),
            composite_score=c.get("composite_score"),
            final_signal=c.get("final_signal"),
            trigger_models=c.get("trigger_models"),
            model_scores=c.get("model_scores"),
            current_price=c.get("current_price"),
        )
        db.add(row)
        rows.append(row)
    await db.flush()
    return rows
