from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db
from app.models.news import NewsItem
from app.models.watchlist import Watchlist
from app.services.news_collector import collect_news
from app.services.sentiment_analyzer import analyze

router = APIRouter(prefix="/news", tags=["news"])


@router.get("")
async def get_news(
    hours: int = Query(24, ge=1, le=168),
    source: str = Query("", description="naver/yonhap/dart/krx 빈 문자열=전체"),
    stock_code: str = Query("", description="특정 종목 필터"),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(NewsItem).where(NewsItem.collected_at >= cutoff)
    if source:
        q = q.where(NewsItem.source == source)
    if stock_code:
        q = q.where(NewsItem.stock_codes.any(stock_code))  # type: ignore
    q = q.order_by(desc(NewsItem.collected_at)).limit(limit)
    result = await db.execute(q)
    items = result.scalars().all()
    return {
        "items": [_serialize(n) for n in items],
        "total": len(items),
        "hours": hours,
    }


@router.get("/sentiment/summary")
async def sentiment_summary(
    hours: int = Query(24, ge=1, le=168),
    db: AsyncSession = Depends(get_db),
):
    """시간대별 감성 분포 요약"""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    result = await db.execute(
        select(NewsItem).where(NewsItem.collected_at >= cutoff)
        .where(NewsItem.sentiment_label != None)
    )
    news = result.scalars().all()

    pos = sum(1 for n in news if n.sentiment_label == "POSITIVE")
    neg = sum(1 for n in news if n.sentiment_label == "NEGATIVE")
    neu = sum(1 for n in news if n.sentiment_label == "NEUTRAL")
    total = len(news)

    avg_score = (
        sum(float(n.sentiment_score) for n in news if n.sentiment_score) / total
        if total else 0.0
    )

    # 시간별 집계 (최근 72시간 이내)
    hourly: dict[str, dict] = {}
    for n in news:
        if n.collected_at:
            key = n.collected_at.strftime("%Y-%m-%dT%H:00:00Z")
            if key not in hourly:
                hourly[key] = {"time": key, "positive": 0, "negative": 0, "neutral": 0, "total": 0}
            hourly[key][n.sentiment_label.lower() if n.sentiment_label else "neutral"] += 1
            hourly[key]["total"] += 1

    timeline = sorted(hourly.values(), key=lambda x: x["time"])

    return {
        "total": total,
        "positive": pos,
        "negative": neg,
        "neutral": neu,
        "avg_score": round(avg_score, 4),
        "market_mood": "BULLISH" if avg_score > 0.1 else ("BEARISH" if avg_score < -0.1 else "NEUTRAL"),
        "timeline": timeline,
    }


@router.get("/sentiment/by-stock")
async def sentiment_by_stock(
    hours: int = Query(24, ge=1, le=168),
    db: AsyncSession = Depends(get_db),
):
    """종목별 감성 점수 집계"""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    result = await db.execute(
        select(NewsItem)
        .where(NewsItem.collected_at >= cutoff)
        .where(NewsItem.sentiment_score != None)
    )
    news = result.scalars().all()

    code_data: dict[str, list[float]] = {}
    for n in news:
        for code in (n.stock_codes or []):
            code_data.setdefault(code, []).append(float(n.sentiment_score))

    from app.services.sentiment_analyzer import aggregate_scores

    codes = list(code_data.keys())
    wl_r = await db.execute(select(Watchlist).where(Watchlist.stock_code.in_(codes)))
    name_map = {w.stock_code: w.stock_name for w in wl_r.scalars().all()}

    summary = []
    for code, scores in code_data.items():
        agg = aggregate_scores(scores)
        summary.append({
            "stock_code": code,
            "stock_name": name_map.get(code, code),
            "sentiment_score": agg,
            "news_count": len(scores),
            "label": "POSITIVE" if agg > 0.1 else ("NEGATIVE" if agg < -0.1 else "NEUTRAL"),
        })
    summary.sort(key=lambda x: x["sentiment_score"], reverse=True)
    return {"items": summary, "hours": hours}


@router.post("/collect")
async def trigger_collect(db: AsyncSession = Depends(get_db)):
    """수동으로 뉴스 수집 트리거"""
    saved = await collect_news(db)
    return {"message": f"{saved}건 수집 완료", "saved": saved}


@router.post("/analyze-pending")
async def analyze_pending(
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """감성 미분석 뉴스에 감성 분석 실행"""
    result = await db.execute(
        select(NewsItem)
        .where(NewsItem.sentiment_label == None)
        .order_by(desc(NewsItem.collected_at))
        .limit(limit)
    )
    items = result.scalars().all()
    updated = 0
    for news in items:
        text = (news.title or "") + " " + (news.content_summary or "")
        score, label = analyze(text)
        news.sentiment_score = score  # type: ignore
        news.sentiment_label = label
        updated += 1

    await db.commit()
    return {"message": f"{updated}건 감성 분석 완료", "updated": updated}


def _serialize(n: NewsItem) -> dict:
    return {
        "id": n.id,
        "title": n.title,
        "content_summary": n.content_summary,
        "source": n.source,
        "stock_codes": n.stock_codes or [],
        "sentiment_score": float(n.sentiment_score) if n.sentiment_score is not None else None,
        "sentiment_label": n.sentiment_label,
        "is_disclosure": n.is_disclosure,
        "disclosure_type": n.disclosure_type,
        "published_at": n.published_at.isoformat() if n.published_at else None,
        "collected_at": n.collected_at.isoformat() if n.collected_at else None,
    }
