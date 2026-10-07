"""
매크로 섹터 기반 전종목 스크리너
==============================================
실행 흐름:
  1) 매크로 이벤트 감지 → 수혜 섹터(LONG) 선별
  2) pykrx로 코스피/코스닥 전종목 조회
     - 거래대금 필터 (일평균 ≥ min_vol_won)
     - 시가총액 필터 (≥ min_market_cap)
  3) 섹터 매핑
     - YAML 대표종목 코드 직접 매칭
     - pykrx 업종 분류 → 섹터 확장 매핑
  4) 상위 max_stocks 종목에 M1-M10 AI 모델 적용
  5) 종합 점수 계산 → screened_stocks 테이블 저장
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.macro.event_detector import detect_events
from app.macro.sector_mapper import compute_sector_signals, get_sector_stocks, load_map_config
from app.macro.schemas import SignalDirection
from app.ml.feature_engineering import compute as fe_compute
from app.ml.multi_models import run_all_models
from app.services.stock_screener import save_screen_results

logger = logging.getLogger(__name__)

# ── 거래대금/시총 기준 ──────────────────────────────────────────────
_MIN_VOL_WON        = 2_000_000_000    # 일평균 거래대금 20억원 (코스닥 포함 확대)
_MIN_MARKET_CAP     = 30_000_000_000   # 시가총액 300억원 (코스닥 중소형주 포함)
_MAX_STOCKS         = 150              # M1-M10 적용 최대 종목 수 (80 → 150)
_CONCURRENCY        = 8                # 동시 OHLCV API 호출 수
_SECTOR_FILL_RATIO  = 0.6              # 전체 후보 중 섹터매핑 종목 비율 (나머지는 유니버스 보충)

# ── pykrx 업종명 → 내부 섹터 ID 매핑 ──────────────────────────────
# pykrx get_market_sector_classifications() 반환 '섹터' 컬럼값(GICS) → sector_id
_GICS_TO_SECTORS: dict[str, list[str]] = {
    "에너지":               ["energy"],
    "소재":                 ["chemicals", "gold_materials"],
    "산업재":               ["shipbuilding", "defense", "construction"],
    "경기소비재":            ["airline", "auto", "beauty"],
    "필수소비재":            ["beauty"],
    "의료":                 ["growth"],
    "금융":                 ["finance"],
    "정보기술":              ["semiconductor", "growth"],
    "커뮤니케이션서비스":     ["growth"],
    "유틸리티":              ["nuclear"],
    "부동산":               ["construction"],
    # 코스닥 GICS 표기
    "IT":                   ["semiconductor", "growth"],
    "제조":                 ["chemicals", "auto"],
    "서비스업":              ["growth"],
    "의약품":               ["growth"],
    "기술장비":              ["semiconductor", "growth"],
    "소프트웨어":            ["growth"],
    "통신서비스":            ["growth"],
    "하드웨어":              ["semiconductor"],
    "반도체":               ["semiconductor"],
}

# 종목명 키워드 → 섹터 (pykrx 업종 분류 실패 시 fallback)
_NAME_KEYWORDS: dict[str, list[str]] = {
    "반도체":   ["semiconductor"],
    "디스플레": ["semiconductor"],
    "디스플":   ["semiconductor"],
    "조선":    ["shipbuilding"],
    "항공우주": ["defense"],
    "방산":    ["defense"],
    "항공":    ["airline"],
    "여행":    ["airline"],
    "정유":    ["energy"],
    "에너지":  ["energy"],
    "화학":    ["chemicals"],
    "소재":    ["chemicals"],
    "은행":    ["finance"],
    "금융":    ["finance"],
    "보험":    ["finance"],
    "증권":    ["finance"],
    "캐피탈":  ["finance"],
    "자동차":  ["auto"],
    "모비스":  ["auto"],
    "건설":    ["construction"],
    "철강":    ["gold_materials"],
    "화장품":  ["beauty"],
    "코스메":  ["beauty"],
    "바이오":  ["growth"],
    "제약":    ["growth"],
    "헬스":    ["growth"],
    "의료":    ["growth"],
    "진단":    ["growth"],
    "원전":    ["nuclear"],
    "원자력":  ["nuclear"],
    # 코스닥 특화 키워드
    "게임":    ["growth"],
    "엔터":    ["growth"],
    "콘텐츠":  ["growth"],
    "배터리":  ["semiconductor"],
    "2차전지": ["semiconductor"],
    "전기차":  ["auto", "semiconductor"],
    "로봇":    ["growth", "semiconductor"],
    "인공지능": ["growth", "semiconductor"],
    "클라우드": ["growth"],
    "소프트":  ["growth"],
    "플랫폼":  ["growth"],
    "솔루션":  ["growth"],
    "전자":    ["semiconductor"],
    "부품":    ["semiconductor"],
    "센서":    ["semiconductor"],
    "카메라":  ["semiconductor"],
}


# ── pykrx 유틸 ─────────────────────────────────────────────────────

async def _pykrx_run(fn, *args, **kwargs):
    """pykrx 동기 함수를 스레드 풀에서 실행"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))


async def _get_market_universe(
    min_vol_won: int = _MIN_VOL_WON,
    min_market_cap: int = _MIN_MARKET_CAP,
    max_stock_price: int = 0,
) -> dict[str, dict]:
    """
    코스피 + 코스닥 전종목 중 거래대금·시총 기준을 통과한 종목 반환.
    반환: {code: {"name": str, "vol_won": int, "market_cap": int, "gics": str}}
    """
    from pykrx import stock as krx

    today_str = None
    # OHLCV 실제 가용성 확인: ticker list가 있어도 OHLCV가 없을 수 있음 (장 초반)
    # 최근 5일 중 OHLCV가 정상 반환되는 가장 최근 날짜 사용
    for delta in range(1, 6):  # 전일부터 시작 (당일 OHLCV는 장 초반에 미완성)
        ref_date = (date.today() - timedelta(days=delta)).strftime("%Y%m%d")
        try:
            test_df = await _pykrx_run(krx.get_market_ohlcv_by_ticker, ref_date, market="KOSPI")
            if test_df is not None and len(test_df) > 50:
                today_str = ref_date
                break
        except Exception:
            continue
    if today_str is None:
        logger.warning("pykrx: 유효한 OHLCV 데이터 날짜를 찾지 못함 — 유니버스 구성 실패")
        return {}

    universe: dict[str, dict] = {}

    for market in ("KOSPI", "KOSDAQ"):
        try:
            # 전종목 OHLCV + 거래대금 (batch)
            ohlcv_df = await _pykrx_run(
                krx.get_market_ohlcv_by_ticker, today_str, market=market
            )
            # 전종목 시가총액 + 종목명 (batch)
            cap_df = await _pykrx_run(
                krx.get_market_cap_by_ticker, today_str, market=market
            )
        except Exception as e:
            logger.warning(f"pykrx {market} 조회 실패: {e}")
            continue

        # 컬럼명 정규화
        vol_col = next(
            (c for c in ohlcv_df.columns if "거래대금" in c or "TradingValue" in c.lower()),
            None,
        )
        close_col = next(
            (c for c in ohlcv_df.columns if "종가" in c or c.lower() == "close"),
            None,
        )
        cap_col = next(
            (c for c in cap_df.columns if "시가총액" in c or "MarketCap" in c.lower()),
            None,
        )
        name_col = next(
            (c for c in cap_df.columns if "종목명" in c or "Name" in c.lower()),
            None,
        )

        if not vol_col or not cap_col:
            logger.warning(f"pykrx {market} 컬럼 미확인: {ohlcv_df.columns.tolist()}")
            continue

        for code in ohlcv_df.index:
            try:
                vol   = float(ohlcv_df.loc[code, vol_col])
                close = float(ohlcv_df.loc[code, close_col]) if close_col else 0
                cap   = float(cap_df.loc[code, cap_col]) if code in cap_df.index else 0
                name  = str(cap_df.loc[code, name_col]) if name_col and code in cap_df.index else code
                if max_stock_price > 0 and close > max_stock_price:
                    continue
                if vol >= min_vol_won and cap >= min_market_cap:
                    universe[str(code)] = {
                        "name":       name,
                        "vol_won":    int(vol),
                        "market_cap": int(cap),
                        "gics":       "",
                    }
            except Exception:
                continue

    # GICS 섹터 분류 추가 (실패해도 계속)
    for market in ("KOSPI", "KOSDAQ"):
        try:
            sec_df = await _pykrx_run(
                krx.get_market_sector_classifications, today_str, market=market
            )
            # 인덱스가 종목코드인지 확인
            sector_col = next(
                (c for c in sec_df.columns if "섹터" in c or "sector" in c.lower()),
                None,
            )
            if sector_col:
                for code in sec_df.index:
                    if str(code) in universe:
                        universe[str(code)]["gics"] = str(sec_df.loc[code, sector_col])
        except Exception as e:
            logger.debug(f"pykrx {market} GICS 분류 실패: {e}")

    logger.info(f"pykrx 유니버스 구성: {len(universe)}종목 (거래대금·시총 필터 적용)")
    return universe


def _map_to_sectors(
    universe: dict[str, dict],
    favorable_sector_ids: set[str],
    yaml_stocks_by_sector: dict[str, set[str]],
) -> dict[str, set[str]]:
    """
    종목코드 → 해당 섹터 집합 매핑.
    우선순위: YAML 대표종목 > GICS 분류 > 종목명 키워드
    반환: {sector_id: {code, ...}}
    """
    sector_to_codes: dict[str, set[str]] = {sid: set() for sid in favorable_sector_ids}

    # 1) YAML 대표종목
    for sid in favorable_sector_ids:
        for code in yaml_stocks_by_sector.get(sid, set()):
            if code in universe:
                sector_to_codes[sid].add(code)

    # 2) pykrx GICS 분류
    for code, info in universe.items():
        gics = info.get("gics", "")
        if not gics:
            continue
        mapped = _GICS_TO_SECTORS.get(gics, [])
        for sid in mapped:
            if sid in favorable_sector_ids:
                sector_to_codes[sid].add(code)

    # 3) 종목명 키워드 fallback
    for code, info in universe.items():
        name = info.get("name", "")
        for kw, sids in _NAME_KEYWORDS.items():
            if kw in name:
                for sid in sids:
                    if sid in favorable_sector_ids:
                        sector_to_codes[sid].add(code)

    return sector_to_codes


# ── 메인 스크리닝 함수 ──────────────────────────────────────────────

async def run_sector_screening(
    db: AsyncSession,
    min_vol_won: int = _MIN_VOL_WON,
    min_market_cap: int = _MIN_MARKET_CAP,
    min_sector_score: float = 0.15,
    max_stocks: int = _MAX_STOCKS,
    max_stock_price: int = 0,
) -> list[dict]:
    """
    매크로 섹터 기반 전종목 스크리닝 실행 후 screened_stocks 저장.
    반환: 저장된 결과 dict 목록
    """
    # ── 1. 매크로 이벤트 감지 ────────────────────────────────────
    try:
        map_cfg = load_map_config()
        events = await detect_events(map_cfg)
    except Exception as e:
        logger.error(f"매크로 이벤트 감지 실패: {e}")
        events = []

    if not events:
        logger.warning("감지된 매크로 이벤트 없음 — 전체 유니버스 기반 스크리닝으로 폴백")

    sector_signals = compute_sector_signals(events) if events else []

    # LONG 섹터 추출
    long_sectors = [
        s for s in sector_signals
        if s.direction == SignalDirection.LONG and s.net_score >= min_sector_score
    ]

    # 이벤트가 없거나 LONG 섹터가 없으면 모든 섹터 대상
    if not long_sectors:
        logger.info("LONG 섹터 없음 — YAML 전 섹터 대상으로 스크리닝")
        cfg = load_map_config()
        favorable_sector_ids = set(cfg.get("sectors", {}).keys())
    else:
        favorable_sector_ids = {s.sector_id for s in long_sectors}
        sector_info = ", ".join(
            f"{s.sector_name}({s.net_score:+.2f})" for s in long_sectors
        )
        logger.info(f"수혜 섹터: {sector_info}")

    # ── 2. YAML 대표종목 수집 ────────────────────────────────────
    yaml_stocks_by_sector: dict[str, set[str]] = {}
    for sid in favorable_sector_ids:
        stocks = get_sector_stocks(sid)
        yaml_stocks_by_sector[sid] = {s["code"] for s in stocks}

    # ── 3. pykrx 전종목 유니버스 구성 (거래대금·시총 필터) ────────
    universe = await _get_market_universe(min_vol_won, min_market_cap, max_stock_price)

    # YAML 대표종목: 필터 미통과 종목도 포함 + YAML 이름을 항상 덮어씀
    # (pykrx가 종목명 없이 코드만 반환하는 경우를 방지)
    for sid in favorable_sector_ids:
        for s_info in get_sector_stocks(sid):
            code = s_info["code"]
            yaml_name = s_info["name"]
            if code in universe:
                universe[code]["name"] = yaml_name  # 항상 YAML 이름으로 덮어씀
            else:
                universe[code] = {
                    "name":       yaml_name,
                    "vol_won":    0,
                    "market_cap": 0,
                    "gics":       "",
                }

    # ── 4. 섹터 매핑 ─────────────────────────────────────────────
    sector_to_codes = _map_to_sectors(universe, favorable_sector_ids, yaml_stocks_by_sector)

    # 섹터 내 상위 종목 선정 (거래대금 내림차순)
    candidate_pool: list[tuple[str, str, str]] = []  # (code, name, sector_id)
    seen: set[str] = set()
    for sid in sorted(sector_to_codes, key=lambda s: _sector_score(s, sector_signals), reverse=True):
        codes_in_sector = sector_to_codes[sid]
        sorted_codes = sorted(
            codes_in_sector,
            key=lambda c: universe[c]["vol_won"],
            reverse=True,
        )
        for code in sorted_codes:
            if code not in seen:
                candidate_pool.append((code, universe[code]["name"], sid))
                seen.add(code)

    # ── 섹터 미매핑 유니버스 종목 보충 (코스닥 포함 확대) ──────────
    # 섹터 매핑 결과가 max_stocks의 SECTOR_FILL_RATIO 미만이면 나머지 슬롯을
    # 유니버스 전체에서 거래대금 상위 순으로 채움 (섹터 무관 종목 포함)
    sector_fill_target = int(max_stocks * _SECTOR_FILL_RATIO)
    if len(candidate_pool) < sector_fill_target:
        fill_target = sector_fill_target
    else:
        fill_target = max_stocks

    remaining_slots = fill_target - len(candidate_pool)
    if remaining_slots > 0:
        supplement = [
            (code, info["name"], "general")
            for code, info in sorted(universe.items(), key=lambda x: x[1]["vol_won"], reverse=True)
            if code not in seen
        ][:remaining_slots]
        candidate_pool.extend(supplement)
        seen.update(c for c, _, _ in supplement)
        logger.info(
            f"유니버스 보충: {len(supplement)}종목 추가 "
            f"(섹터매핑 {fill_target - remaining_slots}개 + 보충 {len(supplement)}개)"
        )

    # 섹터 매핑 결과가 충분하면 max_stocks까지 추가 확장
    if len(candidate_pool) < max_stocks:
        extra_slots = max_stocks - len(candidate_pool)
        extra = [
            (code, info["name"], "general")
            for code, info in sorted(universe.items(), key=lambda x: x[1]["vol_won"], reverse=True)
            if code not in seen
        ][:extra_slots]
        candidate_pool.extend(extra)
        seen.update(c for c, _, _ in extra)

    logger.info(f"최종 후보 종목: {len(candidate_pool)}개 → 상위 {max_stocks}개 스코어링")
    candidate_pool = candidate_pool[:max_stocks]

    # ── 5. M1-M10 + 뉴스·DART·수급 점수 계산 ──────────────────
    results = await _score_candidates(candidate_pool, db, max_stock_price)

    if not results:
        logger.warning("스코어링 결과 없음")
        return []

    # 종합 점수 반영
    market_score = _calc_market_score()
    from app.services.auto_trade_engine import W_MODEL, W_NEWS, W_DART, W_MARKET, W_SUPPLY
    for r in results:
        r["composite_score"] = (
            r.get("model_score",  0.5) * W_MODEL
            + r.get("news_score", 0.5) * W_NEWS
            + r.get("dart_score", 0.5) * W_DART
            + market_score              * W_MARKET
            + r.get("supply_score",0.5) * W_SUPPLY
        )
        r["market_score"] = market_score
        r["style"] = "full"

    results.sort(key=lambda x: x["composite_score"], reverse=True)

    # 매크로 섹터 신호 로그
    for r in results:
        sector_id = r.get("sector_id", "")
        sig = next((s for s in sector_signals if s.sector_id == sector_id), None)
        r["macro_sector_score"] = sig.net_score if sig else 0.0
        r["macro_sector_name"]  = sig.sector_name if sig else ""

    # ── 6. DB 저장 ───────────────────────────────────────────────
    saved = await save_screen_results(db, results)
    await db.commit()
    logger.info(f"섹터 스크리닝 완료: {len(saved)}건 저장 (시장점수={market_score:.2f})")
    return results


def _sector_score(sector_id: str, signals: list) -> float:
    sig = next((s for s in signals if s.sector_id == sector_id), None)
    return sig.net_score if sig else 0.0


def _calc_market_score() -> float:
    from datetime import datetime
    now = datetime.now()
    hour, wd = now.hour, now.weekday()
    if 9 <= hour < 10:     ts = 0.75
    elif 10 <= hour < 14:  ts = 0.85
    elif 14 <= hour < 15:  ts = 0.70
    elif 15 <= hour < 16:  ts = 0.60
    else:                  ts = 0.50
    dw = [0.80, 0.85, 0.88, 0.85, 0.75][wd] if wd < 5 else 0.50
    return round((ts + dw) / 2, 4)


async def _score_candidates(
    candidates: list[tuple[str, str, str]],  # (code, name, sector_id)
    db: AsyncSession,
    max_stock_price: int = 0,
) -> list[dict]:
    """M1-M10 + 뉴스·DART·수급 동시 실행 (세마포어로 API 부하 제어)"""
    from app.services.toss_api import TossApiClient
    from app.services.dart_collector import get_dart_score_for_stock
    from app.services.supply_demand_service import get_supply_score
    from app.models.news import NewsItem
    from sqlalchemy import select, and_
    from datetime import datetime, timezone, timedelta

    api = TossApiClient.get_instance()
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _score_one(code: str, name: str, sector_id: str) -> Optional[dict]:
        async with sem:
            try:
                # ── 가격 먼저 확인 (단가 상한 초과 시 ML 계산 생략) ──
                price_info    = await api.get_current_price(code)
                current_price = int(price_info.get("price", 0))
                if max_stock_price > 0 and current_price > max_stock_price:
                    logger.debug(f"[가격필터] {code} {name} {current_price:,}원 > 상한 {max_stock_price:,}원 → 제외")
                    return None

                # Kiwoom API 종목명 우선, 없으면 YAML/pykrx 이름 사용
                api_name = price_info.get("name", "").strip()
                resolved_name = api_name if api_name else name

                df = await api.get_ohlcv(code, count=200)
                if df.empty or len(df) < 60:
                    return None
                df = fe_compute(df)
                if df.empty:
                    return None

                model_res = run_all_models(df)
                composite  = model_res.get("composite_score", 0.5)
                final_sig  = model_res.get("final_signal", "HOLD")
                model_scores = {
                    mid: {"score": model_res[mid]["score"], "signal": model_res[mid]["signal"]}
                    for mid in ["M1","M2","M3","M4","M5","M6","M7","M8","M9","M10"]
                    if mid in model_res
                }
                trigger_models = [m for m, r in model_scores.items() if r["signal"] == "BUY"]

                # 뉴스 감성 (24h)
                # stock_codes 배열 매칭(any) OR 종목명 제목 검색 — 워치리스트/비워치리스트 모두 커버
                news_score = 0.5
                try:
                    from sqlalchemy import or_
                    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
                    name_conds = [NewsItem.stock_codes.any(code)]  # type: ignore
                    if resolved_name:
                        name_conds.append(NewsItem.title.ilike(f"%{resolved_name}%"))
                    news_r = await db.execute(
                        select(NewsItem).where(
                            and_(
                                NewsItem.collected_at >= cutoff,
                                NewsItem.sentiment_score.isnot(None),
                                or_(*name_conds),
                            )
                        ).limit(50)
                    )
                    news = news_r.scalars().all()
                    if news:
                        avg = sum(float(n.sentiment_score) for n in news) / len(news)
                        news_score = round((avg + 1) / 2, 4)
                except Exception as _ne:
                    logger.debug(f"[뉴스감성] {code} 오류: {_ne}")

                dart_score   = await get_dart_score_for_stock(db, code, days=7)
                supply_score = await get_supply_score(code, days=5)

                return {
                    "stock_code":    code,
                    "stock_name":    resolved_name,
                    "sector_id":     sector_id,
                    "current_price": current_price,
                    "model_score":   composite,
                    "news_score":    news_score,
                    "dart_score":    dart_score,
                    "supply_score":  supply_score,
                    "model_scores":  model_scores,
                    "final_signal":  final_sig,
                    "trigger_models": trigger_models,
                    "composite_score": 0.0,  # 이후 갱신
                }
            except Exception as e:
                logger.debug(f"{code} 스코어링 실패: {e}")
                return None

    tasks = [_score_one(c, n, s) for c, n, s in candidates]
    results_raw = await asyncio.gather(*tasks)
    return [r for r in results_raw if r is not None]


# ── 공개 편의 함수 ──────────────────────────────────────────────────

async def get_favorable_sectors() -> list[dict]:
    """현재 매크로 신호 기반 수혜 섹터 목록 반환 (API 응답용)"""
    try:
        map_cfg = load_map_config()
        events = await detect_events(map_cfg)
    except Exception:
        events = []
    signals = compute_sector_signals(events) if events else []
    return [
        {
            "sector_id":   s.sector_id,
            "sector_name": s.sector_name,
            "net_score":   s.net_score,
            "direction":   s.direction.value,
            "contributions": [
                {
                    "event_name":   c.event_name,
                    "contribution": c.contribution,
                }
                for c in s.contributions
            ],
        }
        for s in signals
    ]
