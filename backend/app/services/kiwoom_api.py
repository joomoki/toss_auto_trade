"""
키움증권 Open API REST 클라이언트
Base URL: https://api.kiwoom.com
인증: POST /oauth2/token  →  응답 필드 "token" (Bearer)
API 함수: api-id 헤더 + /api/* 경로 조합
"""
import asyncio
import json
import os
import time
from datetime import date as date_type, datetime as _dt, time as _dtime
from typing import Optional
import httpx
import pandas as pd
import pytz as _pytz
from app.core.config import settings

_SEOUL_TZ = _pytz.timezone("Asia/Seoul")

# 원장·시세 조회 가용 시간: 평일 08:00 ~ 18:00 KST
# - 시세 실시간 조회: 08:00~18:00
# - 장전 시간외 주문: 08:30~08:40 / 정규장: 09:00~15:30
# - 장후 시간외 종가: 15:40~16:00 / 시간외 단일가: 16:00~18:00
# - 18:00 이후 야간: 조회 불가 → 스냅샷 반환
_ACCOUNT_TR_OPEN  = _dtime(8,  0)
_ACCOUNT_TR_CLOSE = _dtime(18, 0)

_EMPTY_BALANCE: dict = {
    "cash": 0, "availableCash": 0, "totalAsset": 0,
    "totalBuyAmount": 0, "totalPnl": 0, "totalPnlRate": 0.0,
    "accountName": "", "_raw": {},
}

# 서버 재시작 후에도 마지막 잔고를 유지하기 위한 파일 경로
_BALANCE_SNAPSHOT_FILE = os.path.join(
    os.path.dirname(__file__), "..", "..", "logs", "balance_snapshot.json"
)


def _save_balance_snapshot_file(data: dict) -> None:
    """잔고 스냅샷을 파일에 저장 (서버 재시작 후에도 유지)"""
    try:
        os.makedirs(os.path.dirname(_BALANCE_SNAPSHOT_FILE), exist_ok=True)
        with open(_BALANCE_SNAPSHOT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def _load_balance_snapshot_file() -> dict | None:
    """파일에서 마지막 잔고 스냅샷 로드"""
    try:
        with open(_BALANCE_SNAPSHOT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def is_account_tr_available() -> bool:
    """원장 접근 TR(kt00004·kt00005 등) 가용 여부.
    평일 08:00 이상 ~ 18:00 미만 KST 만 True (시간외 단일가 마감 18:00 기준)."""
    now = _dt.now(_SEOUL_TZ)
    if now.weekday() >= 5:      # 토·일
        return False
    return _ACCOUNT_TR_OPEN <= now.time() < _ACCOUNT_TR_CLOSE


class _MemCache:
    """Redis 없을 때 사용하는 인메모리 캐시"""
    def __init__(self):
        self._store: dict[str, tuple[str, float]] = {}

    async def get(self, key: str) -> Optional[str]:
        item = self._store.get(key)
        if item and time.time() < item[1]:
            return item[0]
        self._store.pop(key, None)
        return None

    async def set(self, key: str, value: str, ex: int = 3600):
        self._store[key] = (value, time.time() + ex)

    async def close(self): pass


class KiwoomApiClient:
    BASE_URL = "https://api.kiwoom.com"
    _instance: Optional["KiwoomApiClient"] = None

    def __init__(self):
        self._cache: Optional[_MemCache] = None
        self._http: Optional[httpx.AsyncClient] = None
        self._account_no: Optional[str] = None

    @classmethod
    def get_instance(cls) -> "KiwoomApiClient":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _get_cache(self) -> _MemCache:
        if self._cache is None:
            try:
                import redis.asyncio as aioredis
                r = await aioredis.from_url(
                    settings.redis_url, decode_responses=True, socket_connect_timeout=2
                )
                await r.ping()
                self._cache = r  # type: ignore[assignment]
            except Exception:
                self._cache = _MemCache()
        return self._cache

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=self.BASE_URL,
                timeout=30.0,
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
        return self._http

    # ── 인증 ──────────────────────────────────────────────

    async def get_access_token(self) -> str:
        """OAuth2 Client Credentials → Bearer 토큰 캐시"""
        cache = await self._get_cache()
        cached = await cache.get("kiwoom:token")
        if cached:
            return cached

        if not settings.kiwoom_app_key or not settings.kiwoom_secret_key:
            raise RuntimeError("KIWOOM_APP_KEY / KIWOOM_SECRET_KEY가 .env에 설정되지 않았습니다.")

        http = await self._get_http()
        resp = await http.post(
            "/oauth2/token",
            headers={"Content-Type": "application/json; charset=utf-8"},
            json={
                "grant_type": "client_credentials",
                "appkey": settings.kiwoom_app_key,
                "secretkey": settings.kiwoom_secret_key,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return_code = data.get("return_code", 0)
        if return_code != 0:
            return_msg = data.get("return_msg", "")
            try:
                import asyncio
                from app.services.telegram_notifier import notify_kiwoom_down
                asyncio.ensure_future(notify_kiwoom_down(return_code, return_msg))
            except Exception:
                pass
            raise RuntimeError(
                f"키움 토큰 발급 실패 (code={return_code}): {return_msg}"
            )
        # 키움 응답은 "access_token"이 아닌 "token" 필드 사용
        token = data.get("token") or data.get("access_token", "")
        # expires_dt: "20260621210859" 형식
        try:
            from datetime import datetime
            exp_str = data.get("expires_dt", "")
            if exp_str and len(exp_str) >= 14:
                exp_dt = datetime.strptime(exp_str[:14], "%Y%m%d%H%M%S")
                ttl = max(int((exp_dt - datetime.now()).total_seconds()) - 300, 60)
            else:
                ttl = 86100
        except Exception:
            ttl = 86100
        await cache.set("kiwoom:token", token, ex=ttl)
        return token

    async def _headers(self, api_id: str) -> dict:
        token = await self.get_access_token()
        return {
            "Authorization": f"Bearer {token}",
            "appkey": settings.kiwoom_app_key,
            "api-id": api_id,
            "Content-Type": "application/json; charset=utf-8",
        }

    # ── 공통 요청 ─────────────────────────────────────────

    async def _invalidate_token(self) -> None:
        """캐시된 토큰을 즉시 만료시킨다 (다음 요청에서 재발급 트리거)."""
        cache = await self._get_cache()
        await cache.set("kiwoom:token", "", ex=1)

    async def _post(self, path: str, api_id: str, body: dict) -> dict:
        """지수 백오프 재시도 포함 POST 요청.
        - 토큰 만료(code=3 / 8005): 캐시 무효화 후 즉시 재시도
        - CB 연결 끊김(code=20 / "CB"): 2~6초 대기 후 재시도 (최대 3회)"""
        import logging
        _log = logging.getLogger(__name__)
        http = await self._get_http()
        for attempt in range(4):
            try:
                headers = await self._headers(api_id)
                resp = await http.post(path, headers=headers, json=body)
                if resp.status_code == 429:
                    await asyncio.sleep(2 ** attempt)
                    continue
                if not resp.is_success:
                    try:
                        error_body = resp.text[:800]
                    except Exception:
                        error_body = ""
                    _log.error(
                        f"[키움API] {api_id} HTTP {resp.status_code} "
                        f"요청={json.dumps(body, ensure_ascii=False)} "
                        f"응답={error_body}"
                    )
                    raise RuntimeError(f"키움API {resp.status_code} [{api_id}]: {error_body}")
                data = resp.json()
                rc = data.get("return_code")
                if rc is not None and rc != 0:
                    return_msg = data.get("return_msg", "")
                    # 토큰 만료/무효 → 캐시 삭제 후 즉시 재시도
                    if rc == 3 or "8005" in return_msg:
                        await self._invalidate_token()
                        if attempt < 3:
                            continue
                    # CB 연결 끊김(code=20) → 2초 대기 후 재시도 (키움 자동 재연결 대기)
                    if rc == 20 or (return_msg and "CB" in return_msg):
                        _log.warning(
                            f"[키움API] {api_id} CB 연결 끊김 (code={rc}) — "
                            f"{2 * (attempt + 1)}초 후 재시도 ({attempt+1}/3)"
                        )
                        if attempt < 3:
                            await asyncio.sleep(2 * (attempt + 1))
                            continue
                    raise RuntimeError(f"키움 API 오류 [{api_id}] code={rc}: {return_msg}")
                return data
            except (httpx.HTTPStatusError, RuntimeError):
                if attempt == 3:
                    raise
                await asyncio.sleep(2 ** attempt)
        raise RuntimeError(f"요청 실패: {path}")

    # ── 계좌 조회 ─────────────────────────────────────────

    async def get_accounts(self) -> list[dict]:
        """계좌평가현황 (kt00004) — 계좌명/예수금/평가금액"""
        data = await self._post(
            "/api/dostk/acnt", "kt00004",
            {"qry_tp": "0", "dmst_stex_tp": "KRX"},
        )
        # 단일 계좌 정보가 루트에 있음 → 리스트로 감싸서 반환
        return [data]

    async def get_account_no(self) -> str:
        """환경변수 KIWOOM_ACCOUNT_NO 우선 사용"""
        if self._account_no:
            return self._account_no
        if settings.kiwoom_account_no:
            self._account_no = settings.kiwoom_account_no
            return self._account_no
        # kt00004 응답에서 계좌번호 추출 불가 시 빈 문자열 반환 (주문 시 필요)
        return ""

    async def get_holdings(self) -> list[dict]:
        """체결잔고 조회 (kt00005) → stk_cntr_remn 배열.
        08:00~16:00 KST 외에는 마지막 스냅샷 반환."""
        cache = await self._get_cache()
        if not is_account_tr_available():
            cached = await cache.get("kiwoom:holdings_snapshot")
            if cached:
                return json.loads(cached)
            return []

        data = await self._post(
            "/api/dostk/acnt", "kt00005",
            {"dmst_stex_tp": "KRX"},
        )
        items = data.get("stk_cntr_remn", [])
        result = items if isinstance(items, list) else []
        # 다음 비가용 구간을 위해 스냅샷 저장 (24시간 보존)
        await cache.set("kiwoom:holdings_snapshot", json.dumps(result, ensure_ascii=False), ex=86400)
        return result

    async def get_balance(self) -> dict:
        """계좌평가현황 요약 — 예수금, 평가금액 등 (kt00004).
        08:00~18:00 KST 외에는 마지막 스냅샷 반환."""
        import logging
        log = logging.getLogger(__name__)
        cache = await self._get_cache()

        if not is_account_tr_available():
            cached = await cache.get("kiwoom:balance_snapshot")
            if cached:
                return json.loads(cached)
            # 인메모리 캐시 miss → 파일 스냅샷 시도 (서버 재시작 후 복구)
            file_snap = _load_balance_snapshot_file()
            if file_snap:
                log.info("[kt00004] 원장 비가용 — 파일 스냅샷으로 대체 반환")
                return file_snap
            log.warning("[kt00004] 원장 비가용 시간대이며 스냅샷도 없음 — 빈 잔고 반환")
            return dict(_EMPTY_BALANCE)

        body: dict = {"qry_tp": "0", "dmst_stex_tp": "KRX"}
        acnt_no = await self.get_account_no()
        if acnt_no:
            body["acnt_no"] = acnt_no
        else:
            log.warning("[kt00004] KIWOOM_ACCOUNT_NO 미설정 — 잔고가 0으로 조회될 수 있음")

        data = await self._post("/api/dostk/acnt", "kt00004", body)
        non_meta = {k: v for k, v in data.items() if k not in ("return_code", "return_msg")}

        cash_val        = self._n(data.get("entr", "0"))
        # d2_entra = D+2 예수금 (매도 미결제금 포함, Kiwoom 앱의 "예수금"과 동일)
        d2_cash         = self._n(data.get("d2_entra") or data.get("ord_alowa") or data.get("entr", "0"))
        # tot_est_amt = 주식 평가금액만 (현금 미포함); Kiwoom 앱 "총 자산" = d2예수금 + 주식평가금액
        stock_pure      = self._n(data.get("tot_est_amt", "0"))
        total_asset     = d2_cash + stock_pure
        total_buy       = self._n(data.get("tot_pur_amt", "0"))
        raw_pnl         = self._n(data.get("lspft_amt") or data.get("tdy_lspft_amt", "0"))
        total_pnl       = raw_pnl if raw_pnl != 0 else (stock_pure - total_buy)
        raw_rate        = float(data.get("lspft_rt") or data.get("lspft_ratio") or 0)
        total_pnl_rate  = raw_rate if raw_rate != 0.0 else (
            round(total_pnl / total_buy * 100, 2) if total_buy > 0 else 0.0
        )

        # stk_acnt_evlt_prst: kt00004에 포함된 보유종목별 현재가·손익 (kt00005 불필요)
        stock_holdings: list[dict] = []
        for item in data.get("stk_acnt_evlt_prst", []):
            raw_code = str(item.get("stk_cd") or "")
            code = raw_code.lstrip("A") if raw_code.startswith("A") else raw_code
            if not code:
                continue
            stock_holdings.append({
                "stock_code":    code,
                "stock_name":    str(item.get("stk_nm") or ""),
                "quantity":      self._n(item.get("rmnd_qty", "0")),
                "avg_price":     self._n(item.get("avg_prc", "0")),
                "current_price": self._n(item.get("cur_prc", "0")),
                "pnl":           self._n(item.get("pl_amt", "0")),
                "pnl_pct":       float(str(item.get("pl_rt") or "0").replace(",", "")),
            })

        result = {
            "cash":            cash_val,        # D+0 예수금 (원장 현금잔액)
            "availableCash":   d2_cash,         # D+2 예수금 = Kiwoom 앱 "주문가능금액"
            "totalAsset":      total_asset,     # d2예수금 + 주식평가금액 = Kiwoom 앱 "총 자산"
            "totalBuyAmount":  total_buy,
            "totalPnl":        total_pnl,
            "totalPnlRate":    total_pnl_rate,
            "accountName":     data.get("acnt_nm", ""),
            "stockHoldings":   stock_holdings,
            "_raw":            non_meta,
        }
        # 다음 비가용 구간을 위해 스냅샷 저장 (Redis/메모리 + 파일)
        await cache.set("kiwoom:balance_snapshot", json.dumps(result, ensure_ascii=False), ex=86400)
        _save_balance_snapshot_file(result)
        return result

    @staticmethod
    def _n(s) -> int:
        try:
            return int(str(s).replace(",", "").replace("+", "").replace("-", "")) * (
                -1 if str(s).startswith("-") else 1
            )
        except Exception:
            return 0

    # ── 시세 ──────────────────────────────────────────────

    async def get_current_price(self, stock_code: str) -> dict:
        """주식 기본정보 (ka10001) → 현재가 포함 (10초 캐시)"""
        cache = await self._get_cache()
        key = f"kiwoom:price:{stock_code}"
        cached = await cache.get(key)
        if cached:
            return json.loads(cached)

        data = await self._post(
            "/api/dostk/stkinfo", "ka10001",
            {"stk_cd": stock_code},
        )
        # cur_prc 또는 oyr_hgst 등에서 현재가 추출
        raw_price = data.get("cur_prc") or data.get("prpr") or data.get("stck_prpr") or "0"
        price = int(str(raw_price).replace(",", "").replace("+", "").lstrip("-")) if raw_price else 0
        # 종목명: ka10001 응답 필드 순차 시도
        name = (
            data.get("hts_kor_isnm") or   # HTS 한글 종목명 (주식기본정보 표준 필드)
            data.get("stk_nm") or          # 종목명 단축형
            data.get("stk_name") or
            data.get("isuNm") or
            ""
        )
        result = {"price": price, "name": str(name).strip(), "raw": data}
        await cache.set(key, json.dumps(result, ensure_ascii=False), ex=10)
        return result

    async def get_ohlcv(self, stock_code: str, period: str = "D", count: int = 200) -> pd.DataFrame:
        """OHLCV 차트 조회 — D=일봉(ka10081), W=주봉(ka10082), M=월봉(ka10083)"""
        api_id_map = {"D": "ka10081", "W": "ka10082", "M": "ka10083"}
        api_id = api_id_map.get(period.upper(), "ka10081")
        today = date_type.today().strftime("%Y%m%d")
        data = await self._post(
            "/api/dostk/chart", api_id,
            {
                "stk_cd": stock_code,
                "base_dt": today,
                "upd_stkpc_tp": "0",
            },
        )
        candles = data.get("stk_dt_pole_chart_qry", [])
        if not candles:
            return pd.DataFrame()

        rows = []
        for c in candles:
            try:
                rows.append({
                    "datetime": c.get("dt", ""),
                    "open":     int(str(c.get("open_pric", "0")).replace(",", "") or 0),
                    "high":     int(str(c.get("high_pric", "0")).replace(",", "") or 0),
                    "low":      int(str(c.get("low_pric",  "0")).replace(",", "") or 0),
                    "close":    int(str(c.get("cur_prc",   "0")).replace(",", "").lstrip("+-") or 0),
                    "volume":   int(str(c.get("trde_qty",  "0")).replace(",", "") or 0),
                })
            except Exception:
                continue

        df = pd.DataFrame(rows)
        if df.empty:
            return df
        df = df.sort_values("datetime").reset_index(drop=True)
        return df.tail(count)

    # ── 주문 ──────────────────────────────────────────────

    async def place_order(
        self,
        stock_code: str,
        order_type: str,
        quantity: int,
        price: int,
        market: str = "KOSPI",
        use_market_order: bool = False,
    ) -> dict:
        """
        매수(kt10000) / 매도(kt10001) 주문
        trde_tp: "00" = 지정가, "03" = 시장가
        dmst_stex_tp: "KRX" = 코스피, "NXT" = 코스닥
        """
        api_id = "kt10000" if order_type == "BUY" else "kt10001"
        dmst_stex_tp = "NXT" if market == "KOSDAQ" else "KRX"
        trde_tp = "3" if use_market_order else "0"
        ord_uv  = "" if use_market_order else str(price)
        body: dict = {
            "dmst_stex_tp": dmst_stex_tp,
            "stk_cd": stock_code,
            "ord_qty": str(quantity),
            "ord_uv":  ord_uv,
            "trde_tp": trde_tp,
        }
        acnt_no = await self.get_account_no()
        if acnt_no:
            body["acnt_no"] = acnt_no
        return await self._post("/api/dostk/ordr", api_id, body)

    async def get_filled_orders(self, trade_date: str) -> list[dict]:
        """체결 내역 조회 (ka10076)"""
        data = await self._post(
            "/api/dostk/acnt", "ka10076",
            {
                "qry_tp": "0",
                "dmst_stex_tp": "KRX",
                "strt_dt": trade_date.replace("-", ""),
                "end_dt": trade_date.replace("-", ""),
            },
        )
        return data.get("cntr_hist", data.get("orders", []))

    # ── 정리 ──────────────────────────────────────────────

    async def close(self):
        if self._http and not self._http.is_closed:
            await self._http.aclose()
        if self._cache:
            await self._cache.close()
