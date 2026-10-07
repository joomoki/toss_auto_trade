"""
상승 종목 분석 서비스

데이터 소스:
- 오늘 / 당일 : Naver Finance HTML (sise_rise.naver) — 인증 불필요
- 과거 날짜   : pykrx get_market_ohlcv_by_date (단일 종목, 인증 불필요)
                + StockMaster 종목 목록으로 배치 조회 (watchlist 우선)
"""

import asyncio
import logging
from datetime import date, timedelta
from typing import Optional

import requests
from bs4 import BeautifulSoup

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from app.models.rising_stock import RisingStockLog
from app.models.news import AutoTradeLog, NewsItem
from app.models.watchlist import Watchlist
from app.models.stock_master import StockMaster

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
}


# ── 네이버 금융 오늘 등락률 상위 ────────────────────────────────────
def _fetch_naver_risers(sosok: int = 0, max_pages: int = 2) -> list[dict]:
    """
    네이버 금융 sise_rise 파싱.
    sosok=0 → KOSPI, sosok=1 → KOSDAQ
    """
    results: list[dict] = []
    market = "KOSPI" if sosok == 0 else "KOSDAQ"

    for page in range(1, max_pages + 1):
        url = f"https://finance.naver.com/sise/sise_rise.naver?sosok={sosok}&page={page}"
        try:
            resp = requests.get(url, headers=_HEADERS, timeout=15)
            resp.encoding = "euc-kr"
            soup = BeautifulSoup(resp.text, "html.parser")
            table = soup.find("table", class_="type_2")
            if not table:
                break
            rows = table.find_all("tr")
            found = 0
            for row in rows:
                cols = row.find_all("td")
                if len(cols) < 10:
                    continue
                # 종목 코드 추출 (href="/item/main.naver?code=XXXXXX")
                a_tag = row.find("a", href=lambda h: h and "code=" in h)
                if not a_tag:
                    continue
                code = a_tag["href"].split("code=")[-1].strip()
                if not code or len(code) != 6:
                    continue
                name = a_tag.get_text(strip=True)

                def _clean(s: str) -> str:
                    return s.replace(",", "").replace("%", "").replace("+", "").strip()

                try:
                    # cols: 순위 | 종목명 | 현재가 | 전일대비 | 등락률 | 거래량 | 매도호가 | 매수호가 | 거래대금(백만) | 전일거래량 …
                    close_price  = int(_clean(cols[2].get_text(strip=True)))
                    change_pct   = float(_clean(cols[4].get_text(strip=True)))
                    volume       = int(_clean(cols[5].get_text(strip=True)))
                    tv_str       = _clean(cols[8].get_text(strip=True))
                    trading_val  = int(tv_str) * 1_000_000 if tv_str.lstrip("-").isdigit() else 0
                    prev_vol_str = _clean(cols[9].get_text(strip=True))
                    prev_volume  = int(prev_vol_str) if prev_vol_str.isdigit() else 0
                except (ValueError, IndexError):
                    continue

                if change_pct <= 0:
                    continue

                vol_ratio = round(volume / prev_volume, 2) if prev_volume > 0 else None

                results.append({
                    "code":          code,
                    "name":          name,
                    "market":        market,
                    "close_price":   close_price,
                    "change_pct":    change_pct,
                    "volume":        volume,
                    "trading_value": trading_val,
                    "vol_ratio":     vol_ratio,
                })
                found += 1

            if found == 0:
                break
        except Exception as e:
            logger.warning(f"[상승분석] Naver {market} page={page} 실패: {e}")
            break

    return results


# ── 과거 날짜 pykrx 배치 조회 ───────────────────────────────────────
def _fetch_historical_by_codes(
    codes: list[str],
    analysis_date: date,
    min_change_pct: float,
) -> list[dict]:
    """pykrx get_market_ohlcv_by_date 로 단일 종목씩 조회 후 필터링"""
    from pykrx import stock as pkrx

    date_str = analysis_date.strftime("%Y%m%d")
    results: list[dict] = []

    for code in codes:
        try:
            df = pkrx.get_market_ohlcv_by_date(date_str, date_str, code)
            if df is None or df.empty:
                continue
            row = df.iloc[0]
            # 등락률 컬럼 이름이 인코딩 문제로 깨질 수 있으므로 위치로 접근
            cols = df.columns.tolist()
            close_col  = cols[3]   # 종가
            vol_col    = cols[4]   # 거래량
            change_col = cols[5]   # 등락률

            close   = int(row[close_col])
            volume  = int(row[vol_col])
            change  = float(row[change_col])

            if change < min_change_pct:
                continue

            results.append({
                "code":         code,
                "name":         None,       # 이후 StockMaster로 채움
                "market":       None,
                "close_price":  close,
                "change_pct":   change,
                "volume":       volume,
                "trading_value": 0,
            })
        except Exception:
            pass

    return results


# ── 원인 분류 ────────────────────────────────────────────────────────
def _analyze_causes(
    change_pct: float,
    vol_ratio: Optional[float],
    news_count: int,
    news_sentiment: Optional[float],
) -> tuple[list[str], str]:
    causes: list[str] = []

    # 뉴스
    if news_count >= 2 and (news_sentiment or 0) > 0.55:
        causes.append("뉴스호재")
    elif news_count >= 3:
        causes.append("뉴스다량")

    # 거래량 비율 (전일 대비)
    if (vol_ratio or 0) >= 10.0:
        causes.append("거래량폭발(10배↑)")
    elif (vol_ratio or 0) >= 5.0:
        causes.append("거래량폭발(5배↑)")
    elif (vol_ratio or 0) >= 3.0:
        causes.append("거래량급증(3배↑)")
    elif (vol_ratio or 0) >= 2.0:
        causes.append("거래량증가(2배↑)")
    elif (vol_ratio or 0) >= 1.5:
        causes.append("거래량증가(1.5배↑)")

    # 등락률 기반 — 최소 3% 이상이면 반드시 태그
    if change_pct >= 29.0:
        causes.append("상한가(≈30%)")
    elif change_pct >= 10:
        causes.append("급등(10%↑)")
    elif change_pct >= 5:
        causes.append("강세(5%↑)")
    elif change_pct >= 3:
        causes.append("상승(3%↑)")

    # 주요 원인 분류
    if not causes:
        category = "unknown"
    elif "뉴스호재" in causes or "뉴스다량" in causes:
        category = "news"
    elif any("거래량" in c for c in causes):
        category = "volume"
    else:
        category = "momentum"

    return causes, category


# ── 메인 수집 함수 ────────────────────────────────────────────────────
async def collect_rising_stocks(
    db: AsyncSession,
    analysis_date: date,
    min_change_pct: float = 3.0,
    max_stocks: int = 50,
    compute_vol_ratio: bool = False,
) -> dict:
    loop = asyncio.get_event_loop()
    today = date.today()
    is_today = analysis_date >= (today - timedelta(days=1))

    # ── 1. 시장 데이터 조회 ──────────────────────────────────────────
    if is_today:
        # 오늘/어제: 네이버 금융 HTML
        raw_kospi  = await loop.run_in_executor(None, _fetch_naver_risers, 0, 2)
        raw_kosdaq = await loop.run_in_executor(None, _fetch_naver_risers, 1, 2)
        raw_all = raw_kospi + raw_kosdaq
    else:
        # 과거: pykrx 배치 (watchlist + 자주 거래된 종목 우선)
        wl_r = await db.execute(select(Watchlist.stock_code))
        wl_codes = [r[0] for r in wl_r]

        trade_r = await db.execute(
            select(AutoTradeLog.stock_code).distinct()
            .where(AutoTradeLog.trade_date >= analysis_date - timedelta(days=90))
        )
        trade_codes = [r[0] for r in trade_r]

        # 중복 제거하여 최대 300개
        codes = list(dict.fromkeys(wl_codes + trade_codes))[:300]

        if not codes:
            return {
                "analysis_date": str(analysis_date),
                "collected": 0,
                "message": "과거 날짜는 워치리스트/거래 종목 기준으로 조회합니다. 해당 데이터 없음",
            }

        raw_all = await loop.run_in_executor(
            None, _fetch_historical_by_codes, codes, analysis_date, min_change_pct
        )

    if not raw_all:
        return {
            "analysis_date": str(analysis_date),
            "collected": 0,
            "message": f"{analysis_date} 상승 종목 없음 (시장 데이터 미수신 또는 휴장)",
        }

    # ── 2. 등락률 필터 + 상위 max_stocks ────────────────────────────
    filtered = [s for s in raw_all if s["change_pct"] >= min_change_pct]
    filtered.sort(key=lambda x: x["change_pct"], reverse=True)
    filtered = filtered[:max_stocks]

    # ── 3. StockMaster에서 종목명/시장 보완 ──────────────────────────
    codes = [s["code"] for s in filtered]
    sm_r = await db.execute(
        select(StockMaster.stock_code, StockMaster.stock_name, StockMaster.market)
        .where(StockMaster.stock_code.in_(codes))
    )
    sm_map = {r[0]: (r[1], r[2]) for r in sm_r}

    for s in filtered:
        if s["code"] in sm_map:
            if not s.get("name"):
                s["name"] = sm_map[s["code"]][0]
            if not s.get("market"):
                s["market"] = sm_map[s["code"]][1]

    # ── 4. DB 데이터 조회 ───────────────────────────────────────────
    # 당일 BUY 종목
    bought_r = await db.execute(
        select(AutoTradeLog.stock_code, AutoTradeLog.composite_score)
        .where(
            and_(
                AutoTradeLog.trade_date == analysis_date,
                AutoTradeLog.action == "BUY",
                AutoTradeLog.status.in_(["FILLED", "MOCK", "PENDING"]),
            )
        )
    )
    bought_rows = bought_r.all()
    bought_codes = {r[0] for r in bought_rows}
    ai_scores = {r[0]: float(r[1]) for r in bought_rows if r[1]}

    # 워치리스트
    wl_r2 = await db.execute(select(Watchlist.stock_code))
    watchlist_codes = {r[0] for r in wl_r2}

    # 당일 뉴스
    news_r = await db.execute(
        select(NewsItem.stock_codes, NewsItem.sentiment_score, NewsItem.title)
        .where(
            and_(
                NewsItem.published_at >= analysis_date,
                NewsItem.published_at < analysis_date + timedelta(days=1),
                NewsItem.stock_codes.isnot(None),
            )
        )
    )
    news_by_code: dict[str, dict] = {}
    for row in news_r:
        for code in (row[0] or []):
            if code not in news_by_code:
                news_by_code[code] = {"scores": [], "titles": []}
            if row[1] is not None:
                news_by_code[code]["scores"].append(float(row[1]))
            if row[2]:
                news_by_code[code]["titles"].append(row[2])

    # ── 5. 거래량 비율 (옵션, 느림) ──────────────────────────────────
    avg_vol_map: dict[str, float] = {}
    if compute_vol_ratio and is_today:
        # 각 종목의 20일 평균 거래량 pykrx로 조회
        def _get_avg_vols(items: list[dict]) -> dict[str, float]:
            from pykrx import stock as pkrx
            start = (analysis_date - timedelta(days=40)).strftime("%Y%m%d")
            end   = (analysis_date - timedelta(days=1)).strftime("%Y%m%d")
            result: dict[str, float] = {}
            for item in items:
                try:
                    df = pkrx.get_market_ohlcv_by_date(start, end, item["code"])
                    if df is None or df.empty:
                        continue
                    cols = df.columns.tolist()
                    vol_col = cols[4]  # 거래량
                    avg = df[vol_col].tail(20).mean()
                    result[item["code"]] = float(avg) if avg > 0 else 0.0
                except Exception:
                    pass
            return result

        avg_vol_map = await loop.run_in_executor(None, _get_avg_vols, filtered)

    # ── 6. 저장 ─────────────────────────────────────────────────────
    saved = 0
    updated = 0

    for item in filtered:
        code = item["code"]
        volume = item.get("volume", 0) or 0

        # Naver 데이터에서 바로 계산된 전일 대비 거래량 비율 우선 사용
        # compute_vol_ratio=True 시 pykrx 20일 평균 비율로 덮어씀
        vol_ratio: Optional[float] = item.get("vol_ratio")
        avg_vol = avg_vol_map.get(code, 0)
        if avg_vol > 0 and volume > 0:
            vol_ratio = round(volume / avg_vol, 2)

        news_info  = news_by_code.get(code, {})
        ns_scores  = news_info.get("scores", [])
        ns_titles  = news_info.get("titles", [])
        news_sent  = round(sum(ns_scores) / len(ns_scores), 4) if ns_scores else None
        news_count = len(ns_scores)
        top_news   = ns_titles[0] if ns_titles else None

        causes, category = _analyze_causes(
            change_pct=item["change_pct"],
            vol_ratio=vol_ratio,
            news_count=news_count,
            news_sentiment=news_sent,
        )

        try:
            existing_r = await db.execute(
                select(RisingStockLog).where(
                    and_(
                        RisingStockLog.analysis_date == analysis_date,
                        RisingStockLog.stock_code == code,
                    )
                )
            )
            entry = existing_r.scalar_one_or_none()

            if entry:
                entry.change_pct     = item["change_pct"]
                entry.close_price    = item.get("close_price")
                entry.volume         = volume
                entry.trading_value  = item.get("trading_value")
                entry.volume_ratio   = vol_ratio
                entry.news_sentiment = news_sent
                entry.news_count     = news_count
                entry.top_news       = top_news
                entry.rise_causes    = causes
                entry.rise_category  = category
                entry.was_bought     = code in bought_codes
                entry.ai_score       = ai_scores.get(code)
                updated += 1
            else:
                entry = RisingStockLog(
                    analysis_date    = analysis_date,
                    stock_code       = code,
                    stock_name       = item.get("name") or code,
                    market           = item.get("market") or "KOSPI",
                    close_price      = item.get("close_price"),
                    change_pct       = item["change_pct"],
                    volume           = volume,
                    trading_value    = item.get("trading_value"),
                    volume_ratio     = vol_ratio,
                    news_sentiment   = news_sent,
                    news_count       = news_count,
                    top_news         = top_news,
                    rise_causes      = causes,
                    rise_category    = category,
                    was_in_watchlist = code in watchlist_codes,
                    was_bought       = code in bought_codes,
                    ai_score         = ai_scores.get(code),
                )
                db.add(entry)
                saved += 1
        except Exception as e:
            logger.warning(f"[상승분석] {code} 저장 실패: {e}")

    await db.commit()

    return {
        "analysis_date": str(analysis_date),
        "total_rising":  len(filtered),
        "saved":         saved,
        "updated":       updated,
        "message":       (
            f"{analysis_date} 상승 종목 {len(filtered)}개 분석 완료 "
            f"(신규 {saved}개, 갱신 {updated}개)"
        ),
    }
