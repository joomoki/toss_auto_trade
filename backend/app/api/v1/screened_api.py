"""
스크리닝 결과 API
GET  /api/v1/screened                  — 최근 스크리닝 이력 조회
POST /api/v1/screened/run              — 즉시 스크리닝 실행 후 DB 저장 (감성 기반)
GET  /api/v1/screened/latest           — 가장 최근 스크리닝 세션 결과 (screened_at 기준)
POST /api/v1/screened/sector-run       — 매크로 섹터 기반 전종목 AI 스크리닝
GET  /api/v1/screened/sectors          — 현재 매크로 수혜 섹터 목록
"""
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.screened_stock import ScreenedStock

router = APIRouter(prefix="/screened", tags=["screened"])


def _serialize(s: ScreenedStock) -> dict:
    return {
        "id": s.id,
        "screened_at": s.screened_at.isoformat() if s.screened_at else None,
        "stock_code": s.stock_code,
        "stock_name": s.stock_name,
        "screen_style": s.screen_style,
        "sentiment_score": float(s.sentiment_score) if s.sentiment_score is not None else None,
        "news_count": s.news_count,
        "has_disclosure": s.has_disclosure,
        "model_score": float(s.model_score) if s.model_score is not None else None,
        "news_score": float(s.news_score) if s.news_score is not None else None,
        "dart_score": float(s.dart_score) if s.dart_score is not None else None,
        "supply_score": float(s.supply_score) if s.supply_score is not None else None,
        "market_score": float(s.market_score) if s.market_score is not None else None,
        "composite_score": float(s.composite_score) if s.composite_score is not None else None,
        "final_signal": s.final_signal,
        "trigger_models": s.trigger_models or [],
        "model_scores": s.model_scores or {},
        "current_price": s.current_price,
    }


@router.get("")
async def get_screened(
    style: Optional[str] = Query(None, description="scalping / swing / full"),
    signal: Optional[str] = Query(None, description="BUY / SELL / HOLD"),
    hours: int = Query(24, ge=1, le=168, description="최근 N시간 이내 결과"),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(ScreenedStock).where(ScreenedStock.screened_at >= cutoff)
    if style:
        q = q.where(ScreenedStock.screen_style == style)
    if signal:
        q = q.where(ScreenedStock.final_signal == signal.upper())
    q = q.order_by(desc(ScreenedStock.screened_at), desc(ScreenedStock.composite_score)).limit(limit)
    result = await db.execute(q)
    rows = result.scalars().all()
    return {"results": [_serialize(r) for r in rows], "total": len(rows)}


@router.get("/latest")
async def get_latest_screened(
    style: Optional[str] = Query(None, description="scalping / swing / full"),
    db: AsyncSession = Depends(get_db),
):
    """가장 최근 스크리닝 일시(screened_at)의 결과만 반환"""
    q = select(ScreenedStock.screened_at).order_by(desc(ScreenedStock.screened_at)).limit(1)
    if style:
        q = q.where(ScreenedStock.screen_style == style)
    latest_row = await db.execute(q)
    latest_at = latest_row.scalar_one_or_none()
    if not latest_at:
        return {"screened_at": None, "results": []}

    q2 = (
        select(ScreenedStock)
        .where(ScreenedStock.screened_at == latest_at)
        .order_by(desc(ScreenedStock.composite_score))
    )
    if style:
        q2 = q2.where(ScreenedStock.screen_style == style)
    result = await db.execute(q2)
    rows = result.scalars().all()
    return {
        "screened_at": latest_at.isoformat(),
        "results": [_serialize(r) for r in rows],
    }


@router.post("/run")
async def run_screening(
    style: str = Query("full", description="scalping / swing / full"),
    db: AsyncSession = Depends(get_db),
):
    """즉시 스크리닝을 실행하고 결과를 DB에 저장"""
    from app.services.stock_screener import (
        get_scalping_candidates,
        get_swing_candidates,
        save_screen_results,
    )

    candidates: list[dict] = []
    if style in ("scalping", "full"):
        scalping = await get_scalping_candidates(db)
        for c in scalping:
            c["style"] = "scalping"
        candidates.extend(scalping)

    if style in ("swing", "full"):
        swing = await get_swing_candidates(db)
        for c in swing:
            c["style"] = "swing"
        candidates.extend(swing)

    saved = await save_screen_results(db, candidates)
    await db.commit()

    return {
        "message": f"{len(saved)}건 스크리닝 결과 저장 완료",
        "style": style,
        "results": [_serialize(r) for r in saved],
    }


@router.post("/sector-run")
async def run_sector_screening(
    min_vol_won: int = Query(5_000_000_000, description="일평균 거래대금 최솟값 (원)"),
    min_market_cap: int = Query(100_000_000_000, description="시가총액 최솟값 (원)"),
    min_sector_score: float = Query(0.15, description="매크로 섹터 순점수 최솟값"),
    max_stocks: int = Query(80, ge=10, le=200, description="M1-M10 적용 최대 종목 수"),
    max_stock_price: int = Query(0, ge=0, description="종목 단가 상한 (원, 0=제한없음)"),
    db: AsyncSession = Depends(get_db),
):
    """
    매크로 섹터 신호 → 코스피/코스닥 전종목 필터 → M1-M10 AI 모델 적용 스크리닝.
    결과는 screened_stocks 테이블에 style='full'로 저장됩니다.
    """
    from app.services.sector_screener import run_sector_screening as _run

    try:
        results = await _run(
            db,
            min_vol_won=min_vol_won,
            min_market_cap=min_market_cap,
            min_sector_score=min_sector_score,
            max_stocks=max_stocks,
            max_stock_price=max_stock_price,
        )
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"섹터 스크리닝 실패: {e}")

    buy_count = sum(1 for r in results if r.get("final_signal") == "BUY")
    return {
        "message": f"섹터 스크리닝 완료: {len(results)}종목 분석, 매수 신호 {buy_count}건",
        "total_analyzed": len(results),
        "buy_signals": buy_count,
        "results": results,
    }


@router.get("/sectors")
async def get_macro_sectors():
    """현재 매크로 이벤트 기반 섹터 신호 조회 (LONG/SHORT/NEUTRAL)"""
    from app.services.sector_screener import get_favorable_sectors

    try:
        signals = await get_favorable_sectors()
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"섹터 신호 조회 실패: {e}")

    return {"sectors": signals, "total": len(signals)}
