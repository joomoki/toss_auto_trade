"""
매크로 섹터 로테이션 API

GET  /macro/status            — 현재 이벤트 + 섹터 신호
POST /macro/run               — 파이프라인 수동 실행
GET  /macro/runs              — 최근 실행 이력
POST /macro/backtest          — 백테스트 실행
GET  /macro/backtest/{id}     — 백테스트 결과 조회
GET  /macro/map               — 이벤트-섹터 매핑 테이블 조회
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.macro.schemas import TradeMode

router = APIRouter(prefix="/macro", tags=["macro"])


# ── 스키마 ────────────────────────────────────────────────────────────────────

class RunRequest(BaseModel):
    mode: TradeMode = TradeMode.PAPER


class BacktestRequest(BaseModel):
    start_date:      str    = "2024-01-01"
    end_date:        str    = "2025-12-31"
    initial_capital: float  = 10_000_000
    hold_days:       int    = 5
    top_sectors:     int    = 2
    max_stocks:      int    = 2
    stop_loss_pct:   float  = 5.0
    take_profit_pct: float  = 10.0


# ── 현재 상태 ─────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_status():
    """현재 매크로 이벤트 + 섹터 신호 (실시간 감지, 캐시 30분)"""
    from app.macro.event_detector import detect_events
    from app.macro.sector_mapper import compute_sector_signals, load_map_config

    cfg     = load_map_config()
    events  = await detect_events(cfg)
    signals = compute_sector_signals(events)

    return {
        "events": [
            {
                "event_id":   e.event_id,
                "name":       e.name,
                "category":   e.category.value,
                "score":      e.score,
                "magnitude":  e.magnitude,
                "confidence": e.confidence,
                "persistence":e.persistence,
                "evidence":   e.evidence,
                "detected_at":e.detected_at.isoformat(),
            }
            for e in events
        ],
        "sector_signals": [
            {
                "sector_id":   s.sector_id,
                "sector_name": s.sector_name,
                "net_score":   s.net_score,
                "direction":   s.direction.value,
                "contributions": [
                    {
                        "event_id":    c.event_id,
                        "event_name":  c.event_name,
                        "weight":      c.weight,
                        "event_score": c.event_score,
                        "contribution":c.contribution,
                    }
                    for c in s.contributions
                ],
            }
            for s in signals
        ],
    }


# ── 파이프라인 실행 ───────────────────────────────────────────────────────────

@router.post("/run")
async def run_pipeline(body: RunRequest, background_tasks: BackgroundTasks):
    """파이프라인 수동 실행 (백그라운드)"""
    from app.macro.portfolio_engine import run_pipeline

    result_holder: dict = {}

    async def _run():
        result = await run_pipeline(body.mode)
        result_holder["result"] = result

    background_tasks.add_task(_run)

    return {
        "message":  f"파이프라인 실행 시작 (mode={body.mode.value})",
        "mode":     body.mode.value,
    }


@router.post("/run/sync")
async def run_pipeline_sync(body: RunRequest):
    """파이프라인 동기 실행 (응답 대기, UI 수동 테스트용)"""
    from app.macro.portfolio_engine import run_pipeline
    result = await run_pipeline(body.mode)

    return {
        "run_at":    result.run_at.isoformat(),
        "mode":      result.mode.value,
        "events":    len(result.events),
        "orders":    len(result.orders_placed),
        "log":       result.log,
        "sector_signals": [
            {"sector": s.sector_id, "name": s.sector_name, "score": s.net_score, "dir": s.direction.value}
            for s in result.sector_signals
        ],
        "orders_placed": [
            {
                "code": o.stock_code, "name": o.stock_name,
                "action": o.action, "qty": o.quantity, "price": o.price,
                "reason": o.reason, "mode": o.mode.value,
            }
            for o in result.orders_placed
        ],
    }


# ── 실행 이력 ─────────────────────────────────────────────────────────────────

@router.get("/runs")
async def get_runs(limit: int = 20, db: AsyncSession = Depends(get_db)):
    """최근 실행 이력"""
    from app.models.macro import MacroRunLog
    r = await db.execute(
        select(MacroRunLog).order_by(desc(MacroRunLog.run_at)).limit(limit)
    )
    rows = r.scalars().all()
    return {
        "runs": [
            {
                "id":           row.id,
                "mode":         row.mode,
                "events":       row.events_json or [],
                "signals":      row.signals_json or [],
                "orders_count": row.orders_count,
                "run_at":       row.run_at.isoformat() if row.run_at else None,
            }
            for row in rows
        ]
    }


# ── 백테스트 ──────────────────────────────────────────────────────────────────

@router.post("/backtest")
async def start_backtest(body: BacktestRequest, db: AsyncSession = Depends(get_db)):
    """백테스트 실행 (동기, 최대 수 분 소요)"""
    from datetime import date as dt
    from app.macro.backtest_runner import BacktestConfig, run_backtest
    from app.models.macro import MacroBacktestRun

    cfg = BacktestConfig(
        start_date=dt.fromisoformat(body.start_date),
        end_date=dt.fromisoformat(body.end_date),
        initial_capital=body.initial_capital,
        hold_days=body.hold_days,
        top_sectors=body.top_sectors,
        max_stocks=body.max_stocks,
        stop_loss_pct=body.stop_loss_pct,
        take_profit_pct=body.take_profit_pct,
    )

    result = await run_backtest(cfg)

    # DB 저장
    row = MacroBacktestRun(
        start_date=body.start_date,
        end_date=body.end_date,
        initial_capital=body.initial_capital,
        total_return=round(result.total_return, 4),
        annualized_return=round(result.annualized_return, 4),
        max_drawdown=round(result.max_drawdown, 4),
        sharpe_ratio=round(result.sharpe_ratio, 4),
        win_rate=round(result.win_rate, 4),
        total_trades=result.total_trades,
        benchmark_return=round(result.benchmark_return, 4),
        excess_return=round(result.excess_return, 4),
        equity_curve=result.equity_curve[-100:],  # 최근 100개만 저장
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    return {
        "id":                row.id,
        "total_return_pct":  round(result.total_return * 100, 2),
        "annualized_return_pct": round(result.annualized_return * 100, 2),
        "max_drawdown_pct":  round(result.max_drawdown * 100, 2),
        "sharpe_ratio":      round(result.sharpe_ratio, 3),
        "win_rate_pct":      round(result.win_rate * 100, 1),
        "total_trades":      result.total_trades,
        "benchmark_pct":     round(result.benchmark_return * 100, 2),
        "excess_return_pct": round(result.excess_return * 100, 2),
        "equity_curve":      result.equity_curve[-50:],
    }


@router.get("/backtest/{run_id}")
async def get_backtest(run_id: int, db: AsyncSession = Depends(get_db)):
    from app.models.macro import MacroBacktestRun
    r = await db.execute(select(MacroBacktestRun).where(MacroBacktestRun.id == run_id))
    row = r.scalar_one_or_none()
    if not row:
        raise HTTPException(404, "백테스트 결과를 찾을 수 없습니다.")
    return {
        "id": row.id,
        "start_date": row.start_date,
        "end_date": row.end_date,
        "total_return_pct": float(row.total_return or 0) * 100,
        "annualized_return_pct": float(row.annualized_return or 0) * 100,
        "max_drawdown_pct": float(row.max_drawdown or 0) * 100,
        "sharpe_ratio": float(row.sharpe_ratio or 0),
        "win_rate_pct": float(row.win_rate or 0) * 100,
        "total_trades": row.total_trades,
        "benchmark_pct": float(row.benchmark_return or 0) * 100,
        "excess_return_pct": float(row.excess_return or 0) * 100,
        "equity_curve": row.equity_curve or [],
    }


# ── yfinance 원시 데이터 진단 ──────────────────────────────────────────────────

@router.get("/debug/market")
async def debug_market():
    """yfinance 원시 데이터 확인용 (이벤트가 왜 0인지 진단)"""
    from app.macro.event_detector import _fetch_price_info
    tickers = {
        "유가(WTI)":  "CL=F",
        "유가(Brent)": "BZ=F",
        "USD/KRW":    "KRW=X",
        "VIX":        "^VIX",
        "금":         "GC=F",
        "미10년물":   "^TNX",
    }
    result = {}
    for label, ticker in tickers.items():
        info = _fetch_price_info(ticker)
        result[label] = {
            "현재": round(info["last"], 4),
            "전일": round(info["prev"], 4),
            "일변동%": round(info["chg_pct"], 3),
            "5일변동%": round(info["five_day_pct"], 3),
            "데이터있음": info["last"] != 0.0,
        }
    return result


# ── 매핑 테이블 조회 ──────────────────────────────────────────────────────────

@router.get("/map")
async def get_map():
    """이벤트-섹터 매핑 테이블 조회"""
    from app.macro.sector_mapper import load_map_config
    cfg = load_map_config()
    return {
        "version":  cfg.get("version"),
        "updated":  cfg.get("updated"),
        "events":   cfg.get("events", {}),
        "sectors":  cfg.get("sectors", {}),
        "mappings": cfg.get("mappings", []),
    }
