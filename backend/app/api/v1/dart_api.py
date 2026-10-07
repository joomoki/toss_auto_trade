"""
OpenDART 공시 API
GET  /api/v1/dart/list          — 공시 목록 (최신순)
GET  /api/v1/dart/stock/{code}  — 특정 종목 공시
POST /api/v1/dart/collect       — 수동 수집 트리거
GET  /api/v1/dart/stats         — 최근 공시 통계 요약
"""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func

from app.core.config import settings
from app.core.database import get_db
from app.models.dart import DartDisclosure

router = APIRouter(prefix="/dart", tags=["dart"])


def _serialize(d: DartDisclosure) -> dict:
    return {
        "id": d.id,
        "rcept_no": d.rcept_no,
        "rcept_dt": str(d.rcept_dt),
        "corp_name": d.corp_name,
        "stock_code": d.stock_code,
        "corp_cls": d.corp_cls,
        "report_nm": d.report_nm,
        "filer_nm": d.filer_nm,
        "disclosure_type": d.disclosure_type,
        "dart_score": float(d.dart_score) if d.dart_score is not None else None,
        "is_positive": d.is_positive,
        "dart_url": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={d.rcept_no}",
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


@router.get("/list")
async def get_dart_list(
    days: int = Query(7, ge=1, le=90),
    stock_code: Optional[str] = None,
    disclosure_type: Optional[str] = None,
    only_signal: bool = Query(False, description="점수 있는 호재/악재만 (score != 0)"),
    corp_cls: Optional[str] = Query(None, description="Y=유가증권 K=코스닥"),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    cutoff = date.today() - timedelta(days=days)
    q = select(DartDisclosure).where(DartDisclosure.rcept_dt >= cutoff)
    if stock_code:
        q = q.where(DartDisclosure.stock_code == stock_code)
    if disclosure_type:
        q = q.where(DartDisclosure.disclosure_type == disclosure_type)
    if only_signal:
        q = q.where(DartDisclosure.dart_score != 0)
    if corp_cls:
        q = q.where(DartDisclosure.corp_cls == corp_cls.upper())
    q = q.order_by(desc(DartDisclosure.rcept_dt), desc(DartDisclosure.created_at)).limit(limit)
    result = await db.execute(q)
    rows = result.scalars().all()
    return {"disclosures": [_serialize(r) for r in rows], "total": len(rows)}


@router.get("/stock/{stock_code}")
async def get_stock_dart(
    stock_code: str,
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """특정 종목 공시 이력 + 평균 DART 점수"""
    cutoff = date.today() - timedelta(days=days)
    result = await db.execute(
        select(DartDisclosure)
        .where(DartDisclosure.stock_code == stock_code, DartDisclosure.rcept_dt >= cutoff)
        .order_by(desc(DartDisclosure.rcept_dt))
    )
    rows = result.scalars().all()

    scored = [r for r in rows if r.dart_score is not None and float(r.dart_score) != 0]
    avg_score = sum(float(r.dart_score) for r in scored) / len(scored) if scored else None

    return {
        "stock_code": stock_code,
        "days": days,
        "avg_dart_score": round(avg_score, 4) if avg_score is not None else None,
        "total": len(rows),
        "disclosures": [_serialize(r) for r in rows],
    }


@router.post("/collect")
async def trigger_collect(
    days_back: int = Query(1, ge=1, le=7),
    db: AsyncSession = Depends(get_db),
):
    """DART 공시 수동 수집"""
    if not settings.dart_api_key:
        raise HTTPException(status_code=400, detail="DART_API_KEY가 설정되지 않았습니다.")
    from app.services.dart_collector import collect_dart
    try:
        saved = await collect_dart(db, days_back=days_back)
        return {"message": f"공시 {saved}건 수집 완료", "saved": saved}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"수집 오류: {e}")


@router.get("/stats")
async def get_dart_stats(
    days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
):
    """공시 통계 요약 (유형별 건수, 호재/악재 비율)"""
    cutoff = date.today() - timedelta(days=days)

    # 전체 건수
    total_r = await db.execute(
        select(func.count()).select_from(DartDisclosure)
        .where(DartDisclosure.rcept_dt >= cutoff)
    )
    total = total_r.scalar() or 0

    # 호재/악재
    pos_r = await db.execute(
        select(func.count()).select_from(DartDisclosure)
        .where(DartDisclosure.rcept_dt >= cutoff, DartDisclosure.is_positive == True,
               DartDisclosure.dart_score != 0)
    )
    neg_r = await db.execute(
        select(func.count()).select_from(DartDisclosure)
        .where(DartDisclosure.rcept_dt >= cutoff, DartDisclosure.is_positive == False)
    )
    positive = pos_r.scalar() or 0
    negative = neg_r.scalar() or 0

    # 유형별 TOP 10
    type_r = await db.execute(
        select(DartDisclosure.disclosure_type, func.count().label("cnt"))
        .where(DartDisclosure.rcept_dt >= cutoff)
        .group_by(DartDisclosure.disclosure_type)
        .order_by(desc("cnt"))
        .limit(10)
    )
    by_type = [{"type": row[0], "count": row[1]} for row in type_r.all()]

    # 최근 호재 TOP 5 (가장 높은 점수)
    hot_r = await db.execute(
        select(DartDisclosure)
        .where(DartDisclosure.rcept_dt >= cutoff, DartDisclosure.dart_score > 0.5,
               DartDisclosure.stock_code.is_not(None))
        .order_by(desc(DartDisclosure.dart_score), desc(DartDisclosure.rcept_dt))
        .limit(5)
    )
    hot = [_serialize(r) for r in hot_r.scalars().all()]

    # 최근 악재 TOP 5
    risk_r = await db.execute(
        select(DartDisclosure)
        .where(DartDisclosure.rcept_dt >= cutoff, DartDisclosure.dart_score < -0.3,
               DartDisclosure.stock_code.is_not(None))
        .order_by(DartDisclosure.dart_score, desc(DartDisclosure.rcept_dt))
        .limit(5)
    )
    risk = [_serialize(r) for r in risk_r.scalars().all()]

    return {
        "days": days,
        "total": total,
        "positive": positive,
        "negative": negative,
        "by_type": by_type,
        "hot_disclosures": hot,
        "risk_disclosures": risk,
        "dart_api_configured": bool(settings.dart_api_key),
    }
