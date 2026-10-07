"""
텔레그램 명령어 수신·실행 서비스

지원 명령어 (텔레그램 또는 웹 UI에서 입력):
  /buy  [종목코드/종목명] [수량]   — 시장가 매수
  /sell [종목코드/종목명] [수량]   — 시장가 매도
  /sellall [종목코드/종목명]        — 전량 매도 (보유 수량 전부)
  /holdings                         — 보유 종목 조회
  /status                           — 현황 (포트폴리오)
  /help                             — 도움말

보안: TELEGRAM_CHAT_ID 와 일치하는 chat_id 에서 온 메시지만 처리.
폴링: scheduler 에서 30초마다 getUpdates 호출.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings

log = logging.getLogger(__name__)

# update_id 영속화 파일 — 서버 재시작 시 과거 명령 재실행 방지
_UPDATE_ID_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "logs", "tg_update_id.txt")


def _load_last_update_id() -> int:
    try:
        with open(_UPDATE_ID_FILE) as f:
            return int(f.read().strip())
    except Exception:
        return 0


def _save_last_update_id(uid: int) -> None:
    try:
        os.makedirs(os.path.dirname(_UPDATE_ID_FILE), exist_ok=True)
        with open(_UPDATE_ID_FILE, "w") as f:
            f.write(str(uid))
    except Exception:
        pass


# 서버 시작 시 파일에서 복원
_last_update_id: int = _load_last_update_id()

HELP_TEXT = (
    "📋 <b>명령어 목록</b>\n"
    "━━━━━━━━━━━━━━\n"
    "/buy [종목] [수량]\n"
    "  예) /buy 삼성전자 5\n"
    "  예) /buy 005930 3\n\n"
    "/sell [종목] [수량]\n"
    "  예) /sell 카카오 2\n\n"
    "/sellall [종목]\n"
    "  예) /sellall 미래에셋증권\n"
    "  (보유 수량 전량 시장가 매도)\n\n"
    "/holdings — 보유 종목 조회\n"
    "/status   — 포트폴리오 현황\n"
    "/help     — 이 도움말\n"
    "━━━━━━━━━━━━━━\n"
    "⚠️ 실전 모드에서는 즉시 키움 주문이 접수됩니다."
)


# ── 파싱 ──────────────────────────────────────────────────────────

def parse_command(text: str) -> dict:
    """텍스트를 파싱해 명령 딕셔너리 반환.
    {command_type, stock_query, quantity, error}
    """
    text = text.strip()
    if not text.startswith("/"):
        return {"command_type": "unknown", "stock_query": None, "quantity": None, "error": "명령어는 /로 시작해야 합니다"}

    parts = text.split()
    cmd = parts[0].lower().split("@")[0]  # /buy@botname → /buy

    if cmd == "/help":
        return {"command_type": "help", "stock_query": None, "quantity": None, "error": None}
    if cmd in ("/holdings", "/보유"):
        return {"command_type": "holdings", "stock_query": None, "quantity": None, "error": None}
    if cmd in ("/status", "/현황"):
        return {"command_type": "status", "stock_query": None, "quantity": None, "error": None}

    if cmd in ("/buy", "/매수"):
        if len(parts) < 3:
            return {"command_type": "buy", "stock_query": None, "quantity": None,
                    "error": "사용법: /buy [종목코드/종목명] [수량]"}
        qty_str = parts[-1]
        stock_query = " ".join(parts[1:-1])
        if not qty_str.isdigit() or int(qty_str) <= 0:
            return {"command_type": "buy", "stock_query": stock_query, "quantity": None,
                    "error": f"수량이 올바르지 않습니다: {qty_str}"}
        return {"command_type": "buy", "stock_query": stock_query, "quantity": int(qty_str), "error": None}

    if cmd in ("/sell", "/매도"):
        if len(parts) < 3:
            return {"command_type": "sell", "stock_query": None, "quantity": None,
                    "error": "사용법: /sell [종목코드/종목명] [수량]"}
        qty_str = parts[-1]
        stock_query = " ".join(parts[1:-1])
        if not qty_str.isdigit() or int(qty_str) <= 0:
            return {"command_type": "sell", "stock_query": stock_query, "quantity": None,
                    "error": f"수량이 올바르지 않습니다: {qty_str}"}
        return {"command_type": "sell", "stock_query": stock_query, "quantity": int(qty_str), "error": None}

    if cmd in ("/sellall", "/전량매도"):
        if len(parts) < 2:
            return {"command_type": "sellall", "stock_query": None, "quantity": None,
                    "error": "사용법: /sellall [종목코드/종목명]"}
        stock_query = " ".join(parts[1:])
        return {"command_type": "sellall", "stock_query": stock_query, "quantity": None, "error": None}

    return {"command_type": "unknown", "stock_query": None, "quantity": None,
            "error": f"알 수 없는 명령어: {parts[0]}  (/help 로 도움말 확인)"}


# ── 종목 조회 ─────────────────────────────────────────────────────

_AMBIGUOUS_SENTINEL = "__AMBIGUOUS__"


async def _resolve_stock(
    query: str, db: AsyncSession
) -> Optional[tuple[str, str, str]] | str:
    """종목 코드 또는 이름으로 (code, name, market) 반환.
    없으면 None. 이름이 모호하면 후보 목록 문자열 반환.
    """
    from app.models.stock_master import StockMaster

    q = query.strip()
    # 6자리 숫자면 코드로 간주
    if re.fullmatch(r"\d{6}", q):
        r = await db.execute(select(StockMaster).where(StockMaster.stock_code == q))
        row = r.scalar_one_or_none()
        if row:
            return row.stock_code, row.stock_name, (row.market or "KOSPI")
        # 코드로 못 찾으면 이름 검색으로 fallback

    # 이름 검색 (부분 일치)
    r = await db.execute(
        select(StockMaster)
        .where(StockMaster.stock_name.ilike(f"%{q}%"))
        .order_by(StockMaster.stock_name)
        .limit(6)
    )
    rows = r.scalars().all()
    if not rows:
        return None
    # 정확히 일치하는 게 하나면 확정
    exact = [x for x in rows if x.stock_name == q]
    if len(exact) == 1:
        row = exact[0]
        return row.stock_code, row.stock_name, (row.market or "KOSPI")
    # 다중 매칭 → 모호 에러 메시지 반환
    if len(exact) > 1 or (not exact and len(rows) > 1):
        candidates = exact if exact else rows[:5]
        names = ", ".join(f"{x.stock_name}({x.stock_code})" for x in candidates)
        return f"{_AMBIGUOUS_SENTINEL}여러 종목이 검색되었습니다. 종목코드로 입력해 주세요:\n{names}"
    row = rows[0]
    return row.stock_code, row.stock_name, (row.market or "KOSPI")


async def _get_holding(code: str, db: AsyncSession):
    from app.models.holding import Holding
    r = await db.execute(select(Holding).where(Holding.stock_code == code))
    return r.scalar_one_or_none()


# ── 실행 ──────────────────────────────────────────────────────────

async def execute_command(
    text: str,
    db: AsyncSession,
    source: str = "web",
    chat_id: str = "",
    user_name: str = "",
) -> dict:
    """명령어를 파싱·실행하고 결과 딕셔너리 반환.
    반환: {result, result_msg, command_type, stock_code, stock_name, quantity}
    """
    from app.models.telegram_command_log import TelegramCommandLog
    from app.services.kiwoom_api import KiwoomApiClient

    parsed = parse_command(text)
    cmd_type = parsed["command_type"]
    qty = parsed.get("quantity")
    stock_code: Optional[str] = None
    stock_name: Optional[str] = None
    result = "unknown"
    result_msg = ""

    try:
        if parsed["error"]:
            result = "error"
            result_msg = parsed["error"]

        elif cmd_type == "help":
            result = "success"
            result_msg = HELP_TEXT

        elif cmd_type == "holdings":
            from app.models.holding import Holding
            r = await db.execute(select(Holding).order_by(Holding.stock_code))
            holdings = r.scalars().all()
            if not holdings:
                result_msg = "📭 현재 보유 종목이 없습니다."
            else:
                lines = ["📦 <b>보유 종목</b>"]
                for h in holdings:
                    pnl = float(h.unrealized_pnl or 0)
                    pct = float(h.unrealized_pnl_pct or 0)
                    sign = "+" if pnl >= 0 else ""
                    lines.append(
                        f"  {h.stock_name}({h.stock_code})\n"
                        f"    {h.quantity}주 · 평균 {int(h.avg_buy_price or 0):,}원\n"
                        f"    평가손익: {sign}{pnl:,.0f}원 ({sign}{pct:.2f}%)"
                    )
                result_msg = "\n".join(lines)
            result = "success"

        elif cmd_type == "status":
            api = KiwoomApiClient.get_instance()
            try:
                bal = await api.get_balance()
                cash = int(bal.get("availableCash", 0))
                total = int(bal.get("totalAsset", 0))
                pnl = float(bal.get("totalPnl", 0))
                sign = "+" if pnl >= 0 else ""
                result_msg = (
                    f"💼 <b>포트폴리오 현황</b>\n"
                    f"총자산: {total:,}원\n"
                    f"가용현금: {cash:,}원\n"
                    f"평가손익: {sign}{pnl:,.0f}원"
                )
            except Exception as e:
                result_msg = f"잔고 조회 실패: {e}"
            result = "success"

        elif cmd_type in ("buy", "sell"):
            resolved = await _resolve_stock(parsed["stock_query"], db)
            if not resolved:
                result = "error"
                result_msg = f"종목을 찾을 수 없습니다: {parsed['stock_query']}"
            elif isinstance(resolved, str) and resolved.startswith(_AMBIGUOUS_SENTINEL):
                result = "error"
                result_msg = resolved[len(_AMBIGUOUS_SENTINEL):]
            else:
                stock_code, stock_name, market = resolved
                api = KiwoomApiClient.get_instance()
                # 현재가 조회
                try:
                    price_info = await api.get_current_price(stock_code)
                    current_price = int(price_info.get("current_price", 0))
                except Exception:
                    current_price = 0

                resp = await api.place_order(
                    stock_code=stock_code,
                    order_type=cmd_type.upper(),
                    quantity=qty,
                    price=current_price,
                    market=market,
                    use_market_order=True,  # 명령어 주문은 시장가
                )
                order_no = resp.get("ord_no", resp.get("order_no", ""))
                if order_no:
                    action_str = "매수" if cmd_type == "buy" else "매도"
                    result = "success"
                    result_msg = (
                        f"✅ {action_str} 주문 접수\n"
                        f"종목: {stock_name}({stock_code})\n"
                        f"수량: {qty:,}주 (시장가)\n"
                        f"주문번호: {order_no}"
                    )
                    # DB에 auto_trade_log 기록
                    await _log_trade(db, cmd_type.upper(), stock_code, stock_name, qty, current_price, "PENDING")
                else:
                    result = "error"
                    result_msg = f"주문 접수 실패: {resp}"

        elif cmd_type == "sellall":
            resolved = await _resolve_stock(parsed["stock_query"], db)
            if not resolved:
                result = "error"
                result_msg = f"종목을 찾을 수 없습니다: {parsed['stock_query']}"
            elif isinstance(resolved, str) and resolved.startswith(_AMBIGUOUS_SENTINEL):
                result = "error"
                result_msg = resolved[len(_AMBIGUOUS_SENTINEL):]
            else:
                stock_code, stock_name, market = resolved
                holding = await _get_holding(stock_code, db)
                if not holding or holding.quantity <= 0:
                    result = "error"
                    result_msg = f"보유 중인 종목이 아닙니다: {stock_name}({stock_code})"
                else:
                    sell_qty = holding.quantity
                    api = KiwoomApiClient.get_instance()
                    resp = await api.place_order(
                        stock_code=stock_code,
                        order_type="SELL",
                        quantity=sell_qty,
                        price=0,
                        market=market,
                        use_market_order=True,
                    )
                    order_no = resp.get("ord_no", resp.get("order_no", ""))
                    if order_no:
                        result = "success"
                        result_msg = (
                            f"✅ 전량 매도 주문 접수\n"
                            f"종목: {stock_name}({stock_code})\n"
                            f"수량: {sell_qty:,}주 (시장가 전량)\n"
                            f"주문번호: {order_no}"
                        )
                        await _log_trade(db, "SELL", stock_code, stock_name, sell_qty,
                                         int(holding.avg_buy_price or 0), "PENDING")
                    else:
                        result = "error"
                        result_msg = f"주문 접수 실패: {resp}"

        else:
            result = "error"
            result_msg = parsed.get("error") or "알 수 없는 명령어 (/help 확인)"

    except Exception as e:
        result = "error"
        result_msg = f"실행 중 오류 발생: {e}"
        log.exception(f"[TG 명령] 실행 오류: {e}")

    # DB 로그 저장
    cmd_log = TelegramCommandLog(
        source=source,
        chat_id=chat_id,
        user_name=user_name,
        raw_text=text,
        command_type=cmd_type,
        stock_code=stock_code,
        stock_name=stock_name,
        quantity=qty,
        result=result,
        result_msg=result_msg[:2000],
    )
    db.add(cmd_log)
    await db.commit()

    return {
        "result": result,
        "result_msg": result_msg,
        "command_type": cmd_type,
        "stock_code": stock_code,
        "stock_name": stock_name,
        "quantity": qty,
    }


async def _log_trade(
    db: AsyncSession,
    action: str,
    stock_code: str,
    stock_name: str,
    quantity: int,
    order_price: int,
    status: str,
):
    """auto_trade_logs에 명령어 주문 기록"""
    from app.models.news import AutoTradeLog
    from datetime import date
    entry = AutoTradeLog(
        trade_date=date.today(),
        stock_code=stock_code,
        stock_name=stock_name,
        action=action,
        quantity=quantity,
        order_price=order_price,
        status=status,
        trigger_models=["CMD"],
        composite_score=None,
        error_msg=None,
    )
    db.add(entry)


# ── Telegram Polling ──────────────────────────────────────────────

async def poll_telegram_commands(db: AsyncSession) -> None:
    """Telegram getUpdates 폴링 — 새 메시지에서 명령어 처리.
    scheduler에서 30초마다 호출.
    """
    global _last_update_id

    if not settings.telegram_bot_token or not settings.telegram_chat_id:
        return

    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/getUpdates"
    params = {"timeout": 0, "offset": _last_update_id + 1, "limit": 20}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params)
            data = resp.json()
    except Exception as e:
        log.debug(f"[TG 폴링] getUpdates 실패: {e}")
        return

    if not data.get("ok"):
        log.debug(f"[TG 폴링] API 오류: {data.get('description')}")
        return

    updates = data.get("result", [])
    if not updates:
        return

    allowed_chat = str(settings.telegram_chat_id).strip()

    for update in updates:
        uid = update.get("update_id", 0)
        if uid > _last_update_id:
            _last_update_id = uid

        msg = update.get("message") or update.get("edited_message")
        if not msg:
            continue

        chat_id = str(msg.get("chat", {}).get("id", ""))
        text = (msg.get("text") or "").strip()
        if not text:
            continue

        # 보안: 설정된 chat_id 에서 온 메시지만 처리
        if chat_id != allowed_chat:
            log.warning(f"[TG 폴링] 미인가 chat_id={chat_id} 차단: {text[:50]}")
            continue

        user = msg.get("from", {})
        user_name = user.get("username") or user.get("first_name") or "unknown"
        tg_msg_id = msg.get("message_id")

        # ── 모든 메시지를 수신함에 저장 (명령어 + 일반 텍스트) ──────────
        await _save_user_message(db, tg_msg_id, user_name, text)

        # 명령어가 아니면 저장만 하고 넘어감
        if not text.startswith("/"):
            continue

        log.info(f"[TG 명령] {user_name}: {text}")

        res = await execute_command(
            text=text,
            db=db,
            source="telegram",
            chat_id=chat_id,
            user_name=user_name,
        )

        # 결과를 텔레그램으로 회신
        await _reply(chat_id, res["result_msg"])

    # 처리한 update_id를 파일에 저장 (서버 재시작 시 중복 실행 방지)
    _save_last_update_id(_last_update_id)


async def _save_user_message(db: AsyncSession, tg_msg_id: int | None, from_user: str, text: str) -> None:
    """사용자가 보낸 메시지를 telegram_user_messages 테이블에 저장 (중복 무시)."""
    from app.models.telegram_message import TelegramUserMessage
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    try:
        if tg_msg_id is not None:
            # message_id 중복 시 무시 (ON CONFLICT DO NOTHING)
            stmt = pg_insert(TelegramUserMessage).values(
                tg_msg_id=tg_msg_id,
                from_user=from_user,
                text=text,
                is_command='Y' if text.startswith('/') else 'N',
            ).on_conflict_do_nothing(index_elements=["tg_msg_id"])
            await db.execute(stmt)
        else:
            row = TelegramUserMessage(
                from_user=from_user,
                text=text,
                is_command='Y' if text.startswith('/') else 'N',
            )
            db.add(row)
        await db.commit()
        log.info(f"[TG 수신함] 저장 완료: {text[:30]}")
    except Exception as e:
        log.warning(f"[TG 수신함] 저장 오류: {e}")


async def _reply(chat_id: str, text: str) -> None:
    """텔레그램으로 결과 메시지 발송"""
    if not settings.telegram_bot_token:
        return
    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(url, json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
            })
    except Exception as e:
        log.warning(f"[TG 명령] 회신 실패: {e}")
