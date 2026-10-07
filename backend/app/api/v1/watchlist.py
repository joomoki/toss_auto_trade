from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.models.watchlist import Watchlist

router = APIRouter(prefix="/watchlist", tags=["watchlist"])

# 기본 관심 종목 (DB 비어있을 때 자동 초기화)
DEFAULT_WATCHLIST = [
    {"stock_code": "005930", "stock_name": "삼성전자",       "market": "KOSPI", "sector": "반도체",    "reason": "KOSPI 시가총액 1위, 유동성 최우수"},
    {"stock_code": "000660", "stock_name": "SK하이닉스",     "market": "KOSPI", "sector": "반도체",    "reason": "KOSPI 시가총액 2위, HBM 수혜주"},
    {"stock_code": "005380", "stock_name": "현대차",         "market": "KOSPI", "sector": "자동차",    "reason": "시가총액 상위, 전기차 전환 모멘텀"},
    {"stock_code": "000270", "stock_name": "기아",           "market": "KOSPI", "sector": "자동차",    "reason": "시가총액 상위, 높은 배당수익률"},
    {"stock_code": "051910", "stock_name": "LG화학",         "market": "KOSPI", "sector": "화학/배터리","reason": "배터리 소재 대장주, 시가총액 상위"},
    {"stock_code": "006400", "stock_name": "삼성SDI",        "market": "KOSPI", "sector": "화학/배터리","reason": "EV 배터리 핵심주, 안정적 거래량"},
    {"stock_code": "207940", "stock_name": "삼성바이오로직스","market": "KOSPI", "sector": "바이오",    "reason": "바이오 CDMO 글로벌 선두, 시총 상위"},
    {"stock_code": "068270", "stock_name": "셀트리온",       "market": "KOSPI", "sector": "바이오",    "reason": "바이오시밀러 선두, 높은 변동성 활용"},
    {"stock_code": "035720", "stock_name": "카카오",         "market": "KOSPI", "sector": "IT/플랫폼", "reason": "국내 대표 플랫폼, 높은 유동성"},
    {"stock_code": "028260", "stock_name": "삼성물산",       "market": "KOSPI", "sector": "지주/건설", "reason": "삼성그룹 지주사 역할, 안정적 흐름"},
]


class WatchlistCreate(BaseModel):
    stock_code: str
    stock_name: str
    market: str = "KOSPI"
    sector: Optional[str] = None
    reason: Optional[str] = None


class WatchlistUpdate(BaseModel):
    stock_name: Optional[str] = None
    market: Optional[str] = None
    sector: Optional[str] = None
    reason: Optional[str] = None
    is_active: Optional[bool] = None


def _row(w: Watchlist) -> dict:
    return {
        "id": w.id,
        "stock_code": w.stock_code,
        "stock_name": w.stock_name,
        "market": w.market,
        "sector": w.sector,
        "reason": w.reason,
        "is_active": w.is_active,
        "created_at": w.created_at.isoformat() if w.created_at else None,
    }


@router.get("")
async def list_watchlist(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Watchlist).order_by(Watchlist.market, Watchlist.stock_code)
    )
    items = result.scalars().all()

    # DB가 비어 있으면 기본 종목 자동 초기화
    if not items:
        for d in DEFAULT_WATCHLIST:
            db.add(Watchlist(**d))
        await db.commit()
        result = await db.execute(
            select(Watchlist).order_by(Watchlist.market, Watchlist.stock_code)
        )
        items = result.scalars().all()

    active = [_row(w) for w in items if w.is_active]
    inactive = [_row(w) for w in items if not w.is_active]
    return {
        "items": [_row(w) for w in items],
        "active_count": len(active),
        "total_count": len(items),
        "criteria": [
            "KOSPI/KOSDAQ 시가총액 상위 종목 — 유동성이 높아 ML 신호 신뢰도 우수",
            "일 평균 거래대금 100억 이상 — 슬리피지(체결가 괴리) 최소화",
            "상장 2년 이상 — 충분한 학습 데이터 확보 (OHLCV 200봉 이상)",
            "섹터 분산 — 특정 업종 쏠림 리스크 방지",
            "직접 추가 가능 — 종목코드 입력으로 즉시 편입",
        ],
    }


@router.post("")
async def add_watchlist(body: WatchlistCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(
        select(Watchlist).where(Watchlist.stock_code == body.stock_code.strip().upper())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"{body.stock_code} 이미 등록된 종목입니다.")

    w = Watchlist(
        stock_code=body.stock_code.strip().upper(),
        stock_name=body.stock_name,
        market=body.market,
        sector=body.sector,
        reason=body.reason,
    )
    db.add(w)
    await db.commit()
    await db.refresh(w)
    return _row(w)


@router.patch("/{watchlist_id}")
async def update_watchlist(watchlist_id: int, body: WatchlistUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Watchlist).where(Watchlist.id == watchlist_id))
    w = result.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="종목을 찾을 수 없습니다.")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(w, field, value)
    await db.commit()
    await db.refresh(w)
    return _row(w)


@router.delete("/{watchlist_id}")
async def delete_watchlist(watchlist_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Watchlist).where(Watchlist.id == watchlist_id))
    w = result.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="종목을 찾을 수 없습니다.")
    await db.delete(w)
    await db.commit()
    return {"message": "삭제됨"}
