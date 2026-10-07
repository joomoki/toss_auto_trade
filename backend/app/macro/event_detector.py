"""
매크로 이벤트 감지기

데이터 소스:
  yfinance  — 유가(CL=F/BZ=F), 환율(KRW=X), VIX(^VIX), 금(GC=F), 美국채(^TNX)
  뉴스 DB   — 정책·지정학·금리 관련 키워드 클러스터링
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_CACHE: dict[str, tuple[float, object]] = {}
_CACHE_TTL = 1800  # 30분


def _cache_get(key: str):
    import time
    if key in _CACHE:
        ts, v = _CACHE[key]
        if time.time() - ts < _CACHE_TTL:
            return v
    return None


def _cache_set(key: str, v: object):
    import time
    _CACHE[key] = (time.time(), v)


# ── yfinance 헬퍼 ─────────────────────────────────────────────────────────────

def _fetch_price_info(ticker: str, period: str = "10d") -> dict:
    """종가 시리즈 반환: {last, prev, chg_pct, five_day_pct}"""
    key = f"yf_{ticker}"
    cached = _cache_get(key)
    if cached is not None:
        return cached  # type: ignore

    neutral = {"last": 0.0, "prev": 0.0, "chg_pct": 0.0, "five_day_pct": 0.0}
    try:
        import yfinance as yf
        hist = yf.Ticker(ticker).history(period=period)
        if hist is None or len(hist) < 2:
            logger.warning(f"[매크로] {ticker} 데이터 부족 (rows={len(hist) if hist is not None else 0})")
            return neutral
        closes = hist["Close"].dropna().tolist()
        last   = closes[-1]
        prev   = closes[-2]
        chg    = (last - prev) / (abs(prev) + 1e-9) * 100
        five_d = (last - closes[-6]) / (abs(closes[-6]) + 1e-9) * 100 if len(closes) >= 6 else chg
        result = {"last": last, "prev": prev, "chg_pct": chg, "five_day_pct": five_d}
        logger.info(f"[매크로] {ticker} last={last:.4f} chg={chg:+.3f}% 5d={five_d:+.3f}%")
        _cache_set(key, result)
        return result
    except Exception as e:
        logger.warning(f"[매크로] yfinance {ticker} 조회 실패: {e}")
        return neutral


# ── 뉴스 키워드 스캔 ──────────────────────────────────────────────────────────

async def _scan_news(keywords: list[str], hours_back: int = 24) -> tuple[int, float]:
    """키워드 매칭 기사 수, 평균 감성 스코어 반환"""
    if not keywords:
        return 0, 0.5
    try:
        from app.core.database import AsyncSessionLocal
        from app.models.news import NewsItem
        from sqlalchemy import select, or_
        from datetime import timezone as tz

        cutoff = datetime.now(tz.utc) - timedelta(hours=hours_back)
        async with AsyncSessionLocal() as db:
            conds = [NewsItem.title.ilike(f"%{kw}%") for kw in keywords]
            r = await db.execute(
                select(NewsItem)
                .where(NewsItem.published_at >= cutoff)
                .where(or_(*conds))
                .limit(50)
            )
            items = r.scalars().all()
            if not items:
                return 0, 0.5
            scores = [float(i.sentiment_score or 0.5) for i in items]
            return len(items), sum(scores) / len(scores)
    except Exception as e:
        logger.debug(f"뉴스 스캔 실패: {e}")
        return 0, 0.5


# ── 이벤트별 감지 함수 ────────────────────────────────────────────────────────

def _detect_oil(cfg: dict) -> dict | None:
    """유가 급변 감지"""
    wti  = _fetch_price_info("CL=F")
    brent = _fetch_price_info("BZ=F")
    chg   = (wti["chg_pct"] + brent["chg_pct"]) / 2
    five  = (wti["five_day_pct"] + brent["five_day_pct"]) / 2

    thres = cfg.get("thresholds", {})
    daily_t = thres.get("daily_pct", 3.0)
    five_t  = thres.get("five_day_pct", 8.0)

    magnitude = 0.0
    if abs(chg) >= abs(daily_t):
        magnitude = min(1.0, abs(chg) / (abs(daily_t) * 3))
    elif abs(five) >= abs(five_t):
        magnitude = min(0.7, abs(five) / (abs(five_t) * 2))

    if magnitude < 0.1:
        return None

    direction = "rise" if chg > 0 else "fall"
    return {
        "magnitude":   magnitude,
        "confidence":  0.9,
        "persistence": min(1.0, abs(five) / (abs(five_t) + 1e-9)),
        "evidence":    [f"WTI/Brent 평균 일변동 {chg:.1f}%, 5일 {five:.1f}%"],
        "direction":   direction,
    }


def _detect_fx(cfg: dict) -> dict | None:
    """원달러 환율 급변 감지"""
    krw = _fetch_price_info("KRW=X")
    chg = krw["chg_pct"]
    lvl = krw["last"]

    thres = cfg.get("thresholds", {})
    daily_t = abs(thres.get("daily_pct", 0.7))  # YAML에 음수로 정의될 수 있어 abs() 강제
    level_t = thres.get("level", 1400)

    magnitude = 0.0
    if abs(chg) >= daily_t:
        magnitude = min(1.0, abs(chg) / (daily_t * 3 + 1e-9))
    if abs(lvl - level_t) < 20:  # 레벨 근접
        magnitude = max(magnitude, 0.4)

    if magnitude < 0.1:
        return None

    direction = "weak" if chg > 0 else "strong"
    return {
        "magnitude":   magnitude,
        "confidence":  0.85,
        "persistence": 0.5,
        "evidence":    [f"USD/KRW {lvl:.1f} (일변동 {chg:+.2f}%)"],
        "direction":   direction,
    }


def _detect_rates(cfg: dict) -> dict | None:
    """미 국채 금리 급변 감지"""
    tnx = _fetch_price_info("^TNX")
    # ^TNX는 수익률(%)이므로 bp 변환
    chg_bp = tnx["chg_pct"] * 10  # 대략적 변환

    thres = cfg.get("thresholds", {})
    bp_t = abs(thres.get("daily_bp", 5))  # YAML에 음수(-5)로 정의될 수 있어 abs() 강제

    if abs(chg_bp) < bp_t:
        return None

    direction = "rise" if chg_bp > 0 else "fall"
    magnitude = min(1.0, abs(chg_bp) / (bp_t * 4 + 1e-9))
    return {
        "magnitude":   magnitude,
        "confidence":  0.85,
        "persistence": 0.5,
        "evidence":    [f"美 10년물 {tnx['last']:.2f}% (일변동 {chg_bp:+.0f}bp)"],
        "direction":   direction,
    }


def _detect_geopolitical(cfg: dict, news_count: int, news_sentiment: float) -> dict | None:
    """VIX 급등 + 지정학 뉴스 클러스터 감지"""
    vix  = _fetch_price_info("^VIX")
    gold = _fetch_price_info("GC=F")

    thres = cfg.get("thresholds", {})
    vix_t   = thres.get("vix_level", 25)
    vix_chg = thres.get("vix_change_pct", 15)

    geo_score = 0.0
    evidence  = []

    if vix["last"] >= vix_t:
        geo_score += 0.4
        evidence.append(f"VIX {vix['last']:.1f} (기준 {vix_t})")
    if vix["chg_pct"] >= vix_chg:
        geo_score += 0.3
        evidence.append(f"VIX 일변동 +{vix['chg_pct']:.1f}%")
    if gold["chg_pct"] > 1.0:
        geo_score += 0.2
        evidence.append(f"금 +{gold['chg_pct']:.1f}% (안전자산 선호)")
    if news_count >= 3:
        geo_score += 0.1 * min(news_count / 10, 1.0)
        evidence.append(f"지정학 뉴스 {news_count}건")

    if geo_score < 0.25:
        return None

    return {
        "magnitude":   min(1.0, geo_score),
        "confidence":  0.7 + (0.2 if news_count >= 5 else 0),
        "persistence": 0.5,
        "evidence":    evidence,
        "direction":   "risk_on" if geo_score < 0.25 else "risk_off",
    }


def _detect_policy(keywords: list[str], news_count: int, news_sentiment: float) -> dict | None:
    """뉴스 키워드 기반 정책 이벤트 감지"""
    if news_count < 2:
        return None

    magnitude = min(1.0, news_count / 10)
    confidence = min(0.9, 0.5 + news_count * 0.05)
    return {
        "magnitude":   magnitude,
        "confidence":  confidence,
        "persistence": 0.6,
        "evidence":    [f"관련 뉴스 {news_count}건 (감성 {news_sentiment:.2f})"],
        "direction":   "positive" if news_sentiment > 0.55 else "neutral",
    }


# ── 공개 API ─────────────────────────────────────────────────────────────────

async def detect_events(map_cfg: dict) -> list[dict]:
    """
    활성 이벤트 목록 반환.
    각 항목: event_id, name, category, magnitude, confidence, persistence, score, evidence
    """
    from app.macro.schemas import MacroEvent, EventCategory

    events_cfg = map_cfg.get("events", {})
    results: list[MacroEvent] = []
    now = datetime.now(timezone.utc)

    for event_id, cfg in events_cfg.items():
        raw: dict | None = None
        category = cfg.get("category", "market")

        keywords: list[str] = cfg.get("keywords", [])
        news_count, news_sentiment = 0, 0.5
        if keywords:
            news_count, news_sentiment = await _scan_news(keywords, hours_back=24)

        try:
            if event_id == "oil_rise":
                r = _detect_oil(cfg)
                if r and r["direction"] == "rise":
                    raw = r
            elif event_id == "oil_fall":
                r = _detect_oil(cfg)
                if r and r["direction"] == "fall":
                    raw = r
            elif event_id in ("krw_weak", "krw_strong"):
                r = _detect_fx(cfg)
                if r:
                    expected = "weak" if event_id == "krw_weak" else "strong"
                    if r["direction"] == expected:
                        raw = r
            elif event_id == "rate_rise":
                r = _detect_rates(cfg)
                if r and r["direction"] == "rise":
                    raw = r
                elif news_count >= 3 and news_sentiment > 0.55:
                    raw = _detect_policy(keywords, news_count, news_sentiment)
            elif event_id == "rate_fall":
                r = _detect_rates(cfg)
                if r and r["direction"] == "fall":
                    raw = r
                elif news_count >= 3 and news_sentiment < 0.45:
                    raw = _detect_policy(keywords, news_count, news_sentiment)
            elif event_id == "geopolitical":
                raw = _detect_geopolitical(cfg, news_count, news_sentiment)
            elif event_id == "inflation_high":
                if news_count >= 2:
                    raw = _detect_policy(keywords, news_count, news_sentiment)
            else:
                # policy_* 이벤트
                raw = _detect_policy(keywords, news_count, news_sentiment)

        except Exception as e:
            logger.warning(f"이벤트 감지 오류 [{event_id}]: {e}")

        if raw:
            # [0, 1] 범위 보장 — 음수 magnitude가 Pydantic 검증 오류를 내지 않도록 클램프
            m = max(0.0, min(1.0, raw["magnitude"]))
            c = max(0.0, min(1.0, raw["confidence"]))
            p = max(0.0, min(1.0, raw["persistence"]))
            score = round(m * 0.4 + c * 0.35 + p * 0.25, 4)
            if score >= 0.15:  # 최소 임계값
                try:
                    cat = EventCategory(category)
                except Exception:
                    cat = EventCategory.MARKET
                results.append(MacroEvent(
                    event_id=event_id,
                    name=cfg["name"],
                    category=cat,
                    magnitude=round(m, 4),
                    confidence=round(c, 4),
                    persistence=round(p, 4),
                    score=score,
                    detected_at=now,
                    evidence=raw.get("evidence", []),
                ))

    return results
