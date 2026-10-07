"""
뉴스 수집기
1. 네이버 검색 API  — 워치리스트 종목명으로 검색 (일 25,000건 무료)
2. 언론사 RSS 피드  — 연합뉴스·한국경제·매일경제·이데일리 (무료, 키 불필요)
3. 네이버 금융 RSS  — 종목코드별 RSS (키 불필요)
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import logging
from datetime import datetime, timezone
from typing import Optional

import aiohttp
import feedparser
import httpx
from bs4 import BeautifulSoup
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.models.news import NewsItem
from app.models.watchlist import Watchlist

logger = logging.getLogger(__name__)

# ── 네이버 검색 API ─────────────────────────────────────
NAVER_NEWS_API = "https://openapi.naver.com/v1/search/news.json"

# ── RSS 피드 목록 ────────────────────────────────────────
RSS_FEEDS = [
    # 연합뉴스
    ("연합뉴스", "https://www.yna.co.kr/rss/economy.xml"),
    ("연합뉴스", "https://www.yna.co.kr/rss/finance.xml"),
    # 한국경제
    ("한국경제", "https://rss.hankyung.com/economy.xml"),
    ("한국경제", "https://rss.hankyung.com/finance.xml"),
    # 매일경제
    ("매일경제", "https://www.mk.co.kr/rss/30000001/"),
    ("매일경제", "https://www.mk.co.kr/rss/30200030/"),
    # 이데일리
    ("이데일리", "https://www.edaily.co.kr/rss/economics.xml"),
    # 머니투데이
    ("머니투데이", "https://www.mt.co.kr/rss/economy/news.xml"),
]

# 네이버 금융 종목별 RSS
NAVER_STOCK_RSS = "https://finance.naver.com/rss/news.naver?category=stock&stockcode={code}"


# ── 유틸 ─────────────────────────────────────────────────
def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()


def _clean_html(html: str) -> str:
    if not html:
        return ""
    text = BeautifulSoup(html, "html.parser").get_text(separator=" ").strip()
    # HTML 엔티티 제거
    text = re.sub(r"&[a-zA-Z]+;", " ", text)
    return text[:500]


def _parse_pub_date(date_str: Optional[str]) -> datetime:
    """RFC-2822 날짜 문자열 → datetime (KST→UTC)"""
    if not date_str:
        return datetime.now(timezone.utc)
    try:
        import email.utils
        parsed = email.utils.parsedate_tz(date_str)
        if parsed:
            return datetime.fromtimestamp(email.utils.mktime_tz(parsed), tz=timezone.utc)
    except Exception:
        pass
    return datetime.now(timezone.utc)


def _extract_codes(text: str, name_map: dict[str, str]) -> list[str]:
    """텍스트에서 워치리스트 종목명이 언급된 코드 추출"""
    found = []
    for name, code in name_map.items():
        if name and len(name) >= 2 and name in text:
            found.append(code)
    return list(set(found))


# ── 네이버 검색 API ─────────────────────────────────────
async def _fetch_naver_api(
    query: str,
    stock_code: str,
    name_map: dict[str, str],
    display: int = 20,
) -> list[dict]:
    """네이버 뉴스 검색 API — 종목명으로 검색"""
    if not (settings.naver_client_id and settings.naver_client_secret):
        return []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                NAVER_NEWS_API,
                params={"query": query, "display": display, "sort": "date"},
                headers={
                    "X-Naver-Client-Id": settings.naver_client_id,
                    "X-Naver-Client-Secret": settings.naver_client_secret,
                },
            )
        if resp.status_code != 200:
            logger.warning(f"네이버 API {query}: {resp.status_code}")
            return []
        data = resp.json()
    except Exception as e:
        logger.warning(f"네이버 API 오류 ({query}): {e}")
        return []

    items = []
    for item in data.get("items", []):
        link = item.get("link") or item.get("originallink", "")
        if not link:
            continue
        title = _clean_html(item.get("title", ""))
        summary = _clean_html(item.get("description", ""))
        # pub_date: "Mon, 01 Jan 2024 12:00:00 +0900"
        pub_date_str = item.get("pubDate", "")
        pub_at = _parse_pub_date(pub_date_str)

        codes = [stock_code] if stock_code else _extract_codes(title + " " + summary, name_map)

        items.append({
            "url_hash": _url_hash(link),
            "title": title,
            "content_summary": summary,
            "source": "naver",
            "published_at": pub_at,
            "stock_codes": codes,
        })
    return items


# ── RSS 피드 수집 ────────────────────────────────────────
async def _fetch_rss(
    session: aiohttp.ClientSession,
    source: str,
    url: str,
    name_map: dict[str, str],
    limit: int = 30,
) -> list[dict]:
    """단일 RSS 피드 수집"""
    items = []
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as resp:
            text = await resp.text(encoding="utf-8", errors="ignore")
        feed = feedparser.parse(text)
        for entry in feed.entries[:limit]:
            link = entry.get("link", "")
            if not link:
                continue
            title = _clean_html(entry.get("title", ""))
            summary = _clean_html(entry.get("summary", entry.get("description", "")))
            pub_at = _parse_pub_date(entry.get("published", entry.get("updated", "")))
            codes = _extract_codes(title + " " + summary, name_map)
            items.append({
                "url_hash": _url_hash(link),
                "title": title,
                "content_summary": summary,
                "source": source,
                "published_at": pub_at,
                "stock_codes": codes,
            })
    except Exception as e:
        logger.debug(f"RSS 수집 오류 [{source}] {url}: {e}")
    return items


async def _fetch_naver_stock_rss(
    session: aiohttp.ClientSession,
    stock_code: str,
    name_map: dict[str, str],
) -> list[dict]:
    """네이버 금융 종목별 RSS"""
    url = NAVER_STOCK_RSS.format(code=stock_code)
    items = await _fetch_rss(session, "naver_finance", url, name_map, limit=20)
    for item in items:
        if stock_code not in item["stock_codes"]:
            item["stock_codes"] = [stock_code] + item["stock_codes"]
    return items


# ── 메인 수집 함수 ───────────────────────────────────────
async def collect_news(db: AsyncSession) -> int:
    """
    전체 뉴스 수집 실행.
    1) 워치리스트 기반 네이버 검색 API (종목명 검색)
    2) 네이버 금융 종목별 RSS
    3) 언론사 공통 RSS (연합뉴스·한경·매경·이데일리 등)
    반환: 신규 저장 건수
    """
    # ── 워치리스트 로드 ──────────────────────────────────
    wl_r = await db.execute(select(Watchlist).where(Watchlist.is_active == True))
    watchlist = wl_r.scalars().all()
    name_map: dict[str, str] = {
        w.stock_name: w.stock_code
        for w in watchlist
        if w.stock_name and w.stock_code
    }

    all_items: list[dict] = []

    # ── 1. 네이버 검색 API (종목명별) ───────────────────
    if settings.naver_client_id and watchlist:
        naver_tasks = [
            _fetch_naver_api(w.stock_name, w.stock_code, name_map)
            for w in watchlist
            if w.stock_name
        ]
        # 25,000/일 = ~17/분 → 동시 5개씩 배치 실행으로 속도·한도 균형
        naver_results = []
        batch_size = 5
        for i in range(0, len(naver_tasks), batch_size):
            batch = naver_tasks[i : i + batch_size]
            results = await asyncio.gather(*batch, return_exceptions=True)
            for r in results:
                if isinstance(r, list):
                    naver_results.extend(r)
            if i + batch_size < len(naver_tasks):
                await asyncio.sleep(0.3)  # 속도 제한 준수

        all_items.extend(naver_results)
        logger.info(f"네이버 API 수집: {len(naver_results)}건 (종목 {len(watchlist)}개)")

    # ── 2. RSS 피드 수집 ─────────────────────────────────
    async with aiohttp.ClientSession(
        headers={"User-Agent": "Mozilla/5.0 (compatible; StockBot/1.0)"}
    ) as session:
        # 2-a. 언론사 공통 RSS
        rss_tasks = [
            _fetch_rss(session, source, url, name_map)
            for source, url in RSS_FEEDS
        ]
        # 2-b. 네이버 금융 종목별 RSS (워치리스트 대상)
        stock_rss_tasks = [
            _fetch_naver_stock_rss(session, w.stock_code, name_map)
            for w in watchlist
            if w.stock_code
        ]

        all_rss = await asyncio.gather(*rss_tasks, *stock_rss_tasks, return_exceptions=True)
        rss_count = 0
        for r in all_rss:
            if isinstance(r, list):
                all_items.extend(r)
                rss_count += len(r)
        logger.info(f"RSS 수집: {rss_count}건")

    # ── 3. DB 저장 (중복 제거) ───────────────────────────
    saved = 0
    for item in all_items:
        url_hash = item.get("url_hash")
        if not url_hash or not item.get("title"):
            continue
        exists = await db.execute(
            select(NewsItem).where(NewsItem.url_hash == url_hash)
        )
        if exists.scalar_one_or_none():
            continue
        db.add(NewsItem(
            url_hash=url_hash,
            title=item["title"],
            content_summary=item.get("content_summary", ""),
            source=item.get("source", "unknown"),
            stock_codes=item.get("stock_codes") or [],
            published_at=item.get("published_at"),
            is_disclosure=False,
        ))
        saved += 1

    if saved:
        await db.commit()
    logger.info(f"뉴스 신규 저장: {saved}건")
    return saved
