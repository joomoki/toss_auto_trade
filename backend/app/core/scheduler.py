from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger
from datetime import time as dtime

scheduler = AsyncIOScheduler(timezone="Asia/Seoul")


def is_market_open() -> bool:
    from datetime import datetime
    import pytz
    seoul_tz = pytz.timezone("Asia/Seoul")
    now = datetime.now(seoul_tz)
    if now.weekday() >= 5:
        return False
    market_open = dtime(9, 0)
    market_close = dtime(15, 30)
    current_time = now.time()
    return market_open <= current_time <= market_close


def setup_scheduler(signal_engine_func, interval_minutes: int = 10):
    scheduler.add_job(
        signal_engine_func,
        trigger=IntervalTrigger(minutes=interval_minutes),
        id="signal_generation",
        replace_existing=True,
    )

    async def auto_trade_job():
        """통합 자동매매 엔진 — 10분마다 실행 (정규장 09:00~15:30 KST)"""
        import logging
        _log = logging.getLogger("auto_trade")
        from datetime import datetime, time as _t
        import pytz
        _now = datetime.now(pytz.timezone("Asia/Seoul"))
        # 주말 및 정규장 시간(09:00~15:30) 외에는 스킵
        if _now.weekday() >= 5 or not (_t(9, 0) <= _now.time() <= _t(15, 30)):
            return
        from app.core.database import AsyncSessionLocal
        from app.services.auto_trade_engine import AutoTradeEngine
        try:
            async with AsyncSessionLocal() as db:
                engine = AutoTradeEngine(db)
                await engine.run()
                await db.commit()
        except Exception as _job_err:
            _log.error(f"[자동매매 엔진 오류] 사이클 실패: {_job_err}", exc_info=True)

    scheduler.add_job(
        auto_trade_job,
        trigger=IntervalTrigger(minutes=interval_minutes),
        id="auto_trade",
        replace_existing=True,
        max_instances=1,       # 이전 사이클 미완료 시 중복 실행 방지
        misfire_grace_time=60, # 60초 내 지연 실행은 허용, 이후 건너뜀
        coalesce=True,         # 밀린 실행은 한 번으로 합침
    )

    # 장외 시간 수집 쓰로틀용 상태 — 30분 미만이면 스킵
    _news_state: dict = {"last_run": None}

    async def news_collect_job():
        from datetime import datetime, time as _t, timezone as _tz
        import pytz
        import logging
        _log = logging.getLogger("news_collect")

        _now_kst = datetime.now(pytz.timezone("Asia/Seoul"))
        _now_utc = datetime.now(_tz.utc)
        _in_market = (
            _now_kst.weekday() < 5
            and _t(9, 0) <= _now_kst.time() <= _t(15, 30)
        )

        if not _in_market:
            # 장 외: 직전 실행이 28분 이내면 스킵 (30분 간격 유지)
            if _news_state["last_run"] is not None:
                _elapsed = (_now_utc - _news_state["last_run"]).total_seconds()
                if _elapsed < 1680:  # 28분
                    return

        from app.core.database import AsyncSessionLocal
        from app.services.news_collector import collect_news
        from app.services.sentiment_analyzer import analyze
        from app.models.news import NewsItem
        from sqlalchemy import select
        async with AsyncSessionLocal() as db:
            saved = await collect_news(db)
            if saved > 0:
                result = await db.execute(
                    select(NewsItem).where(NewsItem.sentiment_label == None).limit(200)
                )
                items = result.scalars().all()
                for news in items:
                    text = (news.title or "") + " " + (news.content_summary or "")
                    score, label = analyze(text)
                    news.sentiment_score = score  # type: ignore
                    news.sentiment_label = label
                await db.commit()

        _news_state["last_run"] = _now_utc
        interval_label = "10분(장중)" if _in_market else "30분(장외)"
        _log.debug(f"[뉴스수집] 완료 ({interval_label}) — 신규 {saved}건")

    scheduler.add_job(
        news_collect_job,
        trigger=IntervalTrigger(minutes=10),  # 장중 10분, 장외 내부 쓰로틀로 30분 유지
        id="news_collect",
        replace_existing=True,
    )

    async def daily_price_update_job():
        """장 마감 후 15:35 — 모든 추적 종목 종가 일괄 갱신 (월~금)"""
        from app.core.database import AsyncSessionLocal
        from app.services.daily_price_updater import run_daily_price_update
        async with AsyncSessionLocal() as db:
            result = await run_daily_price_update(db)
            import logging
            logging.getLogger(__name__).info(
                f"[daily_price_update] {result['updated']}/{result['total']} 종목 갱신 완료"
            )

    scheduler.add_job(
        daily_price_update_job,
        trigger=CronTrigger(hour=15, minute=35, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="daily_price_update",
        replace_existing=True,
    )

    async def morning_report_job():
        """08:40 — 텔레그램 매수 예정 리포트 발송 (장전 시간외 08:30 시작 10분 전)"""
        from app.core.database import AsyncSessionLocal
        from app.services.report_service import send_morning_report
        async with AsyncSessionLocal() as db:
            await send_morning_report(db)

    scheduler.add_job(
        morning_report_job,
        trigger=CronTrigger(hour=8, minute=40, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="morning_report",
        replace_existing=True,
    )

    async def hourly_progress_job():
        """장 중 매 정시(10:00~15:00) — 진행 현황 리포트"""
        from app.core.database import AsyncSessionLocal
        from app.services.report_service import send_hourly_progress
        async with AsyncSessionLocal() as db:
            await send_hourly_progress(db)

    scheduler.add_job(
        hourly_progress_job,
        trigger=CronTrigger(
            hour="10,11,12,13,14,15", minute=0,
            day_of_week="mon-fri", timezone="Asia/Seoul",
        ),
        id="hourly_progress",
        replace_existing=True,
    )

    async def close_report_job():
        """장 마감 후(15:35) — 오늘 거래 결과 리포트"""
        from app.core.database import AsyncSessionLocal
        from app.services.report_service import send_close_report
        async with AsyncSessionLocal() as db:
            await send_close_report(db)

    scheduler.add_job(
        close_report_job,
        trigger=CronTrigger(hour=15, minute=35, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="close_report",
        replace_existing=True,
    )

    async def manual_buy_expire_job():
        """장 마감(15:30) 직후 — 미체결 수동 매수 주문 만료 처리"""
        import logging
        import pytz
        from datetime import datetime, timezone as _tz
        from app.core.database import AsyncSessionLocal
        from app.models.manual_buy_order import ManualBuyOrder
        from sqlalchemy import select

        log = logging.getLogger(__name__)
        seoul_tz = pytz.timezone("Asia/Seoul")
        now_kst = datetime.now(seoul_tz)
        # 오늘 15:30 KST 이전에 등록된 pending 주문만 만료 (장 마감 후 등록된 건은 내일 시도)
        market_close_kst = now_kst.replace(hour=15, minute=30, second=0, microsecond=0)
        market_close_utc = market_close_kst.astimezone(_tz.utc)

        async with AsyncSessionLocal() as db:
            r = await db.execute(
                select(ManualBuyOrder).where(
                    ManualBuyOrder.status == "pending",
                    ManualBuyOrder.created_at < market_close_utc,
                )
            )
            orders = r.scalars().all()
            for order in orders:
                order.status    = "failed"
                order.error_msg = "장 마감 미체결"
            if orders:
                await db.commit()
                log.info(f"[수동매수] 장 마감 미체결 만료: {len(orders)}건")

    scheduler.add_job(
        manual_buy_expire_job,
        trigger=CronTrigger(hour=15, minute=31, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="manual_buy_expire",
        replace_existing=True,
    )

    async def dart_collect_job():
        """DART 공시 수집 — 30분마다 (장 시간 + 전후 포함)"""
        from app.core.database import AsyncSessionLocal
        from app.services.dart_collector import collect_dart
        async with AsyncSessionLocal() as db:
            await collect_dart(db, days_back=1)

    scheduler.add_job(
        dart_collect_job,
        trigger=IntervalTrigger(minutes=30),
        id="dart_collect",
        replace_existing=True,
    )

    async def macro_pipeline_job():
        """매크로 섹터 로테이션 파이프라인 — 장중 30분마다 (09:00~15:30)"""
        if not is_market_open():
            return
        import logging
        log = logging.getLogger(__name__)
        try:
            from app.macro.portfolio_engine import run_pipeline
            from app.macro.schemas import TradeMode
            import os
            mode = TradeMode.LIVE if os.environ.get("MACRO_LIVE_MODE", "").lower() == "true" else TradeMode.PAPER
            result = await run_pipeline(mode)
            log.info(f"[매크로] 이벤트={len(result.events)} 주문={len(result.orders_placed)} mode={mode.value}")
        except Exception as e:
            log.warning(f"[매크로] 파이프라인 오류: {e}")

    scheduler.add_job(
        macro_pipeline_job,
        trigger=IntervalTrigger(minutes=30),
        id="macro_pipeline",
        replace_existing=True,
    )

    async def sector_screening_job():
        """매크로 섹터 기반 전종목 AI 스크리닝 + 텔레그램 전송"""
        if not is_market_open():
            return
        import logging
        log = logging.getLogger(__name__)
        try:
            from app.core.database import AsyncSessionLocal
            from app.services.sector_screener import run_sector_screening
            from app.services.report_service import send_sector_screening_report
            from app.core.config import settings as _s
            async with AsyncSessionLocal() as db:
                results = await run_sector_screening(
                    db,
                    max_stock_price=_s.max_stock_price,
                )
                log.info(f"[섹터스크리닝] {len(results)}종목 분석 완료")
            await send_sector_screening_report(results)
        except Exception as e:
            log.warning(f"[섹터스크리닝] 오류: {e}")

    # 장 시작 직후(09:05), 오전(11:00), 오후(13:30) — 하루 3회
    for _job_id, _h, _m in [
        ("sector_screening_0905", 9,  5),
        ("sector_screening_1100", 11, 0),
        ("sector_screening_1330", 13, 30),
    ]:
        scheduler.add_job(
            sector_screening_job,
            trigger=CronTrigger(
                hour=_h, minute=_m,
                day_of_week="mon-fri", timezone="Asia/Seoul",
            ),
            id=_job_id,
            replace_existing=True,
        )


    async def long_term_buy_job():
        """09:10 — 가치주 스크리닝 후 장기보유 종목 자동 매수 (슬롯 여유 있을 때만)"""
        import logging
        from datetime import datetime, time as _t
        import pytz
        _log = logging.getLogger("long_term_buy")
        _now = datetime.now(pytz.timezone("Asia/Seoul"))
        if _now.weekday() >= 5 or not (_t(9, 0) <= _now.time() <= _t(15, 0)):
            return
        from app.core.database import AsyncSessionLocal
        from app.services.auto_trade_engine import AutoTradeEngine
        try:
            async with AsyncSessionLocal() as db:
                engine = AutoTradeEngine(db)
                await engine.run_long_term_screening()
                await db.commit()
        except Exception as _e:
            _log.error(f"[장기매수 잡 오류] {_e}", exc_info=True)

    scheduler.add_job(
        long_term_buy_job,
        trigger=CronTrigger(hour=9, minute=10, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="long_term_buy",
        replace_existing=True,
        max_instances=1,
        misfire_grace_time=120,
    )

    async def holdings_price_sync_job():
        """장중 5분마다 — kt00004 현재가로 DB holdings 갱신 (08:00~18:00 KST)"""
        import logging
        from datetime import datetime as _dt, time as _t
        import pytz
        log = logging.getLogger(__name__)
        now_kst = _dt.now(pytz.timezone("Asia/Seoul"))
        if now_kst.weekday() >= 5:
            return
        if not (_t(8, 0) <= now_kst.time() < _t(18, 0)):
            return
        try:
            from app.core.database import AsyncSessionLocal
            from app.services.toss_api import TossApiClient
            from app.models.holding import Holding
            from sqlalchemy import select
            api = TossApiClient.get_instance()
            balance = await api.get_balance()
            kt4_map = {p["stock_code"]: p for p in balance.get("stockHoldings", [])}
            if not kt4_map:
                return
            async with AsyncSessionLocal() as db:
                for code, kt4 in kt4_map.items():
                    r = await db.execute(select(Holding).where(Holding.stock_code == code))
                    h_obj = r.scalar_one_or_none()
                    if h_obj:
                        if kt4.get("current_price"):
                            h_obj.current_price = kt4["current_price"]
                        if kt4.get("pnl") is not None:
                            h_obj.unrealized_pnl = kt4["pnl"]
                        if kt4.get("pnl_pct") is not None:
                            h_obj.unrealized_pnl_pct = kt4["pnl_pct"]
                        if kt4.get("avg_price"):
                            h_obj.avg_buy_price = kt4["avg_price"]

                # Kiwoom 실잔고에 없는 DB holding → 수동 매도 감지 → P&L 계산 후 삭제
                from app.services.telegram_notifier import is_configured as _tg_ok, send_message as _tg_send
                _all_h = await db.execute(select(Holding))
                for _h in _all_h.scalars().all():
                    if _h.stock_code not in kt4_map:
                        _avg  = float(_h.avg_buy_price or 0)
                        _cur  = float(_h.current_price or _avg)
                        _qty  = int(_h.quantity or 0)
                        _pnl  = (_cur - _avg) * _qty
                        _ppct = (_cur - _avg) / (_avg + 1e-9) * 100
                        _sign = "📈" if _pnl >= 0 else "📉"
                        log.warning(
                            f"[잔고동기화] 수동매도 감지: {_h.stock_name}({_h.stock_code})"
                            f" {_qty}주 | 추정손익 {_pnl:+,.0f}원 ({_ppct:+.2f}%) → DB 삭제"
                        )
                        if _tg_ok():
                            await _tg_send(
                                f"{_sign} 수동 매도 완료 감지\n"
                                f"종목: {_h.stock_name} ({_h.stock_code})\n"
                                f"수량: {_qty:,}주\n"
                                f"평균단가: {_avg:,.0f}원\n"
                                f"추정 매도가: {_cur:,.0f}원\n"
                                f"──────────────\n"
                                f"추정 손익: {_pnl:+,.0f}원 ({_ppct:+.2f}%)\n"
                                f"※ 마지막 갱신 현재가 기준 추정값",
                                msg_type="sell",
                                force=True,
                            )
                        await db.delete(_h)

                await db.commit()
            log.debug(f"[잔고동기화] holdings 현재가 갱신 ({len(kt4_map)}종목)")
        except Exception as e:
            log.warning(f"[잔고동기화] 오류: {e}")

    scheduler.add_job(
        holdings_price_sync_job,
        trigger=IntervalTrigger(minutes=5),
        id="holdings_price_sync",
        replace_existing=True,
    )

    async def account_snapshot_job():
        """장 마감 후(15:40) — 계좌 잔고·보유종목 일별 스냅샷 저장"""
        from app.core.database import AsyncSessionLocal
        from app.services.account_snapshot_service import save_daily_snapshot
        async with AsyncSessionLocal() as db:
            await save_daily_snapshot(db)

    scheduler.add_job(
        account_snapshot_job,
        trigger=CronTrigger(hour=15, minute=40, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="account_snapshot",
        replace_existing=True,
    )

    async def premarket_scan_job():
        """08:10 — 프리장 거래량 스캔 (워치리스트 종목 대상)"""
        import logging
        log = logging.getLogger(__name__)
        try:
            from app.core.database import AsyncSessionLocal
            from app.services.premarket_scanner import run_premarket_scan
            async with AsyncSessionLocal() as db:
                result = await run_premarket_scan(db)
                log.info(f"[프리장스캔] {result['message']}")
        except Exception as e:
            logging.getLogger(__name__).warning(f"[프리장스캔] 오류: {e}")

    scheduler.add_job(
        premarket_scan_job,
        trigger=CronTrigger(hour=8, minute=10, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="premarket_scan",
        replace_existing=True,
    )

    async def premarket_telegram_job():
        """08:25 — 프리장 스캔 결과 텔레그램 발송"""
        import logging
        log = logging.getLogger(__name__)
        try:
            from app.core.database import AsyncSessionLocal
            from app.services.premarket_scanner import send_premarket_telegram
            async with AsyncSessionLocal() as db:
                await send_premarket_telegram(db)
        except Exception as e:
            log.warning(f"[프리장알림] 텔레그램 전송 오류: {e}")

    scheduler.add_job(
        premarket_telegram_job,
        trigger=CronTrigger(hour=8, minute=25, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="premarket_telegram",
        replace_existing=True,
    )

    async def rising_stock_collect_job():
        """장 마감 후(15:45) — 당일 상승 종목 자동 수집 및 원인 분석"""
        import logging
        from datetime import date
        log = logging.getLogger(__name__)
        try:
            from app.core.database import AsyncSessionLocal
            from app.services.rising_stock_analyzer import collect_rising_stocks
            async with AsyncSessionLocal() as db:
                result = await collect_rising_stocks(
                    db=db,
                    analysis_date=date.today(),
                    min_change_pct=3.0,
                    max_stocks=50,
                )
                log.info(f"[상승분석] {result['message']}")
        except Exception as e:
            logging.getLogger(__name__).warning(f"[상승분석] 자동 수집 오류: {e}")

    scheduler.add_job(
        rising_stock_collect_job,
        trigger=CronTrigger(hour=15, minute=45, day_of_week="mon-fri", timezone="Asia/Seoul"),
        id="rising_stock_collect",
        replace_existing=True,
    )

    async def telegram_command_poll_job():
        """텔레그램 명령어 폴링 — 30초마다 getUpdates 호출"""
        from app.core.database import AsyncSessionLocal
        from app.services.telegram_command_handler import poll_telegram_commands
        async with AsyncSessionLocal() as db:
            await poll_telegram_commands(db)

    scheduler.add_job(
        telegram_command_poll_job,
        trigger=IntervalTrigger(seconds=30),
        id="telegram_command_poll",
        replace_existing=True,
    )


def update_telegram_status_job(interval_minutes: int) -> None:
    """현황 주기 리포트 스케줄 동적 업데이트 (0=비활성)"""
    job_id = "telegram_status_interval"
    if interval_minutes <= 0:
        if scheduler.get_job(job_id):
            scheduler.remove_job(job_id)
        return

    # 변동 감지용 상태 (함수 재등록 시 초기화)
    _state: dict = {
        "last_sent_at": None,   # 마지막 실제 전송 시각 (datetime)
        "stock_codes":  None,   # frozenset[str] — 보유 종목 코드 집합
        "total_pnl":    None,   # float — 직전 전송 시 총 손익
    }
    # 손익 변동 임계값: 이 값 이상 바뀌면 변동으로 판단
    _PNL_THRESHOLD = 50_000   # 5만원
    # 변동 없을 때 강제 전송 주기
    _FORCE_INTERVAL_MIN = 60

    async def _status_job():
        import logging
        from datetime import datetime, timezone
        log = logging.getLogger(__name__)
        try:
            from app.services.kiwoom_api import KiwoomApiClient
            from app.services.telegram_notifier import notify_portfolio_status, is_configured
            from app.core.database import AsyncSessionLocal
            from app.models.holding import Holding
            from sqlalchemy import select
            if not is_configured():
                return
            kiwoom = KiwoomApiClient.get_instance()
            balance_raw = await kiwoom.get_balance()

            kiwoom_pos_map: dict = {
                p["stock_code"]: p
                for p in balance_raw.get("stockHoldings", [])
            }

            async with AsyncSessionLocal() as db:
                r = await db.execute(select(Holding).order_by(Holding.stock_code))
                db_holdings = r.scalars().all()

                # 키움 실계좌 ∪ DB — 키움에만 있는 종목도 포함
                db_map = {h.stock_code: h for h in db_holdings}
                all_codes = sorted(
                    set(kiwoom_pos_map.keys()) | set(db_map.keys())
                )

                # Kiwoom-only 종목: auto_trade_logs BUY 기록으로 is_manual 판단
                # (SELL 주문 직후 DB에서 holding이 삭제되지만 Kiwoom에는 미체결 상태일 수 있음)
                kiwoom_only = [c for c in kiwoom_pos_map if c not in db_map]
                from app.models.news import AutoTradeLog
                from sqlalchemy import func as _fn
                auto_bought_set: set = set()
                if kiwoom_only:
                    ab_r = await db.execute(
                        select(AutoTradeLog.stock_code).where(
                            AutoTradeLog.stock_code.in_(kiwoom_only),
                            AutoTradeLog.action == "BUY",
                            AutoTradeLog.status.in_(["FILLED", "MOCK", "PENDING"]),
                        ).distinct()
                    )
                    auto_bought_set = {row[0] for row in ab_r.all()}

            holdings = []
            for code in all_codes:
                p = kiwoom_pos_map.get(code, {})
                h = db_map.get(code)
                name    = p.get("stock_name") or (h.stock_name if h else "") or code
                qty     = int(p.get("quantity") or (h.quantity if h else 0))
                avg     = float(p.get("avg_price") or (float(h.avg_buy_price) if h else 0) or 0)
                cur     = float(p.get("current_price") or (float(h.current_price or 0) if h else 0) or avg)
                pnl     = float(p.get("pnl") or (float(h.unrealized_pnl or 0) if h else 0))
                pnl_pct = float(p.get("pnl_pct") or (float(h.unrealized_pnl_pct or 0) if h else 0))
                if pnl == 0 and avg > 0 and cur > 0:
                    pnl     = round((cur - avg) * qty, 2)
                    pnl_pct = round((cur - avg) / avg * 100, 2)

                if h is not None:
                    is_manual = bool(h.is_manual)
                elif code in auto_bought_set:
                    is_manual = False  # auto_trade_logs BUY 기록 있음 → 자동매매
                else:
                    is_manual = True   # 진짜 수동 구매 (로그 없음)

                holdings.append({
                    "stock_code":         code,
                    "stock_name":         name,
                    "quantity":           qty,
                    "avg_buy_price":      avg,
                    "current_price":      cur,
                    "unrealized_pnl":     pnl,
                    "unrealized_pnl_pct": pnl_pct,
                    "is_long_term":       bool(h.is_long_term) if h else False,
                    "is_manual":          is_manual,
                })

            # ── 변동 감지 ─────────────────────────────────────────────
            now = datetime.now(timezone.utc)
            cur_codes = frozenset(h["stock_code"] for h in holdings)
            cur_pnl   = float(balance_raw.get("totalPnl") or 0)

            codes_changed = (_state["stock_codes"] is not None
                             and cur_codes != _state["stock_codes"])
            pnl_changed   = (_state["total_pnl"] is not None
                             and abs(cur_pnl - _state["total_pnl"]) >= _PNL_THRESHOLD)
            first_send    = _state["last_sent_at"] is None

            minutes_since = (
                (now - _state["last_sent_at"]).total_seconds() / 60
                if _state["last_sent_at"] else float("inf")
            )
            force_by_time = minutes_since >= _FORCE_INTERVAL_MIN

            should_send = first_send or codes_changed or pnl_changed or force_by_time

            if not should_send:
                log.debug(
                    "[텔레그램] 변동 없음 — 전송 스킵 (마지막 전송 %.0f분 전)", minutes_since
                )
                return

            reason = ("초기" if first_send
                      else "종목변동" if codes_changed
                      else "손익변동" if pnl_changed
                      else "1시간 주기")
            await notify_portfolio_status(holdings, balance_raw)
            _state["last_sent_at"] = now
            _state["stock_codes"]  = cur_codes
            _state["total_pnl"]    = cur_pnl
            log.info("[텔레그램] 주기 현황 리포트 전송 (%s, 보유 %d종목)", reason, len(holdings))
        except Exception as e:
            log.warning(f"[텔레그램] 주기 현황 전송 오류: {e}")

    scheduler.add_job(
        _status_job,
        trigger=IntervalTrigger(minutes=interval_minutes),
        id=job_id,
        replace_existing=True,
    )
