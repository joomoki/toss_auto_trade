"""
ML 모델 학습 파이프라인.
사용법: python -m app.ml.train --stock-codes 005930 000660 --target-pct 3.0 --target-bars 5
"""
import argparse
import asyncio
import os
import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score

from app.ml.feature_engineering import compute, get_feature_columns
from app.services.toss_api import TossApiClient


def make_labels(df: pd.DataFrame, target_pct: float = 3.0, target_bars: int = 5) -> pd.Series:
    """N봉 안에 +target_pct% 도달 여부를 레이블로 생성."""
    future_max = df["close"].shift(-1).rolling(target_bars).max().shift(-(target_bars - 1))
    return ((future_max - df["close"]) / df["close"] * 100 >= target_pct).astype(int)


async def collect_data(stock_codes: list[str], count: int = 500) -> pd.DataFrame:
    client = TossApiClient.get_instance()
    frames = []
    for code in stock_codes:
        df = await client.get_ohlcv(code, period="D", count=count)
        if df.empty:
            continue
        df = compute(df)
        df["stock_code"] = code
        frames.append(df)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def train(df: pd.DataFrame, target_pct: float = 3.0, target_bars: int = 5) -> LGBMClassifier:
    features = get_feature_columns()
    df = df.copy()
    df["label"] = make_labels(df, target_pct, target_bars)
    df = df.dropna(subset=features + ["label"])

    X = df[features].values
    y = df["label"].values

    tscv = TimeSeriesSplit(n_splits=5)
    aucs = []
    model = None

    for fold, (train_idx, val_idx) in enumerate(tscv.split(X)):
        m = LGBMClassifier(
            n_estimators=500,
            learning_rate=0.05,
            max_depth=6,
            num_leaves=31,
            subsample=0.8,
            colsample_bytree=0.8,
            class_weight="balanced",
            random_state=42,
            n_jobs=-1,
        )
        m.fit(
            X[train_idx], y[train_idx],
            eval_set=[(X[val_idx], y[val_idx])],
            callbacks=[],
        )
        preds = m.predict_proba(X[val_idx])[:, 1]
        auc = roc_auc_score(y[val_idx], preds)
        aucs.append(auc)
        print(f"Fold {fold + 1} AUC: {auc:.4f}")
        model = m

    print(f"Mean AUC: {np.mean(aucs):.4f}")
    return model


def save_model(model: LGBMClassifier, path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    joblib.dump(model, path)
    print(f"Model saved to {path}")


async def main(stock_codes: list[str], target_pct: float, target_bars: int, output: str):
    print(f"Collecting OHLCV data for {stock_codes}...")
    df = await collect_data(stock_codes)
    if df.empty:
        print("No data collected. Check API connection.")
        return
    print(f"Training on {len(df)} rows...")
    model = train(df, target_pct, target_bars)
    save_model(model, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stock-codes", nargs="+", default=["005930", "000660"])
    parser.add_argument("--target-pct", type=float, default=3.0)
    parser.add_argument("--target-bars", type=int, default=5)
    parser.add_argument("--output", default="./app/ml/models/lgbm_v1.pkl")
    args = parser.parse_args()
    asyncio.run(main(args.stock_codes, args.target_pct, args.target_bars, args.output))
