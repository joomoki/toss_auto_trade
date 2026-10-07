"""
텔레그램 알림 설정 API
GET  /api/v1/telegram/status          — 연결 상태 조회
POST /api/v1/telegram/test            — 테스트 메시지 전송
POST /api/v1/telegram/config          — 봇 토큰·Chat ID 저장
GET  /api/v1/telegram/settings        — 알림 설정 전체 조회
POST /api/v1/telegram/settings        — 알림 설정 저장 (주기 포함)
POST /api/v1/telegram/send/status     — 현재 포트폴리오 현황 즉시 전송
POST /api/v1/telegram/send/morning    — 모닝 리포트 즉시 전송
POST /api/v1/telegram/send/hourly     — 시간별 진행현황 즉시 전송
POST /api/v1/telegram/send/close      — 종가 결산 리포트 즉시 전송
POST /api/v1/telegram/send/screening  — 섹터 스크리닝 결과 즉시 전송
"""
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query, Request
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.services.telegram_notifier import notify_test, is_configured

router = APIRouter(prefix="/telegram", tags=["telegram"])
_ENV_PATH = Path(__file__).parents[3] / ".env"


class TelegramConfig(BaseModel):
    bot_token: str
    chat_id: str


class TelegramSettings(BaseModel):
    status_interval: int = 0        # 분 단위 주기 (0=비활성)
    notify_buy: bool = True
    notify_sell: bool = True
    notify_error: bool = True
    notify_kill_switch: bool = True
    notify_morning: bool = True
    notify_hourly: bool = True
    notify_close: bool = True
    notify_screening: bool = True
    notify_from: str = "00:00"      # 발송 시작 시각 HH:MM
    notify_to: str = "23:59"        # 발송 종료 시각 HH:MM
    notify_business_only: bool = False  # 영업일(평일)만 발송


_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


async def _require_local(request: Request) -> None:
    """매수·매도 등 실거래 엔드포인트를 로컬 클라이언트로 제한"""
    host = (request.client.host if request.client else "") or ""
    if host not in _LOCAL_HOSTS:
        raise HTTPException(status_code=403, detail="로컬에서만 접근 가능합니다.")


def _mask(token: str) -> str:
    if not token:
        return ""
    return token[:10] + "…" + token[-4:] if len(token) > 14 else "****"


def _read_bool_env(key: str, default: bool = True) -> bool:
    from dotenv import dotenv_values
    vals = dotenv_values(str(_ENV_PATH))
    v = vals.get(key, "").lower()
    if not v:
        return default
    return v not in ("false", "0", "no", "off")


@router.get("/status")
async def get_status():
    configured = is_configured()
    return {
        "configured": configured,
        "bot_token_masked": _mask(settings.telegram_bot_token),
        "chat_id": settings.telegram_chat_id if configured else "",
    }


@router.post("/test")
async def send_test():
    if not is_configured():
        raise HTTPException(
            status_code=400,
            detail="텔레그램 봇 토큰과 Chat ID가 설정되지 않았습니다. 먼저 설정을 저장하세요.",
        )
    ok = await notify_test()
    if not ok:
        raise HTTPException(status_code=502, detail="메시지 전송 실패. 봇 토큰과 Chat ID를 확인하세요.")
    return {"message": "테스트 메시지를 전송했습니다."}


@router.post("/config")
async def save_config(body: TelegramConfig):
    from dotenv import set_key
    token = body.bot_token.strip()
    chat  = body.chat_id.strip()
    set_key(str(_ENV_PATH), "TELEGRAM_BOT_TOKEN", token)
    set_key(str(_ENV_PATH), "TELEGRAM_CHAT_ID",   chat)
    settings.telegram_bot_token = token
    settings.telegram_chat_id   = chat
    return {
        "configured": bool(token and chat),
        "bot_token_masked": _mask(token),
        "chat_id": chat,
        "message": "텔레그램 설정이 저장되었습니다.",
    }


@router.get("/settings")
async def get_settings():
    return {
        "status_interval":      settings.telegram_status_interval,
        "notify_buy":           settings.telegram_notify_buy,
        "notify_sell":          settings.telegram_notify_sell,
        "notify_error":         settings.telegram_notify_error,
        "notify_kill_switch":   settings.telegram_notify_kill_switch,
        "notify_morning":       settings.telegram_notify_morning,
        "notify_hourly":        settings.telegram_notify_hourly,
        "notify_close":         settings.telegram_notify_close,
        "notify_screening":     settings.telegram_notify_screening,
        "notify_from":          settings.telegram_notify_from,
        "notify_to":            settings.telegram_notify_to,
        "notify_business_only": settings.telegram_notify_business_only,
    }


@router.post("/settings")
async def save_settings(body: TelegramSettings):
    from dotenv import set_key
    from app.core.scheduler import update_telegram_status_job

    def _bstr(v: bool) -> str:
        return "true" if v else "false"

    set_key(str(_ENV_PATH), "TELEGRAM_STATUS_INTERVAL",        str(body.status_interval))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_BUY",             _bstr(body.notify_buy))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_SELL",            _bstr(body.notify_sell))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_ERROR",           _bstr(body.notify_error))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_KILL_SWITCH",     _bstr(body.notify_kill_switch))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_MORNING",         _bstr(body.notify_morning))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_HOURLY",          _bstr(body.notify_hourly))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_CLOSE",           _bstr(body.notify_close))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_SCREENING",       _bstr(body.notify_screening))
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_FROM",            body.notify_from)
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_TO",              body.notify_to)
    set_key(str(_ENV_PATH), "TELEGRAM_NOTIFY_BUSINESS_ONLY",   _bstr(body.notify_business_only))

    settings.telegram_status_interval    = body.status_interval
    settings.telegram_notify_buy          = body.notify_buy
    settings.telegram_notify_sell         = body.notify_sell
    settings.telegram_notify_error        = body.notify_error
    settings.telegram_notify_kill_switch  = body.notify_kill_switch
    settings.telegram_notify_morning      = body.notify_morning
    settings.telegram_notify_hourly       = body.notify_hourly
    settings.telegram_notify_close        = body.notify_close
    settings.telegram_notify_screening    = body.notify_screening
    settings.telegram_notify_from         = body.notify_from
    settings.telegram_notify_to           = body.notify_to
    settings.telegram_notify_business_only = body.notify_business_only
    update_telegram_status_job(body.status_interval)

    return {"message": "설정이 저장되었습니다.", "status_interval": body.status_interval}


# ── 수동 전송 엔드포인트 ─────────────────────────────────────────

@router.post("/send/status")
async def send_status_now(db: AsyncSession = Depends(get_db)):
    """현재 포트폴리오 현황 즉시 전송"""
    if not is_configured():
        raise HTTPException(status_code=400, detail="텔레그램 미설정")
    from app.services.kiwoom_api import KiwoomApiClient
    from app.services.telegram_notifier import notify_portfolio_status
    from app.models.holding import Holding
    from sqlalchemy import select as sa_select

    # 잔고는 키움 실시간, 보유종목은 DB (현재가·수익률 이미 동기화)
    try:
        kiwoom = KiwoomApiClient.get_instance()
        balance_raw = await kiwoom.get_balance()
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Kiwoom 잔고 조회 실패: {e}")
        balance_raw = {"availableCash": 0, "totalAsset": 0, "totalPnl": 0, "totalPnlRate": 0}

    r = await db.execute(sa_select(Holding).order_by(Holding.stock_code))
    db_holdings = r.scalars().all()
    holdings = [
        {
            "stock_code":         h.stock_code,
            "stock_name":         h.stock_name,
            "quantity":           h.quantity,
            "avg_buy_price":      float(h.avg_buy_price or 0),
            "current_price":      float(h.current_price or h.avg_buy_price or 0),
            "unrealized_pnl":     float(h.unrealized_pnl or 0),
            "unrealized_pnl_pct": float(h.unrealized_pnl_pct or 0),
        }
        for h in db_holdings
    ]
    await notify_portfolio_status(holdings, balance_raw, force=True)
    return {"message": "포트폴리오 현황을 전송했습니다."}


@router.post("/send/morning")
async def send_morning_now(db: AsyncSession = Depends(get_db)):
    """모닝 리포트 즉시 전송"""
    if not is_configured():
        raise HTTPException(status_code=400, detail="텔레그램 미설정")
    try:
        from app.services.report_service import send_morning_report
        await send_morning_report(db, force=True)
        return {"message": "모닝 리포트를 전송했습니다."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"전송 실패: {e}")


@router.post("/send/hourly")
async def send_hourly_now(db: AsyncSession = Depends(get_db)):
    """시간별 진행현황 즉시 전송"""
    if not is_configured():
        raise HTTPException(status_code=400, detail="텔레그램 미설정")
    try:
        from app.services.report_service import send_hourly_progress
        await send_hourly_progress(db, force=True)
        return {"message": "진행현황 리포트를 전송했습니다."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"전송 실패: {e}")


@router.post("/send/close")
async def send_close_now(db: AsyncSession = Depends(get_db)):
    """종가 결산 리포트 즉시 전송"""
    if not is_configured():
        raise HTTPException(status_code=400, detail="텔레그램 미설정")
    try:
        from app.services.report_service import send_close_report
        await send_close_report(db, force=True)
        return {"message": "결산 리포트를 전송했습니다."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"전송 실패: {e}")


@router.get("/logs")
async def get_telegram_logs(
    days: int = Query(7, ge=1, le=90),
    msg_type: Optional[str] = Query(None, description="buy/sell/kill_switch/error/report/portfolio/hourly/close/screening/test"),
    db: AsyncSession = Depends(get_db),
):
    """텔레그램 전송 내역 조회"""
    from app.models.telegram_log import TelegramLog
    from datetime import datetime, timezone, timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    q = select(TelegramLog).where(TelegramLog.sent_at >= cutoff)
    if msg_type:
        q = q.where(TelegramLog.msg_type == msg_type)
    q = q.order_by(desc(TelegramLog.sent_at)).limit(200)

    r = await db.execute(q)
    logs = r.scalars().all()
    return [
        {
            "id":         l.id,
            "msg_type":   l.msg_type,
            "stock_code": l.stock_code,
            "stock_name": l.stock_name,
            "message":    l.message,
            "is_success": l.is_success,
            "sent_at":    l.sent_at.isoformat() if l.sent_at else None,
        }
        for l in logs
    ]


# ── 텔레그램 수신함 (내 메시지) ─────────────────────────────────

@router.get("/inbox")
async def get_telegram_inbox(
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """사용자가 텔레그램 봇으로 보낸 메시지 목록 (최신순)"""
    from app.models.telegram_message import TelegramUserMessage

    r = await db.execute(
        select(TelegramUserMessage)
        .order_by(desc(TelegramUserMessage.received_at))
        .limit(limit)
    )
    msgs = r.scalars().all()
    return [
        {
            "id":          m.id,
            "tg_msg_id":   m.tg_msg_id,
            "received_at": m.received_at.isoformat() if m.received_at else None,
            "from_user":   m.from_user,
            "text":        m.text,
            "is_command":  m.is_command,
        }
        for m in msgs
    ]


# ── 텔레그램 명령어 ──────────────────────────────────────────────

class CommandRequest(BaseModel):
    text: str
    source: str = "web"


@router.post("/command")
async def run_command(
    body: CommandRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_require_local),
):
    """웹 UI에서 명령어 실행 (텔레그램 없이도 동작)"""
    from app.services.telegram_command_handler import execute_command
    res = await execute_command(
        text=body.text.strip(),
        db=db,
        source=body.source or "web",
        chat_id="web",
        user_name="web",
    )
    # 성공한 경우 텔레그램으로도 알림
    if res["result"] == "success" and is_configured():
        from app.services import telegram_notifier as tg
        await tg.send_message(res["result_msg"], force=True, msg_type="command")
    return res


@router.get("/command-logs")
async def get_command_logs(
    days: int = Query(7, ge=1, le=90),
    command_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """텔레그램 명령어 수신·실행 이력 조회"""
    from app.models.telegram_command_log import TelegramCommandLog
    from datetime import datetime, timezone, timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    q = select(TelegramCommandLog).where(TelegramCommandLog.received_at >= cutoff)
    if command_type:
        q = q.where(TelegramCommandLog.command_type == command_type)
    q = q.order_by(desc(TelegramCommandLog.received_at)).limit(200)

    r = await db.execute(q)
    logs = r.scalars().all()
    return [
        {
            "id":           l.id,
            "received_at":  l.received_at.isoformat() if l.received_at else None,
            "source":       l.source,
            "chat_id":      l.chat_id,
            "user_name":    l.user_name,
            "raw_text":     l.raw_text,
            "command_type": l.command_type,
            "stock_code":   l.stock_code,
            "stock_name":   l.stock_name,
            "quantity":     l.quantity,
            "result":       l.result,
            "result_msg":   l.result_msg,
        }
        for l in logs
    ]


@router.post("/send/screening")
async def send_screening_now(db: AsyncSession = Depends(get_db)):
    """섹터 스크리닝 결과 즉시 전송"""
    if not is_configured():
        raise HTTPException(status_code=400, detail="텔레그램 미설정")
    try:
        from app.services.sector_screener import run_sector_screening
        from app.services.report_service import send_sector_screening_report
        from app.core.config import settings as _s
        results = await run_sector_screening(db, max_stock_price=_s.max_stock_price)
        await send_sector_screening_report(results, force=True)
        return {"message": f"스크리닝 결과를 전송했습니다. ({len(results)}종목 분석)"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"전송 실패: {e}")
