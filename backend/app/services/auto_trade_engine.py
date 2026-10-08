"""
통합 자동매매 엔진
실행 흐름:
  1) 매크로 섹터 스크리닝 BUY 종목 + 워치리스트 수집
  2) 각 종목에 대해 M1-M10 모델 실행
  3) 뉴스 감성 점수 반영
  4) 시장 상황 보정 (거래일 / 장 시간 / 시간대별 변동성)
  5) 종합 점수로 상승 여력 랭킹
  6) 상위 N 종목 매수 / 보유 종목 손절·익절 매도
  7) 모든 실행 이력을 auto_trade_logs에 저장
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone, timedelta
from typing import Optional
import pytz as _pytz

_SEOUL_TZ = _pytz.timezone("Asia/Seoul")


def _today_kst() -> date:
    """서버가 UTC여도 항상 KST 기준 오늘 날짜 반환"""
    return datetime.now(_SEOUL_TZ).date()


def _mode_status_bar(current_mode: str, kospi_chg: float) -> str:
    """텔레그램 알림용 경계 단계 현황 텍스트 생성."""
    _STEPS = [
        ("NORMAL",       "🟢", "정상",    "코스피 ≥ -0.8%"),
        ("CAUTIOUS",     "🟡", "경계",    "코스피 -0.8%~-1.5%"),
        ("CONSERVATIVE", "🔴", "수비",    "코스피 -1.5%~-2.5%"),
        ("DEFENSIVE",    "⛔", "전면수비", "코스피 < -2.5%"),
    ]
    _sev = {m: i for i, (m, *_) in enumerate(_STEPS)}
    cur_sev = _sev.get(current_mode, 0)

    lines = [f"📊 단계별 현황  (코스피 {kospi_chg:+.2f}%)"]
    for mode, icon, label, cond in _STEPS:
        sev = _sev[mode]
        if mode == current_mode:
            lines.append(f"  {icon} {label} ◀ 현재  ({cond})")
        elif sev < cur_sev:
            lines.append(f"  ✅ {label}  ({cond})")
        else:
            lines.append(f"  ▫️ {label}  ({cond})")
    return "\n".join(lines)


from sqlalchemy import select, and_, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.news import AutoTradeLog, NewsItem
from app.models.watchlist import Watchlist
from app.models.holding import Holding
from app.models.strategy import Strategy
from app.services.toss_api import TossApiClient
from app.services.risk_manager import RiskManager
from app.services.holding_sync import TRADE_CYCLE_LOCK, sync_holdings_with_balance
from app.core.market_calendar import business_days_ago
from app.services import telegram_notifier as tg
from app.ml.feature_engineering import compute
from app.ml.multi_models import run_all_models
from app.ml.news_gate import check_news_gate
import app.services.cycle_logger as _clog

logger = logging.getLogger(__name__)

def _composite_weights() -> dict:
    """config/model_weights.yaml 의 composite 블록에서 가중치 로드.
    YAML 수정만으로 런타임 반영 가능; 파일이 없으면 하드코딩 폴백."""
    try:
        from pathlib import Path
        import yaml
        path = Path(__file__).parents[2] / "config" / "model_weights.yaml"
        cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
        c = cfg.get("composite", {})
        return {
            "model":  float(c.get("model",  0.35)),
            "news":   float(c.get("news",   0.15)),
            "dart":   float(c.get("dart",   0.10)),
            "market": float(c.get("market", 0.15)),
            "supply": float(c.get("supply", 0.25)),
        }
    except Exception:
        return {"model": 0.35, "news": 0.15, "dart": 0.10, "market": 0.15, "supply": 0.25}


# 종합 점수 가중치 — 기본값 (YAML 우선, 이 상수는 폴백)
W_MODEL   = 0.35   # ML 모델 신호  (0.45 → 0.35)
W_NEWS    = 0.15   # 뉴스 감성
W_DART    = 0.10   # OpenDART 공시
W_MARKET  = 0.15   # 시장 상황
W_SUPPLY  = 0.25   # 외국인/기관 수급 (0.15 → 0.25)


class AutoTradeEngine:
    """모델 + 뉴스 + 시장 상황을 통합해 자동매매를 실행하는 메인 엔진"""

    # 인스턴스 간 공유 — 매 사이클마다 새 인스턴스가 생성되므로 클래스 변수로 유지
    _last_trade_mode: Optional[str] = None
    # 트레일링 스탑 고점 / 스마트홀딩 연속 손실 사이클은 재시작 후에도 유지되도록
    # holdings.peak_pnl_pct / holdings.smart_hold_loss_cycles 컬럼에 저장

    def __init__(self, db: AsyncSession):
        self.db = db
        self.api = TossApiClient.get_instance()
        self.risk_mgr = RiskManager()
        self._market_ctx: dict = {}
        self.ws_broadcast = None
        # False 이면 (장 외 force 실행) 매도 주문 없이 평가만
        self._orders_allowed: bool = True

    # ────────────────────────────────────────────────────────
    # 메인 진입점 (APScheduler에서 호출)
    # ────────────────────────────────────────────────────────

    async def run(self, collect_result: bool = False, force: bool = False) -> dict | None:
        """
        자동매매 사이클 실행.
        collect_result=True 이면 상세 실행 결과 dict 반환 (즉시실행 API용).
        force=True 이면 장 외 시간에도 종목 평가까지 실행 (실제 주문은 제외).
        스케줄 사이클·즉시실행·잔고동기화가 겹쳐 이중 주문이 나지 않도록 락으로 직렬화.
        """
        async with TRADE_CYCLE_LOCK:
            return await self._run(collect_result=collect_result, force=force)

    async def _run(self, collect_result: bool = False, force: bool = False) -> dict | None:
        import time as _time
        started_at = _time.monotonic()

        def _elapsed() -> float:
            return round(_time.monotonic() - started_at, 2)

        market_open = self.risk_mgr.is_market_open()
        self._orders_allowed = market_open
        if not market_open and not force:
            logger.info("[자동매매] 장 운영 시간 외 — 스킵")
            if collect_result:
                return {
                    "status": "skipped",
                    "skip_reason": "장 운영 시간 외 (KRX 거래일 09:00~15:25)",
                    "market_open": False,
                    "elapsed": _elapsed(),
                }
            return None

        strategy = await self._get_strategy()
        if not strategy:
            logger.warning("[자동매매] ⛔ 활성 전략 없음 — 전략탭에서 시작 버튼을 누르세요")
            if collect_result:
                return {
                    "status": "skipped",
                    "skip_reason": "활성 전략 없음 — 전략 탭에서 시작 버튼을 누르세요",
                    "market_open": True,
                    "elapsed": _elapsed(),
                }
            return None

        # 킬스위치 / 일일 손실 한도 → 신규 매수만 중단, 손절·익절 감시는 계속 실행
        buy_block_reason: Optional[str] = None
        if strategy.kill_switch_active:
            logger.warning("[자동매매] ⛔ 킬스위치 ON — 신규 매수 중단, 손절/익절 감시만 실행")
            buy_block_reason = "킬스위치 ON — 신규 매수 중단 (손절/익절은 계속 실행)"
        else:
            _loss_pct_raw = getattr(strategy, "max_daily_loss_pct", None)
            max_loss_pct = float(_loss_pct_raw) if _loss_pct_raw is not None else 5.0   # 0 = 한도 비활성
            if max_loss_pct > 0:
                daily_loss = await self._get_daily_realized_pnl()
                budget_ref = float(strategy.max_position_amt or 1_000_000) * settings.max_holdings
                loss_threshold = -budget_ref * (max_loss_pct / 100)
                if daily_loss < loss_threshold:
                    logger.error(
                        f"[킬스위치 발동] 오늘 손실 {daily_loss:,.0f}원 > 한도 {loss_threshold:,.0f}원 "
                        f"→ 신규 매수 중단 (손절/익절 감시는 계속)"
                    )
                    strategy.kill_switch_active = True
                    await self.db.commit()
                    await tg.notify_kill_switch(daily_loss, loss_threshold)
                    buy_block_reason = (
                        f"일일 손실 한도 초과 ({daily_loss:,.0f}원 > {loss_threshold:,.0f}원) — 신규 매수 중단"
                    )

        _clog.start_cycle()
        _clog.log("info", "start", f"사이클 시작 | 전략={strategy.name} | 모드={'실전' if settings.auto_trade_enabled else '모의'}")

        # ── 3-a. 시장 상황 점수 — 손절/익절 로그에 정확한 market_score 기록하기 위해 먼저 조회 ──
        mctx = await self._get_market_context()

        # 계좌 잔고
        balance = {}
        balance_ok = False
        try:
            balance = await self.api.get_balance()
            from app.services.kiwoom_api import is_account_tr_available
            balance_ok = is_account_tr_available()   # 원장 비가용 시간대는 스냅샷이므로 동기화 제외
        except Exception as e:
            err_str = str(e)
            logger.error(f"잔고 조회 실패: {err_str}")
            # 8050 / 토큰 장애 → Telegram 즉시 알림 (notify_kiwoom_down 미트리거 케이스 보완)
            if "토큰 발급 실패" in err_str or "8050" in err_str or "지정단말기" in err_str:
                await tg.notify_error(
                    "키움 API 인증 실패 — 자동매매 중단",
                    f"{err_str[:300]}\n\n🛠 키움 Open API+ 포털에서 단말기 재등록 후 서버를 재시작하세요."
                )

        # availableCash = d2_entra(T+2 미결제 반영 실질 가용액); entr은 미결제 매수 포함이라 과대계상
        available_cash = float(balance.get("availableCash") or balance.get("cash", 0))
        budget_per_stock = float(strategy.max_position_amt or 1_000_000)

        # ── kt00004 실잔고로 DB holdings 동기화 (체결 확정·누락 복구 포함) ──
        kt4_price_map: dict[str, dict] = {
            p["stock_code"]: p for p in balance.get("stockHoldings", [])
        }
        if balance_ok:
            try:
                await sync_holdings_with_balance(self.db, kt4_price_map)
            except Exception as _sync_e:
                await self.db.rollback()
                logger.warning(f"[잔고동기화] holdings 동기화 오류: {_sync_e}")

        # 보유 종목 (DB 갱신 후 재조회)
        holdings_result = await self.db.execute(select(Holding))
        holdings = {
            h.stock_code: {
                "stock_code": h.stock_code,
                "stock_name": h.stock_name or h.stock_code,
                "quantity": int(h.quantity),
                "avg_buy_price": float(h.avg_buy_price),
                "current_price": float(h.current_price or h.avg_buy_price),
                "is_long_term": bool(h.is_long_term),
                "is_manual":    bool(h.is_manual),
                "peak_pnl_pct": float(h.peak_pnl_pct) if h.peak_pnl_pct is not None else None,
                "smart_hold_loss_cycles": int(h.smart_hold_loss_cycles or 0),
            }
            for h in holdings_result.scalars().all()
        }

        # ── 장기 보유 예산 예약 (전체 포트폴리오의 30%) ─────────────────
        _LONG_TERM_RATIO = 0.30
        _total_portfolio = available_cash + sum(
            float(h["current_price"]) * int(h["quantity"]) for h in holdings.values()
        )
        _lt_deployed = sum(
            float(h["current_price"]) * int(h["quantity"])
            for h in holdings.values() if h.get("is_long_term")
        )
        _lt_budget = _total_portfolio * _LONG_TERM_RATIO
        _lt_reserve = max(0.0, min(_lt_budget - _lt_deployed, available_cash))
        available_cash -= _lt_reserve
        logger.info(
            f"[예산분배] 총자산 {_total_portfolio:,.0f}원 | "
            f"장기할당 {_lt_budget:,.0f}원(30%) | "
            f"장기배포 {_lt_deployed:,.0f}원 | "
            f"장기예약 {_lt_reserve:,.0f}원 | "
            f"단기가용 {available_cash:,.0f}원"
        )

        logger.info(
            f"[자동매매] ▶ 사이클 시작 | 전략={strategy.name} | "
            f"예수금={available_cash:,.0f}원 | 보유={len(holdings)}종목 | "
            f"모드={'REAL' if settings.auto_trade_enabled else 'PAPER'}"
        )

        # ── 오늘 CANCELLED된 매도 종목별 횟수 — 3회 이상이면 당일 매도 차단 ──
        _today = _today_kst()
        blocked_sell_today: set[str] = set()
        try:
            from sqlalchemy import func as _func_exit
            _csell_r2 = await self.db.execute(
                select(AutoTradeLog.stock_code, _func_exit.count().label("cnt"))
                .where(
                    AutoTradeLog.trade_date == _today,
                    AutoTradeLog.action == "SELL",
                    AutoTradeLog.status == "CANCELLED",
                )
                .group_by(AutoTradeLog.stock_code)
            )
            _csell_counts = {row[0]: row[1] for row in _csell_r2.all()}
            blocked_sell_today = {
                code for code, cnt in _csell_counts.items() if cnt >= 3
            }
            if blocked_sell_today:
                logger.warning(f"[매도차단] 오늘 매도 3회+ CANCELLED 종목 {len(blocked_sell_today)}개: {blocked_sell_today} — 당일 매도 차단")
                try:
                    _bal_chk = await self.api.get_balance()
                    _real_held = {h["stock_code"] for h in _bal_chk.get("stockHoldings", [])}
                    for _code in list(blocked_sell_today):
                        if _code not in _real_held:
                            from app.models.holding import Holding as _HExit
                            _h_r2 = await self.db.execute(select(_HExit).where(_HExit.stock_code == _code))
                            _phantom2 = _h_r2.scalar_one_or_none()
                            if _phantom2:
                                await self.db.delete(_phantom2)
                                logger.warning(f"[유령보유 정리] {_code} Holding 삭제 (실잔고 없음, CANCELLED {_csell_counts[_code]}회)")
                    await self.db.commit()
                except Exception as _re2:
                    logger.warning(f"[유령보유 정리] 잔고 재조정 실패: {_re2}")
        except Exception as _bst_err:
            logger.error(f"[매도차단 조회 오류] {_bst_err} — 매도차단 비활성화로 진행")

        # ── 1. 손절/익절 매도 ─────────────────────────────
        _clog.log("info", "exit", f"손절/익절 체크 시작 | 보유 {len(holdings)}종목")
        await self._check_exits(holdings, strategy, blocked_sell_today)
        _clog.log("info", "exit", "손절/익절 체크 완료")

        if buy_block_reason:
            await self.db.commit()
            _clog.log("warn", "start", f"신규 매수 생략 — {buy_block_reason}")
            _clog.end_cycle({"bought": 0, "buy_blocked": buy_block_reason})
            if collect_result:
                return {
                    "status": "skipped",
                    "skip_reason": buy_block_reason,
                    "market_open": market_open,
                    "elapsed": _elapsed(),
                }
            return None

        # ── 1-b. 수동 매수 예약 실행 ──────────────────────
        available_cash = await self._execute_manual_buys(
            available_cash, holdings, market_open, strategy
        )
        await self.db.commit()  # 수동 매수 holding 즉시 커밋 — 이후 오류에 독립

        # 수동 매수 실행 후 holdings 재로드 — max_holdings 판단 정확도 보장
        holdings_r2 = await self.db.execute(select(Holding))
        holdings = {
            h.stock_code: {
                "stock_code": h.stock_code,
                "stock_name": h.stock_name or h.stock_code,
                "quantity": int(h.quantity),
                "avg_buy_price": float(h.avg_buy_price),
                "current_price": float(h.current_price or h.avg_buy_price),
                "is_long_term": bool(h.is_long_term),
                "is_manual":    bool(h.is_manual),
                "peak_pnl_pct": float(h.peak_pnl_pct) if h.peak_pnl_pct is not None else None,
                "smart_hold_loss_cycles": int(h.smart_hold_loss_cycles or 0),
            }
            for h in holdings_r2.scalars().all()
        }

        # ── 2. 종목 수집 ───────────────────────────────────
        stock_codes, name_map = await self._collect_candidates()
        logger.info(f"[후보수집] {len(stock_codes)}종목 수집 완료 → AI 점수 계산 시작")
        _clog.log("info", "collect", f"후보 종목 {len(stock_codes)}개 수집 완료")

        # ── 2-b. 뉴스 없는 후보 종목 사전 수집 ─────────────
        # 매수 결정 전 news_gate가 실제 뉴스를 반영하도록 네이버 API로 즉시 수집
        await self._prefetch_candidate_news(stock_codes, name_map)

        # ── 3. 시장 상황 점수 + 보수적 모드 결정 ────────────
        # mctx는 사이클 시작 시 이미 조회됨 (손절/익절 로그 market_score 정확도 보장)
        market_score = mctx["market_score"]
        trade_mode   = mctx["mode"]

        _MODE_KR = {"NORMAL": "정상", "CAUTIOUS": "경계", "CONSERVATIVE": "수비", "DEFENSIVE": "전면수비"}
        mode_kr = _MODE_KR.get(trade_mode, trade_mode)

        # ── 모드 변경 감지 → 텔레그램 알림 ──────────────────
        _prev_mode    = AutoTradeEngine._last_trade_mode
        _mode_changed = (_prev_mode != trade_mode)
        AutoTradeEngine._last_trade_mode = trade_mode

        kospi_log = f"코스피 {mctx['kospi_change_pct']:+.2f}%"

        if trade_mode != "NORMAL":
            if trade_mode == "DEFENSIVE":
                warn_msg = (
                    f"⛔ [전면수비 모드] {kospi_log} → 신규 매수 전면 차단\n"
                    f"📌 손절·익절 매도만 실행됩니다."
                )
            elif trade_mode == "CONSERVATIVE":
                warn_msg = (
                    f"🔴 [{mode_kr} 모드] {kospi_log}\n"
                    f"📌 임계값 +{mctx['threshold_boost']*100:.0f}점 상향 | 예산 {mctx['budget_mult']*100:.0f}% 축소"
                )
            else:  # CAUTIOUS
                warn_msg = (
                    f"🛡 [{mode_kr} 모드] {kospi_log}\n"
                    f"📌 임계값 +{mctx['threshold_boost']*100:.0f}점 상향 | 예산 {mctx['budget_mult']*100:.0f}% 축소"
                )
            logger.warning(f"[시장경계] {warn_msg.replace(chr(10), ' ')}")
            _clog.log("warn", "market", warn_msg)

        # 모드가 변경된 경우에만 텔레그램 알림 전송
        if _mode_changed and tg.is_configured():
            _status_bar = _mode_status_bar(trade_mode, mctx["kospi_change_pct"])
            if trade_mode == "NORMAL" and _prev_mode is not None:
                # 비정상 → 정상 복귀
                recovery_msg = (
                    f"✅ [시장 정상 복귀] {kospi_log}\n"
                    f"📌 이전: {_MODE_KR.get(_prev_mode, _prev_mode)} 모드 → 정상 복귀\n"
                    f"매수 임계값·예산 원상 복원됩니다.\n\n"
                    f"{_status_bar}"
                )
                logger.info(f"[시장경계] {recovery_msg.replace(chr(10), ' ')}")
                _clog.log("info", "market", recovery_msg)
                await tg.send_message(recovery_msg, force=True, msg_type="info")
            elif trade_mode != "NORMAL":
                # 정상 → 비정상 또는 비정상 간 전환
                prev_kr = _MODE_KR.get(_prev_mode, _prev_mode) if _prev_mode else "정상"
                transition = f"🔄 이전: {prev_kr} 모드" if _prev_mode and _prev_mode != "NORMAL" else ""
                full_msg = warn_msg + (f"\n{transition}" if transition else "") + f"\n\n{_status_bar}"
                msg_type = "error" if trade_mode == "DEFENSIVE" else "warn"
                await tg.send_message(full_msg, force=True, msg_type=msg_type)

        # ── 4. 종목별 종합 점수 계산 ──────────────────────
        ranked = []
        for code in stock_codes:
            try:
                result = await self._score_stock(code, name_map.get(code, ""))
                if result:
                    ranked.append(result)
            except Exception as e:
                logger.info(f"  [{code}] 점수 계산 오류: {e}")

        # YAML에서 런타임 가중치 로드 (수정 시 재시작 불필요)
        cw = _composite_weights()
        for r in ranked:
            r["composite_score"] = (
                r["model_score"]              * cw["model"]
                + r["news_score"]             * cw["news"]
                + r.get("dart_score",   0.55) * cw["dart"]
                + market_score                * cw["market"]
                + r.get("supply_score", 0.5)  * cw["supply"]
            )

        # ── 프리장 거래량 급증 종목 우선순위 부스트 ──────────────
        try:
            from app.models.premarket_scan import PremarketScanLog as _PML
            _pm_r = await self.db.execute(
                select(_PML.stock_code, _PML.vol_ratio, _PML.signal)
                .where(
                    _PML.scan_date == _today_kst(),
                    _PML.priority_boost == True,
                )
            )
            _pm_map = {row[0]: (row[1], row[2]) for row in _pm_r}
            for r in ranked:
                pm = _pm_map.get(r["stock_code"])
                if pm:
                    vol_ratio, pm_signal = pm
                    # vol_ratio가 높을수록 최대 +0.08 부스트
                    boost = min(0.08, float(vol_ratio or 1) * 0.005)
                    r["composite_score"] = min(1.0, r["composite_score"] + boost)
                    r["premarket_signal"] = pm_signal
                    r["premarket_vol_ratio"] = float(vol_ratio or 0)
        except Exception as _pe:
            logger.debug(f"[프리장부스트] 로드 실패: {_pe}")

        ranked.sort(key=lambda x: x["composite_score"], reverse=True)

        # ── 5. 상위 종목 매수 신호 실행 ───────────────────
        buy_threshold = float(strategy.buy_threshold or 0.57)
        max_holdings  = settings.max_holdings
        current_count = len(holdings)

        # 보수적 모드 보정: 매수 임계값 상향 + 1회 예산 축소
        effective_threshold = min(0.95, buy_threshold + mctx["threshold_boost"])
        effective_budget    = budget_per_stock * mctx["budget_mult"]

        logger.info(
            f"[종목평가] {len(ranked)}종목 평가 완료 | 시장점수={market_score:.2f} | "
            f"모드={mode_kr} | 매수임계값={effective_threshold:.2f} | 최대보유={max_holdings}종목"
        )
        _clog.log("info", "rank",
                  f"{len(ranked)}종목 평가 완료 | 시장점수 {market_score*100:.0f}점 "
                  f"| {mode_kr} 모드 | 임계값 {effective_threshold*100:.0f}점")
        for r in ranked:
            logger.info(
                f"  [{r['stock_code']}] {r.get('stock_name','?')} | "
                f"종합={r['composite_score']:.3f} | 모델={r['model_score']:.3f} | "
                f"신호={r['final_signal']} | 현재가={r.get('current_price',0):,}원"
            )
            _clog.log("info", "score",
                      f"{r.get('stock_name') or r['stock_code']} ({r['stock_code']}) | "
                      f"종합 {r['composite_score']*100:.0f}점 | 모델 {r['model_score']*100:.0f}점 | "
                      f"뉴스 {r['news_score']*100:.0f}점 | 수급 {r.get('supply_score',0.5)*100:.0f}점",
                      {"code": r["stock_code"], "composite": round(r["composite_score"], 3),
                       "model": round(r["model_score"], 3), "signal": r["final_signal"]})

        # 결과 수집용 (collect_result=True 일 때 사용)
        result_rows: list[dict] = []

        # ── 추가 매수용 사전 데이터 로드 ───────────────────────────────
        # 보유 종목별 최초 매수 composite_score + 오늘 이미 추가 매수 여부 파악
        _today = _today_kst()
        addon_scores: dict[str, float] = {}       # code → 최초 매수 점수
        addon_bought_today: set[str] = set()       # 오늘 이미 추가 매수한 종목
        addon_bought_cycle: set[str] = set()       # 이번 사이클에서 추가 매수한 종목

        for _code in list(holdings.keys()):
            # 가장 최근 성공 BUY 로그 → 기준 composite_score
            _log_r = await self.db.execute(
                select(AutoTradeLog)
                .where(AutoTradeLog.stock_code == _code,
                       AutoTradeLog.action == "BUY",
                       AutoTradeLog.status != "CANCELLED")
                .order_by(AutoTradeLog.created_at.desc())
                .limit(1)
            )
            _log = _log_r.scalar_one_or_none()
            addon_scores[_code] = float(_log.composite_score or 0) if _log else buy_threshold

            # 오늘 BUY 성공 이력이 있으면 이미 추가 매수 완료로 간주
            _today_r = await self.db.execute(
                select(func.count()).select_from(AutoTradeLog)
                .where(AutoTradeLog.stock_code == _code,
                       AutoTradeLog.action == "BUY",
                       AutoTradeLog.trade_date == _today,
                       AutoTradeLog.status != "CANCELLED")
            )
            if (_today_r.scalar() or 0) >= 1:
                addon_bought_today.add(_code)

        # ── 오늘 매도된 종목 — 손절/익절 재매수 방지 ──────────────────
        # 손절 (stop-loss) 매도: 당일 재매수 완전 차단 + 3일 쿨다운
        # 익절 (take-profit) 매도: buy_threshold + 0.10 초과할 때만 허용
        stoploss_sold_today: set[str] = set()    # 손절로 매도한 종목 → 당일 재매수 금지
        takeprofit_sold_today: set[str] = set()  # 익절로 매도한 종목 → 높은 임계값 적용

        _sell_r = await self.db.execute(
            select(AutoTradeLog)
            .where(
                AutoTradeLog.trade_date == _today,
                AutoTradeLog.action == "SELL",
                AutoTradeLog.status != "CANCELLED",
            )
        )
        for _sell_log in _sell_r.scalars().all():
            _code = _sell_log.stock_code
            _pnl  = float(_sell_log.realized_pnl or 0)
            # trigger_models 에 "손절" 포함 또는 실현손익이 음수인 매도 → 손절로 판단
            _triggers = " ".join(_sell_log.trigger_models or []).lower()
            # 스마트 청산(거래량/수급/샹들리에) = 당일 재매수 금지 (팔고 바로 재매수 방지)
            if "손절" in _triggers or "스마트 청산" in _triggers or _pnl < 0:
                stoploss_sold_today.add(_code)
            else:
                takeprofit_sold_today.add(_code)

        if stoploss_sold_today:
            logger.info(f"[재매수방지] 손절/스마트청산 재매수제한 {len(stoploss_sold_today)}개: {stoploss_sold_today}")

        # ── 3영업일 이내 손절 이력 — 냉각기간 재진입 차단 ─────────────
        # 손절일 D → D+1 ~ D+3 거래일까지 차단 (주말·휴장일은 세지 않음)
        _COOLDOWN_DAYS = 3
        _cooldown_since = business_days_ago(_today, _COOLDOWN_DAYS)
        _cooldown_r = await self.db.execute(
            select(AutoTradeLog.stock_code)
            .where(
                AutoTradeLog.trade_date >= _cooldown_since,
                AutoTradeLog.trade_date < _today,   # 오늘은 stoploss_sold_today 로 처리
                AutoTradeLog.action == "SELL",
                AutoTradeLog.status != "CANCELLED",
                AutoTradeLog.realized_pnl < 0,
            )
            .distinct()
        )
        stoploss_cooldown: set[str] = {r[0] for r in _cooldown_r.all()} - stoploss_sold_today
        if stoploss_cooldown:
            logger.info(f"[재매수방지] 3영업일 쿨다운 적용 {len(stoploss_cooldown)}개: {stoploss_cooldown}")

        # ── 오늘 API 오류로 CANCELLED된 매수 종목 — 당일 재시도 차단 ──
        cancelled_buy_today: set[str] = set()
        _cancelled_r = await self.db.execute(
            select(AutoTradeLog.stock_code)
            .where(
                AutoTradeLog.trade_date == _today,
                AutoTradeLog.action == "BUY",
                AutoTradeLog.status == "CANCELLED",
            )
            .distinct()
        )
        for _row in _cancelled_r.all():
            cancelled_buy_today.add(_row[0])
        if cancelled_buy_today:
            logger.info(f"[재시도방지] 오늘 취소된 매수 종목 {len(cancelled_buy_today)}개: {cancelled_buy_today}")

        # ── 오늘 PENDING 매도 중인 종목 — 미체결 매도 주문이 있는 동안 재매수 차단 ──
        # 장초반 거래량 급감 오신호로 SELL PENDING이 발생하면 Holding이 삭제되어
        # 다음 사이클에서 신규 매수로 오인하는 반복매수 버그를 방지
        pending_sell_today: set[str] = set()
        _psell_r = await self.db.execute(
            select(AutoTradeLog.stock_code)
            .where(
                AutoTradeLog.trade_date == _today,
                AutoTradeLog.action == "SELL",
                AutoTradeLog.status == "PENDING",
            )
            .distinct()
        )
        for _row in _psell_r.all():
            pending_sell_today.add(_row[0])
        if pending_sell_today:
            logger.info(f"[미체결매도] PENDING 매도 종목 {len(pending_sell_today)}개: {pending_sell_today} — 재매수 차단")

        # ── 오늘 PENDING 매수 중인 종목 — 체결 미확인 매수 주문이 있는 동안 재매수 차단 ──
        # 시장가 주문이 3초 내 잔고에 반영되지 않으면 PENDING 유지. Holding이 생성되지 않아
        # 다음 사이클에서 같은 종목을 다시 매수할 수 있는 이중매수 버그를 방지
        pending_buy_today: set[str] = set()
        _pbuy_r = await self.db.execute(
            select(AutoTradeLog.stock_code, AutoTradeLog.stock_name, AutoTradeLog.created_at)
            .where(
                AutoTradeLog.trade_date == _today,
                AutoTradeLog.action == "BUY",
                AutoTradeLog.status == "PENDING",
            )
            .order_by(AutoTradeLog.created_at)
        )
        _pending_earliest: dict[str, datetime] = {}
        _pending_names: dict[str, str] = {}
        for _row in _pbuy_r.all():
            _code, _sname, _cat = _row[0], _row[1], _row[2]
            pending_buy_today.add(_code)
            if _code not in _pending_earliest:
                _pending_earliest[_code] = _cat
                _pending_names[_code] = _sname or _code
        if pending_buy_today:
            logger.info(f"[미체결매수] PENDING 매수 종목 {len(pending_buy_today)}개: {pending_buy_today} — 재매수 차단")
            # 20분(2사이클) 이상 PENDING → 텔레그램 경고
            _now_utc = datetime.now(timezone.utc)
            _long_pending = []
            for _lc, _lt in _pending_earliest.items():
                if _lt is None:
                    continue
                _lt_aware = _lt if _lt.tzinfo else _lt.replace(tzinfo=timezone.utc)
                if (_now_utc - _lt_aware).total_seconds() > 1200:
                    _long_pending.append(_pending_names.get(_lc, _lc))
            if _long_pending:
                await tg.send_message(
                    f"⚠️ 미체결 매수 주문 장기 대기 (20분+)\n"
                    f"종목: {', '.join(_long_pending)}\n"
                    f"체결 미확인 — 수동 확인 필요",
                    msg_type="warn",
                )
                logger.warning(f"[미체결알림] 20분+ PENDING 매수: {_long_pending}")

        bought = 0
        for r in ranked:
            name  = r.get('stock_name', r['stock_code'])
            score = r['composite_score']
            price = r.get("current_price", 0)
            row = {
                "stock_code": r["stock_code"],
                "stock_name": name,
                "composite_score": round(score, 4),
                "model_score": round(r["model_score"], 4),
                "news_score": round(r["news_score"], 4),
                "final_signal": r["final_signal"],
                "current_price": price,
                "trigger_models": r.get("trigger_models", []),
                "result": "",
                "skip_reason": None,
                "qty": 0,
            }

            # 전면수비 모드: 신규 매수 전면 차단
            if trade_mode == "DEFENSIVE":
                row["result"] = "SKIP"
                row["skip_reason"] = f"전면수비 모드 — 코스피 {mctx['kospi_change_pct']:+.2f}% 하락 (신규 매수 차단)"
                result_rows.append(row)
                continue

            # ── 시간대 기반 신규 매수 차단 ────────────────────────────────
            _buy_now = datetime.now(_SEOUL_TZ)
            _bh, _bm = _buy_now.hour, _buy_now.minute
            # 장초반(09:00~09:29): 허수호가·시가 변동성 극대 구간
            if _bh == 9 and _bm < 30:
                skip_msg = f"장초반 매수 차단 (09:00~09:30) — 현재 {_buy_now.strftime('%H:%M')}"
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue
            # 마감 전(14:00 이후): 당일 익절 확률 낮음, 오버나이트 리스크
            if _bh >= 14:
                skip_msg = f"장 마감 전 신규 매수 차단 (14:00+) — 현재 {_buy_now.strftime('%H:%M')}"
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue

            if current_count + bought >= max_holdings:
                logger.info(f"  [{r['stock_code']}] {name} → SKIP: 최대 보유 종목 수 도달 ({max_holdings})")
                _clog.log("warn", "order", f"{name} → SKIP: 최대 보유 종목 수 도달 ({max_holdings}개)")
                row["result"] = "SKIP"
                row["skip_reason"] = f"최대 보유 종목 수 도달 ({max_holdings}개)"
                result_rows.append(row)
                break
            if score < effective_threshold:
                logger.info(f"  [{r['stock_code']}] {name} → SKIP: 점수 미달 ({score:.3f} < {effective_threshold:.3f} [{mode_kr}])")
                _clog.log("warn", "order", f"{name} → SKIP: 점수 미달 ({score*100:.0f}점 < {effective_threshold*100:.0f}점 [{mode_kr}])")
                row["result"] = "SKIP"
                row["skip_reason"] = f"점수 미달 ({score:.3f} < {effective_threshold:.3f}, {mode_kr} 모드)"
                result_rows.append(row)
                break

            # ── 손절/익절 재매수 방지 ────────────────────────────────
            _code = r["stock_code"]
            if _code in stoploss_sold_today:
                skip_msg = f"당일 손절 종목 — 재매수 차단 (점수={score:.3f})"
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue

            if _code in stoploss_cooldown:
                skip_msg = f"3영업일 손절 쿨다운 — 재매수 차단 (점수={score:.3f})"
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue

            if _code in takeprofit_sold_today:
                # 익절 후 재매수는 점수가 훨씬 높을 때만 허용 (보수적 모드엔 effective_threshold 기준)
                rebuy_threshold = round(effective_threshold + 0.10, 4)
                if score < rebuy_threshold:
                    skip_msg = f"당일 익절 종목 — 재매수 임계값 미달 ({score:.3f} < {rebuy_threshold:.3f})"
                    logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                    _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                    row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                    result_rows.append(row); continue

            if _code in cancelled_buy_today:
                skip_msg = "당일 매수 오류 종목 — API 거절로 당일 재시도 차단 (텔레그램 /buy로 수동 주문 가능)"
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue

            if _code in pending_sell_today:
                skip_msg = "미체결 매도 주문 존재 — 체결 대기 중 재매수 차단"
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue

            if _code in pending_buy_today:
                skip_msg = "미체결 매수 주문 존재 — 체결 확인 전 이중매수 차단"
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue

            # 샹들리에 바닥선 이미 하향 돌파 종목 — 매수 시 즉시 청산 발동되므로 차단
            _chandelier_floor = r.get("chandelier_floor")
            if _chandelier_floor and price > 0 and price < _chandelier_floor:
                skip_msg = (
                    f"샹들리에 하향 — 매수 차단 "
                    f"(현재 {price:,}원 < 바닥 {_chandelier_floor:,.0f}원, 고점 대비 하락추세)"
                )
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue
            # ── EMA60 추세 필터 — 장기 이동평균선 2% 이상 하방 종목 매수 차단 ──
            _ema60 = r.get("ema_60")
            if _ema60 and price > 0 and price < _ema60 * 0.98:
                skip_msg = (
                    f"EMA60 하방 — 장기 하락추세 차단 "
                    f"(현재 {price:,}원 < EMA60 {_ema60:,.0f}원)"
                )
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue
            # ─────────────────────────────────────────────────────────

            if r["stock_code"] in holdings:
                # 추가 매수 조건: 현재 점수 > max(최초매수점수, 기본임계값) + 0.05
                orig_score      = addon_scores.get(r["stock_code"], buy_threshold)
                addon_threshold = round(max(orig_score, buy_threshold) + 0.05, 4)

                # 손실 -2% 이하 종목 추가매수 차단 — 하락 추세 물타기 방지
                _held = holdings[r["stock_code"]]
                _avg_p = float(_held.get("avg_buy_price") or 0)
                if _avg_p > 0 and price > 0:
                    _pnl_pct = (price - _avg_p) / _avg_p * 100
                    if _pnl_pct <= -2.0:
                        skip_msg = (
                            f"이미 보유 중 (추가매수 차단 — 손실 {_pnl_pct:.1f}% ≤ -2%, 물타기 방지)"
                        )
                        logger.info(f"  [{r['stock_code']}] {name} → SKIP: {skip_msg}")
                        _clog.log("info", "order", f"{name} → SKIP: {skip_msg}")
                        row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                        result_rows.append(row); continue

                if r["stock_code"] in addon_bought_today:
                    skip_msg = "이미 보유 중 (오늘 추가매수 완료)"
                    logger.info(f"  [{r['stock_code']}] {name} → SKIP: {skip_msg}")
                    _clog.log("info", "order", f"{name} → SKIP: {skip_msg}")
                    row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                    result_rows.append(row); continue

                if r["stock_code"] in addon_bought_cycle:
                    skip_msg = "이미 보유 중 (이번 사이클 추가매수 완료)"
                    logger.info(f"  [{r['stock_code']}] {name} → SKIP: {skip_msg}")
                    row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                    result_rows.append(row); continue

                if score < addon_threshold:
                    skip_msg = f"이미 보유 중 (추가매수 점수 미달: {score:.3f} < {addon_threshold:.3f})"
                    logger.info(f"  [{r['stock_code']}] {name} → SKIP: {skip_msg}")
                    _clog.log("info", "order", f"{name} → SKIP: {skip_msg}")
                    row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                    result_rows.append(row); continue

                # 추가 매수 허용 — bought 카운터 증가 없이 진행 (종목 수 기준 아님)
                logger.info(
                    f"  [{r['stock_code']}] {name} → 📈 추가매수 시도 "
                    f"(점수 {score:.3f} > {addon_threshold:.3f}, 최초매수 {orig_score:.3f})"
                )
                _clog.log("info", "order",
                          f"{name} → 추가매수 시도 (점수 {score:.3f} > 최초매수 {orig_score:.3f})")
                r["_is_add_buy"] = True
            # ── 모델 신호 게이트 — BUY 신호 모델 없으면 차단 ──────
            # 뉴스·수급·공시만으로 임계값을 넘긴 경우 기술적 근거 없음
            _trigger_models = r.get("trigger_models", [])
            if not _trigger_models and not r.get("_is_add_buy"):
                skip_msg = (
                    f"모델 BUY 신호 없음 — 뉴스/수급/공시 단독 매수 차단 "
                    f"(종합 {score:.3f}, 모델={r.get('final_signal','HOLD')})"
                )
                logger.info(f"  [{_code}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue

            # ── 뉴스 악재 게이트 (Phase 3) ──────────────────────
            news_allowed, news_block_reason = check_news_gate(r["news_score"])
            if not news_allowed:
                logger.info(f"  [{r['stock_code']}] {name} → SKIP: {news_block_reason}")
                _clog.log("warn", "order", f"{name} → SKIP: {news_block_reason}")
                row["result"] = "SKIP"
                row["skip_reason"] = news_block_reason
                result_rows.append(row)
                continue

            if price <= 0:
                logger.info(f"  [{r['stock_code']}] {name} → SKIP: 현재가 조회 실패")
                _clog.log("warn", "order", f"{name} → SKIP: 현재가 조회 실패")
                row["result"] = "SKIP"
                row["skip_reason"] = "현재가 조회 실패"
                result_rows.append(row)
                continue

            max_price_limit = settings.max_stock_price
            if max_price_limit > 0 and price > max_price_limit:
                logger.info(
                    f"  [{r['stock_code']}] {name} → SKIP: 단가 상한 초과 "
                    f"({price:,}원 > 상한 {max_price_limit:,}원)"
                )
                _clog.log("warn", "order", f"{name} → SKIP: 단가 상한 초과 ({price:,}원 > {max_price_limit:,}원)")
                row["result"] = "SKIP"
                row["skip_reason"] = f"단가 상한 초과 ({price:,}원 > {max_price_limit:,}원)"
                result_rows.append(row)
                continue

            # 스마트 포지션 사이징: 수급·AI점수 기반 수량 결정
            capped_budget = min(effective_budget, available_cash)
            qty = self.risk_mgr.calculate_smart_quantity(
                price         = price,
                budget        = capped_budget,
                supply_score  = r.get("supply_score", 0.5),
                composite_score = score,
                atr           = r.get("atr"),
            )
            if qty <= 0 and price > capped_budget:
                skip_msg = f"예산 부족 — 1주 단가 {price:,}원 > 종목당 예산 {capped_budget:,.0f}원"
                logger.info(f"  [{r['stock_code']}] {name} → SKIP: {skip_msg}")
                _clog.log("warn", "order", f"{name} → SKIP: {skip_msg}")
                row["result"] = "SKIP"; row["skip_reason"] = skip_msg
                result_rows.append(row); continue
            if qty <= 0 or qty * price > available_cash:
                skip_detail = f"{qty}주 × {price:,}원 = {qty*price:,}원 | 가용={available_cash:,.0f}원"
                if trade_mode != "NORMAL":
                    skip_detail += f" (예산 {mctx['budget_mult']*100:.0f}% 축소 적용)"
                logger.info(f"  [{r['stock_code']}] {name} → SKIP: 예수금 부족 {skip_detail}")
                _clog.log("warn", "order", f"{name} → SKIP: 예수금 부족 ({skip_detail})")
                row["result"] = "SKIP"
                row["skip_reason"] = f"예수금 부족 ({skip_detail})"
                result_rows.append(row)
                continue

            logger.info(f"  [{r['stock_code']}] {name} → 💰 매수 시도 {qty}주 × {price:,}원")
            _clog.log("info", "order", f"{name} ({r['stock_code']}) 매수 시도 {qty}주 × {price:,}원")

            # force=True (장 외 강제 실행)이면 실제 주문 없이 평가만
            if not market_open:
                row["result"] = "BOUGHT(평가전용)"
                row["qty"] = qty
                result_rows.append(row)
                bought += 1
                continue

            log = await self._execute_order(
                stock_code=r["stock_code"],
                stock_name=r.get("stock_name", ""),
                action="BUY",
                quantity=qty,
                price=price,
                model_scores=r["model_scores"],
                news_sentiment=r["news_score"],
                market_score=market_score,
                composite_score=r["composite_score"],
                trigger_models=r.get("trigger_models", []),
                dart_score=r.get("dart_score"),
                supply_score=r.get("supply_score"),
            )
            if log and log.status not in ("CANCELLED",):
                available_cash -= qty * price
                is_add_buy = r.get("_is_add_buy", False)
                if is_add_buy:
                    addon_bought_cycle.add(r["stock_code"])
                    row["result"] = "BOUGHT(추가)"
                else:
                    bought += 1
                    row["result"] = "BOUGHT"
                row["qty"] = qty
                _clog.log("success", "order",
                          f"{name} ({r['stock_code']}) {'추가' if is_add_buy else '신규'}매수 완료 {qty}주 × {price:,}원 [{log.status}]",
                          {"code": r["stock_code"], "qty": qty, "price": price, "status": log.status})

                # 체결 확인된 경우(FILLED 또는 모의MOCK)만 텔레그램 알림 발송
                # PENDING(미체결 또는 체결 지연)은 알림 미발송 — 오알림 방지
                if log.status in ("FILLED", "MOCK"):
                    await tg.notify_buy(
                        stock_name=r.get("stock_name", r["stock_code"]),
                        stock_code=r["stock_code"],
                        quantity=qty,
                        price=price,
                        composite_score=r["composite_score"],
                        trigger_models=r.get("trigger_models", []),
                        is_mock=(log.status == "MOCK"),
                        news_score=r.get("news_score", 0.5),
                        supply_score=r.get("supply_score", 0.5),
                        dart_score=r.get("dart_score", 0.5),
                        model_scores=r.get("model_scores", {}),
                    )
                else:
                    # 미체결(PENDING): 접수 알림만 발송
                    await tg.send_message(
                        f"📋 매수 주문 접수 (체결 대기)\n"
                        f"종목: {r.get('stock_name', r['stock_code'])} ({r['stock_code']})\n"
                        f"{qty}주 × {price:,}원\n"
                        f"⚠️ 체결 여부는 정합성 검사 후 확인됩니다.",
                        msg_type="info",
                    )
                    logger.warning(
                        f"[미체결] {name} ({r['stock_code']}) 주문 접수됐으나 체결 미확인 — 텔레그램 체결 알림 미발송"
                    )

                if self.ws_broadcast:
                    await self.ws_broadcast({
                        "type": "auto_trade",
                        "data": {
                            "action": "BUY",
                            "stock_code": r["stock_code"],
                            "price": price,
                            "quantity": qty,
                            "composite_score": r["composite_score"],
                        },
                    })
            else:
                _clog.log("error", "order", f"{name} ({r['stock_code']}) 매수 취소 (API 오류)")
                row["result"] = "CANCELLED"
            result_rows.append(row)

        await self.db.commit()
        logger.info(f"[자동매매] ■ 사이클 완료 — 매수 {bought}건 실행")
        _clog.end_cycle({"bought": bought, "candidates": len(stock_codes), "scored": len(ranked)})

        if collect_result:
            return {
                "status": "completed",
                "market_open": market_open,
                "mode": "실전" if settings.auto_trade_enabled else "모의",
                "strategy_name": strategy.name,
                "available_cash": available_cash,
                "holdings_count": len(holdings),
                "market_score": round(market_score, 4),
                "buy_threshold": buy_threshold,
                "effective_threshold": round(effective_threshold, 4),
                "trade_mode": trade_mode,
                "kospi_change_pct": mctx.get("kospi_change_pct", 0),
                "candidates_count": len(stock_codes),
                "scored_count": len(ranked),
                "bought_count": bought,
                "rows": result_rows,
                "elapsed": _elapsed(),
            }
        return None

    # ────────────────────────────────────────────────────────
    # 내부 메서드
    # ────────────────────────────────────────────────────────

    async def _get_daily_realized_pnl(self) -> float:
        """오늘 실현 손익 합산 (SELL 체결 기준)"""
        result = await self.db.execute(
            select(func.sum(AutoTradeLog.realized_pnl)).where(
                AutoTradeLog.trade_date == _today_kst(),
                AutoTradeLog.action == "SELL",
                AutoTradeLog.status.in_(("FILLED", "MOCK")),  # CANCELLED·PENDING 제외
                AutoTradeLog.realized_pnl.isnot(None),
            )
        )
        return float(result.scalar() or 0)

    async def _get_strategy(self) -> Optional[Strategy]:
        r = await self.db.execute(select(Strategy).where(Strategy.is_active == True).limit(1))
        return r.scalar_one_or_none()

    async def _collect_candidates(self) -> tuple[list[str], dict[str, str]]:
        """
        후보 종목 수집:
          1) 최근 섹터 스크리닝 결과 (screened_stocks, style='full', BUY 신호)
          2) 워치리스트 활성 종목
        반환: (코드 목록, {코드: 종목명} 맵)
        """
        from datetime import datetime, timezone, timedelta
        from app.models.screened_stock import ScreenedStock
        from sqlalchemy import desc as _desc

        codes: set[str] = set()
        name_map: dict[str, str] = {}

        # 1) 최근 24시간 이내 섹터 스크리닝 결과 — composite_score 기준 상위 40종목
        # final_signal=="BUY" 대신 composite_score >= 0.57 직접 사용:
        # M10 모델 레이블보다 수급·뉴스·공시·시장을 종합한 composite가 더 신뢰성 있음
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        _screen_where = [
            ScreenedStock.screen_style == "full",
            ScreenedStock.screened_at >= cutoff,
            ScreenedStock.composite_score >= 0.57,
        ]
        if settings.max_stock_price > 0:
            _screen_where.append(ScreenedStock.current_price <= settings.max_stock_price)
        screened_r = await self.db.execute(
            select(ScreenedStock)
            .where(*_screen_where)
            .order_by(_desc(ScreenedStock.composite_score))
            .limit(40)
        )
        for s in screened_r.scalars().all():
            codes.add(s.stock_code)
            if s.stock_name:
                name_map[s.stock_code] = s.stock_name

        # 2) 워치리스트
        wl_r = await self.db.execute(
            select(Watchlist).where(Watchlist.is_active == True)
        )
        for w in wl_r.scalars().all():
            codes.add(w.stock_code)
            if w.stock_name:
                name_map[w.stock_code] = w.stock_name

        return list(codes), name_map

    async def _score_stock(self, stock_code: str, stock_name: str = "") -> Optional[dict]:
        """단일 종목 종합 점수 계산"""
        df = await self.api.get_ohlcv(stock_code, count=200)
        if df.empty or len(df) < 60:
            return None

        df = compute(df)
        if df.empty:
            return None

        model_results = run_all_models(df)

        model_scores = {
            mid: {
                "score":  model_results[mid]["score"],
                "signal": model_results[mid]["signal"],
                "reason": model_results[mid].get("reason", ""),
            }
            for mid in ["M1","M2","M3","M4","M5","M6","M7","M8","M9","M10"]
            if mid in model_results
        }
        composite = model_results.get("composite_score", 0.5)
        final_signal = model_results.get("final_signal", "HOLD")
        trigger_models = [
            mid for mid, r in model_scores.items()
            if r["signal"] == "BUY"
        ]

        news_score = await self._get_news_score(stock_code, stock_name)

        from app.services.dart_collector import get_dart_score_for_stock
        dart_score = await get_dart_score_for_stock(self.db, stock_code, days=7)

        from app.services.supply_demand_service import get_supply_score
        supply_score = await get_supply_score(stock_code, days=5)

        price_info = await self.api.get_current_price(stock_code)
        current_price = int(price_info.get("price", 0))
        api_name = price_info.get("name", "").strip()
        resolved_name = api_name if api_name else stock_name

        atr    = float(df["atr_14"].iloc[-1]) if "atr_14" in df.columns else None
        ema_60 = float(df["ema_60"].iloc[-1]) if "ema_60" in df.columns else None

        # 샹들리에 바닥선 사전 계산 — 매수 전 하락추세 종목 필터링용
        chandelier_floor: Optional[float] = None
        if atr and atr > 0 and len(df) >= 20:
            _recent_high = float(df["close"].tail(20).max())
            chandelier_floor = round(_recent_high - 3.0 * atr, 2)

        return {
            "stock_code": stock_code,
            "stock_name": resolved_name,
            "current_price": current_price,
            "model_score": composite,
            "news_score": news_score,
            "dart_score": dart_score,
            "supply_score": supply_score,
            "atr": atr,
            "ema_60": ema_60,
            "chandelier_floor": chandelier_floor,
            "model_scores": model_scores,
            "final_signal": final_signal,
            "trigger_models": trigger_models,
            "composite_score": 0,  # 시장점수 반영 후 갱신
        }

    async def _get_news_score(self, stock_code: str, stock_name: str = "") -> float:
        """최근 24시간 해당 종목 뉴스 감성 평균 (없으면 중립 0.5)
        _prefetch_candidate_news 가 먼저 실행되어야 정확한 점수를 반환함"""
        try:
            from sqlalchemy import or_
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            name_conds = [NewsItem.stock_codes.any(stock_code)]  # type: ignore
            if stock_name:
                name_conds.append(NewsItem.title.ilike(f"%{stock_name}%"))
            r = await self.db.execute(
                select(NewsItem).where(
                    and_(
                        NewsItem.collected_at >= cutoff,
                        NewsItem.sentiment_score.isnot(None),
                        or_(*name_conds),
                    )
                ).limit(50)
            )
            news = r.scalars().all()
            if not news:
                return 0.55  # 악재 뉴스 없음 = 소폭 긍정 (중립 0.5보다 상향)
            avg = sum(float(n.sentiment_score) for n in news) / len(news)
            return round((avg + 1) / 2, 4)
        except Exception:
            return 0.55

    async def _prefetch_candidate_news(
        self, codes: list[str], name_map: dict[str, str]
    ) -> None:
        """후보 종목 중 최근 뉴스 없는 종목 네이버 API로 실시간 수집.
        _score_stock 호출 전에 반드시 실행해야 news_gate가 실제 뉴스를 반영함."""
        from app.core.config import settings
        if not getattr(settings, "naver_client_id", None):
            return

        from app.services.news_collector import _fetch_naver_api
        from app.services.sentiment_analyzer import analyze
        import asyncio as _asyncio

        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

        # 1) 뉴스 없는 종목 식별 (stock_codes 태깅 + title ILIKE 둘 다 없는 종목)
        no_news: list[tuple[str, str]] = []
        for code in codes:
            name = name_map.get(code, "")
            if not name:
                continue
            from sqlalchemy import or_
            cnt_r = await self.db.execute(
                select(func.count()).select_from(NewsItem).where(
                    and_(
                        NewsItem.collected_at >= cutoff,
                        NewsItem.sentiment_score.isnot(None),
                        or_(
                            NewsItem.stock_codes.any(code),  # type: ignore
                            NewsItem.title.ilike(f"%{name}%"),
                        ),
                    )
                )
            )
            if (cnt_r.scalar() or 0) == 0:
                no_news.append((code, name))

        if not no_news:
            logger.debug("[뉴스프리페치] 모든 후보 종목 뉴스 충분 — 스킵")
            return

        logger.info(f"[뉴스프리페치] 뉴스 없는 {len(no_news)}종목 네이버 API 실시간 수집")
        collector_name_map = {name: code for code, name in no_news}
        tasks = [
            _fetch_naver_api(name, code, collector_name_map, display=10)
            for code, name in no_news
        ]

        # 2) 배치 수집 (네이버 API 속도 제한 준수)
        fetched: list[dict] = []
        for i in range(0, len(tasks), 5):
            batch = await _asyncio.gather(*tasks[i:i+5], return_exceptions=True)
            for res in batch:
                if isinstance(res, list):
                    fetched.extend(res)
            if i + 5 < len(tasks):
                await _asyncio.sleep(0.3)

        # 3) 감성 분석 + DB 저장
        saved = 0
        for item in fetched:
            url_hash = item.get("url_hash")
            if not url_hash or not item.get("title"):
                continue
            exists = await self.db.execute(
                select(NewsItem).where(NewsItem.url_hash == url_hash)
            )
            if exists.scalar_one_or_none():
                continue
            text = (item.get("title") or "") + " " + (item.get("content_summary") or "")
            score, label = analyze(text)
            self.db.add(NewsItem(
                url_hash=url_hash,
                title=item["title"],
                content_summary=item.get("content_summary", ""),
                source="naver",
                stock_codes=item.get("stock_codes") or [],
                published_at=item.get("published_at"),
                sentiment_score=score,
                sentiment_label=label,
                is_disclosure=False,
            ))
            saved += 1

        if saved:
            await self.db.commit()
        logger.info(f"[뉴스프리페치] 완료 — {len(no_news)}종목, 신규 {saved}건 저장")

    async def _get_market_context(self) -> dict:
        """KOSPI 실시간 등락률 + 시간대를 결합한 시장 컨텍스트.
        결과를 self._market_ctx 에 캐싱해 _check_exits에서도 동일 값 사용."""
        from app.services.supply_demand_service import get_market_index

        idx = {}
        try:
            idx = await get_market_index()
        except Exception as e:
            logger.debug(f"시장 지수 조회 실패: {e}")

        kospi_chg = float(idx.get("kospi_change_pct", 0))
        available  = bool(idx.get("available", False))

        # ── 시간대 + 요일 점수 (기존 로직) ──────────────────
        now = datetime.now(_SEOUL_TZ)
        hour = now.hour
        weekday = now.weekday()
        if 9 <= hour < 10:    time_score = 0.75
        elif 10 <= hour < 14: time_score = 0.85
        elif 14 <= hour < 15: time_score = 0.70
        elif 15 <= hour < 16: time_score = 0.60
        else:                  time_score = 0.50
        day_weights = [0.80, 0.85, 0.88, 0.85, 0.75]
        day_w = day_weights[weekday] if weekday < 5 else 0.50

        # ── 코스피 등락률 → 0~1 (-3%~+3% 정규화) ────────────
        kospi_score = max(0.0, min(1.0, (kospi_chg + 3) / 6)) if available else 0.5

        # 시간대 40% + 요일 20% + 코스피 40%
        market_score = round(time_score * 0.4 + day_w * 0.2 + kospi_score * 0.4, 4)

        # ── 보수적 모드 결정 ─────────────────────────────────
        if available and kospi_chg < -2.5:
            mode = "DEFENSIVE"       # 전면수비: 신규 매수 전면 차단
            threshold_boost = 0.0
            budget_mult = 0.0
        elif available and kospi_chg < -1.5:
            mode = "CONSERVATIVE"    # 수비: 임계값 +0.10, 예산 60%
            threshold_boost = 0.10
            budget_mult = 0.60
        elif available and kospi_chg < -0.8:
            mode = "CAUTIOUS"        # 경계: 임계값 +0.05, 예산 80%
            threshold_boost = 0.05
            budget_mult = 0.80
        else:
            mode = "NORMAL"
            threshold_boost = 0.0
            budget_mult = 1.0

        ctx = {
            "kospi":              round(float(idx.get("kospi", 0)), 2),
            "kospi_change_pct":   round(kospi_chg, 4),
            "kosdaq":             round(float(idx.get("kosdaq", 0)), 2),
            "kosdaq_change_pct":  round(float(idx.get("kosdaq_change_pct", 0)), 4),
            "market_score":       market_score,
            "mode":               mode,
            "threshold_boost":    threshold_boost,
            "budget_mult":        budget_mult,
            "available":          available,
        }
        self._market_ctx = ctx
        return ctx

    def _calc_market_score(self) -> float:
        """시장 상황 점수 — _get_market_context() 캐시 우선, 없으면 시간대만으로 계산."""
        if getattr(self, "_market_ctx", None):
            return self._market_ctx["market_score"]

        now = datetime.now(_SEOUL_TZ)
        hour = now.hour
        weekday = now.weekday()
        if 9 <= hour < 10:    time_score = 0.75
        elif 10 <= hour < 14: time_score = 0.85
        elif 14 <= hour < 15: time_score = 0.70
        elif 15 <= hour < 16: time_score = 0.60
        else:                  time_score = 0.50
        day_weights = [0.80, 0.85, 0.88, 0.85, 0.75]
        day_w = day_weights[weekday] if weekday < 5 else 0.50
        return round((time_score + day_w) / 2, 4)

    async def _check_exits(
        self, holdings: dict, strategy: Strategy,
        blocked_sell_today: set[str] | None = None,
    ):
        """보유 종목 손절 / 스마트 동적 청산 체크 및 매도.

        수급 점수 < 0.75 → 기존 익절 % 기준 (고정 또는 동적 배수)
        수급 점수 ≥ 0.75 → 스마트 홀딩 모드: 고정 익절 없이 아래 3가지 청산 신호 사용
          ① 샹들리에 청산 : 최근 20봉 최고 종가 − 3×ATR14 미만
          ② 거래량 급감   : 당일 거래량 < 5일 평균의 40% (수익 구간에서만)
          ③ 수급 이탈     : 수급 점수 < 0.55 로 하락
        손절(-sl_pct%) 은 수급 점수와 무관하게 항상 적용.
        """
        if blocked_sell_today is None:
            blocked_sell_today = set()
        from app.services.supply_demand_service import get_supply_score

        sl_pct        = float(strategy.stop_loss_pct   or 3.0)
        base_tp       = float(strategy.take_profit_pct or 5.0)
        dyn_enabled   = bool(strategy.dynamic_tp_enabled)
        dyn_threshold = float(strategy.dynamic_tp_supply_threshold or 0.65)
        dyn_mult      = float(strategy.dynamic_tp_multiplier       or 1.5)

        # 스마트 홀딩 모드 진입 임계값 (수급 ≥ 0.75)
        SMART_HOLD_SUPPLY = 0.75
        # 스마트 홀딩 중 수급 이탈 기준
        SMART_EXIT_SUPPLY = 0.55
        # 샹들리에 ATR 배수
        CHANDELIER_MULT = 3.0
        # 거래량 급감 비율 (0.40→0.30: 기준 완화, 수익 +3% 미만 구간 추가 필터링)
        VOL_COLLAPSE_RATIO = 0.30

        # ── 미체결(PENDING) 매도 — 20분 이내면 체결 대기, 그 이후면 취소 처리 후 재매도 ──
        # 매도 PENDING 은 Holding 을 유지하므로(체결 확인 시 삭제) 중복 매도 주문을 여기서 막는다.
        _PENDING_SELL_WAIT_SEC = 1200
        _now_utc = datetime.now(timezone.utc)
        sell_in_flight: set[str] = set()
        _ps_r = await self.db.execute(
            select(AutoTradeLog).where(
                AutoTradeLog.action == "SELL",
                AutoTradeLog.status == "PENDING",
                AutoTradeLog.stock_code.in_(list(holdings.keys())),
            )
        )
        for _ps in _ps_r.scalars().all():
            _created = _ps.created_at
            if _created is not None and _created.tzinfo is None:
                _created = _created.replace(tzinfo=timezone.utc)
            if _created is not None and (_now_utc - _created).total_seconds() < _PENDING_SELL_WAIT_SEC:
                sell_in_flight.add(_ps.stock_code)
            else:
                _ps.status = "CANCELLED"
                _ps.error_msg = (_ps.error_msg or "") + " [미체결 20분 경과 — 재매도 대상]"
                logger.warning(f"  [{_ps.stock_code}] 매도 주문 20분+ 미체결 → CANCELLED 처리 후 재매도 허용")
        await self.db.commit()

        for code, h in holdings.items():
            try:
                # ── 수동 매수 종목 — 자동 청산 전면 제외 ──────────────────────
                if h.get("is_manual"):
                    logger.info(f"  [{code}] {h.get('stock_name',code)} → 수동 매수 종목 — 자동 청산 스킵")
                    continue

                # ── 현재가 / 수익률 계산 (손절 판단에 먼저 필요) ──────────────
                try:
                    price_info = await self.api.get_current_price(code)
                    current = int(price_info.get("price", 0) or 0)
                except Exception as _pe:
                    logger.warning(
                        f"  [{code}] 현재가 API 오류: {_pe} — DB 캐시 가격으로 손절 체크"
                    )
                    current = int(h["current_price"])
                if current <= 0:
                    continue

                if code in sell_in_flight:
                    logger.info(f"  [{code}] 매도 주문 체결 대기 중 — 청산 체크 스킵")
                    continue

                avg = h["avg_buy_price"]
                change_pct = (current - avg) / (avg + 1e-9) * 100

                # ── 장기 보유 전용 청산 기준 (-7% 손절 / +30% 익절) ──────────
                if h.get("is_long_term"):
                    _LT_SL = -7.0
                    _LT_TP = 30.0
                    name_lt = h.get("stock_name", code)
                    if change_pct <= _LT_SL:
                        _lt_reason = (
                            f"장기보유 손절 {change_pct:.1f}% (기준 -{abs(_LT_SL):.0f}%)"
                        )
                        logger.warning(f"  [{code}] {name_lt} → {_lt_reason}")
                        await self._do_sell(code, h, current, _lt_reason, supply_score=0.5)
                    elif change_pct >= _LT_TP:
                        _lt_reason = (
                            f"장기보유 익절 {change_pct:.1f}% (기준 +{_LT_TP:.0f}%)"
                        )
                        logger.info(f"  [{code}] {name_lt} → {_lt_reason}")
                        await self._do_sell(code, h, current, _lt_reason, supply_score=0.5)
                    else:
                        logger.info(
                            f"  [{code}] 장기 보유 유지 | 수익 {change_pct:+.1f}% "
                            f"(손절 -{abs(_LT_SL):.0f}% / 익절 +{_LT_TP:.0f}%)"
                        )
                    continue

                # ── 매도 차단: 오늘 3회+ CANCELLED 종목 ─────────────────────
                # 손절(-sl_pct% 이하)은 차단 무시하고 강제 실행
                if code in blocked_sell_today:
                    if change_pct > -sl_pct:
                        logger.info(f"  [{code}] 매도 차단 (오늘 CANCELLED 3회+) — 스킵")
                        continue
                    else:
                        logger.warning(
                            f"  [{code}] 매도 차단 종목이지만 손절 강제 실행 "
                            f"({change_pct:.1f}% ≤ -{sl_pct}%)"
                        )

                # ── 수급 점수 조회 ───────────────────────────────
                try:
                    supply_score = await get_supply_score(code, days=5)
                except Exception:
                    supply_score = 0.5

                # ── 손절 (항상 적용) ─────────────────────────────
                if change_pct <= -sl_pct:
                    reason = f"손절 {change_pct:.1f}% (기준 -{sl_pct}%)"
                    await self._do_sell(code, h, current, reason, supply_score=supply_score)
                    continue

                # ── 트레일링 스탑 (수익 구간 고점 추적, DB 저장) ─
                _cur_peak = h.get("peak_pnl_pct")
                if _cur_peak is None or change_pct > _cur_peak:
                    _cur_peak = change_pct
                    h["peak_pnl_pct"] = _cur_peak
                    await self._save_exit_state(code, peak_pnl_pct=round(_cur_peak, 4))
                # 고점이 base_tp의 70% 이상이고 고점 대비 3% 이상 하락 시 청산
                _TRAIL_TRIGGER = base_tp * 0.7   # e.g. 6%×0.7 = 4.2%
                _TRAIL_DROP    = 3.0
                if _cur_peak >= _TRAIL_TRIGGER and (_cur_peak - change_pct) >= _TRAIL_DROP:
                    trail_reason = (
                        f"트레일링 스탑 {change_pct:+.1f}% "
                        f"(고점 {_cur_peak:+.1f}%에서 -{_TRAIL_DROP:.0f}% 하락)"
                    )
                    logger.info(f"  [{code}] {h.get('stock_name', code)} → {trail_reason}")
                    await self._do_sell(code, h, current, trail_reason, supply_score=supply_score)
                    continue

                # ── 스마트 홀딩 모드 (수급 ≥ 75점) ─────────────
                if supply_score >= SMART_HOLD_SUPPLY:
                    # 연속 손실 -1.5% 이하 3사이클(30분) 지속 시 강제 청산
                    _loss_cycles = (int(h.get("smart_hold_loss_cycles") or 0) + 1) if change_pct <= -1.5 else 0
                    if _loss_cycles != int(h.get("smart_hold_loss_cycles") or 0):
                        h["smart_hold_loss_cycles"] = _loss_cycles
                        await self._save_exit_state(code, smart_hold_loss_cycles=_loss_cycles)

                    if _loss_cycles >= 3:
                        _force_reason = (
                            f"스마트 홀딩 연속 손실 강제 청산 "
                            f"({change_pct:+.1f}% × {_loss_cycles}사이클 지속)"
                        )
                        logger.warning(f"  [{code}] {_force_reason}")
                        await self._do_sell(code, h, current, _force_reason, supply_score=supply_score)
                        continue

                    smart_reason = await self._smart_exit_signal(
                        code, current, change_pct, supply_score,
                        SMART_EXIT_SUPPLY, CHANDELIER_MULT, VOL_COLLAPSE_RATIO,
                    )
                    if smart_reason:
                        logger.info(f"  [{code}] 스마트 청산 발동: {smart_reason}")
                        await self._do_sell(code, h, current, smart_reason, supply_score=supply_score)
                    else:
                        _loss_warn = f" | 손실 경고 {_loss_cycles}/3사이클" if _loss_cycles > 0 else ""
                        logger.info(
                            f"  [{code}] 스마트 홀딩 유지 "
                            f"| 수익 {change_pct:+.1f}% | 수급 {supply_score*100:.0f}점{_loss_warn}"
                        )
                    continue

                # ── 일반 익절 (수급 < 75점) ──────────────────────
                tp_pct = base_tp
                if dyn_enabled and change_pct > 0:
                    market_score = self._calc_market_score()
                    if supply_score >= dyn_threshold and market_score >= 0.5:
                        tp_pct = base_tp * dyn_mult
                        logger.info(
                            f"[동적익절] {code} 수급:{supply_score*100:.0f}점 "
                            f"→ 익절 기준 {base_tp}%→{tp_pct:.1f}%"
                        )

                if change_pct >= tp_pct:
                    label = "동적익절" if tp_pct != base_tp else "익절"
                    reason = f"{label} {change_pct:.1f}% (기준 +{tp_pct:.1f}%)"
                    await self._do_sell(code, h, current, reason, supply_score=supply_score)

            except Exception as e:
                logger.warning(f"  [{code}] 청산 체크 오류 (스킵): {e}")

        await self.db.commit()

    async def _save_exit_state(self, code: str, **values) -> None:
        """트레일링 고점·스마트홀딩 손실 사이클을 holdings 에 저장 (재시작 후에도 유지)."""
        from sqlalchemy import update as _update
        await self.db.execute(_update(Holding).where(Holding.stock_code == code).values(**values))

    async def _smart_exit_signal(
        self,
        code: str,
        current: int,
        change_pct: float,
        supply_score: float,
        exit_supply: float,
        chandelier_mult: float,
        vol_collapse_ratio: float,
    ) -> str | None:
        """스마트 홀딩 종목의 청산 신호 검사. 이유 문자열 반환, 없으면 None."""

        # ① 수급 이탈
        if supply_score < exit_supply:
            return f"수급 이탈 청산 (수급 {supply_score*100:.0f}점 < {exit_supply*100:.0f}점)"

        # ② 샹들리에 청산 + ③ 거래량 급감 — OHLCV 필요
        try:
            df = await self.api.get_ohlcv(code, period="D", count=25)
            if df is None or len(df) < 6:
                return None

            # ATR14 계산 (간략 버전 — TR 기반)
            high  = df["high"].astype(float)
            low   = df["low"].astype(float)
            close = df["close"].astype(float)
            prev_close = close.shift(1)
            tr = (high - low).combine(
                (high - prev_close).abs(), max
            ).combine(
                (low  - prev_close).abs(), max
            )
            atr14 = float(tr.rolling(14).mean().iloc[-1] or 0)

            # ② 샹들리에 청산: 최근 20봉 최고 종가 − chandelier_mult × ATR
            recent_high = float(close.tail(20).max())
            chandelier_floor = recent_high - chandelier_mult * atr14
            if atr14 > 0 and current < chandelier_floor:
                return (
                    f"샹들리에 청산 (현재 {current:,}원 < "
                    f"20일고가{recent_high:,.0f}원 − {chandelier_mult}×ATR{atr14:,.0f}원 "
                    f"= {chandelier_floor:,.0f}원)"
                )

            # ③ 거래량 급감 (수익 +3% 이상 구간에서만, 11:00 이후만)
            # +3% 미만 구간은 자연 등락 범위 — 거래량급감만으로 청산하지 않음
            _now_kst = datetime.now(_SEOUL_TZ)
            _vol_time_ok = _now_kst.hour >= 11
            if change_pct >= 3.0 and _vol_time_ok:
                vol_today_raw = float(df["volume"].iloc[-1])
                # 최근 5 완성 영업일 평균 (오늘 부분합 제외)
                vol_avg5 = float(df["volume"].tail(6).iloc[:-1].mean())
                if vol_avg5 > 0:
                    # 09:00~15:30 경과 비율로 오늘 거래량을 하루 예상치로 보정
                    _mkt_open  = _now_kst.replace(hour=9, minute=0, second=0, microsecond=0)
                    _mkt_close = _now_kst.replace(hour=15, minute=30, second=0, microsecond=0)
                    _elapsed   = (_now_kst - _mkt_open).total_seconds()
                    _total     = (_mkt_close - _mkt_open).total_seconds()
                    _time_frac = max(0.05, min(1.0, _elapsed / _total))
                    vol_today_adj = vol_today_raw / _time_frac
                    if vol_today_adj < vol_avg5 * vol_collapse_ratio:
                        return (
                            f"거래량 급감 청산 (오늘 예상 {vol_today_adj:,.0f} < "
                            f"5일평균 {vol_avg5:,.0f}의 {vol_collapse_ratio*100:.0f}%, "
                            f"수익 {change_pct:+.1f}%)"
                        )
        except Exception as e:
            logger.debug(f"[스마트청산] {code} OHLCV 조회 실패: {e}")

        return None

    async def _do_sell(self, code: str, h: dict, current: int, reason: str, supply_score: float = 0.5):
        """매도 주문 실행 + 텔레그램 알림 공통 처리.
        청산은 체결이 우선이므로 시장가로 주문한다 (급락 시 지정가 미체결 방지)."""
        if not self._orders_allowed:
            logger.info(f"  [{code}] 장 외 평가 전용 — 매도 신호만 기록: {reason}")
            _clog.log("info", "exit", f"{h.get('stock_name', code)} 매도 신호 (평가전용, 주문 없음): {reason}")
            return
        qty = h["quantity"]
        log = await self._execute_order(
            stock_code=code,
            stock_name=h.get("stock_name", code),
            action="SELL",
            quantity=qty,
            price=current,
            model_scores={},
            news_sentiment=0.5,
            market_score=self._calc_market_score(),
            composite_score=0,
            trigger_models=[reason],
            use_market_order=True,
        )
        if log and log.status not in ("CANCELLED",):
            await tg.notify_sell(
                stock_name=h.get("stock_name", code),
                stock_code=code,
                quantity=qty,
                price=current,
                avg_buy_price=h["avg_buy_price"],
                reason=reason,
                is_mock=not settings.auto_trade_enabled,
                supply_score=supply_score,
            )

    async def _execute_order(
        self,
        stock_code: str,
        action: str,
        quantity: int,
        price: int,
        model_scores: dict,
        news_sentiment: float,
        market_score: float,
        composite_score: float,
        trigger_models: list[str],
        stock_name: str = "",
        dart_score: Optional[float] = None,
        supply_score: Optional[float] = None,
        is_manual: bool = False,
        is_long_term: bool = False,
        use_market_order: bool = False,
    ) -> Optional[AutoTradeLog]:
        """주문 실행 + auto_trade_logs 기록 + Holding 테이블 갱신"""
        # SELL 시 실현손익 사전 계산 (Holding의 평균단가 기준)
        realized_pnl: Optional[float] = None
        if action == "SELL":
            h_r = await self.db.execute(select(Holding).where(Holding.stock_code == stock_code))
            existing_h = h_r.scalar_one_or_none()
            if existing_h:
                avg_p = float(existing_h.avg_buy_price)
                realized_pnl = round((price - avg_p) * quantity, 2)

        _amount = quantity * price
        _COMMISSION_RATE = 0.00015   # 0.015% 편도 수수료
        _TAX_RATE        = 0.0020    # 0.20% 증권거래세 (매도 시)
        _commission = round(_amount * _COMMISSION_RATE, 2)
        _tax        = round(_amount * _TAX_RATE, 2) if action == "SELL" else 0.0

        log = AutoTradeLog(
            trade_date=_today_kst(),
            stock_code=stock_code,
            stock_name=stock_name or stock_code,
            action=action,
            quantity=quantity,
            order_price=price,
            order_amount=_amount,
            model_scores=model_scores,
            news_sentiment=news_sentiment,
            dart_score=dart_score,
            supply_score=supply_score,
            market_score=market_score,
            composite_score=composite_score,
            trigger_models=trigger_models,
            realized_pnl=realized_pnl,
            commission=_commission,
            tax=_tax,
        )

        if not settings.auto_trade_enabled:
            # 모의 주문
            log.status      = "MOCK"
            log.order_id    = f"MOCK-{stock_code}-{int(datetime.now().timestamp())}"
            log.filled_price  = price
            log.filled_amount = quantity * price
            log.filled_at     = datetime.now(timezone.utc)
        else:
            try:
                # StockMaster 시장 구분 (주문은 코스피·코스닥 모두 KRX 로 전송)
                from app.models.stock_master import StockMaster as _SM
                _sm_r = await self.db.execute(
                    select(_SM.market).where(_SM.stock_code == stock_code)
                )
                stock_market = _sm_r.scalar() or "KOSPI"

                result = await self.api.place_order(
                    stock_code=stock_code,
                    order_type=action,
                    quantity=quantity,
                    price=price,
                    market=stock_market,
                    use_market_order=use_market_order,
                )
                log.order_id = result.get("ord_no") or result.get("orderId") or ""
                log.status   = "PENDING"

                # ── BUY 체결 확인: 3초 대기 후 실제 보유 여부로 체결 검증 ──
                if action == "BUY":
                    import asyncio as _aio
                    await _aio.sleep(3)
                    try:
                        bal = await self.api.get_balance()
                        held = {h["stock_code"] for h in bal.get("stockHoldings", [])}
                        if stock_code in held:
                            log.status        = "FILLED"
                            log.filled_price  = price
                            log.filled_amount = quantity * price
                            log.filled_at     = datetime.now(timezone.utc)
                            logger.info(f"[체결확인] {stock_code} 매수 체결 확인 (잔고 보유 확인)")
                        else:
                            logger.warning(
                                f"[체결확인] {stock_code} 잔고 미확인 → PENDING 유지 "
                                f"(미체결 또는 체결 지연)"
                            )
                    except Exception as _ce:
                        logger.warning(f"[체결확인] {stock_code} 잔고 조회 실패: {_ce} → PENDING 유지")

                # ── SELL 체결 확인: 3초 대기 후 잔고 소멸 여부로 체결 검증 ──
                elif action == "SELL":
                    import asyncio as _aio
                    await _aio.sleep(3)
                    try:
                        bal = await self.api.get_balance()
                        held = {h["stock_code"] for h in bal.get("stockHoldings", [])}
                        if stock_code not in held:
                            log.status        = "FILLED"
                            log.filled_price  = price
                            log.filled_amount = quantity * price
                            log.filled_at     = datetime.now(timezone.utc)
                            logger.info(f"[체결확인] {stock_code} 매도 체결 확인 (잔고 소멸 확인)")
                        else:
                            logger.info(
                                f"[체결확인] {stock_code} 잔고 잔존 → PENDING 유지 "
                                f"(미체결 또는 부분체결)"
                            )
                    except Exception as _ce:
                        logger.warning(f"[체결확인] {stock_code} 잔고 조회 실패: {_ce} → PENDING 유지")

            except Exception as e:
                log.status    = "CANCELLED"
                log.error_msg = str(e)
                logger.error(f"주문 실패 {stock_code}: {e}")
                # ── 보유수량 초과 오류(571445) 시 잔고 재조정 ──────────────
                # "보유수량을 초과" 에러는 이미 매도됐지만 Holding이 남은 경우.
                # 실제 잔고를 조회해 해당 종목이 없으면 Holding을 삭제한다.
                if "보유수량" in str(e) or "571445" in str(e):
                    try:
                        import asyncio as _aio
                        await _aio.sleep(1)
                        _bal = await self.api.get_balance()
                        _held_codes = {h["stock_code"] for h in _bal.get("stockHoldings", [])}
                        if stock_code not in _held_codes:
                            from app.models.holding import Holding as _Holding
                            _h_r = await self.db.execute(
                                select(_Holding).where(_Holding.stock_code == stock_code)
                            )
                            _phantom = _h_r.scalar_one_or_none()
                            if _phantom:
                                await self.db.delete(_phantom)
                                logger.warning(
                                    f"[유령보유 정리] {stock_code} Holding 삭제 "
                                    f"(실잔고 없음, 오류: {e})"
                                )
                    except Exception as _re:
                        logger.warning(f"[유령보유 정리] {stock_code} 잔고 재조정 실패: {_re}")

        self.db.add(log)
        await self.db.flush()

        # Holding 테이블 갱신 — 체결 확인(FILLED/MOCK)된 경우만
        # BUY PENDING: 유령 보유 방지 (잔고 동기화에서 체결 확인 시 생성)
        # SELL PENDING: Holding 유지 → 미체결이면 다음 사이클에서 다시 손절 감시
        #               (잔고 동기화에서 실잔고 소멸 확인 시 FILLED + 삭제)
        # CANCELLED: 갱신하지 않음
        if action == "BUY" and log.status in ("FILLED", "MOCK"):
            await self._update_holding(stock_code, stock_name, action, quantity, price, is_manual=is_manual, is_long_term=is_long_term)
        elif action == "SELL" and log.status in ("FILLED", "MOCK"):
            await self._update_holding(stock_code, stock_name, action, quantity, price, is_manual=is_manual)

        # 주문 로그 + Holding을 즉시 커밋 — 이후 사이클 오류에 무관하게 이력 유실 방지
        await self.db.commit()

        return log

    async def _update_holding(
        self, stock_code: str, stock_name: str, action: str, quantity: int, price: int,
        is_manual: bool = False,
        is_long_term: bool = False,
    ) -> None:
        """BUY → upsert Holding, SELL → 수량 차감 (0이면 삭제)"""
        h_r = await self.db.execute(select(Holding).where(Holding.stock_code == stock_code))
        holding = h_r.scalar_one_or_none()

        if action == "BUY":
            if holding:
                old_total = float(holding.avg_buy_price) * int(holding.quantity)
                new_total = price * quantity
                new_qty   = int(holding.quantity) + quantity
                holding.avg_buy_price = round((old_total + new_total) / new_qty, 2)
                holding.quantity      = new_qty
                holding.current_price = price
                # 자동매매(is_manual=False)가 매수 시 잘못된 수동 플래그를 교정
                if is_manual:
                    holding.is_manual = True
                else:
                    holding.is_manual = False
                if is_long_term:
                    holding.is_long_term = True
            else:
                self.db.add(Holding(
                    stock_code=stock_code,
                    stock_name=stock_name or stock_code,
                    quantity=quantity,
                    avg_buy_price=price,
                    current_price=price,
                    is_manual=is_manual,
                    is_long_term=is_long_term,
                ))
        elif action == "SELL":
            if holding:
                new_qty = int(holding.quantity) - quantity
                if new_qty <= 0:
                    await self.db.delete(holding)
                else:
                    holding.quantity      = new_qty
                    holding.current_price = price

    async def _execute_manual_buys(
        self,
        available_cash: float,
        holdings: dict,
        market_open: bool,
        strategy,
    ) -> float:
        """수동 매수 예약 종목을 개장 사이클마다 즉시 매수한다.
        이미 보유 중인 종목은 스킵하고, 매수 완료 후 Holding.is_manual=True 설정.
        반환값: 갱신된 available_cash"""
        from app.models.manual_buy_order import ManualBuyOrder

        r = await self.db.execute(
            select(ManualBuyOrder).where(ManualBuyOrder.status == "pending")
        )
        orders = r.scalars().all()
        if not orders:
            return available_cash

        _clog.log("info", "order", f"수동 매수 예약 {len(orders)}건 처리 시작")

        for order in orders:
            code = order.stock_code
            name = order.stock_name or code

            if code in holdings:
                _clog.log("warn", "order", f"수동매수 {name} ({code}) — SKIP: 이미 보유 중")
                continue

            try:
                price_info = await self.api.get_current_price(code)
                price = int(price_info.get("price", 0))
                resolved_name = price_info.get("name", "").strip() or name
                if price <= 0:
                    _clog.log("warn", "order", f"수동매수 {name} ({code}) — 현재가 조회 실패, 장 마감 전까지 재시도")
                    continue

                if order.quantity:
                    qty = int(order.quantity)
                else:
                    budget = float(order.budget or strategy.max_position_amt or 1_000_000)
                    qty    = int(min(budget, available_cash) // price)

                if qty <= 0 or qty * price > available_cash:
                    _clog.log("warn", "order",
                              f"수동매수 {name} ({code}) — 예수금 부족 ({qty}주 × {price:,}원 | 가용 {available_cash:,.0f}원), 장 마감 전까지 재시도")
                    continue

                if not market_open:
                    # 장 외 강제 실행 (평가 전용)
                    order.status         = "executed"
                    order.executed_at    = datetime.now(timezone.utc)
                    order.executed_price = price
                    order.executed_qty   = qty
                    available_cash      -= qty * price
                    _clog.log("info", "order",
                              f"수동매수 {resolved_name} ({code}) {qty}주 × {price:,}원 [평가전용]")
                    continue

                log = await self._execute_order(
                    stock_code=code,
                    stock_name=resolved_name,
                    action="BUY",
                    quantity=qty,
                    price=price,
                    model_scores={},
                    news_sentiment=0.5,
                    market_score=self._calc_market_score(),
                    composite_score=1.0,
                    trigger_models=["수동매수"],
                    is_manual=True,
                    use_market_order=True,
                )

                if log and log.status not in ("CANCELLED",):
                    order.status         = "executed"
                    order.executed_at    = datetime.now(timezone.utc)
                    order.executed_price = price
                    order.executed_qty   = qty
                    available_cash      -= qty * price
                    _clog.log("success", "order",
                              f"수동매수 {resolved_name} ({code}) {qty}주 × {price:,}원 완료 [{log.status}]")
                    # 체결 확인된 경우만 알림
                    if log.status in ("FILLED", "MOCK"):
                        await tg.notify_buy(
                            stock_name=resolved_name,
                            stock_code=code,
                            quantity=qty,
                            price=price,
                            composite_score=1.0,
                            trigger_models=["수동매수"],
                            is_mock=(log.status == "MOCK"),
                        )
                    else:
                        await tg.send_message(
                            f"📋 수동 매수 주문 접수 (체결 대기)\n"
                            f"종목: {resolved_name} ({code})\n"
                            f"{qty}주 × {price:,}원\n"
                            f"⚠️ 체결 여부는 정합성 검사 후 확인됩니다.",
                            msg_type="info",
                        )
                else:
                    err = (log.error_msg or "API 오류") if log else "주문 처리 실패"
                    _clog.log("warn", "order", f"수동매수 {resolved_name} ({code}) — {err}, 장 마감 전까지 재시도")

            except Exception as e:
                _clog.log("warn", "order", f"수동매수 {code} — 오류 발생, 장 마감 전까지 재시도: {e}")
                logger.error(f"수동 매수 오류 {code}: {e}")

        return available_cash

    async def run_long_term_screening(self) -> None:
        async with TRADE_CYCLE_LOCK:
            self._orders_allowed = self.risk_mgr.is_market_open()
            if not self._orders_allowed:
                logger.info("[장기매수] 장 운영 시간 외 — 스킵")
                return
            await self._run_long_term_screening()

    async def _run_long_term_screening(self) -> None:
        """
        가치주 스크리닝 후 장기보유 종목 자동 매수 (매일 1회 09:10 호출).
        - 이미 보유 중인 종목 제외
        - 장기보유 슬롯 최대 3개 유지
        - 매수 후 is_long_term=True 자동 설정
        """
        from app.services.fundamental_screener import screen_value_stocks
        from app.models.holding import Holding as _Holding

        logger.info("[장기매수] 가치주 스크리닝 시작")

        # 전략 설정 조회
        strategy = await self._get_strategy()
        budget_per_pos = float(strategy.max_position_amt or 500_000) if strategy else 500_000  # type: ignore[union-attr]
        _MAX_LONG_TERM = 3

        # 현재 보유 현황
        h_r = await self.db.execute(select(_Holding))
        all_holdings = h_r.scalars().all()
        held_codes = {h.stock_code for h in all_holdings}
        long_term_count = sum(1 for h in all_holdings if h.is_long_term)

        # ── 기존 장기 보유 종목 가치지표 재검증 (PER>25 or PBR>3.0 → 가치 훼손 매도) ──
        lt_holdings_list = [h for h in all_holdings if h.is_long_term]
        if lt_holdings_list:
            logger.info(f"[장기검증] 장기보유 {len(lt_holdings_list)}종목 가치지표 재검증")
            try:
                from app.services.fundamental_screener import get_stock_fundamentals as _get_fund

                for _lth in lt_holdings_list:
                    _code = _lth.stock_code
                    _name = _lth.stock_name or _code
                    _fund = await _get_fund(_code)
                    _per, _pbr = _fund["per"], _fund["pbr"]
                    # 가치 훼손 기준: PER > 25(0 제외) or PBR > 3.0(0 제외)
                    _per_bad = 0 < _per > 25
                    _pbr_bad = 0 < _pbr > 3.0
                    if _per_bad or _pbr_bad:
                        logger.warning(
                            f"[장기검증] {_name}({_code}) 가치 훼손 "
                            f"(PER {_per:.1f} / PBR {_pbr:.2f}) → 청산 실행"
                        )
                        try:
                            _pi = await self.api.get_current_price(_code)
                            _cp = int(_pi.get("price", 0) or 0)
                            if _cp > 0:
                                _avg = float(_lth.avg_buy_price or 0)
                                _chg = (_cp - _avg) / (_avg + 1e-9) * 100
                                _h_dict = {
                                    "stock_code": _code, "stock_name": _name,
                                    "quantity": int(_lth.quantity or 0),
                                    "avg_buy_price": _avg, "current_price": _cp,
                                    "is_long_term": True,
                                }
                                _reason = (
                                    f"장기보유 가치 훼손 청산 "
                                    f"(PER {_per:.1f} / PBR {_pbr:.2f}, 수익 {_chg:+.1f}%)"
                                )
                                await self._do_sell(_code, _h_dict, _cp, _reason)
                                await tg.send_message(
                                    f"📉 장기보유 가치 훼손 청산\n"
                                    f"종목: {_name} ({_code})\n"
                                    f"PER {_per:.1f} / PBR {_pbr:.2f}\n"
                                    f"수익: {_chg:+.1f}%",
                                    msg_type="sell",
                                )
                                # 슬롯 반환
                                long_term_count -= 1
                        except Exception as _se:
                            logger.warning(f"[장기검증] {_code} 매도 실패: {_se}")
                    else:
                        logger.info(
                            f"[장기검증] {_name}({_code}) 가치지표 정상 "
                            f"(PER {_per:.1f} / PBR {_pbr:.2f})"
                        )
            except Exception as _ve:
                logger.warning(f"[장기검증] 가치지표 재검증 실패: {_ve}")

        if long_term_count >= _MAX_LONG_TERM:
            logger.info(f"[장기매수] 장기보유 슬롯 포화 ({long_term_count}/{_MAX_LONG_TERM}) — 스킵")
            return

        slots = _MAX_LONG_TERM - long_term_count

        # 예수금 조회 + 포트폴리오 기반 장기 예산 계산 (30%)
        try:
            bal = await self.api.get_balance()
            available_cash = float(bal.get("availableCash", 0) or bal.get("cash", 0) or 0)
        except Exception as e:
            logger.warning(f"[장기매수] 예수금 조회 실패: {e}")
            return

        _LONG_TERM_RATIO = 0.30
        _bal_holdings = bal.get("stockHoldings", [])
        _total_portfolio = available_cash + sum(
            float(h.get("current_price", 0) or 0) * int(h.get("quantity", 0) or 0)
            for h in _bal_holdings
        )
        _lt_deployed = sum(
            float(h.current_price or h.avg_buy_price or 0) * int(h.quantity or 0)
            for h in all_holdings if h.is_long_term
        )
        _lt_budget = _total_portfolio * _LONG_TERM_RATIO
        _lt_remaining = max(0.0, _lt_budget - _lt_deployed)
        lt_available = min(_lt_remaining, available_cash)

        logger.info(
            f"[장기매수] 총자산 {_total_portfolio:,.0f}원 | "
            f"장기예산 {_lt_budget:,.0f}원(30%) | "
            f"장기배포 {_lt_deployed:,.0f}원 | "
            f"잔여 {_lt_remaining:,.0f}원 | "
            f"가용 {lt_available:,.0f}원"
        )

        if lt_available < budget_per_pos * 0.5:
            logger.info(
                f"[장기매수] 장기 가용 예산 부족 ({lt_available:,.0f}원 < "
                f"최소 {budget_per_pos*0.5:,.0f}원) — 스킵"
            )
            return

        # 스크리닝
        candidates = await screen_value_stocks(exclude_codes=held_codes, max_candidates=10)
        if not candidates:
            logger.info("[장기매수] 스크리닝 통과 종목 없음")
            return

        bought = 0
        for cand in candidates:
            if bought >= slots:
                break

            code = cand["stock_code"]
            name = cand["stock_name"]

            try:
                price_info = await self.api.get_current_price(code)
                price = int(price_info.get("price", 0) or 0)
                resolved_name = price_info.get("name", "").strip() or name
            except Exception as e:
                logger.warning(f"[장기매수] {name} ({code}) 현재가 조회 실패: {e}")
                continue

            if price <= 0:
                continue

            qty = int(min(budget_per_pos, lt_available) // price)
            if qty <= 0:
                logger.info(f"[장기매수] {name} ({code}) — 예산 부족 (단가 {price:,}원, 가용 {lt_available:,.0f}원)")
                continue

            cost = qty * price
            log = await self._execute_order(
                stock_code=code,
                stock_name=resolved_name,
                action="BUY",
                quantity=qty,
                price=price,
                model_scores={"value_score": cand["value_score"]},
                news_sentiment=0.5,
                market_score=self._calc_market_score(),
                composite_score=cand["value_score"],
                trigger_models=["장기가치주"],
                is_long_term=True,
                use_market_order=True,
            )

            if log and log.status not in ("CANCELLED",):
                lt_available -= cost
                bought += 1
                msg = (
                    f"🌱 장기가치주 매수\n"
                    f"종목: {resolved_name} ({code})\n"
                    f"{qty}주 × {price:,}원 = {cost:,}원\n"
                    f"PER {cand['per']} | PBR {cand['pbr']} | 배당 {cand['div']}%\n"
                    f"가치점수: {cand['value_score']:.3f}"
                )
                await tg.send_message(msg, msg_type="buy")
                logger.info(f"[장기매수] {resolved_name} ({code}) {qty}주 × {price:,}원 [{log.status}]")
            else:
                err = (log.error_msg if log else "주문 실패")
                logger.warning(f"[장기매수] {name} ({code}) 주문 실패: {err}")

        if bought == 0:
            logger.info("[장기매수] 매수 완료된 종목 없음")
