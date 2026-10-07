"""
M1-M10 다중 모델 신호 계산
각 모델은 DataFrame(feature_engineering.compute() 결과)을 받아
{"score": 0~1, "signal": BUY/SELL/HOLD, "reason": str} 를 반환한다.

집계 방식 (M10):
  - YAML(config/model_weights.yaml)에서 가중치·임계값·enabled 플래그 로드
  - weighted_score = Σ(score_i × w_i) / Σ(w_i)
  - score ≥ buy_threshold  → BUY
  - score ≤ sell_threshold → SELL
  - 그 사이               → HOLD
  - 투표 조건(다수결) 없음 — 임계값 하나로만 결정
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

# YAML 경로: 이 파일 기준으로 2단계 위 → backend/config/
_YAML_PATH = Path(__file__).parents[2] / "config" / "model_weights.yaml"


@functools.lru_cache(maxsize=1)
def _load_cfg() -> dict:
    """config/model_weights.yaml 로드 (프로세스 내 1회 캐시)."""
    try:
        with open(_YAML_PATH, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception:
        return {}


def reload_config() -> None:
    """런타임 중 YAML을 다시 읽어야 할 때 외부에서 호출."""
    _load_cfg.cache_clear()


def _get_ensemble_thresholds() -> tuple[float, float]:
    cfg = _load_cfg()
    ens = cfg.get("ensemble", {})
    return (
        float(ens.get("buy_threshold",  0.55)),
        float(ens.get("sell_threshold", 0.45)),
    )


def _get_model_configs() -> dict[str, dict]:
    """모델별 설정 {M1: {weight, enabled, ...}, ...}."""
    cfg = _load_cfg()
    return cfg.get("models", {})


def _last(df: pd.DataFrame, col: str, default=0):
    try:
        return float(df[col].iloc[-1])
    except Exception:
        return float(default)


# ── M1: 이동평균 골든/데드 크로스 ────────────────────────────
def m1_ma_cross(df: pd.DataFrame) -> dict:
    """EMA5가 EMA20을 상향 돌파하면 BUY (골든크로스)"""
    if len(df) < 3:
        return {"score": 0.5, "signal": "HOLD", "reason": "데이터 부족"}

    e5  = df["ema_5"].iloc[-3:]
    e20 = df["ema_20"].iloc[-3:]
    cross_up   = (e5.iloc[-2] <= e20.iloc[-2]) and (e5.iloc[-1] > e20.iloc[-1])
    cross_down = (e5.iloc[-2] >= e20.iloc[-2]) and (e5.iloc[-1] < e20.iloc[-1])

    e5_now, e20_now = e5.iloc[-1], e20.iloc[-1]
    gap = (e5_now - e20_now) / (e20_now + 1e-9)

    if cross_up:
        score = min(0.9, 0.7 + abs(gap) * 5)
        return {"score": score, "signal": "BUY", "reason": f"EMA5/20 골든크로스 (gap={gap:.3f})"}
    if cross_down:
        score = max(0.1, 0.3 - abs(gap) * 5)
        return {"score": score, "signal": "SELL", "reason": f"EMA5/20 데드크로스 (gap={gap:.3f})"}

    score = 0.6 if e5_now > e20_now else 0.4
    return {"score": score, "signal": "HOLD", "reason": "크로스 없음"}


# ── M2: RSI 과매도 반등 ──────────────────────────────────────
def m2_rsi_rebound(df: pd.DataFrame) -> dict:
    """RSI 14 < 30이면 과매도 → 반등 BUY / RSI > 70이면 과매수 → SELL"""
    rsi = _last(df, "rsi_14", 50)
    stoch_k = _last(df, "stoch_k", 50)

    if rsi < 25 and stoch_k < 20:
        return {"score": 0.88, "signal": "BUY", "reason": f"극과매도 RSI={rsi:.1f}, Stoch={stoch_k:.1f}"}
    if rsi < 30:
        score = 0.7 + (30 - rsi) / 100
        return {"score": min(score, 0.85), "signal": "BUY", "reason": f"과매도 RSI={rsi:.1f}"}
    if rsi > 75:
        score = 0.2 - (rsi - 75) / 100
        return {"score": max(score, 0.1), "signal": "SELL", "reason": f"극과매수 RSI={rsi:.1f}"}
    if rsi > 70:
        score = 0.3 - (rsi - 70) / 100
        return {"score": max(score, 0.15), "signal": "SELL", "reason": f"과매수 RSI={rsi:.1f}"}

    score = 0.5 + (50 - rsi) / 200
    return {"score": round(score, 3), "signal": "HOLD", "reason": f"RSI 중립 ({rsi:.1f})"}


# ── M3: MACD 골든크로스 모멘텀 ──────────────────────────────
def m3_macd_momentum(df: pd.DataFrame) -> dict:
    """MACD가 시그널을 상향 돌파하면 BUY"""
    if len(df) < 3:
        return {"score": 0.5, "signal": "HOLD", "reason": "데이터 부족"}

    macd = df["macd"].iloc[-3:]
    sig  = df["macd_signal"].iloc[-3:]
    hist = _last(df, "macd_hist")
    cross_up   = (macd.iloc[-2] <= sig.iloc[-2]) and (macd.iloc[-1] > sig.iloc[-1])
    cross_down = (macd.iloc[-2] >= sig.iloc[-2]) and (macd.iloc[-1] < sig.iloc[-1])

    if cross_up and hist > 0:
        return {"score": 0.82, "signal": "BUY", "reason": f"MACD 골든크로스 hist={hist:.2f}"}
    if cross_down and hist < 0:
        return {"score": 0.18, "signal": "SELL", "reason": f"MACD 데드크로스 hist={hist:.2f}"}

    score = 0.6 if hist > 0 else 0.4
    return {"score": score, "signal": "HOLD", "reason": f"MACD hist={hist:.2f}"}


# ── M4: 볼린저밴드 돌파/반등 ────────────────────────────────
def m4_bollinger(df: pd.DataFrame) -> dict:
    """%B < 0.05 → 하단 반등 BUY / %B > 0.95 → 상단 과열 SELL"""
    bb_pct = _last(df, "bb_pct_b", 0.5)
    rsi    = _last(df, "rsi_14", 50)

    if bb_pct < 0.05 and rsi < 40:
        return {"score": min(0.85 - bb_pct, 0.92), "signal": "BUY",
                "reason": f"BB 하단 반등 %B={bb_pct:.3f}"}
    if bb_pct < 0.15:
        return {"score": 0.70, "signal": "BUY", "reason": f"BB 하단 근접 %B={bb_pct:.3f}"}
    if bb_pct > 0.95 and rsi > 65:
        return {"score": 0.15, "signal": "SELL", "reason": f"BB 상단 과열 %B={bb_pct:.3f}"}
    if bb_pct > 0.85:
        return {"score": 0.35, "signal": "HOLD", "reason": f"BB 상단 근접 %B={bb_pct:.3f}"}

    score = 0.5 + (0.5 - bb_pct) * 0.3
    return {"score": round(score, 3), "signal": "HOLD", "reason": f"BB 중립 %B={bb_pct:.3f}"}


# ── M5: 거래량 폭발 감지 ─────────────────────────────────────
def m5_volume_surge(df: pd.DataFrame) -> dict:
    """거래량이 20일 평균의 2배 이상 + 가격 상승이면 BUY"""
    vol_ratio = _last(df, "volume_ratio", 1.0)
    change    = _last(df, "pos_vs_prev_close", 0)

    if vol_ratio >= 3.0 and change > 0.02:
        return {"score": 0.90, "signal": "BUY",
                "reason": f"거래량 폭발({vol_ratio:.1f}x) 가격상승 {change*100:.1f}%"}
    if vol_ratio >= 2.0 and change > 0.01:
        return {"score": 0.78, "signal": "BUY", "reason": f"거래량 급등({vol_ratio:.1f}x) 가격상승"}
    if vol_ratio >= 2.0 and change < -0.02:
        return {"score": 0.20, "signal": "SELL",
                "reason": f"거래량 급등({vol_ratio:.1f}x) 가격하락 → 매도세"}
    if vol_ratio < 0.5:
        return {"score": 0.45, "signal": "HOLD", "reason": f"거래량 저조({vol_ratio:.2f}x)"}

    score = min(0.65, 0.5 + (vol_ratio - 1) * 0.1)
    return {"score": round(score, 3), "signal": "HOLD", "reason": f"거래량 {vol_ratio:.2f}x"}


# ── M6: CCI 과매도 반등 ──────────────────────────────────────
def m6_cci_signal(df: pd.DataFrame) -> dict:
    """CCI(20) < -100 과매도 반등 / > +100 과매수"""
    cci = _last(df, "cci_20", 0)

    if cci < -150:
        return {"score": 0.85, "signal": "BUY", "reason": f"CCI 극과매도 ({cci:.1f})"}
    if cci < -100:
        return {"score": 0.72, "signal": "BUY", "reason": f"CCI 과매도 ({cci:.1f})"}
    if cci > 150:
        return {"score": 0.18, "signal": "SELL", "reason": f"CCI 극과매수 ({cci:.1f})"}
    if cci > 100:
        return {"score": 0.28, "signal": "SELL", "reason": f"CCI 과매수 ({cci:.1f})"}

    score = 0.5 - cci / 600
    return {"score": max(0.2, min(0.8, score)), "signal": "HOLD", "reason": f"CCI 중립 ({cci:.1f})"}


# ── M7: VWAP 이탈 회귀 ──────────────────────────────────────
def m7_vwap_reversion(df: pd.DataFrame) -> dict:
    """현재가가 VWAP 대비 -5% 이하 이탈 시 회귀 매수"""
    vwap_r = _last(df, "vwap_ratio", 1.0)
    change = _last(df, "pos_vs_prev_close", 0)
    dev = (vwap_r - 1.0) * 100

    if dev < -5:
        return {"score": min(0.88, 0.7 + abs(dev) / 100), "signal": "BUY",
                "reason": f"VWAP 하방 이탈 {dev:.1f}%"}
    if dev < -2:
        return {"score": 0.68, "signal": "BUY", "reason": f"VWAP 소폭 하방 이탈 {dev:.1f}%"}
    if dev > 8:
        return {"score": 0.22, "signal": "SELL", "reason": f"VWAP 상방 과열 +{dev:.1f}%"}
    if dev > 4:
        return {"score": 0.35, "signal": "HOLD", "reason": f"VWAP 상방 +{dev:.1f}%"}

    score = 0.55 if change > 0 else 0.45
    return {"score": score, "signal": "HOLD", "reason": f"VWAP 정상 이격 {dev:.1f}%"}


# ── M8: 스토캐스틱 신호 ──────────────────────────────────────
def m8_stochastic(df: pd.DataFrame) -> dict:
    """스토캐스틱 K가 D를 하방에서 상향 돌파 → BUY"""
    if len(df) < 3:
        return {"score": 0.5, "signal": "HOLD", "reason": "데이터 부족"}

    k = df["stoch_k"].iloc[-3:]
    d = df["stoch_d"].iloc[-3:]
    cross_up   = (k.iloc[-2] <= d.iloc[-2]) and (k.iloc[-1] > d.iloc[-1])
    cross_down = (k.iloc[-2] >= d.iloc[-2]) and (k.iloc[-1] < d.iloc[-1])
    k_now, d_now = k.iloc[-1], d.iloc[-1]

    if cross_up and k_now < 30:
        return {"score": 0.86, "signal": "BUY",
                "reason": f"스토캐스틱 과매도 구간 골든크로스 K={k_now:.1f}"}
    if cross_up:
        return {"score": 0.70, "signal": "BUY", "reason": f"스토캐스틱 골든크로스 K={k_now:.1f}"}
    if cross_down and k_now > 70:
        return {"score": 0.15, "signal": "SELL",
                "reason": f"스토캐스틱 과매수 구간 데드크로스 K={k_now:.1f}"}
    if cross_down:
        return {"score": 0.30, "signal": "SELL",
                "reason": f"스토캐스틱 데드크로스 K={k_now:.1f}"}

    score = 0.6 if k_now > d_now else 0.4
    return {"score": score, "signal": "HOLD", "reason": f"스토캐스틱 K={k_now:.1f} D={d_now:.1f}"}


# ── M9: LightGBM 스윙 (ML) ──────────────────────────────────
def m9_lightgbm_swing(df: pd.DataFrame) -> dict:
    """LightGBM 모델 파일이 있으면 사용, 없으면 복합 기술적 규칙 폴백"""
    try:
        import joblib
        model_path = os.path.join(os.path.dirname(__file__), "models", "lgbm_v1.pkl")
        if os.path.exists(model_path):
            from app.ml.feature_engineering import get_feature_columns
            model = joblib.load(model_path)
            features = get_feature_columns()
            row = df[features].iloc[-1:].fillna(0)
            proba = float(model.predict_proba(row)[0][1])
            signal = "BUY" if proba >= 0.6 else ("SELL" if proba <= 0.3 else "HOLD")
            return {"score": proba, "signal": signal, "reason": f"LightGBM 예측확률={proba:.3f}"}
    except Exception:
        pass

    # 폴백: 복합 기술 지표
    rsi    = _last(df, "rsi_14", 50)
    macd_h = _last(df, "macd_hist", 0)
    bb_pct = _last(df, "bb_pct_b", 0.5)
    vol_r  = _last(df, "volume_ratio", 1.0)
    adx    = _last(df, "adx", 25)
    ema_5  = _last(df, "ema_5",  0.0)
    ema_20 = _last(df, "ema_20", 0.0)
    ema_60 = _last(df, "ema_60", 0.0)

    score = 0.5
    if rsi < 40:     score += 0.10
    if rsi > 60:     score -= 0.10
    if macd_h > 0:   score += 0.08
    if macd_h < 0:   score -= 0.08
    if bb_pct < 0.3: score += 0.07
    if bb_pct > 0.7: score -= 0.07
    if vol_r > 1.5:  score += 0.05
    if adx > 30:     score += 0.05

    # EMA 정렬 — 추세 방향 확인 (EMA5 > EMA20 > EMA60 이면 상승 추세)
    if ema_5 > 0 and ema_20 > 0 and ema_60 > 0:
        if ema_5 > ema_20 > ema_60:
            score += 0.07   # 단기·중기·장기 모두 상승 정렬
        elif ema_5 < ema_20 < ema_60:
            score -= 0.07   # 하락 정렬
        elif ema_5 > ema_20:
            score += 0.03   # 단기만 상승 반전

    score = max(0.1, min(0.9, score))
    signal = "BUY" if score >= 0.58 else ("SELL" if score <= 0.38 else "HOLD")
    return {"score": round(score, 3), "signal": signal, "reason": f"복합지표 점수={score:.3f}"}


# ── 모델 함수 레지스트리 ──────────────────────────────────────
_MODEL_REGISTRY: dict[str, callable] = {
    "M1": m1_ma_cross,
    "M2": m2_rsi_rebound,
    "M3": m3_macd_momentum,
    "M4": m4_bollinger,
    "M5": m5_volume_surge,
    "M6": m6_cci_signal,
    "M7": m7_vwap_reversion,
    "M8": m8_stochastic,
    "M9": m9_lightgbm_swing,
}

# 하드코딩 기본값 (YAML 로드 실패 시 폴백)
_DEFAULT_WEIGHTS = {
    "M1": 1.0, "M2": 1.0, "M3": 1.0, "M4": 1.0,
    "M5": 0.8, "M6": 0.8, "M7": 0.9, "M8": 0.9, "M9": 1.2,
}

# 하위 호환용 리스트 (기존 코드가 MODEL_FUNCS를 직접 참조할 경우 대비)
MODEL_FUNCS = [
    ("M1", m1_ma_cross,       1.0),
    ("M2", m2_rsi_rebound,    1.0),
    ("M3", m3_macd_momentum,  1.0),
    ("M4", m4_bollinger,      1.0),
    ("M5", m5_volume_surge,   0.8),
    ("M6", m6_cci_signal,     0.8),
    ("M7", m7_vwap_reversion, 0.9),
    ("M8", m8_stochastic,     0.9),
    ("M9", m9_lightgbm_swing, 1.2),
]


# ── M10: 앙상블 (M1-M9 종합) ────────────────────────────────
def m10_ensemble(
    scores: list[dict],
    weights: list[float] | None = None,
    buy_threshold: float | None = None,
    sell_threshold: float | None = None,
) -> dict:
    """
    M1-M9 결과를 가중 평균하여 최종 신호 결정.

    변경 이전: weighted_score ≥ 0.63 AND buy_votes ≥ 4  → BUY  (이중 조건)
    변경 이후: weighted_score ≥ buy_threshold            → BUY  (단일 임계값)
               임계값은 YAML에서 런타임 조절 가능.
    """
    if not scores:
        return {"score": 0.5, "signal": "HOLD", "reason": "신호 없음"}

    if weights is None:
        weights = [1.0] * len(scores)

    # YAML 임계값 (인자로 넘기면 우선, 없으면 YAML에서 읽음)
    if buy_threshold is None or sell_threshold is None:
        yaml_buy, yaml_sell = _get_ensemble_thresholds()
        buy_threshold  = buy_threshold  if buy_threshold  is not None else yaml_buy
        sell_threshold = sell_threshold if sell_threshold is not None else yaml_sell

    total_w = sum(weights) + 1e-9
    weighted_score = sum(s["score"] * w for s, w in zip(scores, weights)) / total_w
    buy_votes  = sum(1 for s in scores if s["signal"] == "BUY")
    sell_votes = sum(1 for s in scores if s["signal"] == "SELL")

    # 단일 임계값으로만 결정 (투표 조건 제거)
    if weighted_score >= buy_threshold:
        signal = "BUY"
    elif weighted_score <= sell_threshold:
        signal = "SELL"
    else:
        signal = "HOLD"

    return {
        "score":       round(weighted_score, 4),
        "signal":      signal,
        "reason":      (f"앙상블 점수={weighted_score:.3f} "
                        f"(BUY:{buy_votes}, SELL:{sell_votes}, "
                        f"임계={buy_threshold}/{sell_threshold})"),
        "buy_votes":   buy_votes,
        "sell_votes":  sell_votes,
        "buy_threshold":  buy_threshold,
        "sell_threshold": sell_threshold,
    }


# ── 편의 함수: 전체 모델 실행 ────────────────────────────────
def run_all_models(
    df: pd.DataFrame,
    buy_threshold: float | None = None,
    sell_threshold: float | None = None,
) -> dict:
    """
    DataFrame에 대해 M1~M10 전체 실행.
    YAML(config/model_weights.yaml)에서 enabled/weight를 읽어
    비활성화된 모델은 건너뛴다.

    반환: {
      "M1": {...}, ..., "M9": {...},
      "M10": {...},           # 앙상블
      "composite_score": float,
      "final_signal": "BUY"/"SELL"/"HOLD",
      "active_models": [str],  # 실제 실행된 모델 ID 목록
    }
    """
    model_cfgs = _get_model_configs()

    results: dict        = {}
    individual_scores    = []
    weights              = []
    active_models        = []

    for model_id, fn in _MODEL_REGISTRY.items():
        cfg    = model_cfgs.get(model_id, {})
        enabled = cfg.get("enabled", True)
        if not enabled:
            results[model_id] = {"score": 0.5, "signal": "HOLD",
                                 "reason": "비활성화(config)"}
            continue

        weight = float(cfg.get("weight", _DEFAULT_WEIGHTS.get(model_id, 1.0)))
        try:
            r = fn(df)
        except Exception as e:
            r = {"score": 0.5, "signal": "HOLD", "reason": f"오류: {e}"}

        results[model_id] = r
        individual_scores.append(r)
        weights.append(weight)
        active_models.append(model_id)

    ensemble = m10_ensemble(
        individual_scores, weights,
        buy_threshold=buy_threshold,
        sell_threshold=sell_threshold,
    )
    results["M10"] = ensemble

    return {
        **results,
        "composite_score": ensemble["score"],
        "final_signal":    ensemble["signal"],
        "active_models":   active_models,
    }
