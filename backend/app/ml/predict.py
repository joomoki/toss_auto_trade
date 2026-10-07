import os
from typing import Optional
import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

from app.ml.feature_engineering import get_feature_columns
from app.core.config import settings


_model: Optional[LGBMClassifier] = None


def load_model() -> Optional[LGBMClassifier]:
    global _model
    if _model is not None:
        return _model
    path = settings.model_path
    if os.path.exists(path):
        _model = joblib.load(path)
    return _model


def predict(df: pd.DataFrame) -> dict:
    """
    피처가 이미 계산된 DataFrame의 마지막 행으로 예측.
    Returns: {"buy_proba": float, "sell_proba": float, "features": dict}
    """
    model = load_model()
    if model is None:
        return {"buy_proba": 0.0, "sell_proba": 0.0, "features": {}}

    features = get_feature_columns()
    missing = [f for f in features if f not in df.columns]
    if missing:
        return {"buy_proba": 0.0, "sell_proba": 0.0, "features": {}}

    last_row = df[features].iloc[[-1]]
    buy_proba = float(model.predict_proba(last_row)[0][1])
    # sell_proba: 반대 방향 모델이 없으면 1 - buy_proba 근사
    sell_proba = 1.0 - buy_proba

    feature_values = last_row.iloc[0].to_dict()
    return {
        "buy_proba": round(buy_proba, 4),
        "sell_proba": round(sell_proba, 4),
        "features": {k: round(float(v), 6) for k, v in feature_values.items()},
    }
