"""
프리장(시간외 단일가 08:00~08:30) 거래량 스캔 서비스

흐름:
1. 워치리스트 + 섹터스크리닝 상위 30종목 대상
2. Naver Finance HTML에서 시간외 가격·거래량 파싱 (2025+ 구조 대응)
3. pykrx로 20일 평균 거래량 조회 (StockDailyPrice 테이블 대체)
4. 최근 뉴스 감성 + AI 모델 점수 합산
5. 종합 점수 기반 signal 분류 (STRONG_BUY / BUY / WATCH / PASS)
6. DB 저장 + 텔레그램 알림
"""

import asyncio
import concurrent.futures
import logging
import re
import datetime
from typing import Optional

import requests
from bs4 import BeautifulSoup

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func, desc

from app.models.premarket_scan import PremarketScanLog
from app.models.watchlist import Watchlist
from app.models.news import AutoTradeLog, NewsItem
from app.models.signal import TradeSignal
from app.models.screened_stock import ScreenedStock

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": "https://finance.naver.com/",
}

_PRICE_RE = re.compile(r'\d{1,3}(?:,\d{3})+')
_PLAIN_NUM_RE = re.compile(r'\b(\d{4,8})\b')

# 종합 점수 가중치
W_VOL   = 0.40
W_MODEL = 0.35
W_NEWS  = 0.25


def _extract_price_from_tag(tag) -> Optional[int]:
    """태그에서 첫 번째 유효한 comma-formatted 숫자를 추출."""
    if not tag:
        return None
    txt = tag.get_text()
    m = _PRICE_RE.search(txt)
    if m:
        return int(m.group().replace(",", ""))
    m2 = _PLAIN_NUM_RE.search(txt.replace(",", ""))
    return int(m2.group(1)) if m2 else None


def _fetch_naver_stock(code: str) -> dict:
    """
    Naver Finance 개별 종목 페이지에서 현재가·거래량·전일종가 파싱.
    2025년 이후 HTML 구조 기준 (span.blind 방식).
    08:00~08:30 시간외 중에는 시간외 가격/거래량이 반환됨.
    """
    result: dict = {}
    try:
        url = f"https://finance.naver.com/item/main.naver?code={code}"
        resp = requests.get(url, headers=_HEADERS, timeout=10)
        resp.encoding = "euc-kr"
        soup = BeautifulSoup(resp.text, "html.parser")

        # ── 현재가 (또는 시간외 가격) ──────────────────────────────────
        # 구조: div.today > p.no_today > em.no_up/.no_down > span.blind("269,000")
        price_tag = soup.select_one("p.no_today em span.blind")
        result["price"] = _extract_price_from_tag(price_tag)

        # ── 거래량 ─────────────────────────────────────────────────────
        # table.no_info td[2] = 거래량 (2025 기준 검증됨)
        # Naver는 PC/모바일 두 테이블을 HTML에 포함 → td[2]와 td[8] 동일 데이터
        no_info_tds = soup.select("table.no_info td")
        if len(no_info_tds) >= 3:
            vol_candidate = _extract_price_from_tag(no_info_tds[2])
            # 합리적인 거래량 범위: 1,000 ~ 2,000,000,000 (20억)
            if vol_candidate and 1_000 <= vol_candidate <= 2_000_000_000:
                result["volume"] = vol_candidate

        # td[2] fallback: 모든 td 중 10,000 이상 최대값 (단, 가격보다 커야 거래량)
        if not result.get("volume"):
            for td in no_info_tds:
                v = _extract_price_from_tag(td)
                if v and 10_000 <= v <= 2_000_000_000:
                    if v > result.get("volume", 0):
                        result["volume"] = v

        # ── 전일 종가 (변동액 역산) ────────────────────────────────────
        # 구조: p.no_exday > em.no_up/.no_down > span.blind("21,500" = 변동액)
        exday_em = soup.select_one("p.no_exday em")
        exday_blind = soup.select_one("p.no_exday em span.blind")
        if exday_em and exday_blind and result.get("price"):
            change_amt = _extract_price_from_tag(exday_blind)
            if change_amt:
                classes = exday_em.get("class") or []
                if "no_up" in classes:
                    result["prev_close"] = result["price"] - change_amt
                elif "no_down" in classes:
                    result["prev_close"] = result["price"] + change_amt

        # ── 등락률 (참고용) ────────────────────────────────────────────
        if result.get("price") and result.get("prev_close"):
            prev = result["prev_close"]
            if prev > 0:
                pct = (result["price"] - prev) / prev * 100
                if abs(pct) <= 30:
                    result["change_pct"] = round(pct, 2)

    except Exception as e:
        logger.warning(f"[프리장] {code} Naver 조회 실패: {e}")

    return result


def _pykrx_avg_vol(code: str, days: int = 20) -> tuple[str, int]:
    """pykrx로 최근 N영업일 평균 거래량 반환. 실패 시 0."""
    try:
        from pykrx import stock as krx_stock
        today = datetime.date.today()
        since = today - datetime.timedelta(days=days + 15)
        df = krx_stock.get_market_ohlcv_by_date(
            since.strftime('%Y%m%d'), today.strftime('%Y%m%d'), code
        )
        if df is not None and '거래량' in df.columns and len(df) >= 3:
            avg = int(df['거래량'].tail(days).mean())
            return code, avg
    except Exception as e:
        logger.debug(f"[프리장] pykrx {code} avg_vol 실패: {e}")
    return code, 0


async def _build_avg_vol_map(codes: list[str], loop) -> dict[str, int]:
    """pykrx로 여러 종목 평균 거래량 병렬 조회 (최대 5개 동시)"""
    if not codes:
        return {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [
            loop.run_in_executor(executor, _pykrx_avg_vol, code)
            for code in codes
        ]
        results = await asyncio.gather(*futures, return_exceptions=True)
    avg_map = {}
    for r in results:
        if not isinstance(r, Exception) and isinstance(r, tuple):
            avg_map[r[0]] = r[1]
    return avg_map


def _vol_to_score(vol_ratio: Optional[float]) -> float:
    """거래량 비율 → 0~1 점수. 10배 이상 = 1.0"""
    if not vol_ratio or vol_ratio <= 0:
        return 0.0
    import math
    return min(1.0, math.log10(max(1.0, vol_ratio)) / math.log10(10))


def _news_to_score(sentiment: Optional[float]) -> float:
    """뉴스 감성 (-1~+1) → 0~1 점수"""
    if sentiment is None:
        return 0.5
    return round((float(sentiment) + 1) / 2, 4)


def _classify_signal(score: float, vol_ratio: Optional[float]) -> tuple[str, list[str]]:
    reasons: list[str] = []

    if (vol_ratio or 0) >= 5:
        reasons.append(f"프리장 거래량 {vol_ratio:.1f}배 폭발")
    elif (vol_ratio or 0) >= 2:
        reasons.append(f"프리장 거래량 {vol_ratio:.1f}배 급증")
    elif (vol_ratio or 0) >= 1:
        reasons.append(f"프리장 거래량 {vol_ratio:.1f}배")

    if score >= 0.72:
        signal = "STRONG_BUY"
        reasons.append("종합 점수 우수")
    elif score >= 0.55:
        signal = "BUY"
    elif score >= 0.40:
        signal = "WATCH"
    else:
        signal = "PASS"

    return signal, reasons


async def run_premarket_scan(db: AsyncSession) -> dict:
    """전체 프리장 스캔 실행"""
    today = datetime.date.today()
    loop = asyncio.get_running_loop()

    # ── 1. 스캔 대상 수집: 워치리스트 + 섹터스크리닝 상위 30종목 ────────
    wl_r = await db.execute(select(Watchlist))
    watchlist = wl_r.scalars().all()
    name_map: dict[str, str] = {w.stock_code: (w.stock_name or w.stock_code) for w in watchlist}

    # 최근 24시간 섹터 스크리닝 상위 30종목 추가
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
    screened_r = await db.execute(
        select(ScreenedStock.stock_code, ScreenedStock.stock_name)
        .where(
            ScreenedStock.screened_at >= cutoff,
            ScreenedStock.composite_score >= 0.55,
        )
        .order_by(desc(ScreenedStock.composite_score))
        .limit(30)
    )
    for row in screened_r:
        name_map.setdefault(row[0], row[1] or row[0])

    all_codes = list(name_map.keys())
    if not all_codes:
        return {"scanned": 0, "message": "스캔 대상 없음"}

    # ── 2. pykrx로 20일 평균 거래량 조회 ────────────────────────────────
    logger.info(f"[프리장] pykrx 평균 거래량 조회 시작 — {len(all_codes)}종목")
    avg_vol_map = await _build_avg_vol_map(all_codes, loop)
    valid_avg = sum(1 for v in avg_vol_map.values() if v > 0)
    logger.info(f"[프리장] 평균 거래량 확보 — {valid_avg}/{len(all_codes)}종목")

    # ── 3. 최근 뉴스 감성 (3일 이내) ────────────────────────────────────
    news_since = today - datetime.timedelta(days=3)
    news_r = await db.execute(
        select(NewsItem.stock_codes, NewsItem.sentiment_score)
        .where(
            and_(
                NewsItem.published_at >= news_since,
                NewsItem.stock_codes.isnot(None),
                NewsItem.sentiment_score.isnot(None),
            )
        )
    )
    news_scores: dict[str, list[float]] = {}
    for row in news_r:
        for code in (row[0] or []):
            news_scores.setdefault(code, []).append(float(row[1]))
    news_map = {
        code: round(sum(v) / len(v), 4)
        for code, v in news_scores.items()
    }

    # ── 4. 최근 모델 점수 ────────────────────────────────────────────────
    model_r = await db.execute(
        select(TradeSignal.stock_code, func.avg(TradeSignal.confidence).label("avg_conf"))
        .where(
            and_(
                TradeSignal.stock_code.in_(all_codes),
                TradeSignal.signal_type == "BUY",
                TradeSignal.created_at >= today - datetime.timedelta(days=1),
            )
        )
        .group_by(TradeSignal.stock_code)
    )
    model_map = {r[0]: float(r[1]) for r in model_r}

    # composite_score로 보완 (3일 이내 최신값)
    atl_r = await db.execute(
        select(AutoTradeLog.stock_code, AutoTradeLog.composite_score)
        .where(
            and_(
                AutoTradeLog.stock_code.in_(all_codes),
                AutoTradeLog.trade_date >= today - datetime.timedelta(days=3),
                AutoTradeLog.composite_score.isnot(None),
            )
        )
        .order_by(desc(AutoTradeLog.created_at))
    )
    for r in atl_r:
        if r[0] not in model_map:
            model_map[r[0]] = float(r[1])

    # ── 5. Naver Finance 개별 조회 (concurrent) ──────────────────────────
    async def _fetch_one(code: str) -> tuple[str, dict]:
        data = await loop.run_in_executor(None, _fetch_naver_stock, code)
        return code, data

    fetch_tasks = [_fetch_one(code) for code in all_codes]
    fetched = await asyncio.gather(*fetch_tasks, return_exceptions=True)

    # ── 6. 분석 + 저장 ───────────────────────────────────────────────────
    results: list[dict] = []
    saved = updated = 0

    for item in fetched:
        if isinstance(item, Exception):
            continue
        code, naver = item
        name = name_map.get(code, code)

        pm_volume = naver.get("volume") or 0
        pm_price  = naver.get("price")
        prev_cls  = naver.get("prev_close")
        avg_vol   = avg_vol_map.get(code, 0)

        vol_ratio: Optional[float] = None
        if avg_vol > 0 and pm_volume > 0:
            vol_ratio = round(pm_volume / avg_vol, 2)

        if pm_price is not None and (pm_price <= 0 or pm_price > 10_000_000):
            pm_price = None

        price_chg: Optional[float] = naver.get("change_pct")

        news_sent   = news_map.get(code)
        model_score = model_map.get(code)

        vol_s   = _vol_to_score(vol_ratio)
        news_s  = _news_to_score(news_sent)
        model_s = float(model_score) if model_score else 0.5

        combined = round(vol_s * W_VOL + model_s * W_MODEL + news_s * W_NEWS, 4)
        signal, reasons = _classify_signal(combined, vol_ratio)

        # 프리장 거래량이 없거나 너무 작으면 PASS 강제
        if (vol_ratio or 0) < 0.05:
            signal = "PASS"

        priority_boost = signal in ("STRONG_BUY", "BUY")

        # DB upsert
        try:
            ex_r = await db.execute(
                select(PremarketScanLog).where(
                    and_(
                        PremarketScanLog.scan_date == today,
                        PremarketScanLog.stock_code == code,
                    )
                )
            )
            entry = ex_r.scalar_one_or_none()
            if entry:
                entry.premarket_price   = pm_price
                entry.premarket_volume  = pm_volume
                entry.prev_close        = prev_cls
                entry.prev_avg_volume   = avg_vol or None
                entry.vol_ratio         = vol_ratio
                entry.price_change_pct  = price_chg
                entry.news_sentiment    = news_sent
                entry.model_score       = model_score
                entry.combined_score    = combined
                entry.signal            = signal
                entry.signal_reasons    = reasons
                entry.priority_boost    = priority_boost
                updated += 1
            else:
                entry = PremarketScanLog(
                    scan_date        = today,
                    stock_code       = code,
                    stock_name       = name,
                    premarket_price  = pm_price,
                    premarket_volume = pm_volume,
                    prev_close       = prev_cls,
                    prev_avg_volume  = avg_vol or None,
                    vol_ratio        = vol_ratio,
                    price_change_pct = price_chg,
                    news_sentiment   = news_sent,
                    model_score      = model_score,
                    combined_score   = combined,
                    signal           = signal,
                    signal_reasons   = reasons,
                    priority_boost   = priority_boost,
                )
                db.add(entry)
                saved += 1
        except Exception as e:
            await db.rollback()
            logger.warning(f"[프리장] {code} 저장 실패: {e}")

        if signal != "PASS" and (vol_ratio or 0) >= 0.05:
            results.append({
                "stock_code":       code,
                "stock_name":       name,
                "pm_price":         pm_price,
                "pm_volume":        pm_volume,
                "vol_ratio":        vol_ratio,
                "price_change_pct": price_chg,
                "news_sentiment":   news_sent,
                "model_score":      model_score,
                "combined_score":   combined,
                "signal":           signal,
                "signal_reasons":   reasons,
            })

    await db.commit()

    results.sort(key=lambda x: x["combined_score"], reverse=True)

    logger.info(f"[프리장] 스캔 완료 — {len(all_codes)}종목, 매수 후보 {len(results)}개")
    return {
        "scan_date":  str(today),
        "total":      len(all_codes),
        "saved":      saved,
        "updated":    updated,
        "candidates": results,
        "message":    f"프리장 스캔 완료 — {len(all_codes)}종목, 매수 후보 {len(results)}개",
    }


async def send_premarket_telegram(db: AsyncSession) -> None:
    """텔레그램으로 프리장 스캔 결과 전송"""
    from app.services import telegram_notifier as tg
    if not tg.is_configured():
        return

    result = await run_premarket_scan(db)
    candidates = result.get("candidates", [])

    signal_emoji = {"STRONG_BUY": "🔥", "BUY": "📈", "WATCH": "👀"}

    lines = [
        f"🌅 *프리장 거래량 신호* {datetime.date.today().strftime('%m/%d')}",
        f"스캔 {result['total']}종목 완료",
        "",
    ]

    if not candidates:
        lines.append("⚠️ 유의미한 프리장 거래량 신호 없음")
    else:
        for c in candidates[:8]:
            emoji = signal_emoji.get(c["signal"], "")
            vol_str = f"{c['vol_ratio']:.1f}배" if c["vol_ratio"] else "거래량 미수집"
            pct_str = f"{c['price_change_pct']:+.1f}%" if c["price_change_pct"] is not None else ""
            score_str = f"{c['combined_score']:.2f}"
            news_str = f"뉴스{c['news_sentiment']:+.2f}" if c["news_sentiment"] else ""
            model_str = f"AI {c['model_score']:.2f}" if c["model_score"] else ""

            extra = " · ".join(filter(None, [news_str, model_str]))
            lines.append(
                f"{emoji} *{c['stock_name']}* ({c['stock_code']})\n"
                f"   거래량 {vol_str} {pct_str} | 종합 {score_str}\n"
                f"   {extra}"
            )
            lines.append("")

    lines.append("⚠️ 프리장은 유동성 낮음 — 장 시작 후 추이 확인 권장")

    message = "\n".join(lines)
    try:
        await tg.send_message(message)
        logger.info(f"[프리장] 텔레그램 전송 완료 ({len(candidates)}개 후보)")
    except Exception as e:
        logger.warning(f"[프리장] 텔레그램 전송 실패: {e}")
