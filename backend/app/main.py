import logging
import logging.handlers
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ── 자동매매 엔진 로그 파일 설정 ─────────────────────────────────
_LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")
os.makedirs(_LOG_DIR, exist_ok=True)
_log_path = os.path.join(_LOG_DIR, "auto_trade.log")

_file_handler = logging.handlers.RotatingFileHandler(
    _log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
)
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%H:%M:%S"))
_file_handler.setLevel(logging.INFO)

for _logger_name in (
    "app.services.auto_trade_engine",
    "app.services.sector_screener",
):
    _lg = logging.getLogger(_logger_name)
    _lg.addHandler(_file_handler)
    _lg.setLevel(logging.INFO)

from app.core.database import engine, Base
from app.core.scheduler import scheduler, setup_scheduler
from app.core.config import settings
import app.models  # noqa: F401 — 모든 ORM 모델을 Base.metadata에 등록
from app.api.v1 import dashboard, trades, holdings, signals, strategy, ws, backtest, portfolio, watchlist
from app.api.v1 import news_api, models_api, auto_trade_api, model_portfolio_api, stock_prices_api
from app.api.v1 import telegram_api
from app.api.v1 import dart_api, supply_api
from app.api.v1 import macro_api
from app.api.v1 import system_api
from app.api.v1 import screened_api
from app.api.v1 import manual_buy_api
from app.api.v1 import stock_master_api
from app.api.v1 import account_debug_api
from app.api.v1 import account_snapshot_api
from app.api.v1 import rising_stock_api
from app.api.v1 import premarket_api
from app.api.v1.ws import broadcast


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # supply_score 컬럼 누락 시 자동 추가 (ALTER TABLE IF NOT EXISTS)
        from sqlalchemy import text
        await conn.execute(text(
            "ALTER TABLE toss_stock.auto_trade_logs "
            "ADD COLUMN IF NOT EXISTS supply_score NUMERIC(5,4)"
        ))
        await conn.execute(text(
            "ALTER TABLE toss_stock.holdings "
            "ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE"
        ))
        await conn.execute(text(
            "ALTER TABLE toss_stock.holdings "
            "ADD COLUMN IF NOT EXISTS is_long_term BOOLEAN DEFAULT FALSE"
        ))
        await conn.execute(text(
            "ALTER TABLE toss_stock.holdings "
            "ADD COLUMN IF NOT EXISTS peak_pnl_pct NUMERIC(8,4)"
        ))
        await conn.execute(text(
            "ALTER TABLE toss_stock.holdings "
            "ADD COLUMN IF NOT EXISTS smart_hold_loss_cycles INTEGER DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE toss_stock.auto_trade_logs "
            "ADD COLUMN IF NOT EXISTS commission NUMERIC(10,2)"
        ))
        await conn.execute(text(
            "ALTER TABLE toss_stock.auto_trade_logs "
            "ADD COLUMN IF NOT EXISTS tax NUMERIC(10,2)"
        ))
        await conn.execute(text(
            "ALTER TABLE toss_stock.strategies "
            "ADD COLUMN IF NOT EXISTS total_deposited NUMERIC(15,2) DEFAULT 0"
        ))

    async def signal_job():
        from app.core.database import AsyncSessionLocal
        from app.services.signal_engine import SignalEngine
        async with AsyncSessionLocal() as db:
            engine_svc = SignalEngine(db)
            engine_svc.ws_broadcast = broadcast
            await engine_svc.run()

    setup_scheduler(signal_job, settings.signal_interval_minutes)
    scheduler.start()

    # 텔레그램 주기 현황 리포트 — 저장된 설정 복원
    if settings.telegram_status_interval > 0:
        from app.core.scheduler import update_telegram_status_job
        update_telegram_status_job(settings.telegram_status_interval)

    # KOSPI/KOSDAQ 종목 마스터 갱신 (오늘 미갱신 시에만, 백그라운드)
    async def _refresh_stock_master():
        import asyncio
        await asyncio.sleep(2)  # DB 연결 안정화 대기
        from app.core.database import AsyncSessionLocal
        from app.services.stock_master_service import maybe_refresh_stock_master
        async with AsyncSessionLocal() as db:
            await maybe_refresh_stock_master(db)

    import asyncio as _asyncio
    _asyncio.create_task(_refresh_stock_master())

    yield

    # Shutdown
    scheduler.shutdown(wait=False)
    from app.services.toss_api import TossApiClient
    await TossApiClient.get_instance().close()
    await engine.dispose()


app = FastAPI(
    title="키움증권 AI 자동매매",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboard.router, prefix="/api/v1")
app.include_router(trades.router, prefix="/api/v1")
app.include_router(holdings.router, prefix="/api/v1")
app.include_router(signals.router, prefix="/api/v1")
app.include_router(strategy.router, prefix="/api/v1")
app.include_router(backtest.router, prefix="/api/v1")
app.include_router(portfolio.router, prefix="/api/v1")
app.include_router(watchlist.router, prefix="/api/v1")
app.include_router(news_api.router, prefix="/api/v1")
app.include_router(models_api.router, prefix="/api/v1")
app.include_router(auto_trade_api.router, prefix="/api/v1")
app.include_router(model_portfolio_api.router, prefix="/api/v1")
app.include_router(stock_prices_api.router, prefix="/api/v1")
app.include_router(telegram_api.router, prefix="/api/v1")
app.include_router(dart_api.router,   prefix="/api/v1")
app.include_router(supply_api.router, prefix="/api/v1")
app.include_router(macro_api.router,  prefix="/api/v1")
app.include_router(system_api.router, prefix="/api/v1")
app.include_router(screened_api.router,   prefix="/api/v1")
app.include_router(manual_buy_api.router,    prefix="/api/v1")
app.include_router(stock_master_api.router,  prefix="/api/v1")
app.include_router(account_debug_api.router,   prefix="/api/v1")
app.include_router(account_snapshot_api.router, prefix="/api/v1")
app.include_router(rising_stock_api.router,    prefix="/api/v1")
app.include_router(premarket_api.router,       prefix="/api/v1")
app.include_router(ws.router)


@app.get("/health")
async def health():
    return {"status": "ok", "auto_trade": settings.auto_trade_enabled}
