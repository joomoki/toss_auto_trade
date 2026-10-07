"""
키움 TR 코드 유효성 검증 모듈
- 미확인 TR을 실제 호출해 응답 필드명·구조를 파악
- 수집 모듈 구현 전 단계
"""
import logging
from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter

from app.services.kiwoom_api import KiwoomApiClient

router = APIRouter(prefix="/account-debug", tags=["account-debug"])
log = logging.getLogger(__name__)

today_str = lambda: date.today().strftime("%Y%m%d")  # noqa: E731


# ── TR 명세 ────────────────────────────────────────────
# body_extra: 각 TR에 고유하게 필요한 추가 파라미터
# status: confirmed=기존코드 검증됨 / unverified=사용자제공 / probe=추정

TR_SPECS: list[dict] = [
    # ── 확인된 TR ────────────────────────────────────
    {
        "tr_id": "kt00004",
        "desc": "계좌평가현황 (총자산/예수금/손익)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0"},
        "status": "confirmed",
    },
    {
        "tr_id": "kt00005",
        "desc": "계좌평가잔고내역 (보유종목별 stk_cntr_remn)",
        "path": "/api/dostk/acnt",
        "body_extra": {},
        "status": "confirmed",
    },
    {
        "tr_id": "ka10076",
        "desc": "당일 체결내역",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0", "strt_dt": today_str(), "end_dt": today_str()},
        "status": "confirmed",
    },
    # ── 사용자 제공 미확인 TR ─────────────────────────
    {
        "tr_id": "kt00001",
        "desc": "예수금 상세현황 (주문가능금액/D+2예수금)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0"},
        "status": "unverified",
    },
    {
        "tr_id": "ka10072",
        "desc": "당일 실현손익 상세",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0", "strt_dt": today_str(), "end_dt": today_str()},
        "status": "unverified",
    },
    {
        "tr_id": "ka10075",
        "desc": "미체결 주문내역",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0"},
        "status": "unverified",
    },
    {
        "tr_id": "kt00018",
        "desc": "잔고 (사용자 제공, 용도 불명)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0"},
        "status": "unverified",
    },
    # ── 추정 TR (교육적 탐색) ──────────────────────────
    {
        "tr_id": "kt00002",
        "desc": "추정예탁자산 현황 (추정)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0"},
        "status": "probe",
    },
    {
        "tr_id": "kt00003",
        "desc": "계좌별당일현황 (추정)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0"},
        "status": "probe",
    },
    {
        "tr_id": "kt00006",
        "desc": "일별계좌수익률 (추정)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0", "strt_dt": today_str(), "end_dt": today_str()},
        "status": "probe",
    },
    {
        "tr_id": "ka10073",
        "desc": "기간별 실현손익 (추정)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0", "strt_dt": today_str(), "end_dt": today_str()},
        "status": "probe",
    },
    {
        "tr_id": "ka10077",
        "desc": "주문체결내역 상세 (추정)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0", "strt_dt": today_str(), "end_dt": today_str()},
        "status": "probe",
    },
    {
        "tr_id": "ka10078",
        "desc": "매매일지 (추정)",
        "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0", "strt_dt": today_str(), "end_dt": today_str()},
        "status": "probe",
    },
]


# ── 응답 분석 헬퍼 ────────────────────────────────────

def _flatten_fields(obj: Any, prefix: str = "", depth: int = 0) -> list[dict]:
    """응답 dict/list를 재귀적으로 펼쳐 필드명·샘플값·타입 반환."""
    rows: list[dict] = []
    max_depth = 3

    if depth >= max_depth:
        return rows

    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("return_code", "return_msg"):
                continue
            full_key = f"{prefix}{k}"
            if isinstance(v, dict):
                rows.append({"field": full_key, "type": "object", "sample": "{...}"})
                rows.extend(_flatten_fields(v, f"{full_key}.", depth + 1))
            elif isinstance(v, list):
                rows.append({"field": full_key, "type": f"array[{len(v)}]",
                             "sample": f"(배열, {len(v)}개)"})
                if v and isinstance(v[0], dict):
                    rows.extend(_flatten_fields(v[0], f"{full_key}[0].", depth + 1))
            else:
                sample = str(v)[:80] if v is not None else "null"
                rows.append({"field": full_key, "type": type(v).__name__, "sample": sample})
    elif isinstance(obj, list) and obj:
        rows.append({"field": prefix.rstrip("."), "type": f"array[{len(obj)}]",
                     "sample": f"(배열, {len(obj)}개)"})
        if isinstance(obj[0], dict):
            rows.extend(_flatten_fields(obj[0], f"{prefix}[0].", depth + 1))

    return rows


def _find_arrays(obj: Any, parent: str = "") -> list[dict]:
    """응답에서 배열 키를 찾아 반환 (페이지네이션 대상 파악용)."""
    arrays: list[dict] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, list):
                arrays.append({"key": k, "parent": parent, "count": len(v)})
            elif isinstance(v, dict):
                arrays.extend(_find_arrays(v, k))
    return arrays


async def _call_tr(spec: dict, acnt_no: str) -> dict:
    """TR을 실제 호출하고 결과를 구조화해서 반환."""
    api = KiwoomApiClient.get_instance()
    body = {"dmst_stex_tp": "KRX", **spec["body_extra"]}
    if acnt_no:
        body["acnt_no"] = acnt_no

    started = datetime.now(timezone.utc)
    result: dict = {
        "tr_id":   spec["tr_id"],
        "desc":    spec["desc"],
        "status":  spec["status"],
        "body_sent": body,
        "ok":      False,
        "return_code": None,
        "return_msg":  None,
        "top_level_keys": [],
        "arrays_found":   [],
        "fields":         [],
        "raw":            None,
        "elapsed_ms": 0,
        "error": None,
    }

    try:
        raw = await api._post(spec["path"], spec["tr_id"], body)
        elapsed = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)

        result["ok"]           = True
        result["return_code"]  = raw.get("return_code")
        result["return_msg"]   = raw.get("return_msg")
        result["top_level_keys"] = [k for k in raw if k not in ("return_code", "return_msg")]
        result["arrays_found"] = _find_arrays(raw)
        result["fields"]       = _flatten_fields(raw)
        result["raw"]          = raw
        result["elapsed_ms"]   = elapsed

    except Exception as exc:
        elapsed = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        result["error"]       = str(exc)
        result["elapsed_ms"]  = elapsed
        log.warning(f"[TR검증] {spec['tr_id']} 실패: {exc}")

    return result


# ── 엔드포인트 ────────────────────────────────────────

@router.get("/validate-all")
async def validate_all_trs():
    """
    모든 TR을 순차 호출해 유효성 검증.
    - ok=true → TR 존재, fields에 실제 응답 필드명 포함
    - ok=false → error 메시지로 원인 파악
    """
    api = KiwoomApiClient.get_instance()
    acnt_no = await api.get_account_no()

    results = []
    for spec in TR_SPECS:
        res = await _call_tr(spec, acnt_no)
        results.append(res)
        # Rate limit 보호: TR 간 0.8초 대기
        import asyncio
        await asyncio.sleep(0.8)

    summary = {
        "total":      len(results),
        "ok":         sum(1 for r in results if r["ok"]),
        "failed":     sum(1 for r in results if not r["ok"]),
        "account_no": acnt_no or "(미설정)",
        "tested_at":  datetime.now(timezone.utc).isoformat(),
    }

    return {"summary": summary, "results": results}


@router.get("/validate/{tr_id}")
async def validate_single_tr(tr_id: str):
    """특정 TR 단건 검증. custom_body 없이 기본 파라미터로 호출."""
    api = KiwoomApiClient.get_instance()
    acnt_no = await api.get_account_no()

    spec = next((s for s in TR_SPECS if s["tr_id"] == tr_id), None)
    if not spec:
        # 스펙에 없는 TR도 기본 파라미터로 탐색 허용
        spec = {
            "tr_id": tr_id,
            "desc": f"미등록 TR 탐색: {tr_id}",
            "path": "/api/dostk/acnt",
            "body_extra": {"qry_tp": "0"},
            "status": "probe",
        }

    return await _call_tr(spec, acnt_no)


@router.get("/validate/{tr_id}/with-dates")
async def validate_tr_with_dates(
    tr_id: str,
    strt_dt: str | None = None,
    end_dt:  str | None = None,
):
    """날짜 범위가 필요한 TR 검증 (체결, 손익 등)."""
    api = KiwoomApiClient.get_instance()
    acnt_no = await api.get_account_no()
    today = today_str()

    spec = {
        "tr_id": tr_id,
        "desc": f"날짜 범위 검증: {tr_id}",
        "path": "/api/dostk/acnt",
        "body_extra": {
            "qry_tp": "0",
            "strt_dt": strt_dt or today,
            "end_dt":  end_dt  or today,
        },
        "status": "probe",
    }
    return await _call_tr(spec, acnt_no)


@router.get("/fields/{tr_id}")
async def get_tr_fields(tr_id: str):
    """TR 응답에서 필드명·타입·샘플값만 추출해서 반환 (파서 구현용)."""
    api = KiwoomApiClient.get_instance()
    acnt_no = await api.get_account_no()

    spec = next((s for s in TR_SPECS if s["tr_id"] == tr_id), {
        "tr_id": tr_id, "desc": tr_id, "path": "/api/dostk/acnt",
        "body_extra": {"qry_tp": "0"}, "status": "probe",
    })
    res = await _call_tr(spec, acnt_no)

    return {
        "tr_id":  tr_id,
        "ok":     res["ok"],
        "error":  res.get("error"),
        "arrays": res.get("arrays_found", []),
        "fields": res.get("fields", []),
    }


@router.get("/specs")
async def get_tr_specs():
    """등록된 모든 TR 명세 목록 반환 (호출 없이 메타데이터만)."""
    return {
        "specs": [
            {
                "tr_id":  s["tr_id"],
                "desc":   s["desc"],
                "status": s["status"],
                "body_extra": s["body_extra"],
            }
            for s in TR_SPECS
        ]
    }
