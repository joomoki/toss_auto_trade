"""
자동매매 이력 및 현황 API
GET  /api/v1/auto-trade/logs         — 자동매매 이력 목록
GET  /api/v1/auto-trade/logs/today   — 오늘 실행 이력
GET  /api/v1/auto-trade/stats        — 요약 통계
POST /api/v1/auto-trade/run-now      — 즉시 사이클 실행 (테스트용)
GET  /api/v1/auto-trade/mode         — 현재 실전/모의 모드 조회
POST /api/v1/auto-trade/mode         — 실전/모의 모드 전환
"""
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models.news import AutoTradeLog

_ENV_PATH = Path(__file__).parents[3] / ".env"

router = APIRouter(prefix="/auto-trade", tags=["auto-trade"])


_COMMISSION_RATE = 0.00015   # 0.015% 편도 수수료
_TAX_RATE        = 0.0020    # 0.20% 증권거래세 (매도 시)


def _serialize(log: AutoTradeLog) -> dict:
    # 과거 레코드에 commission/tax가 없으면 order_amount 기준으로 추정
    _base = float(log.order_amount or 0)
    commission = (
        float(log.commission) if log.commission is not None
        else round(_base * _COMMISSION_RATE, 2)
    )
    tax = (
        float(log.tax) if log.tax is not None
        else (round(_base * _TAX_RATE, 2) if log.action == "SELL" else 0.0)
    )
    return {
        "id": log.id,
        "trade_date": str(log.trade_date),
        "stock_code": log.stock_code,
        "stock_name": log.stock_name,
        "action": log.action,
        "quantity": log.quantity,
        "order_price": log.order_price,
        "order_amount": log.order_amount,
        "filled_price": log.filled_price,
        "filled_amount": log.filled_amount,
        "model_scores": log.model_scores or {},
        "news_sentiment": float(log.news_sentiment) if log.news_sentiment is not None else None,
        "dart_score": float(log.dart_score) if log.dart_score is not None else None,
        "supply_score": float(log.supply_score) if log.supply_score is not None else None,
        "market_score": float(log.market_score) if log.market_score is not None else None,
        "composite_score": float(log.composite_score) if log.composite_score is not None else None,
        "trigger_models": log.trigger_models or [],
        "order_id": log.order_id,
        "status": log.status,
        "realized_pnl": float(log.realized_pnl) if log.realized_pnl is not None else None,
        "commission": commission,
        "tax": tax,
        "error_msg": log.error_msg,
        "created_at": log.created_at.isoformat() if log.created_at else None,
        "filled_at": log.filled_at.isoformat() if log.filled_at else None,
    }


@router.get("/logs")
async def get_logs(
    action: Optional[str] = Query(None, description="BUY / SELL"),
    status: Optional[str] = Query(None, description="PENDING / FILLED / MOCK / CANCELLED"),
    stock_code: Optional[str] = None,
    trade_date: Optional[str] = Query(None, description="특정 날짜 (YYYY-MM-DD), 지정 시 days 무시"),
    days: int = Query(7, ge=1, le=730),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    if trade_date:
        target = date.fromisoformat(trade_date)
        q = select(AutoTradeLog).where(AutoTradeLog.trade_date == target)
    else:
        cutoff = date.today() - timedelta(days=days)
        q = select(AutoTradeLog).where(AutoTradeLog.trade_date >= cutoff)
    if action:
        q = q.where(AutoTradeLog.action == action.upper())
    if status:
        q = q.where(AutoTradeLog.status == status.upper())
    if stock_code:
        q = q.where(AutoTradeLog.stock_code == stock_code)
    q = q.order_by(desc(AutoTradeLog.created_at)).limit(limit)
    result = await db.execute(q)
    logs = result.scalars().all()
    return {"logs": [_serialize(l) for l in logs], "total": len(logs)}


@router.get("/daily-summary")
async def get_daily_summary(
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """날짜별 매매 현황 집계 — 일별 현황 탭용.
    buy_amount / sell_amount 는 CANCELLED 제외 (PENDING·FILLED·MOCK) 건만 합산."""
    from sqlalchemy import func as _func, case as _case, and_ as _and
    _FILLED = AutoTradeLog.status != "CANCELLED"
    cutoff = date.today() - timedelta(days=days)
    result = await db.execute(
        select(
            AutoTradeLog.trade_date,
            _func.count(AutoTradeLog.id).label("total"),
            # 시도 건수 (취소 포함 전체)
            _func.sum(_case((AutoTradeLog.action == "BUY",  1), else_=0)).label("buy_count"),
            _func.sum(_case((AutoTradeLog.action == "SELL", 1), else_=0)).label("sell_count"),
            # 체결 금액 (FILLED/MOCK만)
            _func.sum(_case(
                (_and(AutoTradeLog.action == "BUY",  _FILLED), AutoTradeLog.order_amount), else_=0,
            )).label("buy_amount"),
            _func.sum(_case(
                (_and(AutoTradeLog.action == "SELL", _FILLED), AutoTradeLog.order_amount), else_=0,
            )).label("sell_amount"),
            # 체결 건수 (FILLED/MOCK만)
            _func.sum(_case((_and(AutoTradeLog.action == "BUY",  _FILLED), 1), else_=0)).label("buy_filled"),
            _func.sum(_case((_and(AutoTradeLog.action == "SELL", _FILLED), 1), else_=0)).label("sell_filled"),
            _func.sum(AutoTradeLog.realized_pnl).label("realized_pnl"),
            _func.sum(AutoTradeLog.commission).label("total_commission"),
            _func.sum(AutoTradeLog.tax).label("total_tax"),
        )
        .where(AutoTradeLog.trade_date >= cutoff)
        .group_by(AutoTradeLog.trade_date)
        .order_by(desc(AutoTradeLog.trade_date))
    )
    rows = result.all()
    return [
        {
            "date":             str(r.trade_date),
            "total":            r.total,
            "buy_count":        r.buy_count    or 0,
            "sell_count":       r.sell_count   or 0,
            "buy_filled":       r.buy_filled   or 0,
            "sell_filled":      r.sell_filled  or 0,
            "buy_amount":       int(r.buy_amount  or 0),
            "sell_amount":      int(r.sell_amount or 0),
            "realized_pnl":     float(r.realized_pnl or 0),
            "total_commission": float(r.total_commission or 0),
            "total_tax":        float(r.total_tax or 0),
        }
        for r in rows
    ]


@router.get("/logs/today")
async def get_today_logs(db: AsyncSession = Depends(get_db)):
    today = date.today()
    r = await db.execute(
        select(AutoTradeLog)
        .where(AutoTradeLog.trade_date == today)
        .order_by(desc(AutoTradeLog.created_at))
    )
    logs = r.scalars().all()

    buy_count  = sum(1 for l in logs if l.action == "BUY")
    sell_count = sum(1 for l in logs if l.action == "SELL")
    # PENDING = 키움 주문 접수 완료(실제 체결), FILLED/MOCK 포함
    _success = ("FILLED", "MOCK", "PENDING")
    filled_buy  = [l for l in logs if l.action == "BUY"  and l.status in _success]
    filled_sell = [l for l in logs if l.action == "SELL" and l.status in _success]
    total_buy_amt  = sum((l.filled_amount or l.order_amount or 0) for l in filled_buy)
    total_sell_amt = sum((l.filled_amount or l.order_amount or 0) for l in filled_sell)

    return {
        "date": str(today),
        "buy_count":          buy_count,
        "sell_count":         sell_count,
        "filled_buy_count":   len(filled_buy),
        "filled_sell_count":  len(filled_sell),
        "total_buy_amount":   total_buy_amt,
        "total_sell_amount":  total_sell_amt,
        "logs": [_serialize(l) for l in logs],
    }


@router.get("/stats")
async def get_stats(
    days: int = Query(30, ge=7, le=365),
    db: AsyncSession = Depends(get_db),
):
    cutoff = date.today() - timedelta(days=days)
    r = await db.execute(
        select(AutoTradeLog).where(AutoTradeLog.trade_date >= cutoff)
    )
    logs = r.scalars().all()

    filled = [l for l in logs if l.status in ("FILLED", "MOCK")]
    buy_logs  = [l for l in filled if l.action == "BUY"]
    sell_logs = [l for l in filled if l.action == "SELL"]

    total_realized = sum(float(l.realized_pnl or 0) for l in sell_logs)
    avg_composite  = (
        sum(float(l.composite_score or 0) for l in logs) / len(logs)
        if logs else 0
    )

    # 모델별 BUY 신호 카운트
    model_trigger_counts: dict[str, int] = {}
    for l in buy_logs:
        for m in (l.trigger_models or []):
            model_trigger_counts[m] = model_trigger_counts.get(m, 0) + 1

    # 종목별 거래 횟수
    stock_counts: dict[str, int] = {}
    for l in filled:
        stock_counts[l.stock_code] = stock_counts.get(l.stock_code, 0) + 1

    top_stocks = sorted(stock_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    return {
        "days": days,
        "total_orders": len(logs),
        "filled_orders": len(filled),
        "buy_orders": len(buy_logs),
        "sell_orders": len(sell_logs),
        "total_realized_pnl": round(total_realized, 2),
        "avg_composite_score": round(avg_composite, 4),
        "model_trigger_counts": model_trigger_counts,
        "top_traded_stocks": [{"stock_code": s, "count": c} for s, c in top_stocks],
    }


@router.get("/cycle-log")
async def get_cycle_log():
    """최근 자동매매 사이클 로그 반환 (최대 10사이클)"""
    from app.services.cycle_logger import get_cycles
    return {"cycles": get_cycles()}


@router.post("/run-now")
async def run_now(
    force: bool = Query(False, description="장 외 시간에도 종목 평가 강제 실행"),
    db: AsyncSession = Depends(get_db),
):
    """즉시 자동매매 사이클 실행 — 상세 결과 반환"""
    from app.services.auto_trade_engine import AutoTradeEngine
    engine = AutoTradeEngine(db)
    try:
        result = await engine.run(collect_result=True, force=force)
        await db.commit()
        return result or {"status": "completed", "message": "사이클 완료"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"실행 오류: {e}")


@router.get("/signal-preview")
async def signal_preview(
    model_ids: Optional[str] = Query(
        None, description="콤마 구분 모델 ID 필터, 예: M1,M3,M5 (미입력 시 전체)"
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    현재 시점 종목 종합 점수 미리보기
    model_ids 지정 시 해당 모델의 추천종목 + 워치리스트만 대상
    (주문 없이 점수만 계산 — 장 외에도 사용 가능)
    """
    from app.services.auto_trade_engine import AutoTradeEngine, W_MODEL, W_NEWS, W_DART, W_MARKET, W_SUPPLY

    engine = AutoTradeEngine(db)

    # 선택 모델 파싱
    parsed_models = [m.strip() for m in model_ids.split(",") if m.strip()] if model_ids else None

    # 후보 종목 수집 (섹터 스크리닝 BUY + 워치리스트)
    codes, name_map = await engine._collect_candidates()

    market_score = engine._calc_market_score()
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
        except Exception:
            pass

    previews.sort(key=lambda x: x["composite_score"], reverse=True)
    return {
        "market_score": market_score,
        "previews": previews,
        "filtered_models": parsed_models,
    }


@router.post("/report/send-now")
async def send_report_now(db: AsyncSession = Depends(get_db)):
    """현재 시장 기준 매수 후보 리포트를 텔레그램으로 즉시 전송"""
    from app.services.report_service import send_now_report
    try:
        data = await send_now_report(db)
        buy_count = sum(
            1 for p in data["previews"]
            if p.get("composite_score", 0) >= data["buy_threshold"]
            and p.get("final_signal") == "BUY"
        )
        return {
            "message": f"리포트 전송 완료 (매수 후보 {buy_count}종목 / 전체 {len(data['previews'])}종목 분석)",
            "market_score": data["market_score"],
            "buy_candidates": buy_count,
            "total_analyzed": len(data["previews"]),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"리포트 생성 실패: {e}")


@router.get("/model-performance")
async def get_model_performance(
    days: int = Query(30, ge=7, le=365),
    db: AsyncSession = Depends(get_db),
):
    """모델별 적중률 및 손익 분석 — 자동매매 체결 로그 기반"""
    from collections import defaultdict
    cutoff = date.today() - timedelta(days=days)

    buy_res = await db.execute(
        select(AutoTradeLog)
        .where(
            AutoTradeLog.action == "BUY",
            AutoTradeLog.trade_date >= cutoff,
            AutoTradeLog.status.in_(["FILLED", "MOCK"]),
        )
        .order_by(AutoTradeLog.created_at)
    )
    buy_logs = buy_res.scalars().all()

    sell_res = await db.execute(
        select(AutoTradeLog)
        .where(
            AutoTradeLog.action == "SELL",
            AutoTradeLog.trade_date >= cutoff,
            AutoTradeLog.status.in_(["FILLED", "MOCK"]),
            AutoTradeLog.realized_pnl.is_not(None),
        )
        .order_by(AutoTradeLog.created_at)
    )
    sell_logs = sell_res.scalars().all()

    # BUY를 stock_code별로 그룹화
    buy_by_stock: dict = defaultdict(list)
    for b in buy_logs:
        buy_by_stock[b.stock_code].append(b)

    # 모델별 통계 누적
    stats: dict = defaultdict(lambda: {"signals": 0, "wins": 0, "losses": 0, "total_pnl": 0.0})
    for b in buy_logs:
        for m in (b.trigger_models or []):
            stats[m]["signals"] += 1

    # SELL과 BUY 매칭 → 모델에 손익 귀속
    for sell in sell_logs:
        candidates = [
            b for b in buy_by_stock.get(sell.stock_code, [])
            if b.created_at and sell.created_at and b.created_at < sell.created_at
        ]
        if not candidates:
            continue
        matching_buy = max(candidates, key=lambda b: b.created_at)
        pnl = float(sell.realized_pnl or 0)
        key = "wins" if pnl >= 0 else "losses"
        for m in (matching_buy.trigger_models or []):
            stats[m][key] += 1
            stats[m]["total_pnl"] += pnl

    MODEL_IDS = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"]
    results = []
    for mid in MODEL_IDS:
        s = stats[mid]
        completed = s["wins"] + s["losses"]
        hit_rate = s["wins"] / completed if completed > 0 else None
        avg_pnl = s["total_pnl"] / completed if completed > 0 else None
        # 적중률 50% → 가중치 1.0 (중립), 80% → 1.6, 20% → 0.4
        suggested_weight = round(hit_rate * 2, 3) if hit_rate is not None else 1.0
        results.append({
            "model_id": mid,
            "signal_count": s["signals"],
            "completed_count": completed,
            "win_count": s["wins"],
            "loss_count": s["losses"],
            "pending_count": max(0, s["signals"] - completed),
            "hit_rate": round(hit_rate, 4) if hit_rate is not None else None,
            "total_pnl": round(s["total_pnl"], 2),
            "avg_pnl": round(avg_pnl, 2) if avg_pnl is not None else None,
            "suggested_weight": suggested_weight,
        })

    return {
        "days": days,
        "models": results,
        "total_signals": sum(r["signal_count"] for r in results),
        "total_completed": sum(r["completed_count"] for r in results),
    }


class TradeModeRequest(BaseModel):
    real_trade: bool


@router.get("/mode")
async def get_trade_mode():
    """현재 실전/모의 매매 모드 조회"""
    return {
        "real_trade": settings.auto_trade_enabled,
        "mode": "실전매매" if settings.auto_trade_enabled else "모의투자",
    }


@router.post("/mode")
async def set_trade_mode(body: TradeModeRequest):
    """실전/모의 매매 모드 전환 (런타임 즉시 적용 + .env 저장)"""
    from dotenv import set_key
    set_key(str(_ENV_PATH), "AUTO_TRADE_ENABLED", str(body.real_trade).lower())
    settings.auto_trade_enabled = body.real_trade
    return {
        "real_trade": settings.auto_trade_enabled,
        "mode": "실전매매" if settings.auto_trade_enabled else "모의투자",
        "message": f"{'실전매매' if body.real_trade else '모의투자'} 모드로 전환되었습니다.",
    }


class MaxStockPriceRequest(BaseModel):
    max_stock_price: int


@router.get("/price-limit")
async def get_price_limit():
    """종목 단가 상한 조회"""
    return {
        "max_stock_price": settings.max_stock_price,
        "label": f"{settings.max_stock_price:,}원" if settings.max_stock_price > 0 else "제한 없음",
    }


@router.post("/price-limit")
async def set_price_limit(body: MaxStockPriceRequest):
    """종목 단가 상한 설정 (런타임 즉시 적용 + .env 저장)"""
    from dotenv import set_key
    set_key(str(_ENV_PATH), "MAX_STOCK_PRICE", str(body.max_stock_price))
    settings.max_stock_price = body.max_stock_price
    label = f"{body.max_stock_price:,}원" if body.max_stock_price > 0 else "제한 없음"
    return {
        "max_stock_price": settings.max_stock_price,
        "label": label,
        "message": f"단가 상한이 {label}으로 설정되었습니다.",
    }


@router.get("/engine-log")
async def get_engine_log(lines: int = Query(200, ge=10, le=1000)):
    """자동매매 엔진 실행 로그 — 후보 종목 평가 이유 포함"""
    log_path = Path(__file__).parents[3] / "logs" / "auto_trade.log"
    if not log_path.exists():
        return {"lines": [], "total_lines": 0, "message": "아직 로그가 없습니다."}
    with open(log_path, encoding="utf-8") as f:
        all_lines = f.readlines()
    return {
        "lines": [l.rstrip() for l in all_lines[-lines:]],
        "total_lines": len(all_lines),
    }


@router.get("/engine-log/summary")
async def get_engine_log_summary():
    """오늘 엔진 로그 요약 — 사이클 수, 매수 시도, SKIP 이유, 에러"""
    import re
    from datetime import datetime, date as _date
    log_path = Path(__file__).parents[3] / "logs" / "auto_trade.log"
    if not log_path.exists():
        return {"cycles": 0, "bought": 0, "skipped": [], "errors": [], "last_run": None, "warnings": []}

    with open(log_path, encoding="utf-8") as f:
        all_lines = [l.rstrip() for l in f.readlines()]

    today = _date.today().strftime("%H:")   # 로그 포맷: HH:MM:SS
    # 오늘 날짜 구분이 없으므로 최근 500줄만 분석
    recent = all_lines[-500:]

    cycles      = sum(1 for l in recent if "▶ 사이클 시작" in l)
    bought      = sum(1 for l in recent if "💰 매수 시도" in l)
    errors      = [l for l in recent if ("ERROR" in l or "오류" in l or "실패" in l or "⛔" in l)]
    warnings    = [l for l in recent if "WARNING" in l or "SKIP" in l or "→ SKIP" in l]
    skip_lines  = [l for l in recent if "→ SKIP" in l]
    last_cycle  = next((l for l in reversed(recent) if "▶ 사이클 시작" in l), None)

    # SKIP 이유 집계
    skip_reasons: dict[str, int] = {}
    for l in skip_lines:
        m = re.search(r"SKIP:\s*(.+?)(\s*\(|$)", l)
        if m:
            reason = m.group(1).strip()
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1

    return {
        "cycles": cycles,
        "bought": bought,
        "errors": errors[-20:],
        "warnings": warnings[-20:],
        "skip_summary": [{"reason": k, "count": v} for k, v in sorted(skip_reasons.items(), key=lambda x: -x[1])],
        "last_cycle_line": last_cycle,
        "total_lines": len(all_lines),
    }


@router.post("/reconcile")
async def reconcile_orders(
    trade_date: Optional[str] = Query(None, description="검사 날짜 YYYY-MM-DD (기본: 오늘)"),
    db: AsyncSession = Depends(get_db),
):
    """PENDING 주문 정합성 검사.

    kt00004 실제 계좌보유 ↔ auto_trade_logs PENDING 레코드를 비교해
    실제로 체결되지 않은 주문을 CANCELLED로 정정하고 Holding도 제거합니다.

    BUY PENDING:
      - 종목이 kt00004 보유목록에 있음 → FILLED로 정정
      - 종목이 kt00004에 없음           → CANCELLED + Holding 삭제
    SELL PENDING:
      - 종목이 kt00004 보유목록에 없음   → FILLED로 정정 (실제 매도됨)
      - 종목이 kt00004에 있음            → CANCELLED (미체결)
    """
    import logging
    from datetime import datetime, timezone
    from app.models.holding import Holding
    from app.services.toss_api import TossApiClient

    log = logging.getLogger(__name__)
    check_date = date.fromisoformat(trade_date) if trade_date else date.today()

    api = TossApiClient.get_instance()

    # ── 1. 키움 실제 보유 종목 조회 (kt00004) ──────────────────────
    try:
        bal = await api.get_balance()
        held_codes: set[str] = {
            p["stock_code"] for p in bal.get("stockHoldings", []) if p.get("stock_code")
        }
        kt4_info: dict[str, dict] = {
            p["stock_code"]: p for p in bal.get("stockHoldings", []) if p.get("stock_code")
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"키움 잔고 조회 실패: {e}")

    # ── 2. 해당 날짜 PENDING 로그 ──────────────────────────────────
    pending_r = await db.execute(
        select(AutoTradeLog).where(
            AutoTradeLog.trade_date == check_date,
            AutoTradeLog.status == "PENDING",
        )
    )
    pending_logs = pending_r.scalars().all()

    if not pending_logs:
        return {
            "check_date": str(check_date),
            "held_codes": sorted(held_codes),
            "pending_count": 0,
            "changes": [],
            "cancelled": [],
            "filled": [],
            "ghost_removed": [],
            "message": f"{check_date} PENDING 주문 없음 — 정합성 이상 없음",
        }

    changes = []

    for log_entry in pending_logs:
        code = log_entry.stock_code
        name = log_entry.stock_name or code
        old_status = "PENDING"
        new_status: str
        reason: str

        if log_entry.action == "BUY":
            if code in held_codes:
                # 실제 보유 중 → 체결된 것으로 확정
                new_status = "FILLED"
                reason = "kt00004 보유 확인 → 체결 정정"
                kt4 = kt4_info.get(code, {})
                log_entry.status       = "FILLED"
                log_entry.filled_at    = datetime.now(timezone.utc)
                log_entry.filled_price = int(kt4.get("current_price") or log_entry.order_price)
                log_entry.filled_amount = log_entry.quantity * log_entry.filled_price
                # Holding upsert (없으면 생성 — PENDING에서 Holding 미생성 케이스 포함)
                h_r = await db.execute(select(Holding).where(Holding.stock_code == code))
                h = h_r.scalar_one_or_none()
                avg_p = float(kt4.get("avg_price") or log_entry.order_price)
                cur_p = float(kt4.get("current_price") or log_entry.order_price)
                if h:
                    h.avg_buy_price  = avg_p
                    h.current_price  = cur_p
                    log.info(f"[정합성] Holding 단가 보정: {name}({code}) avg={avg_p:,.0f}")
                else:
                    from app.models.holding import Holding as _Holding
                    new_h = _Holding(
                        stock_code=code,
                        stock_name=name,
                        quantity=log_entry.quantity,
                        avg_buy_price=avg_p,
                        current_price=cur_p,
                    )
                    db.add(new_h)
                    log.info(f"[정합성] Holding 신규 생성: {name}({code}) {log_entry.quantity}주")
            else:
                # 실제 미보유 → 미체결(취소)
                new_status = "CANCELLED"
                reason = "kt00004 미보유 → 미체결 정정"
                log_entry.status    = "CANCELLED"
                log_entry.error_msg = (log_entry.error_msg or "") + " [정합성검사: kt00004 미보유]"
                # Holding 에서도 제거
                h_r = await db.execute(select(Holding).where(Holding.stock_code == code))
                h = h_r.scalar_one_or_none()
                if h:
                    await db.delete(h)
                    log.info(f"[정합성] Holding 제거: {name}({code})")

        elif log_entry.action == "SELL":
            if code not in held_codes:
                # 실제 미보유 → 매도 체결된 것으로 확정
                new_status = "FILLED"
                reason = "kt00004 미보유 → 매도 체결 정정"
                log_entry.status    = "FILLED"
                log_entry.filled_at = datetime.now(timezone.utc)
            else:
                # 아직 보유 중 → 매도 미체결
                new_status = "CANCELLED"
                reason = "kt00004 보유 중 → 매도 미체결 정정"
                log_entry.status    = "CANCELLED"
                log_entry.error_msg = (log_entry.error_msg or "") + " [정합성검사: kt00004 보유중]"
        else:
            continue

        changes.append({
            "log_id":     log_entry.id,
            "stock_code": code,
            "stock_name": name,
            "action":     log_entry.action,
            "order_price": log_entry.order_price,
            "old_status": old_status,
            "new_status": new_status,
            "reason":     reason,
        })
        log.info(f"[정합성] {name}({code}) {log_entry.action}: {old_status} → {new_status} ({reason})")

    await db.commit()

    # ── 2단계: DB Holding 전수 비교 — 실제 잔고에 없는 유령 종목 정리 ──────
    # PENDING 로그 날짜와 무관하게, 현재 DB에 남아있는 모든 Holding을
    # Kiwoom 실제 보유 종목과 비교해 불일치 항목 삭제
    ghost_removed: list[dict] = []
    all_holdings_r = await db.execute(select(Holding))
    all_db_holdings = all_holdings_r.scalars().all()
    for h in all_db_holdings:
        if h.stock_code not in held_codes:
            ghost_removed.append({
                "stock_code": h.stock_code,
                "stock_name": h.stock_name or h.stock_code,
                "quantity":   int(h.quantity),
                "avg_price":  float(h.avg_buy_price),
                "reason":     "kt00004 미보유 → 유령 Holding 삭제",
            })
            await db.delete(h)
            log.warning(f"[정합성] 유령 Holding 삭제: {h.stock_name}({h.stock_code}) {h.quantity}주")

    await db.commit()

    cancelled = [c for c in changes if c["new_status"] == "CANCELLED"]
    filled    = [c for c in changes if c["new_status"] == "FILLED"]

    # ── 정합성 검사 후 체결 확정된 BUY 건 → 텔레그램 알림 ──────────
    # (엔진이 PENDING 상태로 두고 알림을 보내지 않은 건들을 여기서 최종 알림)
    from app.services import telegram_notifier as _tg
    filled_ids = {ch["log_id"] for ch in filled if ch["action"] == "BUY"}
    if filled_ids:
        filled_logs_r = await db.execute(
            select(AutoTradeLog).where(AutoTradeLog.id.in_(filled_ids))
        )
        for fl in filled_logs_r.scalars().all():
            try:
                await _tg.notify_buy(
                    stock_name=fl.stock_name or fl.stock_code,
                    stock_code=fl.stock_code,
                    quantity=fl.quantity,
                    price=int(fl.filled_price or fl.order_price),
                    composite_score=float(fl.composite_score or 0),
                    trigger_models=(fl.trigger_models or []) + ["✅ 정합성검사 체결확인"],
                    is_mock=False,
                )
            except Exception:
                pass

    # 유령 Holding에 대해 텔레그램 알림
    if ghost_removed:
        try:
            ghost_names = ", ".join(f"{g['stock_name']}({g['stock_code']})" for g in ghost_removed)
            await _tg.send_message(
                f"🧹 정합성 검사 — 유령 보유 종목 {len(ghost_removed)}건 삭제\n{ghost_names}",
                msg_type="warn",
            )
        except Exception:
            pass

    total_issues = len(changes) + len(ghost_removed)
    return {
        "check_date":       str(check_date),
        "held_codes":       sorted(held_codes),
        "pending_count":    len(pending_logs),
        "changes":          changes,
        "cancelled":        cancelled,
        "filled":           filled,
        "ghost_removed":    ghost_removed,
        "message": (
            f"정합성 검사 완료: "
            f"미체결 정정 {len(cancelled)}건 / 체결 확정 {len(filled)}건 / "
            f"유령 종목 삭제 {len(ghost_removed)}건"
            if total_issues else "정합성 이상 없음"
        ),
    }


@router.get("/traded-stocks")
async def get_traded_stocks(db: AsyncSession = Depends(get_db)):
    """거래 이력이 있는 종목 목록 + 기본 통계 (종목 필터 드롭다운용)"""
    from sqlalchemy import func as _func, case as _case
    result = await db.execute(
        select(
            AutoTradeLog.stock_code,
            AutoTradeLog.stock_name,
            _func.count(AutoTradeLog.id).label("total"),
            _func.sum(_case((AutoTradeLog.action == "BUY",  1), else_=0)).label("buy_count"),
            _func.sum(_case((AutoTradeLog.action == "SELL", 1), else_=0)).label("sell_count"),
            _func.sum(
                _case((AutoTradeLog.action == "BUY", AutoTradeLog.filled_amount), else_=0)
            ).label("buy_amount"),
            _func.sum(AutoTradeLog.realized_pnl).label("total_pnl"),
        )
        .where(AutoTradeLog.status.in_(["FILLED", "MOCK", "PENDING"]))
        .group_by(AutoTradeLog.stock_code, AutoTradeLog.stock_name)
        .order_by(_func.count(AutoTradeLog.id).desc())
    )
    rows = result.all()
    return [
        {
            "stock_code":  r.stock_code,
            "stock_name":  r.stock_name or r.stock_code,
            "total":       r.total,
            "buy_count":   r.buy_count  or 0,
            "sell_count":  r.sell_count or 0,
            "buy_amount":  int(r.buy_amount  or 0),
            "total_pnl":   float(r.total_pnl or 0),
        }
        for r in rows
    ]


@router.get("/market-status")
async def get_market_status():
    """현재 코스피/코스닥 지수 및 보수적 매매 모드 상태 반환"""
    from app.services.supply_demand_service import get_market_index
    idx = await get_market_index()

    kospi_chg = float(idx.get("kospi_change_pct", 0))
    available  = bool(idx.get("available", False))

    if available and kospi_chg < -3.0:
        mode = "DEFENSIVE"
    elif available and kospi_chg < -2.0:
        mode = "CONSERVATIVE"
    elif available and kospi_chg < -1.0:
        mode = "CAUTIOUS"
    else:
        mode = "NORMAL"

    _MODE_KR = {"NORMAL": "정상", "CAUTIOUS": "경계", "CONSERVATIVE": "수비", "DEFENSIVE": "전면수비"}
    _MODE_DESC = {
        "NORMAL":       "정상 매매 중",
        "CAUTIOUS":     f"코스피 {kospi_chg:+.2f}% — 임계값 +5점, 예산 80%",
        "CONSERVATIVE": f"코스피 {kospi_chg:+.2f}% — 임계값 +10점, 예산 60%",
        "DEFENSIVE":    f"코스피 {kospi_chg:+.2f}% — 신규 매수 전면 차단",
    }

    return {
        "kospi":             idx.get("kospi", 0),
        "kospi_change_pct":  round(kospi_chg, 4),
        "kosdaq":            idx.get("kosdaq", 0),
        "kosdaq_change_pct": round(float(idx.get("kosdaq_change_pct", 0)), 4),
        "mode":              mode,
        "mode_kr":           _MODE_KR[mode],
        "mode_desc":         _MODE_DESC[mode],
        "available":         available,
    }
