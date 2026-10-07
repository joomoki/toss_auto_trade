"""
텔레그램 봇 알림 서비스
- 매수/매도 체결 알림
- 킬스위치 발동 알림
- 오류 알림
- 설정: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (.env)
"""
from __future__ import annotations

import logging
from datetime import datetime
import pytz

import httpx
from app.core.config import settings

logger = logging.getLogger(__name__)
SEOUL_TZ = pytz.timezone("Asia/Seoul")

_TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"


def _now_kst() -> str:
    return datetime.now(SEOUL_TZ).strftime("%Y-%m-%d %H:%M:%S")


def is_configured() -> bool:
    return bool(settings.telegram_bot_token and settings.telegram_chat_id)


def _in_notify_window() -> bool:
    """설정된 발송 시간 창(from~to) 및 영업일 조건을 확인한다.
    조건이 기본값(00:00~23:59, 영업일 미제한)이면 항상 True."""
    now = datetime.now(SEOUL_TZ)

    # 영업일(평일) 제한
    if settings.telegram_notify_business_only and now.weekday() >= 5:
        return False

    # 시간 창 파싱
    def _hm(s: str) -> tuple[int, int]:
        try:
            h, m = s.split(":")
            return int(h), int(m)
        except Exception:
            return 0, 0

    from_h, from_m = _hm(settings.telegram_notify_from)
    to_h,   to_m   = _hm(settings.telegram_notify_to)
    from_total = from_h * 60 + from_m
    to_total   = to_h   * 60 + to_m
    now_total  = now.hour * 60 + now.minute

    # 00:00~23:59 = 전체 허용 (기본값)
    if from_total == 0 and to_total == 23 * 60 + 59:
        return True

    if from_total <= to_total:
        return from_total <= now_total <= to_total
    # 자정을 넘는 구간 (예: 22:00~06:00)
    return now_total >= from_total or now_total <= to_total


# 메시지 유형별 상단 구분선 아이콘
_MSG_HEADER: dict[str, str] = {
    "buy":         "📈",
    "sell":        "📉",
    "kill_switch": "🚨",
    "error":       "⚠️",
    "warn":        "🛡",
    "info":        "✅",
    "report":      "📊",
    "screening":   "🔍",
    "macro":       "🌐",
    "hourly":      "⏰",
    "portfolio":   "📋",
    "close":       "🔔",
    "test":        "🧪",
}

def _header_sep(msg_type: str) -> str:
    icon = _MSG_HEADER.get(msg_type, "🤖")
    return f"{'─' * 8} {icon} {'─' * 8}"


async def send_message(
    text: str,
    force: bool = False,
    msg_type: str = "general",
    stock_code: str | None = None,
    stock_name: str | None = None,
) -> bool:
    """텔레그램 메시지 전송. 실패해도 예외를 던지지 않음.
    force=True 이면 발송 시간 창 제한을 무시한다 (수동 전송 등)."""
    if not is_configured():
        return False
    if not force and not _in_notify_window():
        logger.debug("텔레그램 발송 시간 창 외 — 스킵")
        return False
    url = _TELEGRAM_API.format(token=settings.telegram_bot_token)
    # 메시지 맨 위에 구분선 추가
    text = f"{_header_sep(msg_type)}\n{text}"
    ok = False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json={
                "chat_id": settings.telegram_chat_id,
                "text": text,
                "parse_mode": "HTML",
            })
            if resp.status_code != 200:
                logger.warning(f"텔레그램 전송 실패: {resp.status_code} {resp.text[:200]}")
            else:
                ok = True
    except Exception as e:
        logger.warning(f"텔레그램 전송 오류: {e}")

    # 전송 내역 DB 저장 (실패해도 전파하지 않음)
    try:
        from app.core.database import AsyncSessionLocal
        from app.models.telegram_log import TelegramLog
        async with AsyncSessionLocal() as _db:
            _db.add(TelegramLog(
                msg_type=msg_type,
                stock_code=stock_code,
                stock_name=stock_name,
                message=text[:1000],
                is_success=ok,
            ))
            await _db.commit()
    except Exception as _e:
        logger.debug(f"텔레그램 로그 저장 실패: {_e}")

    return ok


# ─── 알림 템플릿 ─────────────────────────────────────────

async def notify_buy(
    stock_name: str,
    stock_code: str,
    quantity: int,
    price: int,
    composite_score: float,
    trigger_models: list[str],
    is_mock: bool,
    news_score: float = 0.5,
    supply_score: float = 0.5,
    dart_score: float = 0.5,
    model_scores: dict | None = None,
) -> None:
    mode = "🔵 모의" if is_mock else "🟢 실전"
    amount = quantity * price

    # 트리거 모델 표시
    models_str = " ".join(trigger_models[:5]) if trigger_models else "-"

    # 뉴스 감성 레이블
    if news_score >= 0.65:
        news_label = "😊 긍정"
    elif news_score <= 0.35:
        news_label = "😟 부정"
    else:
        news_label = "😐 중립"

    # 수급 레이블
    if supply_score >= 0.7:
        supply_label = "🔥 강함"
    elif supply_score >= 0.5:
        supply_label = "➡️ 보통"
    else:
        supply_label = "❄️ 약함"

    # BUY 신호 모델별 점수 + 판단 사유
    model_lines = ""
    if model_scores:
        buy_models = [
            (mid, v) for mid, v in model_scores.items()
            if v.get("signal") == "BUY"
        ]
        if buy_models:
            parts = []
            for i, (mid, v) in enumerate(buy_models[:5]):
                reason = v.get("reason", "")
                connector = "└" if i == len(buy_models) - 1 or i == 4 else "├"
                parts.append(f"  {connector} <b>{mid}</b> ({v['score']:.2f}) {reason}")
            model_lines = "\n" + "\n".join(parts)

    text = (
        f"{mode} <b>[매수체결]</b> {stock_name} ({stock_code})\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"💰 {quantity:,}주 × {price:,}원 = <b>{amount:,}원</b>\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"📊 <b>AI 판단 근거</b>\n"
        f"  ├ 종합점수: <b>{composite_score:.3f}</b>\n"
        f"  ├ 뉴스감성: {news_score:.2f}  {news_label}\n"
        f"  ├ 수급점수: {supply_score:.2f}  {supply_label}\n"
        f"  ├ 공시점수: {dart_score:.2f}\n"
        f"  └ 매수 신호 모델 [{models_str}]{model_lines}\n"
        f"🕐 {_now_kst()}"
    )
    await send_message(text, msg_type="buy", stock_code=stock_code, stock_name=stock_name)


async def notify_sell(
    stock_name: str,
    stock_code: str,
    quantity: int,
    price: int,
    avg_buy_price: float,
    reason: str,
    is_mock: bool,
    supply_score: float | None = None,
) -> None:
    mode = "🔵 모의" if is_mock else "🔴 실전"
    amount = quantity * price
    pnl = (price - avg_buy_price) * quantity
    pnl_pct = (price - avg_buy_price) / (avg_buy_price + 1e-9) * 100
    pnl_icon = "📈" if pnl >= 0 else "📉"
    pnl_sign = "+" if pnl >= 0 else ""

    # 사유에서 유형 아이콘 결정
    if "손절" in reason:
        reason_icon = "🚨"
    elif "익절" in reason or "동적익절" in reason:
        reason_icon = "✅"
    elif "스마트" in reason or "샹들리에" in reason:
        reason_icon = "🧠"
    elif "거래량" in reason:
        reason_icon = "📉"
    elif "수급" in reason:
        reason_icon = "⚠️"
    else:
        reason_icon = "📌"

    supply_line = f"  └ 매도시점 수급: {supply_score:.2f}\n" if supply_score is not None else ""

    text = (
        f"{mode} <b>[매도체결]</b> {stock_name} ({stock_code})\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"💰 {quantity:,}주 × {price:,}원 = <b>{amount:,}원</b>\n"
        f"{pnl_icon} 손익: <b>{pnl_sign}{pnl:,.0f}원 ({pnl_sign}{pnl_pct:.2f}%)</b>\n"
        f"  ├ 매수가: {avg_buy_price:,.0f}원  →  매도가: {price:,}원\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"{reason_icon} <b>매도 사유</b>: {reason}\n"
        f"{supply_line}"
        f"🕐 {_now_kst()}"
    )
    await send_message(text, msg_type="sell", stock_code=stock_code, stock_name=stock_name)


async def notify_kill_switch(daily_loss: float, threshold: float) -> None:
    text = (
        f"🚨 <b>[킬스위치 발동]</b>\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"오늘 손실: {daily_loss:,.0f}원\n"
        f"설정 한도: {threshold:,.0f}원\n"
        f"⛔ 당일 자동매매 즉시 중단됨\n"
        f"🕐 {_now_kst()}"
    )
    await send_message(text, msg_type="kill_switch")


async def notify_error(context: str, error: str) -> None:
    text = (
        f"⚠️ <b>[오류]</b> {context}\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"{error[:300]}\n"
        f"🕐 {_now_kst()}"
    )
    await send_message(text, msg_type="error")


async def notify_kiwoom_down(return_code: int, return_msg: str) -> None:
    """키움 API 인증/토큰 장애 즉시 알림 (force=True: 시간 창 무시)"""
    if return_code == 3:
        cause = "🔑 지정단말기 인증 실패 (8050)\n키움 Open API+ 포털 → 단말기 재등록 필요"
        action = "포털(https://openapi.kiwoom.com) 접속 후 단말기 재등록하세요."
    else:
        cause = f"토큰 발급 실패 (code={return_code})"
        action = "키움 API 키와 네트워크 연결을 확인하세요."

    text = (
        f"🚨 <b>[키움 API 장애]</b>\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"❌ {cause}\n"
        f"📋 메시지: {return_msg[:200]}\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"🛠 조치: {action}\n"
        f"⚠️ <b>자동매매가 중단되었습니다.</b>\n"
        f"🕐 {_now_kst()}"
    )
    await send_message(text, force=True, msg_type="kill_switch")


async def notify_test() -> bool:
    text = (
        f"✅ <b>텔레그램 알림 연결 성공!</b>\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"주식 자동매매 알림이 이 채널로 전송됩니다.\n"
        f"🕐 {_now_kst()}"
    )
    return await send_message(text, msg_type="test")


# ─── 모델 설명 매핑 ──────────────────────────────────────
_MODEL_DESC = {
    "M1":  "이동평균 골든크로스",
    "M2":  "RSI 과매도 반등",
    "M3":  "MACD 상향 전환",
    "M4":  "볼린저밴드 반등",
    "M5":  "거래량 급증 돌파",
    "M6":  "스토캐스틱 크로스",
    "M7":  "ADX 추세 강도",
    "M8":  "캔들 패턴 신호",
    "M9":  "지지선 돌파",
    "M10": "앙상블 종합",
}

def _market_label(score: float) -> str:
    if score >= 0.80: return "매우 양호 🟢"
    if score >= 0.65: return "양호 🟡"
    if score >= 0.50: return "보통 🟠"
    return "불량 🔴"

def _score_bar(score: float, width: int = 10) -> str:
    filled = round(score * width)
    return "█" * filled + "░" * (width - filled) + f" {score:.2f}"


async def notify_report(
    label: str,
    previews: list[dict],
    market_score: float,
    buy_threshold: float,
    max_position_amt: float | None,
    is_mock: bool,
    force: bool = False,
) -> None:
    """장 시작 전 / 현재 기준 매수 후보 리포트 전송"""
    mode_str = "🔵 모의투자" if is_mock else "🟢 실전매매"

    buy_list  = [p for p in previews if p.get("composite_score", 0) >= buy_threshold and p.get("final_signal") == "BUY"]
    near_list = [p for p in previews if buy_threshold * 0.88 <= p.get("composite_score", 0) < buy_threshold]

    lines: list[str] = [
        f"📊 <b>{label}</b>",
        f"━━━━━━━━━━━━━━━━━",
        f"🕐 {_now_kst()}",
        f"📈 시장 점수: {_score_bar(market_score)} ({_market_label(market_score)})",
        "",
    ]

    if buy_list:
        lines.append(f"✅ <b>매수 후보 {len(buy_list)}종목</b> (종합점수 ≥ {buy_threshold})\n")
        nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣"]
        for i, p in enumerate(buy_list[:5]):
            models = p.get("trigger_models", [])[:4]
            model_str = " · ".join(
                _MODEL_DESC.get(m, m) for m in models
            ) if models else "신호 없음"
            price = p.get("current_price", 0)
            lines.append(
                f"{nums[i]} <b>{p.get('stock_name','?')}</b> ({p.get('stock_code','?')})\n"
                f"   종합: <b>{p['composite_score']:.3f}</b> | AI: {p.get('model_score',0):.2f} | 뉴스: {p.get('news_score',0):.2f}\n"
                f"   현재가: {int(price):,}원\n"
                f"   📌 {model_str}\n"
            )
    else:
        lines.append("📭 현재 매수 조건을 충족하는 종목이 없습니다.\n")

    if near_list:
        near_str = " / ".join(
            f"{p.get('stock_name','?')} {p.get('composite_score',0):.3f}"
            for p in near_list[:4]
        )
        lines.append(f"⚡ 임계값 근접: {near_str}\n")

    amt_str = f"{int(max_position_amt):,}원" if max_position_amt else "미설정"
    lines += [
        f"━━━━━━━━━━━━━━━━━",
        f"💰 임계값: {buy_threshold} | 종목당 최대: {amt_str}",
        f"{mode_str} | 총 분석 {len(previews)}종목",
    ]

    await send_message("\n".join(lines), force=force, msg_type="report")


async def notify_hourly_progress(
    hour: int,
    buy_count: int,
    sell_count: int,
    realized_pnl: float,
    recent_trades: list[dict],
    is_mock: bool,
    kill_switch: bool,
    macro_summary: str | None = None,
    force: bool = False,
) -> None:
    """시간별 진행 현황 알림 (매 정시)"""
    if kill_switch:
        status_icon = "🚨 킬스위치 발동"
    else:
        status_icon = "🔵 모의투자" if is_mock else "🟢 실전매매"

    pnl_icon = "📈" if realized_pnl >= 0 else "📉"
    pnl_sign = "+" if realized_pnl >= 0 else ""

    lines: list[str] = [
        f"⏰ <b>[{hour:02d}:00 진행 현황]</b> {status_icon}",
        f"━━━━━━━━━━━━━━━━━",
        f"📥 매수 {buy_count}건 / 📤 매도 {sell_count}건",
        f"{pnl_icon} 실현손익(체결확정): <b>{pnl_sign}{realized_pnl:,.0f}원</b>",
    ]

    if macro_summary:
        lines.append(f"🌐 수혜 섹터: {macro_summary}")

    if recent_trades:
        lines.append("\n🕐 최근 거래:")
        for t in recent_trades[:5]:
            action_icon = "📥" if t["action"] == "BUY" else "📤"
            pnl_str = ""
            if t["action"] == "SELL" and t.get("realized_pnl") is not None:
                p = t["realized_pnl"]
                pnl_str = f" ({'+' if p >= 0 else ''}{p:,.0f}원)"
            lines.append(
                f"  {action_icon} {t['stock_name']} {t['quantity']:,}주 × {int(t.get('order_price', 0)):,}원{pnl_str}"
            )

    lines.append(f"\n🕐 {_now_kst()}")
    await send_message("\n".join(lines), force=force, msg_type="hourly")


async def notify_macro_sector(
    events: list[dict],
    sector_signals: list[dict],
    label: str = "매크로 섹터 시그널",
    force: bool = False,
) -> None:
    """매크로 이벤트 + 섹터 신호 알림"""
    long_sectors  = [s for s in sector_signals if s.get("direction") == "long"]
    short_sectors = [s for s in sector_signals if s.get("direction") == "short"]

    lines: list[str] = [
        f"🌐 <b>[{label}]</b>",
        f"━━━━━━━━━━━━━━━━━",
        f"📡 활성 이벤트: {len(events)}개",
    ]

    for ev in events[:4]:
        cat = ev.get("category", "")
        cat_icon = {"market": "📈", "risk": "⚠️", "macro": "🏦", "policy": "🏛"}.get(cat, "·")
        lines.append(f"  {cat_icon} {ev['name']} (강도 {ev.get('magnitude', 0):.2f})")

    lines.append("")
    if long_sectors:
        lines.append(f"🟢 <b>수혜 섹터 {len(long_sectors)}개</b>")
        for s in long_sectors[:5]:
            score = s.get("net_score", 0)
            filled = max(0, round(score * 5))
            bar = "█" * filled + "░" * (5 - filled)
            lines.append(f"  {bar} {s['sector_name']} (<b>+{score:.2f}</b>)")
    else:
        lines.append("🟡 현재 수혜 섹터 없음 (전 섹터 관망)")

    if short_sectors:
        lines.append(f"\n🔴 불리한 섹터:")
        for s in short_sectors[:3]:
            lines.append(f"  · {s['sector_name']} ({s.get('net_score', 0):.2f})")

    lines.append(f"\n🕐 {_now_kst()}")
    await send_message("\n".join(lines), force=force, msg_type="macro")


async def notify_sector_screening(
    screened_at: str,
    total_analyzed: int,
    buy_count: int,
    top_stocks: list[dict],
    favorable_sectors: list[str],
    force: bool = False,
) -> None:
    """AI 섹터 스크리닝 결과 알림 (09:05 / 11:00 / 13:30)"""
    nums = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"]
    sector_str = " · ".join(favorable_sectors[:4]) if favorable_sectors else "전 섹터"

    lines: list[str] = [
        f"🔍 <b>[AI 섹터 스크리닝 결과]</b> {screened_at}",
        f"━━━━━━━━━━━━━━━━━",
        f"분석 <b>{total_analyzed}</b>종목 | 매수 신호 <b>{buy_count}</b>종목",
        f"수혜 섹터: {sector_str}",
        "",
    ]

    buy_stocks = [s for s in top_stocks if s.get("final_signal") == "BUY"]
    if buy_stocks:
        lines.append(f"✅ <b>TOP {min(len(buy_stocks), 5)} 매수 후보</b>")
        for i, s in enumerate(buy_stocks[:5]):
            score  = s.get("composite_score") or 0
            price  = int(s.get("current_price") or 0)
            name   = s.get("stock_name") or s.get("stock_code", "?")
            code   = s.get("stock_code", "?")
            m_sc   = s.get("model_score") or 0
            n_sc   = s.get("news_score") or 0
            lines.append(
                f"{nums[i]} <b>{name}</b> ({code})\n"
                f"   종합: <b>{score:.3f}</b> | AI: {m_sc:.2f} | 뉴스: {n_sc:.2f}\n"
                f"   현재가: {price:,}원"
            )
    else:
        lines.append("📭 현재 매수 조건 충족 종목 없음")

    lines.append(f"\n🕐 {_now_kst()}")
    await send_message("\n".join(lines), force=force, msg_type="screening")


async def notify_portfolio_status(
    holdings: list[dict],
    balance: dict,
    screened_buys: list[dict] | None = None,
    force: bool = False,
) -> None:
    """현재 포트폴리오 현황 — 주기 리포트 / 수동 전송용"""
    cash        = int(balance.get("availableCash", balance.get("cash", 0)))
    total_asset = int(balance.get("totalAsset", 0))
    total_pnl   = int(balance.get("totalPnl", 0))
    pnl_rate    = float(balance.get("totalPnlRate", 0))
    pnl_icon    = "📈" if total_pnl >= 0 else "📉"
    pnl_sign    = "+" if total_pnl >= 0 else ""

    lines: list[str] = [
        f"📋 <b>[현재 포트폴리오 현황]</b>",
        f"━━━━━━━━━━━━━━━━━",
        f"🕐 {_now_kst()}",
        f"",
        f"💰 예수금: <b>{cash:,}원</b>",
        f"📊 총자산: {total_asset:,}원",
        f"{pnl_icon} 손익: {pnl_sign}{total_pnl:,}원 ({pnl_sign}{pnl_rate:.2f}%)",
        f"",
    ]

    if holdings:
        long_h   = [h for h in holdings if h.get("is_long_term")]
        manual_h = [h for h in holdings if h.get("is_manual") and not h.get("is_long_term")]
        auto_h   = [h for h in holdings if not h.get("is_manual") and not h.get("is_long_term")]

        def _holding_line(h: dict) -> str:
            name = h.get("stock_name") or h.get("stock_code") or "?"
            qty  = int(h.get("quantity", 0))
            avg  = float(h.get("avg_buy_price", 0) or 0)
            cur  = float(h.get("current_price", 0) or avg)
            upnl     = float(h.get("unrealized_pnl") or 0)
            upnl_pct = float(h.get("unrealized_pnl_pct") or 0)
            if upnl == 0 and avg > 0 and cur > 0:
                upnl     = round((cur - avg) * qty, 2)
                upnl_pct = round((cur - avg) / avg * 100, 2)
            icon = "🟢" if upnl >= 0 else "🔴"
            sign = "+" if upnl >= 0 else ""
            return f"  {icon} {name} {qty:,}주 | {sign}{upnl_pct:.1f}% ({sign}{upnl:,.0f}원)"

        lines.append(f"<b>📦 보유 종목 {len(holdings)}개</b>")

        if manual_h:
            lines.append(f"\n👤 <b>수동 매수 {len(manual_h)}종목</b>")
            for h in manual_h[:5]:
                lines.append(_holding_line(h))
            if len(manual_h) > 5:
                lines.append(f"  … 외 {len(manual_h)-5}종목")

        if auto_h:
            lines.append(f"\n🤖 <b>자동매매 {len(auto_h)}종목</b>")
            for h in auto_h[:5]:
                lines.append(_holding_line(h))
            if len(auto_h) > 5:
                lines.append(f"  … 외 {len(auto_h)-5}종목")

        if long_h:
            lines.append(f"\n🌱 <b>장기 보유 {len(long_h)}종목</b>")
            for h in long_h[:5]:
                lines.append(_holding_line(h))
            if len(long_h) > 5:
                lines.append(f"  … 외 {len(long_h)-5}종목")
    else:
        lines.append("📭 보유 종목 없음")

    if screened_buys:
        lines.append(f"\n✅ <b>AI 매수 후보 {len(screened_buys)}종목</b>")
        for s in screened_buys[:3]:
            name  = s.get("stock_name", s.get("stock_code", "?"))
            score = s.get("composite_score", 0)
            price = int(s.get("current_price", 0))
            lines.append(f"  · {name} | 점수 {score:.3f} | {price:,}원")

    lines.append(f"\n━━━━━━━━━━━━━━━━━")
    await send_message("\n".join(lines), force=force, msg_type="portfolio")


async def notify_close_report(
    buy_count: int,
    sell_count: int,
    realized_pnl: float,
    win_count: int,
    loss_count: int,
    sell_details: list[dict],
    is_mock: bool,
    screened_total: int = 0,
    screened_buy: int = 0,
    top_sectors: list[str] | None = None,
    force: bool = False,
) -> None:
    """장 마감 결과 리포트 (15:35 자동 전송)"""
    mode_str = "🔵 모의투자" if is_mock else "🟢 실전매매"
    total_sell = win_count + loss_count
    win_rate = (win_count / total_sell * 100) if total_sell > 0 else 0.0
    pnl_icon = "📈" if realized_pnl >= 0 else "📉"
    pnl_sign = "+" if realized_pnl >= 0 else ""

    lines: list[str] = [
        f"🔔 <b>[장 마감 결과 리포트]</b> {mode_str}",
        f"━━━━━━━━━━━━━━━━━",
        f"🕐 {_now_kst()}",
        f"",
        f"📥 총 매수: {buy_count}건",
        f"📤 총 매도: {sell_count}건",
        f"{pnl_icon} 실현손익: <b>{pnl_sign}{realized_pnl:,.0f}원</b>",
        f"🎯 매도 승률: {win_rate:.1f}% ({win_count}승 {loss_count}패)",
        f"",
    ]

    if sell_details:
        lines.append(f"<b>📋 매도 내역:</b>")
        for t in sell_details[:8]:
            p = t.get("realized_pnl") or 0
            sign = "+" if p >= 0 else ""
            icon = "✅" if p >= 0 else "❌"
            lines.append(
                f"  {icon} {t['stock_name']} → {sign}{p:,.0f}원"
            )

    if sell_count == 0 and buy_count == 0:
        lines.append("📭 오늘 체결된 매매가 없습니다.")

    # ── 매크로 섹터 스크리닝 요약 ───────────────────────────
    if screened_total > 0 or top_sectors:
        lines.append(f"\n━━━━━━━━━━━━━━━━━")
        lines.append(f"🌐 <b>[AI 섹터 스크리닝 요약]</b>")
        if screened_total > 0:
            lines.append(f"  분석 {screened_total}종목 | 매수 신호 {screened_buy}종목")
        if top_sectors:
            lines.append(f"  수혜 섹터: {' · '.join(top_sectors[:4])}")

    lines.append(f"\n━━━━━━━━━━━━━━━━━")
    lines.append(f"내일도 AI가 최적 종목을 찾겠습니다 🤖")
    await send_message("\n".join(lines), force=force, msg_type="close")
