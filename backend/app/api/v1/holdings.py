from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as _sqlfunc
import asyncio
from datetime import datetime, timezone

from app.core.database import get_db
from app.models.holding import Holding
from app.models.news import AutoTradeLog
from app.services.toss_api import TossApiClient


async def _was_auto_bought(db: AsyncSession, stock_code: str) -> bool:
    """auto_trade_logs에 BUY 체결 기록이 있으면 자동매매 종목으로 판단."""
    r = await db.execute(
        select(_sqlfunc.count()).select_from(AutoTradeLog)
        .where(
            AutoTradeLog.stock_code == stock_code,
            AutoTradeLog.action == "BUY",
            AutoTradeLog.status.in_(["FILLED", "MOCK", "PENDING"]),
        )
    )
    return int(r.scalar() or 0) > 0

router = APIRouter(prefix="/holdings", tags=["holdings"])


def _flt(s) -> float:
    """키움 API 문자열(+1,234.5 / -678) → float 변환"""
    try:
        return float(str(s).replace(",", "").replace("+", "").replace("%", ""))
    except Exception:
        return 0.0


def _parse_kiwoom_pos(pos: dict) -> dict | None:
    """kt00005 체결잔고 항목 → 정규화된 dict.
    평가손익·수익율은 키움 제공값(수수료·거래세 포함) 우선 사용."""
    code = pos.get("stk_cd") or pos.get("stock_code") or pos.get("symbol", "")
    if not code:
        return None

    name       = pos.get("stk_nm") or pos.get("stock_name") or ""
    qty        = int(_flt(pos.get("rmn_qty") or pos.get("quantity") or 0))
    avg_price  = _flt(pos.get("pchs_avg_prc") or pos.get("avg_buy_price") or 0)
    cur_price  = _flt(pos.get("prpr") or pos.get("current_price") or avg_price)

    # 키움이 수수료·거래세 반영한 평가손익을 내려주면 그대로 사용
    raw_pnl = pos.get("evlu_pfls_amt") or pos.get("evlu_pl_amt")
    raw_pct = pos.get("evlu_erng_rt")  or pos.get("evlu_profit_rt")

    pnl = _flt(raw_pnl) if raw_pnl is not None else (cur_price - avg_price) * qty
    pnl_pct = (
        _flt(raw_pct)
        if raw_pct is not None
        else ((cur_price - avg_price) / avg_price * 100 if avg_price > 0 else 0.0)
    )

    return {
        "code": code, "name": name, "qty": qty,
        "avg_price": avg_price, "cur_price": cur_price,
        "pnl": pnl, "pnl_pct": pnl_pct,
    }


def _holding_to_dict(h: Holding) -> dict:
    return {
        "id": h.id,
        "stock_code": h.stock_code,
        "stock_name": h.stock_name,
        "quantity": h.quantity,
        "avg_buy_price": float(h.avg_buy_price),
        "current_price": float(h.current_price) if h.current_price else None,
        "unrealized_pnl": float(h.unrealized_pnl) if h.unrealized_pnl else None,
        "unrealized_pnl_pct": float(h.unrealized_pnl_pct) if h.unrealized_pnl_pct else None,
        "is_manual": bool(h.is_manual),
        "is_long_term": bool(h.is_long_term),
        "updated_at": h.updated_at.isoformat() if h.updated_at else None,
    }


@router.get("")
async def get_holdings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Holding).order_by(Holding.stock_code))
    holdings = result.scalars().all()
    return [_holding_to_dict(h) for h in holdings]


@router.patch("/{stock_code}/toggle-manual")
async def toggle_manual(stock_code: str, db: AsyncSession = Depends(get_db)):
    """수동/자동 구분 토글. 없으면 404."""
    from fastapi import HTTPException
    r = await db.execute(select(Holding).where(Holding.stock_code == stock_code))
    h = r.scalar_one_or_none()
    if not h:
        raise HTTPException(status_code=404, detail=f"보유 종목 없음: {stock_code}")
    new_val = not bool(h.is_manual)
    h.is_manual = new_val
    await db.flush()
    await db.refresh(h)
    return _holding_to_dict(h)


@router.patch("/{stock_code}/long-term")
async def toggle_long_term(stock_code: str, db: AsyncSession = Depends(get_db)):
    """장기 보유 여부 토글. 없으면 404."""
    from fastapi import HTTPException
    r = await db.execute(select(Holding).where(Holding.stock_code == stock_code))
    h = r.scalar_one_or_none()
    if not h:
        raise HTTPException(status_code=404, detail=f"보유 종목 없음: {stock_code}")
    h.is_long_term = not bool(h.is_long_term)
    await db.flush()
    await db.refresh(h)
    return _holding_to_dict(h)


@router.get("/balance")
async def get_balance(db: AsyncSession = Depends(get_db)):
    """잔고(kt00004) + 체결잔고(kt00005) 병렬 조회 — 현재가·수익률 포함.
    08:00~16:00 KST 외에는 캐시 잔고 + DB 보유종목을 그대로 반환 (kiwoom_available=false)."""
    from datetime import datetime, timezone
    from fastapi import HTTPException
    from app.services.kiwoom_api import is_account_tr_available
    api = TossApiClient.get_instance()

    kiwoom_available = is_account_tr_available()

    # ── 비가용 시간: 캐시 잔고 + DB holdings 반환 ────────────────────
    if not kiwoom_available:
        bal = await api.get_balance()   # 내부적으로 스냅샷 반환 (API 미호출)
        r = await db.execute(select(Holding).order_by(Holding.stock_code))
        holdings_out = [_holding_to_dict(h) for h in r.scalars().all()]
        return {
            "cash":             bal.get("cash", 0),
            "available_cash":   bal.get("availableCash", 0),
            "total_asset":      bal.get("totalAsset", 0),
            "total_buy_amount": bal.get("totalBuyAmount", 0),
            "total_pnl":        bal.get("totalPnl", 0),
            "total_pnl_rate":   bal.get("totalPnlRate", 0.0),
            "account_name":     bal.get("accountName", ""),
            "synced_at":        datetime.now(timezone.utc).isoformat(),
            "kiwoom_available": False,
            "holdings":         holdings_out,
        }

    # ── 가용 시간: 키움 API 실시간 조회 ──────────────────────────────
    bal_result, pos_result = await asyncio.gather(
        api.get_balance(),
        api.get_holdings(),
        return_exceptions=True,
    )

    if isinstance(bal_result, Exception):
        raise HTTPException(status_code=502, detail=f"잔고 조회 실패: {bal_result}")

    bal = bal_result
    holdings_out = []

    # kt00004 stk_acnt_evlt_prst: 현재가·손익 (kt00005보다 정확)
    kt4_pos_map: dict[str, dict] = {
        p["stock_code"]: p
        for p in bal.get("stockHoldings", [])
    }

    # kt00005 평균단가·수량 동기화 후 kt00004 데이터로 현재가·손익 보완
    if isinstance(pos_result, list):
        for pos in pos_result:
            p = _parse_kiwoom_pos(pos)
            if not p:
                continue
            r = await db.execute(select(Holding).where(Holding.stock_code == p["code"]))
            holding = r.scalar_one_or_none()
            if holding:
                holding.avg_buy_price = p["avg_price"]
                # kt00004에 현재가·손익이 있으면 그것을 우선 사용
                kt4 = kt4_pos_map.get(p["code"], {})
                holding.current_price      = kt4.get("current_price") or p["cur_price"] or holding.current_price
                holding.unrealized_pnl     = kt4.get("pnl") or p["pnl"] or holding.unrealized_pnl
                holding.unrealized_pnl_pct = kt4.get("pnl_pct") or p["pnl_pct"] or holding.unrealized_pnl_pct

    # kt00005에 없지만 kt00004에 있는 종목도 DB 업데이트
    for code, kt4 in kt4_pos_map.items():
        r = await db.execute(select(Holding).where(Holding.stock_code == code))
        holding = r.scalar_one_or_none()
        if holding and kt4.get("current_price"):
            holding.current_price      = kt4["current_price"]
            if kt4.get("pnl") is not None:
                holding.unrealized_pnl     = kt4["pnl"]
            if kt4.get("pnl_pct") is not None:
                holding.unrealized_pnl_pct = kt4["pnl_pct"]
            if kt4.get("avg_price"):
                holding.avg_buy_price = kt4["avg_price"]

    await db.commit()
    r2 = await db.execute(select(Holding).order_by(Holding.stock_code))
    holdings_out = [_holding_to_dict(h) for h in r2.scalars().all()]

    return {
        "cash":             bal.get("cash", 0),
        "available_cash":   bal.get("availableCash", 0),
        "total_asset":      bal.get("totalAsset", 0),
        "total_buy_amount": bal.get("totalBuyAmount", 0),
        "total_pnl":        bal.get("totalPnl", 0),
        "total_pnl_rate":   bal.get("totalPnlRate", 0.0),
        "account_name":     bal.get("accountName", ""),
        "synced_at":        datetime.now(timezone.utc).isoformat(),
        "kiwoom_available": True,
        "holdings":         holdings_out,
    }


@router.get("/balance/raw")
async def get_balance_raw():
    """키움 kt00004 원본 응답 확인 (필드명 디버그용)"""
    api = TossApiClient.get_instance()
    try:
        bal = await api.get_balance()
        return {
            "parsed": {
                "cash":             bal.get("cash", 0),
                "available_cash":   bal.get("availableCash", 0),
                "total_asset":      bal.get("totalAsset", 0),
                "total_pnl":        bal.get("totalPnl", 0),
                "account_name":     bal.get("accountName", ""),
            },
            "raw_fields": bal.get("_raw", {}),
        }
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/refresh")
async def refresh_holdings(db: AsyncSession = Depends(get_db)):
    """키움증권 체결잔고(kt00005)를 조회해 holdings 테이블 동기화"""
    api = TossApiClient.get_instance()
    try:
        positions = await api.get_holdings()   # kt00005 stk_cntr_remn
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail=f"키움 API 오류: {e}")

    for pos in positions:
        p = _parse_kiwoom_pos(pos)
        if not p:
            continue
        name = pos.get("stk_nm") or pos.get("stock_name") or ""

        result = await db.execute(select(Holding).where(Holding.stock_code == p["code"]))
        holding = result.scalar_one_or_none()

        if p["qty"] <= 0:
            if holding:
                await db.delete(holding)
            continue

        if holding:
            holding.quantity          = p["qty"]
            holding.avg_buy_price     = p["avg_price"]
            holding.current_price     = p["cur_price"]
            holding.unrealized_pnl    = p["pnl"]
            holding.unrealized_pnl_pct = p["pnl_pct"]
            if holding.is_manual:
                auto_bought = await _was_auto_bought(db, p["code"])
                if auto_bought:
                    holding.is_manual = False
        else:
            auto_bought = await _was_auto_bought(db, p["code"])
            db.add(Holding(
                stock_code=p["code"], stock_name=name,
                quantity=p["qty"], avg_buy_price=p["avg_price"],
                current_price=p["cur_price"],
                unrealized_pnl=p["pnl"], unrealized_pnl_pct=p["pnl_pct"],
                is_manual=not auto_bought,
            ))

    await db.commit()
    result = await db.execute(select(Holding).order_by(Holding.stock_code))
    return [_holding_to_dict(h) for h in result.scalars().all()]


@router.post("/sync")
async def sync_holdings_with_kiwoom(db: AsyncSession = Depends(get_db)):
    """키움 실제 계좌와 DB 완전 동기화.
    - kt00004(계좌평가) + kt00005(체결잔고) 두 소스를 합산해 실제 보유 종목 판단
    - 두 소스 모두에 없는 DB 종목 → 삭제 (미체결·허위 보유)
    - 안전장치: 두 API가 모두 0종목 반환 시 삭제 거부
    반환: {removed, updated, added, holdings}"""
    from fastapi import HTTPException
    import logging
    log = logging.getLogger(__name__)

    api = TossApiClient.get_instance()

    # ── kt00004 계좌평가현황 (가장 신뢰도 높음) ──────────────────────
    kt4_map: dict[str, dict] = {}
    try:
        bal = await api.get_balance()
        for p in bal.get("stockHoldings", []):
            code = p.get("stock_code", "")
            if code:
                kt4_map[code] = p
    except Exception as e:
        log.warning(f"[계좌동기화] kt00004 조회 실패: {e}")

    # ── kt00005 체결잔고 ──────────────────────────────────────────────
    kt5_map: dict[str, dict] = {}
    try:
        positions = await api.get_holdings()
        for pos in positions:
            p = _parse_kiwoom_pos(pos)
            if p and p["qty"] > 0:
                p["name_raw"] = pos.get("stk_nm") or pos.get("stock_name") or ""
                kt5_map[p["code"]] = p
    except Exception as e:
        log.warning(f"[계좌동기화] kt00005 조회 실패: {e}")

    # ── 실제 보유 = kt00004 ∪ kt00005 ────────────────────────────────
    actually_held: set[str] = set(kt4_map.keys()) | set(kt5_map.keys())

    # DB 현재 holdings 조회
    db_result = await db.execute(select(Holding))
    db_holdings = {h.stock_code: h for h in db_result.scalars().all()}

    # ── 안전장치 ─────────────────────────────────────────────────────
    # (1) 두 소스 모두 0종목 반환 → 삭제 거부
    if len(actually_held) == 0 and len(db_holdings) > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"키움 API 두 소스 모두 0종목 반환 — DB 종목({len(db_holdings)}개) 삭제를 거부했습니다. "
                "API 연결 상태를 확인하세요."
            ),
        )
    # (2) API 응답이 DB의 50% 미만이면 부분 응답(네트워크 오류 등)으로 판단 → 삭제 거부
    if len(db_holdings) >= 2 and len(actually_held) < len(db_holdings) * 0.5:
        raise HTTPException(
            status_code=409,
            detail=(
                f"키움 API 응답({len(actually_held)}종목)이 DB({len(db_holdings)}종목)의 50% 미만 — "
                "부분 응답 의심, 삭제를 거부했습니다. 잠시 후 다시 시도하세요."
            ),
        )

    removed, updated, added = [], [], []

    # ── 1) DB에 있지만 키움 두 소스 모두에 없는 종목 → 삭제 ─────────
    for code, holding in db_holdings.items():
        if code not in actually_held:
            log.info(f"[계좌동기화] 삭제: {holding.stock_name}({code}) — kt00004·kt00005 모두 미보유")
            removed.append({"stock_code": code, "stock_name": holding.stock_name})
            await db.delete(holding)

    # ── 2) 실제 보유 종목 → 업데이트 또는 추가 ──────────────────────
    for code in actually_held:
        kt4 = kt4_map.get(code, {})
        kt5 = kt5_map.get(code, {})

        # 수량: kt00005 우선 (체결잔고), 없으면 kt00004
        qty       = kt5.get("qty") or int(kt4.get("quantity") or 1)
        avg_price = kt5.get("avg_price") or float(kt4.get("avg_price") or kt4.get("avg_buy_price") or 0)
        cur_price = float(kt4.get("current_price") or kt5.get("cur_price") or avg_price)
        pnl       = float(kt4.get("pnl") or kt5.get("pnl") or 0)
        pnl_pct   = float(kt4.get("pnl_pct") or kt5.get("pnl_pct") or 0)
        name      = (kt4.get("stock_name") or kt5.get("name_raw") or code)

        holding = db_holdings.get(code)
        if holding:
            holding.quantity           = qty
            holding.avg_buy_price      = avg_price or holding.avg_buy_price
            holding.current_price      = cur_price or holding.current_price
            holding.unrealized_pnl     = pnl
            holding.unrealized_pnl_pct = pnl_pct
            if name and name != code:
                holding.stock_name = name
            # is_manual=True로 잘못 설정된 경우 auto_trade_logs로 재평가해 교정
            if holding.is_manual:
                auto_bought = await _was_auto_bought(db, code)
                if auto_bought:
                    holding.is_manual = False
                    log.info(f"[계좌동기화] is_manual 교정: {name}({code}) — auto_trade_logs 기록 확인")
            updated.append(code)
            log.info(f"[계좌동기화] 업데이트: {name}({code}) {qty}주")
        else:
            auto_bought = await _was_auto_bought(db, code)
            is_manual_flag = not auto_bought
            db.add(Holding(
                stock_code=code, stock_name=name or code,
                quantity=qty, avg_buy_price=avg_price,
                current_price=cur_price,
                unrealized_pnl=pnl, unrealized_pnl_pct=pnl_pct,
                is_manual=is_manual_flag,
            ))
            added.append({"stock_code": code, "stock_name": name, "is_manual": is_manual_flag})
            kind = "수동" if is_manual_flag else "자동"
            log.info(f"[계좌동기화] 추가({kind}): {name}({code}) {qty}주")

    await db.commit()

    final_r = await db.execute(select(Holding).order_by(Holding.stock_code))
    final_holdings = [_holding_to_dict(h) for h in final_r.scalars().all()]

    log.info(
        f"[계좌동기화] 완료 — 삭제 {len(removed)}개 / 업데이트 {len(updated)}개 / 추가 {len(added)}개"
    )
    return {
        "removed": removed,
        "updated": updated,
        "added":   added,
        "holdings": final_holdings,
    }


@router.get("/pending-buys")
async def get_pending_buys(db: AsyncSession = Depends(get_db)):
    """오늘 미체결(PENDING) 매수 주문 목록.
    체결 완료(FILLED) 종목은 제외, 현재 대기 중인 주문만 반환."""
    from sqlalchemy import text
    today = datetime.now(timezone.utc).date()

    # 오늘 PENDING 매수 (stock_code별 가장 최근 레코드)
    result = await db.execute(
        select(
            AutoTradeLog.stock_code,
            AutoTradeLog.stock_name,
            AutoTradeLog.order_price,
            AutoTradeLog.quantity,
            AutoTradeLog.order_amount,
            AutoTradeLog.created_at,
        )
        .where(
            AutoTradeLog.trade_date == today,
            AutoTradeLog.action == "BUY",
            AutoTradeLog.status == "PENDING",
        )
        .order_by(AutoTradeLog.created_at)
    )
    rows = result.all()

    # 이미 체결된(FILLED) 종목은 제거
    filled_result = await db.execute(
        select(AutoTradeLog.stock_code)
        .where(
            AutoTradeLog.trade_date == today,
            AutoTradeLog.action == "BUY",
            AutoTradeLog.status == "FILLED",
        )
        .distinct()
    )
    filled_codes = {r[0] for r in filled_result.all()}

    # holdings 테이블에 이미 존재하는 종목도 제거 (로그 미업데이트 케이스 대응)
    held_result = await db.execute(select(Holding.stock_code).distinct())
    held_codes = {r[0] for r in held_result.all()}

    now_utc = datetime.now(timezone.utc)
    pending = []
    seen: set[str] = set()
    for row in rows:
        code = row.stock_code
        if code in filled_codes or code in held_codes or code in seen:
            continue
        seen.add(code)
        created = row.created_at
        if created and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        wait_min = int((now_utc - created).total_seconds() // 60) if created else 0
        pending.append({
            "stock_code":   code,
            "stock_name":   row.stock_name or code,
            "order_price":  row.order_price,
            "quantity":     row.quantity,
            "order_amount": row.order_amount,
            "ordered_at":   row.created_at.isoformat() if row.created_at else None,
            "wait_minutes": wait_min,
        })

    return pending
