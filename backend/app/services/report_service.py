"""
매수 후보 리포트 생성 + 텔레그램 전송
- 장 시작 전(08:50) 자동 실행
- 매 정시 진행 현황 전송
- 장 마감(15:35) 결과 리포트 전송
- API 엔드포인트로 수동 실행
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.models.strategy import Strategy
from app.models.news import AutoTradeLog
from app.services.auto_trade_engine import AutoTradeEngine, W_MODEL, W_NEWS, W_DART, W_MARKET, W_SUPPLY
from app.services import telegram_notifier as tg

logger = logging.getLogger(__name__)


async def _get_macro_data() -> tuple[list[dict], list[dict]]:
    """현재 매크로 이벤트 + 섹터 신호 반환. 실패하면 빈 리스트."""
    try:
        from app.macro.event_detector import detect_events
        from app.macro.sector_mapper import compute_sector_signals, load_map_config
        cfg = load_map_config()
        events = await detect_events(cfg)
        signals = compute_sector_signals(events) if events else []
        return (
            [
                {
                    "name": e.name,
                    "category": e.category,
                    "magnitude": e.magnitude,
                    "confidence": e.confidence,
                }
                for e in events
            ],
            [
                {
                    "sector_name": s.sector_name,
                    "net_score": s.net_score,
                    "direction": s.direction.value,
                }
                for s in signals
            ],
        )
    except Exception as e:
        logger.warning(f"매크로 데이터 조회 실패: {e}")
        return [], []


async def _get_strategy(db: AsyncSession):
    r = await db.execute(select(Strategy).where(Strategy.is_active == True).limit(1))
    s = r.scalar_one_or_none()
    if not s:
        r2 = await db.execute(select(Strategy).order_by(Strategy.id).limit(1))
        s = r2.scalar_one_or_none()
    return s


async def _load_report_from_db(db: AsyncSession) -> dict:
    """screened_stocks 최근 24h 데이터로 리포트 구성 (API 재호출 없음 — 빠름)"""
    from datetime import datetime, timezone, timedelta
    from sqlalchemy import select as sa_select
    from app.models.screened_stock import ScreenedStock

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    r = await db.execute(
        sa_select(ScreenedStock)
        .where(ScreenedStock.screened_at >= cutoff)
        .order_by(ScreenedStock.screened_at.desc(), ScreenedStock.composite_score.desc())
    )
    rows = r.scalars().all()

    seen: set[str] = set()
    previews = []
    for row in rows:
        if row.stock_code in seen:
            continue
        seen.add(row.stock_code)
        previews.append({
            "stock_code":      row.stock_code,
            "stock_name":      row.stock_name or row.stock_code,
            "composite_score": float(row.composite_score or 0),
            "model_score":     float(row.model_score or 0.5),
            "news_score":      float(row.news_score or 0.5),
            "dart_score":      float(row.dart_score or 0.5),
            "supply_score":    float(row.supply_score or 0.5),
            "market_score":    float(row.market_score or 0.5),
            "final_signal":    row.final_signal or "HOLD",
            "trigger_models":  list(row.trigger_models or []),
            "current_price":   int(row.current_price or 0),
        })

    previews.sort(key=lambda x: x["composite_score"], reverse=True)

    now = datetime.now()
    h, wd = now.hour, now.weekday()
    ts = 0.75 if 9 <= h < 10 else 0.85 if 10 <= h < 14 else 0.70 if 14 <= h < 15 else 0.60 if 15 <= h < 16 else 0.50
    dw = [0.80, 0.85, 0.88, 0.85, 0.75][wd] if wd < 5 else 0.50
    market_score = round((ts + dw) / 2, 4)

    strategy = await _get_strategy(db)
    buy_threshold    = float(strategy.buy_threshold)    if strategy else 0.6
    max_position_amt = float(strategy.max_position_amt) if strategy and strategy.max_position_amt else None

    return {
        "previews":         previews,
        "market_score":     market_score,
        "buy_threshold":    buy_threshold,
        "max_position_amt": max_position_amt,
        "is_mock":          not settings.auto_trade_enabled,
    }


async def generate_report(db: AsyncSession) -> dict:
    """종합 점수 계산 후 결과 반환 (전송 안 함) — send_now_report 전용"""
    engine = AutoTradeEngine(db)
    strategy = await _get_strategy(db)

    codes, name_map = await engine._collect_candidates()
    market_score   = engine._calc_market_score()

    previews = []
    for code in codes:
        try:
            r = await engine._score_stock(code, name_map.get(code, ""))
            if r:
                r["composite_score"] = (
                    r["model_score"]              * W_MODEL
                    + r["news_score"]             * W_NEWS
                    + r.get("dart_score",   0.5)  * W_DART
                    + market_score                * W_MARKET
                    + r.get("supply_score", 0.5)  * W_SUPPLY
                )
                previews.append(r)
        except Exception as e:
            logger.debug(f"{code} 리포트 점수 계산 오류: {e}")

    previews.sort(key=lambda x: x["composite_score"], reverse=True)

    buy_threshold   = float(strategy.buy_threshold)    if strategy else 0.6
    max_position_amt = float(strategy.max_position_amt) if strategy and strategy.max_position_amt else None

    return {
        "previews":        previews,
        "market_score":    market_score,
        "buy_threshold":   buy_threshold,
        "max_position_amt": max_position_amt,
        "is_mock":         not settings.auto_trade_enabled,
    }


async def send_morning_report(db: AsyncSession, force: bool = False) -> None:
    """08:50 자동 발송 — 장 시작 전 매수 예정 리포트 + 매크로 섹터 시그널"""
    if not tg.is_configured():
        logger.info("텔레그램 미설정 — 모닝 리포트 건너뜀")
        return
    # screened_stocks DB 데이터 사용 (API 재호출 없이 빠름)
    data = await _load_report_from_db(db)
    await tg.notify_report(label="장 시작 전 매수 예정 리포트", force=force, **data)
    events, signals = await _get_macro_data()
    await tg.notify_macro_sector(events, signals, label="오늘 매크로 섹터 시그널", force=force)
    logger.info("모닝 리포트 전송 완료")


async def send_now_report(db: AsyncSession, force: bool = False) -> dict:
    """수동 즉시 전송 — API 엔드포인트용 (DB 캐시 사용)"""
    if not tg.is_configured():
        raise ValueError("텔레그램 봇이 설정되지 않았습니다.")
    data = await _load_report_from_db(db)
    await tg.notify_report(label="현재 AI 매수 후보 리포트", force=force, **data)
    events, signals = await _get_macro_data()
    await tg.notify_macro_sector(events, signals, label="현재 매크로 섹터 시그널", force=force)
    return data


def _today_kst() -> date:
    import pytz
    return datetime.now(pytz.timezone("Asia/Seoul")).date()


async def _get_today_logs(db: AsyncSession) -> list[AutoTradeLog]:
    today = _today_kst()
    r = await db.execute(
        select(AutoTradeLog)
        .where(AutoTradeLog.trade_date == today)
        .order_by(AutoTradeLog.created_at.desc())
    )
    return list(r.scalars().all())


async def send_hourly_progress(db: AsyncSession, force: bool = False) -> None:
    """매 정시 진행 현황 텔레그램 전송 (10:00~15:00)"""
    if not tg.is_configured():
        logger.info("텔레그램 미설정 — 시간별 진행 현황 건너뜀")
        return
    from datetime import datetime
    import pytz
    hour = datetime.now(pytz.timezone("Asia/Seoul")).hour

    logs = await _get_today_logs(db)
    # CANCELLED 제외: 실제로 접수된(or 체결된) 주문만
    filled = [l for l in logs if l.status in ("FILLED", "MOCK", "PENDING")]
    buy_logs  = [l for l in filled if l.action == "BUY"]
    sell_logs = [l for l in filled if l.action == "SELL"]
    # PENDING = Kiwoom 접수 완료 (시장가 주문은 접수=실질 체결); CANCELLED는 이미 제외됨
    confirmed_sells = sell_logs
    realized_pnl = sum(float(l.realized_pnl or 0) for l in confirmed_sells)

    strategy = await _get_strategy(db)
    kill_switch = bool(getattr(strategy, "kill_switch_active", False)) if strategy else False

    # 최근 거래: CANCELLED 제외한 주문 5건 (시간 역순)
    recent_trades = [
        {
            "action": l.action,
            "stock_name": l.stock_name,
            "quantity": l.quantity or 0,
            "order_price": float(l.order_price or 0),
            "realized_pnl": float(l.realized_pnl or 0) if l.realized_pnl is not None else None,
        }
        for l in filled[:5]
    ]

    await tg.notify_hourly_progress(
        hour=hour,
        buy_count=len(buy_logs),
        sell_count=len(sell_logs),
        realized_pnl=realized_pnl,
        recent_trades=recent_trades,
        is_mock=not settings.auto_trade_enabled,
        kill_switch=kill_switch,
        macro_summary=None,
        force=force,
    )
    logger.info(f"[{hour:02d}:00] 진행 현황 리포트 전송 완료")


async def send_sector_screening_report(results: list[dict], force: bool = False) -> None:
    """섹터 스크리닝 완료 후 텔레그램 전송 (09:05 / 11:00 / 13:30)"""
    if not tg.is_configured():
        return
    try:
        import pytz
        from datetime import datetime
        now_str = datetime.now(pytz.timezone("Asia/Seoul")).strftime("%H:%M")

        sector_names = list({
            r.get("macro_sector_name", "")
            for r in results
            if r.get("macro_sector_name")
        })

        await tg.notify_sector_screening(
            screened_at=now_str,
            total_analyzed=len(results),
            buy_count=sum(1 for r in results if r.get("final_signal") == "BUY"),
            top_stocks=sorted(
                [r for r in results if r.get("final_signal") == "BUY"],
                key=lambda x: x.get("composite_score") or 0,
                reverse=True,
            ),
            favorable_sectors=sector_names,
            force=force,
        )
        logger.info("섹터 스크리닝 리포트 전송 완료")
    except Exception as e:
        logger.error(f"섹터 스크리닝 리포트 전송 실패: {e}")


async def send_close_report(db: AsyncSession, force: bool = False) -> None:
    """장 마감(15:35) 결과 리포트 텔레그램 전송"""
    if not tg.is_configured():
        logger.info("텔레그램 미설정 — 장 마감 리포트 건너뜀")
        return
    logs = await _get_today_logs(db)
    # PENDING = 실매수·매도 주문 접수 완료 (Kiwoom 성공); FILLED = 체결 확인; MOCK = 모의
    filled = [l for l in logs if l.status in ("FILLED", "MOCK", "PENDING")]
    buy_logs  = [l for l in filled if l.action == "BUY"]
    sell_logs = [l for l in filled if l.action == "SELL"]
    # PENDING = Kiwoom 주문 접수 완료 (시장가 주문은 접수=실질 체결); FILLED/MOCK 포함
    confirmed_sells = sell_logs  # CANCELLED는 이미 filled 목록에서 제외됨

    realized_pnl = sum(float(l.realized_pnl or 0) for l in confirmed_sells)
    win_count  = sum(1 for l in confirmed_sells if (l.realized_pnl or 0) > 0)
    loss_count = sum(1 for l in confirmed_sells if (l.realized_pnl or 0) < 0)

    sell_details = [
        {
            "stock_name": l.stock_name,
            "realized_pnl": float(l.realized_pnl or 0),
            "status": l.status,
        }
        for l in sorted(confirmed_sells, key=lambda x: float(x.realized_pnl or 0), reverse=True)
    ]

    from datetime import datetime, timezone as tz
    from sqlalchemy import select as sa_select
    from app.models.screened_stock import ScreenedStock
    today_start = datetime.now(tz.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    sc_r = await db.execute(
        sa_select(ScreenedStock.final_signal)
        .where(ScreenedStock.screened_at >= today_start)
    )
    sc_rows = sc_r.all()
    screened_total = len(sc_rows)
    screened_buy   = sum(1 for r in sc_rows if r.final_signal == "BUY")

    await tg.notify_close_report(
        buy_count=len(buy_logs),
        sell_count=len(sell_logs),
        realized_pnl=realized_pnl,
        win_count=win_count,
        loss_count=loss_count,
        sell_details=sell_details,
        is_mock=not settings.auto_trade_enabled,
        screened_total=screened_total,
        screened_buy=screened_buy,
        top_sectors=[],
        force=force,
    )
    logger.info("장 마감 결과 리포트 전송 완료")
