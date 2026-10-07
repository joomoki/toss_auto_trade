"""
뉴스 기반 ML 모델 (M2 XGBoost 뉴스돌파, M3 LightGBM 스윙 확장, M5 앙상블)
실제 학습은 train_news_models.py 에서 수행하고 joblib으로 저장.
여기서는 추론(predict) 함수만 제공.
"""
import os
import joblib
import numpy as np
import pandas as pd
from typing import Optional

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "models")


def _load(filename: str):
    path = os.path.join(MODEL_DIR, filename)
    if os.path.exists(path):
        try:
            return joblib.load(path)
        except Exception as e:
            print(f"[NewsModels] {filename} 로드 실패: {e}")
    return None


# ── M2: XGBoost 뉴스 돌파 (스캘핑) ───────────────────────────
_m2_model = None

def m2_predict(df: pd.DataFrame, sentiment_score: float = 0.0) -> dict:
    """
    M2 — XGBoost 뉴스 돌파 스캘핑 예측.
    df: 기술적 지표가 계산된 OHLCV DataFrame
    sentiment_score: 종목의 최근 감성 통합 점수 (-1 ~ +1)
    """
    global _m2_model
    if _m2_model is None:
        _m2_model = _load("m2_xgb_breakout.pkl")

    features = _build_features(df, sentiment_score)
    if _m2_model is None or features is None:
        # 모델 없으면 규칙 기반 fallback
        return _rule_based_scalping(df, sentiment_score)

    X = pd.DataFrame([features])
    try:
        proba = _m2_model.predict_proba(X)[0]
        buy_proba = float(proba[1]) if len(proba) > 1 else 0.5
    except Exception:
        return _rule_based_scalping(df, sentiment_score)

    return {
        "model": "M2",
        "style": "scalping",
        "buy_proba": round(buy_proba, 4),
        "sell_proba": round(1 - buy_proba, 4),
        "sentiment_boost": sentiment_score > 0.15,
        "features": features,
    }


def _rule_based_scalping(df: pd.DataFrame, sentiment_score: float) -> dict:
    """M2 모델 없을 때: RSI + MACD + 감성 기반 규칙 fallback"""
    buy_proba = 0.35
    if len(df) < 20:
        return {"model": "M2", "style": "scalping", "buy_proba": buy_proba,
                "sell_proba": 1 - buy_proba, "sentiment_boost": False, "features": {}}
    row = df.iloc[-1]
    # RSI 과매도
    if "rsi" in df.columns and row.get("rsi", 50) < 35:
        buy_proba += 0.15
    # MACD 상향
    if "macd" in df.columns and "macd_signal" in df.columns:
        if row.get("macd", 0) > row.get("macd_signal", 0):
            buy_proba += 0.1
    # 볼린저 하단 터치
    if "bb_lower" in df.columns:
        if row.get("close", 0) <= row.get("bb_lower", float("inf")):
            buy_proba += 0.1
    # 감성 부스트
    if sentiment_score > 0.2:
        buy_proba += 0.1
    buy_proba = min(buy_proba, 0.95)
    return {
        "model": "M2",
        "style": "scalping",
        "buy_proba": round(buy_proba, 4),
        "sell_proba": round(1 - buy_proba, 4),
        "sentiment_boost": sentiment_score > 0.15,
        "features": {},
    }


# ── M3: LightGBM 스윙 (뉴스 감성 피처 추가) ──────────────────
_m3_model = None

def m3_predict(df: pd.DataFrame, sentiment_score: float = 0.0,
               has_disclosure: bool = False) -> dict:
    """
    M3 — LightGBM 스윙 예측 (기존 M3 + 감성 피처 추가).
    """
    global _m3_model
    if _m3_model is None:
        _m3_model = _load("m3_lgbm_swing_news.pkl")
    if _m3_model is None:
        _m3_model = _load("lgbm_model.pkl")  # 기존 모델 사용

    features = _build_features(df, sentiment_score, has_disclosure)
    if _m3_model is None or features is None:
        return _rule_based_swing(df, sentiment_score, has_disclosure)

    from app.ml.feature_engineering import get_feature_columns
    tech_cols = get_feature_columns()
    swing_cols = tech_cols + ["sentiment_score", "has_disclosure_int"]
    available = [c for c in swing_cols if c in features]

    X = pd.DataFrame([{c: features.get(c, 0) for c in available}])
    try:
        X_valid = X[[c for c in X.columns if c in [f for f in _m3_model.feature_name_()
                                                     if hasattr(_m3_model, "feature_name_")]]]
        if X_valid.empty:
            X_valid = X
        proba = _m3_model.predict_proba(X_valid)[0]
        buy_proba = float(proba[1]) if len(proba) > 1 else 0.5
    except Exception:
        return _rule_based_swing(df, sentiment_score, has_disclosure)

    return {
        "model": "M3",
        "style": "swing",
        "buy_proba": round(buy_proba, 4),
        "sell_proba": round(1 - buy_proba, 4),
        "disclosure_boost": has_disclosure,
        "features": features,
    }


def _rule_based_swing(df: pd.DataFrame, sentiment_score: float,
                      has_disclosure: bool) -> dict:
    buy_proba = 0.35
    if len(df) >= 20:
        row = df.iloc[-1]
        if "rsi" in df.columns and 40 < row.get("rsi", 50) < 60:
            buy_proba += 0.1
        if "macd" in df.columns and "macd_signal" in df.columns:
            if row.get("macd", 0) > row.get("macd_signal", 0):
                buy_proba += 0.1
        if sentiment_score > 0.1:
            buy_proba += sentiment_score * 0.2
        if has_disclosure:
            buy_proba += 0.1
    buy_proba = min(buy_proba, 0.92)
    return {
        "model": "M3",
        "style": "swing",
        "buy_proba": round(buy_proba, 4),
        "sell_proba": round(1 - buy_proba, 4),
        "disclosure_boost": has_disclosure,
        "features": {},
    }


# ── M5: 앙상블 (로지스틱 회귀) ───────────────────────────────
_m5_model = None

def m5_ensemble(m2_result: dict, m3_result: dict,
                sentiment_score: float = 0.0) -> dict:
    """
    M5 — M2 + M3 출력을 입력으로 로지스틱 회귀 앙상블.
    모델 없으면 가중합 fallback.
    """
    global _m5_model
    if _m5_model is None:
        _m5_model = _load("m5_ensemble.pkl")

    m2_buy = m2_result.get("buy_proba", 0.5)
    m3_buy = m3_result.get("buy_proba", 0.5)

    if _m5_model is not None:
        X = pd.DataFrame([[m2_buy, m3_buy, sentiment_score]],
                         columns=["m2_buy", "m3_buy", "sentiment"])
        try:
            proba = _m5_model.predict_proba(X)[0]
            buy_proba = float(proba[1]) if len(proba) > 1 else 0.5
        except Exception:
            buy_proba = _weighted_ensemble(m2_buy, m3_buy, sentiment_score)
    else:
        buy_proba = _weighted_ensemble(m2_buy, m3_buy, sentiment_score)

    return {
        "model": "M5",
        "style": "ensemble",
        "buy_proba": round(buy_proba, 4),
        "sell_proba": round(1 - buy_proba, 4),
        "m2_buy": m2_buy,
        "m3_buy": m3_buy,
        "sentiment_score": sentiment_score,
    }


def _weighted_ensemble(m2: float, m3: float, sent: float) -> float:
    # 스타일별 가중치: 스캘핑 0.35 + 스윙 0.45 + 감성 0.2
    raw = m2 * 0.35 + m3 * 0.45 + (sent + 1) / 2 * 0.2
    return min(max(raw, 0.01), 0.99)


# ── 공통 피처 빌더 ───────────────────────────────────────────
def _build_features(df: pd.DataFrame, sentiment_score: float,
                    has_disclosure: bool = False) -> Optional[dict]:
    if df.empty or len(df) < 5:
        return None
    from app.ml.feature_engineering import get_feature_columns, compute
    cols = get_feature_columns()
    missing = [c for c in cols if c not in df.columns]
    if missing:
        try:
            df = compute(df)
        except Exception:
            return None
    row = df.iloc[-1]
    features = {c: float(row.get(c, 0)) for c in cols if c in df.columns}
    features["sentiment_score"] = float(sentiment_score)
    features["has_disclosure_int"] = int(has_disclosure)
    return features
