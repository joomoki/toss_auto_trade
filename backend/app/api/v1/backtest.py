from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db, AsyncSessionLocal
from app.models.backtest import BacktestRun

router = APIRouter(prefix="/backtest", tags=["backtest"])


class BacktestRequest(BaseModel):
    name: Optional[str] = "백테스트"
    stock_codes: list[str] = Field(..., min_length=1, max_length=20)
    start_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    initial_capital: float = Field(10_000_000, ge=100_000)
    buy_threshold: float = Field(0.6, ge=0.0, le=1.0)
    sell_threshold: float = Field(0.6, ge=0.0, le=1.0)
    stop_loss_pct: float = Field(3.0, ge=0.0, le=50.0)
    take_profit_pct: float = Field(5.0, ge=0.0, le=100.0)
    max_position_amt: float = Field(1_000_000, ge=10_000)
    max_holdings: int = Field(10, ge=1, le=30)


def _run_to_dict(r: BacktestRun, include_detail: bool = False) -> dict:
    d = {
        "id": r.id,
        "name": r.name,
        "stock_codes": r.stock_codes,
        "start_date": r.start_date,
        "end_date": r.end_date,
        "initial_capital": float(r.initial_capital),
        "status": r.status,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        "error_msg": r.error_msg,
        "summary": None,
    }
    if r.status == "DONE":
        d["summary"] = {
            "total_return_pct": float(r.total_return_pct or 0),
            "cagr_pct": float(r.cagr_pct or 0),
            "max_drawdown_pct": float(r.max_drawdown_pct or 0),
            "sharpe_ratio": float(r.sharpe_ratio or 0),
            "win_rate": float(r.win_rate or 0),
            "profit_factor": float(r.profit_factor or 0),
            "total_trades": r.total_trades or 0,
            "win_trades": r.win_trades or 0,
            "lose_trades": r.lose_trades or 0,
            "final_capital": float(r.final_capital or 0),
        }
    if include_detail:
        d["equity_curve"] = r.equity_curve or []
        d["trade_log"] = r.trade_log or []
    return d


async def _execute_backtest(run_id: int):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(BacktestRun).where(BacktestRun.id == run_id))
        run = result.scalar_one_or_none()
        if not run:
            return

        try:
            from app.services.backtest import BacktestConfig, run_backtest
            from app.services.toss_api import TossApiClient
            from app.ml.feature_engineering import compute

            api = TossApiClient.get_instance()
            config = BacktestConfig(
                stock_codes=run.stock_codes,
                start_date=run.start_date,
                end_date=run.end_date,
                initial_capital=float(run.initial_capital),
                buy_threshold=float(run.buy_threshold or 0.6),
                sell_threshold=float(run.sell_threshold or 0.6),
                stop_loss_pct=float(run.stop_loss_pct or 3.0),
                take_profit_pct=float(run.take_profit_pct or 5.0),
                max_position_amt=float(run.max_position_amt or 1_000_000),
                max_holdings=run.max_holdings or 10,
            )

            ohlcv_data = {}
            for code in run.stock_codes:
                df = await api.get_ohlcv(code, period="D", count=500)
                if not df.empty:
                    df = compute(df)
                    ohlcv_data[code] = df

            bt_result = run_backtest(config, ohlcv_data)

            run.total_return_pct = bt_result.total_return_pct
            run.cagr_pct = bt_result.cagr_pct
            run.max_drawdown_pct = bt_result.max_drawdown_pct
            run.sharpe_ratio = bt_result.sharpe_ratio
            run.win_rate = bt_result.win_rate
            run.profit_factor = bt_result.profit_factor
            run.total_trades = bt_result.total_trades
            run.win_trades = bt_result.win_trades
            run.lose_trades = bt_result.lose_trades
            run.final_capital = bt_result.final_capital
            run.equity_curve = bt_result.equity_curve
            run.trade_log = bt_result.trade_log
            run.status = "DONE"
            run.completed_at = datetime.now()

        except Exception as e:
            run.status = "FAILED"
            run.error_msg = str(e)[:499]
            run.completed_at = datetime.now()

        await db.commit()


@router.post("/run")
async def start_backtest(
    body: BacktestRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    run = BacktestRun(
        name=body.name,
        stock_codes=body.stock_codes,
        start_date=body.start_date,
        end_date=body.end_date,
        initial_capital=body.initial_capital,
        buy_threshold=body.buy_threshold,
        sell_threshold=body.sell_threshold,
        stop_loss_pct=body.stop_loss_pct,
        take_profit_pct=body.take_profit_pct,
        max_position_amt=body.max_position_amt,
        max_holdings=body.max_holdings,
        status="RUNNING",
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    background_tasks.add_task(_execute_backtest, run.id)
    return {"id": run.id, "status": "RUNNING", "message": "백테스트 시작됨"}


@router.get("")
async def list_backtests(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(BacktestRun).order_by(BacktestRun.created_at.desc()).limit(20)
    )
    return [_run_to_dict(r) for r in result.scalars().all()]


@router.get("/{run_id}")
async def get_backtest(run_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(BacktestRun).where(BacktestRun.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="백테스트 결과를 찾을 수 없습니다.")
    return _run_to_dict(run, include_detail=True)


@router.delete("/{run_id}")
async def delete_backtest(run_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(BacktestRun).where(BacktestRun.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    await db.delete(run)
    await db.commit()
    return {"message": "삭제됨"}
