"""
시스템 상태 헬스체크 API

GET /system/health  — 전체 연동 상태 한 번에 확인
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/health")
async def health_check():
    """
    모든 외부 연동 서비스의 현재 상태를 반환.
    각 항목은 {status, ...} 구조:
      ok       — 정상
      degraded — 응답은 하지만 데이터 없음 (뉴스 0건 등)
      error    — 연결 실패 또는 예외
    """
    services: dict[str, dict] = {}
    loop = asyncio.get_running_loop()

    # ── 1. DB ──────────────────────────────────────────────────────
    try:
        from app.core.database import AsyncSessionLocal
        from sqlalchemy import text
        async with AsyncSessionLocal() as db:
            await asyncio.wait_for(
                db.execute(text("SELECT 1")), timeout=3.0
            )
        services["database"] = {"status": "ok", "label": "PostgreSQL"}
    except Exception as e:
        services["database"] = {"status": "error", "label": "PostgreSQL", "msg": str(e)[:80]}

    # ── 2. yfinance (KOSPI 조회) ───────────────────────────────────
    try:
        import yfinance as yf

        def _yfetch():
            h = yf.Ticker("^KS11").history(period="3d")
            if h is not None and len(h) >= 1:
                return round(float(h["Close"].iloc[-1]), 2)
            return None

        val = await asyncio.wait_for(
            loop.run_in_executor(None, _yfetch), timeout=10.0
        )
        if val:
            services["yfinance"] = {"status": "ok", "label": "yfinance", "kospi": val}
        else:
            services["yfinance"] = {"status": "degraded", "label": "yfinance", "msg": "데이터 없음"}
    except Exception as e:
        services["yfinance"] = {"status": "error", "label": "yfinance", "msg": str(e)[:80]}

    # ── 3. 매크로 yfinance 티커 캐시 상태 ─────────────────────────
    try:
        from app.macro.event_detector import _CACHE
        yf_keys  = [k for k in _CACHE if k.startswith("yf_")]
        yf_ok    = sum(1 for k in yf_keys if _CACHE[k][1].get("last", 0) != 0.0)
        yf_total = len(yf_keys)
        if yf_total == 0:
            services["macro_data"] = {"status": "degraded", "label": "매크로 데이터", "msg": "캐시 없음 (첫 조회 전)"}
        elif yf_ok == 0:
            services["macro_data"] = {"status": "error",    "label": "매크로 데이터", "msg": f"{yf_total}개 티커 모두 실패"}
        elif yf_ok < yf_total:
            services["macro_data"] = {"status": "degraded", "label": "매크로 데이터", "msg": f"{yf_ok}/{yf_total} 티커 정상"}
        else:
            services["macro_data"] = {"status": "ok",       "label": "매크로 데이터", "msg": f"{yf_ok}개 티커 정상"}
    except Exception as e:
        services["macro_data"] = {"status": "error", "label": "매크로 데이터", "msg": str(e)[:80]}

    # ── 4. 뉴스 수집 (최근 24시간 건수) ──────────────────────────
    try:
        from app.core.database import AsyncSessionLocal
        from app.models.news import NewsItem
        from sqlalchemy import select, func
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        async with AsyncSessionLocal() as db:
            r = await db.execute(
                select(func.count()).select_from(NewsItem)
                .where(NewsItem.published_at >= cutoff)
            )
            count = int(r.scalar() or 0)
        services["news"] = {
            "status": "ok" if count > 0 else "degraded",
            "label":  "뉴스 수집",
            "count":  count,
            "msg":    f"최근 24h {count}건",
        }
    except Exception as e:
        services["news"] = {"status": "error", "label": "뉴스 수집", "msg": str(e)[:80]}

    # ── 5. DART 공시 (최근 7일) ────────────────────────────────────
    try:
        from app.core.database import AsyncSessionLocal
        from app.models.dart import DartDisclosure
        from sqlalchemy import select, func
        from datetime import date, timedelta as td
        cutoff_date = date.today() - td(days=7)
        async with AsyncSessionLocal() as db:
            r = await db.execute(
                select(func.count()).select_from(DartDisclosure)
                .where(DartDisclosure.rcept_dt >= cutoff_date)
            )
            count = int(r.scalar() or 0)
        services["dart"] = {
            "status": "ok" if count > 0 else "degraded",
            "label":  "DART 공시",
            "count":  count,
            "msg":    f"최근 7일 {count}건",
        }
    except Exception as e:
        services["dart"] = {"status": "error", "label": "DART 공시", "msg": str(e)[:80]}

    # ── 6. Kiwoom API 키 설정 여부 ─────────────────────────────────
    try:
        from app.core.config import settings
        has_key = bool(settings.kiwoom_app_key and settings.kiwoom_secret_key)
        services["kiwoom"] = {
            "status": "ok" if has_key else "error",
            "label":  "키움 API",
            "msg":    "키 설정됨" if has_key else "API 키 없음",
        }
    except Exception as e:
        services["kiwoom"] = {"status": "error", "label": "키움 API", "msg": str(e)[:80]}

    # ── 7. Telegram 설정 여부 ──────────────────────────────────────
    try:
        from app.core.config import settings
        has_tg = bool(settings.telegram_bot_token and settings.telegram_chat_id)
        services["telegram"] = {
            "status": "ok" if has_tg else "degraded",
            "label":  "텔레그램",
            "msg":    "설정됨" if has_tg else "미설정",
        }
    except Exception as e:
        services["telegram"] = {"status": "error", "label": "텔레그램", "msg": str(e)[:80]}

    # ── 8. pykrx ──────────────────────────────────────────────────
    try:
        from app.core.config import settings as _s
        if not (_s.krx_id and _s.krx_pw):
            services["pykrx"] = {
                "status": "degraded",
                "label":  "pykrx",
                "msg":    "KRX 로그인 미설정 (선택 기능)",
            }
        else:
            from datetime import date
            import io, os, sys

            _krx_id, _krx_pw = _s.krx_id, _s.krx_pw

            def _pykrx_check():
                if "KRX_ID" not in os.environ:
                    os.environ["KRX_ID"] = _krx_id
                if "KRX_PW" not in os.environ:
                    os.environ["KRX_PW"] = _krx_pw
                from pykrx import stock as krx
                from datetime import timedelta
                _buf = io.StringIO()
                _old_out, _old_err = sys.stdout, sys.stderr
                # 당일 데이터가 없을 수 있으므로 최근 5거래일 순으로 시도
                for delta in range(6):
                    ref = (date.today() - timedelta(days=delta)).strftime("%Y%m%d")
                    sys.stdout = sys.stderr = _buf
                    try:
                        df = krx.get_market_ticker_list(ref, market="KOSPI")
                    except Exception:
                        df = None
                    finally:
                        sys.stdout, sys.stderr = _old_out, _old_err
                    if df:
                        return len(df)
                return 0

            cnt = await asyncio.wait_for(
                loop.run_in_executor(None, _pykrx_check), timeout=10.0
            )
            services["pykrx"] = {
                "status": "ok" if cnt > 0 else "degraded",
                "label":  "pykrx",
                "msg":    f"KOSPI {cnt}종목",
            }
    except Exception as e:
        # pykrx는 선택적 기능 — 실패해도 overall error가 아닌 degraded로 표시
        err_msg = str(e)
        if "Expecting value" in err_msg or "JSONDecodeError" in err_msg:
            err_msg = "KRX 인증 실패 (KRX 서버 응답 오류)"
        elif "timeout" in err_msg.lower():
            err_msg = "KRX 응답 시간 초과"
        services["pykrx"] = {"status": "degraded", "label": "pykrx", "msg": err_msg[:80]}

    # ── 종합 상태 ──────────────────────────────────────────────────
    statuses = [v["status"] for v in services.values()]
    if "error" in statuses:
        overall = "error"
    elif "degraded" in statuses:
        overall = "degraded"
    else:
        overall = "ok"

    return {
        "overall": overall,
        "services": services,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
