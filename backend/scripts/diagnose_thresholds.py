#!/usr/bin/env python
"""
임계값별 예상 매매 빈도 진단 스크립트

사용법:
  cd backend
  python scripts/diagnose_thresholds.py \
      --codes 005930 000660 035420 \
      --start 2024-01-01 \
      --end   2025-12-31

출력:
  - 임계값 0.40 ~ 0.70 구간에서 예상 BUY 신호 횟수·비율
  - 변경 전(0.63 + 투표 4개) vs 변경 후(임계값 단일) 비교
  - 상관행렬 힌트 (Phase 2 준비)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# backend 폴더를 Python path에 추가
ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

import pandas as pd
import numpy as np

from app.ml.feature_engineering import compute
from app.ml.multi_models import _MODEL_REGISTRY, _get_model_configs, _DEFAULT_WEIGHTS


def _fetch_ohlcv(code: str, start: str, end: str) -> pd.DataFrame | None:
    """DB 또는 pykrx에서 OHLCV 로드."""
    try:
        from pykrx import stock as krx
        df = krx.get_market_ohlcv_by_date(start.replace("-", ""), end.replace("-", ""), code)
        if df is None or len(df) < 60:
            print(f"  [{code}] pykrx 데이터 부족 ({len(df) if df is not None else 0}행)")
            return None
        df = df.reset_index()
        df = df.rename(columns={
            "날짜": "datetime", "시가": "open", "고가": "high",
            "저가": "low", "종가": "close", "거래량": "volume",
        })
        df["datetime"] = df["datetime"].astype(str)
        return compute(df)
    except Exception as e:
        print(f"  [{code}] OHLCV 로드 실패: {e}")
        return None


def _old_ensemble_signal(scores: list[dict], weights: list[float]) -> str:
    """변경 전 M10 로직 (점수 ≥ 0.63 AND 투표 ≥ 4)."""
    total_w = sum(weights) + 1e-9
    ws = sum(s["score"] * w for s, w in zip(scores, weights)) / total_w
    buy_v = sum(1 for s in scores if s["signal"] == "BUY")
    sell_v = sum(1 for s in scores if s["signal"] == "SELL")
    if ws >= 0.63 and buy_v >= len(scores) * 0.4:
        return "BUY"
    if ws <= 0.37 and sell_v >= len(scores) * 0.4:
        return "SELL"
    return "HOLD"


def diagnose(codes: list[str], start: str, end: str) -> None:
    thresholds = [round(t, 2) for t in np.arange(0.40, 0.71, 0.05)]

    print(f"\n{'='*70}")
    print(f"임계값별 매매 빈도 진단  |  종목: {codes}  |  기간: {start} ~ {end}")
    print(f"{'='*70}")

    model_cfgs = _get_model_configs()

    all_ws: dict[str, list[float]] = {mid: [] for mid in _MODEL_REGISTRY}
    old_buy_cnt = 0
    new_buy_cnts: dict[float, int] = {t: 0 for t in thresholds}
    total_rows = 0

    for code in codes:
        print(f"\n[{code}] OHLCV 로드 중...")
        full_df = _fetch_ohlcv(code, start, end)
        if full_df is None:
            continue

        dates = sorted(full_df["datetime"].astype(str).str[:10].unique())
        print(f"  총 {len(dates)}거래일 처리 중...", end="", flush=True)

        for i, sim_date in enumerate(dates):
            mask = full_df["datetime"].astype(str).str[:10] <= sim_date
            sub  = full_df[mask]
            if len(sub) < 60:
                continue

            # 각 모델 점수 수집
            ind_scores: list[dict] = []
            ind_weights: list[float] = []
            for mid, fn in _MODEL_REGISTRY.items():
                cfg = model_cfgs.get(mid, {})
                if not cfg.get("enabled", True):
                    continue
                w = float(cfg.get("weight", _DEFAULT_WEIGHTS.get(mid, 1.0)))
                try:
                    r = fn(sub)
                except Exception:
                    r = {"score": 0.5, "signal": "HOLD", "reason": ""}
                all_ws[mid].append(r["score"])
                ind_scores.append(r)
                ind_weights.append(w)

            if not ind_scores:
                continue

            total_w = sum(ind_weights) + 1e-9
            ws = sum(s["score"] * w for s, w in zip(ind_scores, ind_weights)) / total_w

            # 변경 전
            old_sig = _old_ensemble_signal(ind_scores, ind_weights)
            if old_sig == "BUY":
                old_buy_cnt += 1

            # 변경 후 (임계값별)
            for t in thresholds:
                if ws >= t:
                    new_buy_cnts[t] += 1

            total_rows += 1

        print(f" 완료 ({total_rows}행 누적)")

    if total_rows == 0:
        print("\n데이터가 없어 진단을 중단합니다.")
        return

    # ── 결과 출력 ─────────────────────────────────────────────
    print(f"\n{'─'*70}")
    print(f"총 평가 행 수: {total_rows}")
    print(f"\n[변경 전] 구 앙상블 (score≥0.63 AND vote≥4개)")
    print(f"  BUY 신호: {old_buy_cnt}회  ({old_buy_cnt/total_rows*100:.1f}%)")

    print(f"\n[변경 후] 신 앙상블 (단일 임계값)")
    print(f"  {'임계값':>6}  {'BUY 횟수':>8}  {'빈도':>7}  {'변경 전 대비':>10}")
    print(f"  {'─'*6}  {'─'*8}  {'─'*7}  {'─'*10}")
    for t in thresholds:
        cnt  = new_buy_cnts[t]
        pct  = cnt / total_rows * 100
        mult = cnt / (old_buy_cnt + 1e-9)
        marker = " ← YAML 기본값" if abs(t - 0.55) < 0.001 else ""
        print(f"  {t:>6.2f}  {cnt:>8}  {pct:>6.1f}%  {mult:>9.1f}x{marker}")

    # ── 모델 간 상관행렬 (Phase 2 참고용) ────────────────────
    print(f"\n{'─'*70}")
    print("[참고] M1~M9 신호 시계열 상관행렬 (Phase 2 모델 정리 참고용)")
    model_ids = [m for m in _MODEL_REGISTRY if all_ws.get(m)]
    min_len = min(len(all_ws[m]) for m in model_ids)
    if min_len > 10:
        mat = pd.DataFrame({m: all_ws[m][:min_len] for m in model_ids})
        corr = mat.corr().round(2)
        print(corr.to_string())

        # 상관 > 0.75 클러스터 힌트
        high_corr = []
        for i in range(len(model_ids)):
            for j in range(i + 1, len(model_ids)):
                mi, mj = model_ids[i], model_ids[j]
                c = corr.loc[mi, mj]
                if c > 0.75:
                    high_corr.append((mi, mj, c))
        if high_corr:
            print(f"\n[!] 상관 > 0.75 쌍 (Phase 2 병합/제거 후보):")
            for mi, mj, c in sorted(high_corr, key=lambda x: -x[2]):
                print(f"  {mi} ↔ {mj}  : {c:.2f}")
        else:
            print("\n모든 모델 쌍 상관 ≤ 0.75 — 병합 불필요")

    print(f"\n{'='*70}")
    print("진단 완료. 임계값을 config/model_weights.yaml > ensemble > buy_threshold 에 반영하세요.")
    print(f"{'='*70}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="임계값별 매매 빈도 진단")
    parser.add_argument("--codes", nargs="+", default=["005930", "000660", "035420"],
                        help="종목 코드 목록 (기본: 삼성전자 SK하이닉스 NAVER)")
    parser.add_argument("--start", default="2024-01-01", help="시작일 YYYY-MM-DD")
    parser.add_argument("--end",   default="2025-06-30", help="종료일 YYYY-MM-DD")
    args = parser.parse_args()

    diagnose(args.codes, args.start, args.end)
