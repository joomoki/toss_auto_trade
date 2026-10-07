"""
가치주 스크리너 — 저PER·저PBR·고배당 기반 장기보유 후보 종목 발굴
데이터: Naver Finance itemSummary API + HTML 배당수익률 파싱
pykrx 의존성 없음
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, timedelta

import aiohttp

logger = logging.getLogger(__name__)

_PER_MIN        = 3.0
_PER_MAX        = 15.0
_PBR_MAX        = 1.5
_DIV_MIN        = 0.5
_CAP_MIN_MILLION = 300_000        # 3,000억원 = 300,000 (Naver marketSum 단위: 백만원)
_MAX_CANDIDATES = 20
_SEMAPHORE      = 30             # 동시 HTTP 요청 수

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://finance.naver.com/",
}


def _last_weekday() -> str:
    """오늘 또는 가장 최근 평일 (YYYYMMDD)"""
    d = date.today()
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.strftime("%Y%m%d")


# _find_ref_date: auto_trade_engine에서 import하므로 alias 유지
def _find_ref_date() -> str:
    return _last_weekday()


async def _fetch_item_summary(
    session: aiohttp.ClientSession,
    code: str,
    sem: asyncio.Semaphore,
) -> dict | None:
    """Naver itemSummary: per, pbr, marketSum(백만원) 반환"""
    url = f"https://api.finance.naver.com/service/itemSummary.nhn?itemcode={code}"
    async with sem:
        try:
            async with session.get(url, headers=_HEADERS, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json(content_type=None)
                return data
        except Exception:
            return None


async def _fetch_dividend(
    session: aiohttp.ClientSession,
    code: str,
    sem: asyncio.Semaphore,
) -> float:
    """Naver Finance 개별 페이지에서 배당수익률 파싱 (<em id="_dvr">)"""
    url = f"https://finance.naver.com/item/main.naver?code={code}"
    async with sem:
        try:
            async with session.get(url, headers=_HEADERS, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return 0.0
                html = await resp.text()
                m = re.search(r'<em id="_dvr">([\d.]+)</em>', html)
                return float(m.group(1)) if m else 0.0
        except Exception:
            return 0.0


async def get_stock_fundamentals(code: str) -> dict:
    """단일 종목 PER/PBR 조회 (장기보유 재검증용)"""
    async with aiohttp.ClientSession() as session:
        sem = asyncio.Semaphore(1)
        data = await _fetch_item_summary(session, code, sem)
        if not data:
            return {"per": 0.0, "pbr": 0.0}
        return {
            "per": float(data.get("per") or 0),
            "pbr": float(data.get("pbr") or 0),
        }


async def _get_universe() -> list[tuple[str, str]]:
    """DB stock_master에서 KOSPI/KOSDAQ 종목 목록 반환 [(code, name), ...]"""
    try:
        import asyncpg
        conn = await asyncpg.connect(
            "postgresql://toss_stock:toss_stock@localhost:5432/toss_auto_trade"
        )
        rows = await conn.fetch(
            "SELECT stock_code, stock_name FROM stock_master "
            "WHERE market IN ('KOSPI', 'KOSDAQ') ORDER BY stock_code"
        )
        await conn.close()
        return [(r["stock_code"], r["stock_name"]) for r in rows]
    except Exception as e:
        logger.warning(f"[가치주스크리닝] DB 종목 목록 조회 실패: {e}")
        return []


async def screen_value_stocks(
    exclude_codes: set[str] | None = None,
    max_candidates: int = _MAX_CANDIDATES,
) -> list[dict]:
    """
    저PER·저PBR·배당수익률 기반 가치주 스크리닝.
    반환: [{stock_code, stock_name, per, pbr, div, market_cap, value_score}, ...]
    """
    exclude = exclude_codes or set()

    universe = await _get_universe()
    if not universe:
        logger.warning("[가치주스크리닝] 종목 유니버스가 비어있음")
        return []

    logger.info(f"[가치주스크리닝] 유니버스 {len(universe)}종목 → itemSummary 조회 시작")

    sem = asyncio.Semaphore(_SEMAPHORE)
    phase1: list[dict] = []

    async with aiohttp.ClientSession() as session:
        # Phase 1: PER/PBR/시가총액 필터
        tasks = {code: _fetch_item_summary(session, code, sem) for code, _ in universe if code not in exclude}
        name_map = {code: name for code, name in universe}

        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        for (code, _), data in zip(
            [(c, n) for c, n in universe if c not in exclude], results
        ):
            if not isinstance(data, dict):
                continue
            try:
                per = float(data.get("per") or 0)
                pbr = float(data.get("pbr") or 0)
                cap = float(data.get("marketSum") or 0)   # 백만원 단위
            except (TypeError, ValueError):
                continue

            if not (_PER_MIN <= per <= _PER_MAX):
                continue
            if pbr <= 0 or pbr > _PBR_MAX:
                continue
            if cap < _CAP_MIN_MILLION:
                continue

            phase1.append({
                "stock_code": code,
                "stock_name": name_map.get(code, code),
                "per": round(per, 2),
                "pbr": round(pbr, 2),
                "market_cap": int(cap) * 1_000_000,     # 원 단위 (백만원 → 원)
            })

        logger.info(f"[가치주스크리닝] 1차 통과(PER/PBR/시총) {len(phase1)}종목 → 배당 조회")

        # Phase 2: 배당수익률 조회 (1차 통과 종목만)
        div_tasks = [_fetch_dividend(session, item["stock_code"], sem) for item in phase1]
        div_results = await asyncio.gather(*div_tasks, return_exceptions=True)

    candidates: list[dict] = []
    for item, div_result in zip(phase1, div_results):
        div = float(div_result) if isinstance(div_result, (int, float)) else 0.0
        if div < _DIV_MIN:
            continue

        per = item["per"]
        pbr = item["pbr"]
        per_score = (_PER_MAX - per) / (_PER_MAX - _PER_MIN)
        pbr_score = max(0.0, (_PBR_MAX - pbr) / _PBR_MAX)
        div_score = min(1.0, div / 5.0)
        value_score = round(per_score * 0.40 + pbr_score * 0.35 + div_score * 0.25, 4)

        candidates.append({
            **item,
            "div": round(div, 2),
            "value_score": value_score,
        })

    candidates.sort(key=lambda x: x["value_score"], reverse=True)
    logger.info(
        f"[가치주스크리닝] 최종 통과 {len(candidates)}종목 → 상위 {max_candidates}개 반환"
    )
    return candidates[:max_candidates]
