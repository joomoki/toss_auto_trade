"""
OpenDART 공시 수집 서비스
https://opendart.fss.or.kr/
- 무료 API: 일 20,000건 한도
- 수집 대상: 유가증권 + 코스닥 전체 공시
- 점수 산정: 공시 유형별 호재/악재 자동 분류
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.models.dart import DartDisclosure

logger = logging.getLogger(__name__)
DART_BASE = "https://opendart.fss.or.kr/api"


# ── 공시 유형 분류 및 점수 ────────────────────────────────
_POSITIVE = [
    ("공급계약",     0.75, "공급계약"),
    ("수주",         0.70, "수주"),
    ("공급협약",     0.65, "공급계약"),
    ("흑자전환",     0.85, "흑자전환"),
    ("영업이익 증가", 0.65, "실적개선"),
    ("자기주식취득", 0.55, "자사주취득"),
    ("자사주취득",   0.55, "자사주취득"),
    ("현금배당",     0.45, "배당"),
    ("주식배당",     0.40, "배당"),
    ("기술이전",     0.65, "기술이전"),
    ("기술수출",     0.65, "기술이전"),
    ("특허",         0.50, "특허"),
    ("신약",         0.60, "신약승인"),
    ("임상",         0.45, "임상"),
    ("FDA",          0.70, "신약승인"),
    ("합병",         0.35, "합병"),
    ("분기보고서",   0.10, "정기공시"),  # 중립에 가까운 약한 긍정
    ("반기보고서",   0.10, "정기공시"),
]

_NEGATIVE = [
    ("유상증자",     -0.55, "유상증자"),
    ("주식매수선택권", -0.30, "스톡옵션"),
    ("전환사채",     -0.35, "전환사채"),
    ("신주인수권",   -0.35, "신주인수권"),
    ("횡령",         -0.90, "횡령배임"),
    ("배임",         -0.90, "횡령배임"),
    ("감사의견 비적정", -0.85, "감사비적정"),
    ("감사의견 거절", -0.90, "감사비적정"),
    ("최대주주변경", -0.35, "최대주주변경"),
    ("소송",         -0.40, "소송"),
    ("과징금",       -0.50, "제재"),
    ("과태료",       -0.45, "제재"),
    ("영업정지",     -0.85, "영업정지"),
    ("허가취소",     -0.85, "영업정지"),
    ("불성실공시",   -0.70, "불성실공시"),
    ("손실",         -0.50, "손실"),
    ("적자전환",     -0.70, "적자전환"),
    ("조회공시",     -0.20, "조회공시"),
]


def _classify(report_nm: str) -> tuple[float, str, bool]:
    """공시명 → (점수, 유형, 호재여부)"""
    for keyword, score, dtype in _POSITIVE:
        if keyword in report_nm:
            return score, dtype, True
    for keyword, score, dtype in _NEGATIVE:
        if keyword in report_nm:
            return score, dtype, False
    return 0.0, "기타", True


async def collect_dart(db: AsyncSession, days_back: int = 1) -> int:
    """DART 공시 수집. 당일 포함 days_back일치 수집. 반환: 신규 저장 건수"""
    if not settings.dart_api_key:
        logger.warning("DART_API_KEY 미설정 — 공시 수집 건너뜀")
        return 0

    today = date.today()
    bgn = (today - timedelta(days=days_back)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")

    saved = 0
    page = 1
    while True:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.get(
                    f"{DART_BASE}/list.json",
                    params={
                        "crtfc_key": settings.dart_api_key,
                        "bgn_de": bgn,
                        "end_de": end,
                        "corp_cls": "Y",   # 유가증권 — 2차 호출로 코스닥
                        "page_no": page,
                        "page_count": 100,
                    },
                )
            data = resp.json()
        except Exception as e:
            logger.error(f"DART API 호출 오류: {e}")
            break

        if data.get("status") not in ("000", "013"):  # 013 = 조회 결과 없음
            logger.warning(f"DART API 응답 이상: {data.get('status')} {data.get('message')}")
            break

        items = data.get("list", [])
        if not items:
            break

        for item in items:
            rcept_no = item.get("rcept_no", "")
            if not rcept_no:
                continue

            # 중복 체크
            exists = await db.execute(
                select(DartDisclosure).where(DartDisclosure.rcept_no == rcept_no)
            )
            if exists.scalar_one_or_none():
                continue

            report_nm = item.get("report_nm", "")
            score, dtype, is_pos = _classify(report_nm)
            rcept_dt_str = item.get("rcept_dt", "")
            try:
                rcept_dt = datetime.strptime(rcept_dt_str, "%Y%m%d").date()
            except ValueError:
                rcept_dt = today

            db.add(DartDisclosure(
                rcept_no=rcept_no,
                rcept_dt=rcept_dt,
                corp_code=item.get("corp_code") or None,
                corp_name=item.get("corp_name") or None,
                stock_code=item.get("stock_code") or None,
                corp_cls=item.get("corp_cls") or None,
                report_nm=report_nm,
                filer_nm=item.get("flr_nm") or None,
                disclosure_type=dtype,
                dart_score=score,
                is_positive=is_pos,
            ))
            saved += 1

        total_page = data.get("total_page", 1)
        if page >= total_page:
            break
        page += 1

    # 코스닥 추가 수집 (page=1만, 많지 않음)
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp2 = await client.get(
                f"{DART_BASE}/list.json",
                params={
                    "crtfc_key": settings.dart_api_key,
                    "bgn_de": bgn,
                    "end_de": end,
                    "corp_cls": "K",
                    "page_no": 1,
                    "page_count": 100,
                },
            )
        data2 = resp2.json()
        for item in data2.get("list", []):
            rcept_no = item.get("rcept_no", "")
            if not rcept_no:
                continue
            exists = await db.execute(
                select(DartDisclosure).where(DartDisclosure.rcept_no == rcept_no)
            )
            if exists.scalar_one_or_none():
                continue
            report_nm = item.get("report_nm", "")
            score, dtype, is_pos = _classify(report_nm)
            try:
                rcept_dt = datetime.strptime(item.get("rcept_dt", ""), "%Y%m%d").date()
            except ValueError:
                rcept_dt = today
            db.add(DartDisclosure(
                rcept_no=rcept_no, rcept_dt=rcept_dt,
                corp_code=item.get("corp_code") or None,
                corp_name=item.get("corp_name") or None,
                stock_code=item.get("stock_code") or None,
                corp_cls="K", report_nm=report_nm,
                filer_nm=item.get("flr_nm") or None,
                disclosure_type=dtype, dart_score=score, is_positive=is_pos,
            ))
            saved += 1
    except Exception as e:
        logger.warning(f"코스닥 DART 수집 오류: {e}")

    if saved:
        await db.commit()
    logger.info(f"DART 공시 수집 완료: {saved}건 저장")
    return saved


async def get_dart_score_for_stock(db: AsyncSession, stock_code: str, days: int = 7) -> float:
    """특정 종목의 최근 DART 공시 점수 (0~1, 0.5=중립)"""
    cutoff = date.today() - timedelta(days=days)
    r = await db.execute(
        select(DartDisclosure)
        .where(
            DartDisclosure.stock_code == stock_code,
            DartDisclosure.rcept_dt >= cutoff,
            DartDisclosure.dart_score != 0,
        )
        .order_by(DartDisclosure.rcept_dt.desc())
        .limit(5)
    )
    disclosures = r.scalars().all()
    if not disclosures:
        return 0.5  # 공시 없으면 중립

    scores = [float(d.dart_score) for d in disclosures]
    avg = sum(scores) / len(scores)
    return round((avg + 1) / 2, 4)  # -1~+1 → 0~1
