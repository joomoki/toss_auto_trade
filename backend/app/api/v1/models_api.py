"""
ML 모델 레지스트리 API (M1-M10)
GET    /api/v1/models                         — 전체 모델 목록
GET    /api/v1/models/{model_id}/performance  — 모델 성과
GET    /api/v1/models/signals/recent          — 최근 신호
PATCH  /api/v1/models/{model_id}/toggle       — 활성화 토글
PUT    /api/v1/models/{model_id}/stocks       — 추천 종목 갱신
GET    /api/v1/models/{model_id}/stocks       — 추천 종목 조회
"""
from datetime import date, datetime, timezone, timedelta
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db
from app.models.news import MlModel, ModelDailyPerformance

router = APIRouter(prefix="/models", tags=["models"])

# ── 기본 M1-M10 모델 정의 ────────────────────────────────────
DEFAULT_MODELS = [
    {
        "model_id": "M1",
        "model_name": "이동평균 골든크로스",
        "model_type": "technical",
        "trade_style": "swing",
        "description": "EMA5/20 골든크로스·데드크로스 감지. 추세 전환 초기에 진입.",
        "version": "1.0.0",
        "weight": 1.0,
        "recommended_stocks":      ["005930", "000660", "005380", "051910", "068270"],
        "recommended_stock_names": ["삼성전자", "SK하이닉스", "현대차", "LG화학", "셀트리온"],
    },
    {
        "model_id": "M2",
        "model_name": "RSI 과매도 반등",
        "model_type": "technical",
        "trade_style": "scalping",
        "description": "RSI 14 < 30 과매도 구간 진입 후 반등 매수. 스토캐스틱으로 이중 확인.",
        "version": "1.0.0",
        "weight": 1.0,
        "recommended_stocks":      ["000270", "006400", "028260", "035720", "207940"],
        "recommended_stock_names": ["기아", "삼성SDI", "삼성물산", "카카오", "삼성바이오로직스"],
    },
    {
        "model_id": "M3",
        "model_name": "MACD 모멘텀",
        "model_type": "technical",
        "trade_style": "swing",
        "description": "MACD가 시그널선을 상향 돌파 시 BUY. 히스토그램 양전환 확인.",
        "version": "1.0.0",
        "weight": 1.0,
        "recommended_stocks":      ["005930", "000660", "005380", "068270", "051910"],
        "recommended_stock_names": ["삼성전자", "SK하이닉스", "현대차", "셀트리온", "LG화학"],
    },
    {
        "model_id": "M4",
        "model_name": "볼린저밴드 반등",
        "model_type": "technical",
        "trade_style": "scalping",
        "description": "볼린저밴드 하단(%B < 0.05) 반등 매수. RSI와 결합해 신호 강도 측정.",
        "version": "1.0.0",
        "weight": 1.0,
        "recommended_stocks":      ["000270", "006400", "207940", "035720", "028260"],
        "recommended_stock_names": ["기아", "삼성SDI", "삼성바이오로직스", "카카오", "삼성물산"],
    },
    {
        "model_id": "M5",
        "model_name": "거래량 폭발 감지",
        "model_type": "technical",
        "trade_style": "scalping",
        "description": "거래량이 20일 평균의 2배 이상 + 가격 1% 이상 상승 시 강한 매수 신호.",
        "version": "1.0.0",
        "weight": 0.8,
        "recommended_stocks":      ["005930", "000660", "005380", "051910", "068270"],
        "recommended_stock_names": ["삼성전자", "SK하이닉스", "현대차", "LG화학", "셀트리온"],
    },
    {
        "model_id": "M6",
        "model_name": "CCI 과매도 반등",
        "model_type": "technical",
        "trade_style": "swing",
        "description": "CCI(20) < -100 과매도 구간 진입 시 반등 매수. 역추세 매매 전략.",
        "version": "1.0.0",
        "weight": 0.8,
        "recommended_stocks":      ["000270", "006400", "028260", "035720", "207940"],
        "recommended_stock_names": ["기아", "삼성SDI", "삼성물산", "카카오", "삼성바이오로직스"],
    },
    {
        "model_id": "M7",
        "model_name": "VWAP 이탈 회귀",
        "model_type": "technical",
        "trade_style": "scalping",
        "description": "현재가가 VWAP 대비 -5% 이하 이탈 시 평균 회귀 매수. 단기 차익 전략.",
        "version": "1.0.0",
        "weight": 0.9,
        "recommended_stocks":      ["005930", "000660", "005380", "051910", "068270"],
        "recommended_stock_names": ["삼성전자", "SK하이닉스", "현대차", "LG화학", "셀트리온"],
    },
    {
        "model_id": "M8",
        "model_name": "스토캐스틱 골든크로스",
        "model_type": "technical",
        "trade_style": "scalping",
        "description": "스토캐스틱 K선이 D선을 과매도 구간(<30)에서 상향 돌파 시 BUY.",
        "version": "1.0.0",
        "weight": 0.9,
        "recommended_stocks":      ["000270", "006400", "028260", "035720", "207940"],
        "recommended_stock_names": ["기아", "삼성SDI", "삼성물산", "카카오", "삼성바이오로직스"],
    },
    {
        "model_id": "M9",
        "model_name": "LightGBM 스윙 (ML)",
        "model_type": "ml",
        "trade_style": "swing",
        "description": "21개 기술적 지표를 LightGBM으로 학습. 모델 파일 없을 시 복합 규칙 폴백.",
        "version": "1.1.0",
        "weight": 1.2,
        "recommended_stocks":      ["005930", "000660", "005380", "051910", "068270", "000270", "006400"],
        "recommended_stock_names": ["삼성전자", "SK하이닉스", "현대차", "LG화학", "셀트리온", "기아", "삼성SDI"],
    },
    {
        "model_id": "M10",
        "model_name": "앙상블 종합 (M1-M9)",
        "model_type": "ensemble",
        "trade_style": "ensemble",
        "description": "M1-M9 점수를 가중 평균. 40% 이상 BUY 동의 + 종합 점수 0.63 이상 시 최종 매수.",
        "version": "1.0.0",
        "weight": 1.5,
        "recommended_stocks": [],
        "recommended_stock_names": [],
    },
]


async def _init_models(db: AsyncSession):
    """테이블이 비어 있으면 기본 M1-M10 모델 등록, 있으면 신규 모델만 추가"""
    r = await db.execute(select(MlModel))
    existing_ids = {m.model_id for m in r.scalars().all()}
    added = False
    for m in DEFAULT_MODELS:
        if m["model_id"] not in existing_ids:
            db.add(MlModel(**m))
            added = True
    if added:
        await db.commit()


@router.get("")
async def get_models(db: AsyncSession = Depends(get_db)):
    await _init_models(db)
    r = await db.execute(select(MlModel).order_by(MlModel.id))
    return {"models": [_serialize_model(m) for m in r.scalars().all()]}


@router.get("/{model_id}/performance")
async def get_model_performance(
    model_id: str,
    days: int = Query(30, ge=7, le=365),
    db: AsyncSession = Depends(get_db),
):
    cutoff = date.today() - timedelta(days=days)
    r = await db.execute(
        select(ModelDailyPerformance)
        .where(
            ModelDailyPerformance.model_id == model_id,
            ModelDailyPerformance.perf_date >= cutoff,
        )
        .order_by(ModelDailyPerformance.perf_date)
    )
    rows = r.scalars().all()

    cumulative = 0.0
    timeline = []
    for row in rows:
        cumulative += float(row.realized_pnl or 0)
        timeline.append({
            "date":            row.perf_date.isoformat(),
            "signal_count":    row.signal_count,
            "executed_count":  row.executed_count,
            "win_count":       row.win_count,
            "lose_count":      row.lose_count,
            "realized_pnl":    float(row.realized_pnl or 0),
            "cumulative_pnl":  round(cumulative, 2),
            "win_rate":        float(row.win_rate or 0),
        })

    total_executed = sum(r.executed_count or 0 for r in rows)
    total_wins     = sum(r.win_count or 0 for r in rows)
    return {
        "model_id":       model_id,
        "days":           days,
        "total_pnl":      round(cumulative, 2),
        "total_signals":  sum(r.signal_count or 0 for r in rows),
        "total_executed": total_executed,
        "win_rate":       round(total_wins / total_executed, 4) if total_executed else 0,
        "timeline":       timeline,
    }


@router.get("/signals/recent")
async def get_recent_signals(
    hours: int = Query(24, ge=1, le=168),
    model_id: str = Query(""),
    db: AsyncSession = Depends(get_db),
):
    from app.models.signal import TradeSignal
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(TradeSignal).where(TradeSignal.created_at >= cutoff)
    if model_id:
        q = q.where(TradeSignal.model_id == model_id)  # type: ignore[attr-defined]
    q = q.order_by(desc(TradeSignal.created_at)).limit(100)
    r = await db.execute(q)
    signals = r.scalars().all()
    return {
        "signals": [
            {
                "id":              s.id,
                "stock_code":      s.stock_code,
                "signal_type":     s.signal_type,
                "confidence":      float(s.confidence) if s.confidence else 0,
                "price_at_signal": float(s.price_at_signal) if s.price_at_signal else 0,
                "model_id":        getattr(s, "model_id", None),
                "created_at":      s.created_at.isoformat() if s.created_at else None,
            }
            for s in signals
        ],
        "hours": hours,
    }


@router.patch("/{model_id}/toggle")
async def toggle_model(model_id: str, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(MlModel).where(MlModel.model_id == model_id))
    model = r.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    model.is_active = not model.is_active  # type: ignore[assignment]
    await db.commit()
    return {"model_id": model_id, "is_active": model.is_active}


class StockItem(BaseModel):
    code: str
    name: str = ""


class StocksBody(BaseModel):
    stocks: list[StockItem]


@router.put("/{model_id}/stocks")
async def update_recommended_stocks(
    model_id: str,
    body: StocksBody,
    db: AsyncSession = Depends(get_db),
):
    """모델 추천 종목 목록 갱신 (코드 + 종목명)"""
    r = await db.execute(select(MlModel).where(MlModel.model_id == model_id))
    model = r.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    valid = [s for s in body.stocks if s.code.strip()]
    model.recommended_stocks      = [s.code.strip() for s in valid]   # type: ignore
    model.recommended_stock_names = [s.name.strip() for s in valid]   # type: ignore
    await db.commit()
    await db.refresh(model)
    return {
        "model_id":              model_id,
        "recommended_stocks":      model.recommended_stocks,
        "recommended_stock_names": model.recommended_stock_names,
    }


@router.get("/{model_id}/stocks")
async def get_recommended_stocks(model_id: str, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(MlModel).where(MlModel.model_id == model_id))
    model = r.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    codes = model.recommended_stocks      or []
    names = model.recommended_stock_names or []
    return {
        "model_id":              model_id,
        "recommended_stocks":      codes,
        "recommended_stock_names": names,
        "stocks": [{"code": c, "name": names[i] if i < len(names) else ""} for i, c in enumerate(codes)],
    }


def _serialize_model(m: MlModel) -> dict:
    codes = m.recommended_stocks      or []
    names = m.recommended_stock_names or []
    return {
        "id":                       m.id,
        "model_id":                 m.model_id,
        "model_name":               m.model_name,
        "model_type":               m.model_type,
        "trade_style":              m.trade_style,
        "description":              m.description,
        "version":                  m.version,
        "is_active":                m.is_active,
        "weight":                   float(m.weight) if m.weight is not None else 1.0,
        "recommended_stocks":       codes,
        "recommended_stock_names":  names,
        "stocks": [
            {"code": c, "name": names[i] if i < len(names) else ""}
            for i, c in enumerate(codes)
        ],
        "win_rate":            float(m.win_rate)        if m.win_rate        is not None else None,
        "profit_factor":       float(m.profit_factor)   if m.profit_factor   is not None else None,
        "sharpe_ratio":        float(m.sharpe_ratio)    if m.sharpe_ratio    is not None else None,
        "max_drawdown":        float(m.max_drawdown)    if m.max_drawdown    is not None else None,
        "total_signals":       m.total_signals,
        "last_trained_at":     m.last_trained_at.isoformat() if m.last_trained_at else None,
        "created_at":          m.created_at.isoformat()      if m.created_at      else None,
    }
