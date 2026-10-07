import numpy as np
import pandas as pd


def compute(df: pd.DataFrame) -> pd.DataFrame:
    """
    OHLCV DataFrame으로부터 ML 피처를 생성한다.
    최소 200봉 데이터가 필요하며, NaN이 있는 행은 제거 후 반환.
    """
    df = df.copy()
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]

    # --- 추세 피처 ---
    for span in [5, 10, 20, 60]:
        df[f"ema_{span}"] = close.ewm(span=span, adjust=False).mean()

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    df["macd"] = ema12 - ema26
    df["macd_signal"] = df["macd"].ewm(span=9, adjust=False).mean()
    df["macd_hist"] = df["macd"] - df["macd_signal"]

    df["adx"] = _adx(high, low, close, period=14)

    # --- 모멘텀 피처 ---
    df["rsi_14"] = _rsi(close, 14)

    stoch_k, stoch_d = _stochastic(high, low, close, k_period=14, d_period=3)
    df["stoch_k"] = stoch_k
    df["stoch_d"] = stoch_d

    df["cci_20"] = _cci(high, low, close, 20)

    # --- 변동성 피처 ---
    df["atr_14"] = _atr(high, low, close, 14)

    bb_mid = close.rolling(20).mean()
    bb_std = close.rolling(20).std()
    bb_upper = bb_mid + 2 * bb_std
    bb_lower = bb_mid - 2 * bb_std
    df["bb_pct_b"] = (close - bb_lower) / (bb_upper - bb_lower + 1e-9)
    df["bb_width"] = (bb_upper - bb_lower) / (bb_mid + 1e-9)

    # --- 거래량 피처 ---
    obv = (np.sign(close.diff()) * volume).fillna(0).cumsum()
    df["obv"] = obv
    df["volume_ratio"] = volume / volume.rolling(20).mean()

    tp = (high + low + close) / 3
    vwap_num = (tp * volume).rolling(20).sum()
    vwap_den = volume.rolling(20).sum()
    df["vwap_ratio"] = close / (vwap_num / (vwap_den + 1e-9))

    # --- 가격 패턴 피처 ---
    df["gap_ratio"] = (df["open"] - close.shift(1)) / (close.shift(1) + 1e-9)
    df["pos_vs_prev_close"] = (close - close.shift(1)) / (close.shift(1) + 1e-9)
    df["high_low_range"] = (high - low) / (close + 1e-9)

    df = df.replace([np.inf, -np.inf], np.nan).dropna()
    return df


def get_feature_columns() -> list[str]:
    return [
        "ema_5", "ema_10", "ema_20", "ema_60",
        "macd", "macd_signal", "macd_hist", "adx",
        "rsi_14", "stoch_k", "stoch_d", "cci_20",
        "atr_14", "bb_pct_b", "bb_width",
        "obv", "volume_ratio", "vwap_ratio",
        "gap_ratio", "pos_vs_prev_close", "high_low_range",
    ]


def _rsi(series: pd.Series, period: int) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / (loss + 1e-9)
    return 100 - (100 / (1 + rs))


def _stochastic(high, low, close, k_period=14, d_period=3):
    lowest = low.rolling(k_period).min()
    highest = high.rolling(k_period).max()
    k = 100 * (close - lowest) / (highest - lowest + 1e-9)
    d = k.rolling(d_period).mean()
    return k, d


def _cci(high, low, close, period=20):
    tp = (high + low + close) / 3
    sma = tp.rolling(period).mean()
    mad = tp.rolling(period).apply(lambda x: np.mean(np.abs(x - x.mean())), raw=True)
    return (tp - sma) / (0.015 * mad + 1e-9)


def _atr(high, low, close, period=14):
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def _adx(high, low, close, period=14):
    prev_high = high.shift(1)
    prev_low = low.shift(1)
    dm_plus = np.where((high - prev_high) > (prev_low - low), np.maximum(high - prev_high, 0), 0)
    dm_minus = np.where((prev_low - low) > (high - prev_high), np.maximum(prev_low - low, 0), 0)
    atr = _atr(high, low, close, period)
    di_plus = 100 * pd.Series(dm_plus, index=high.index).rolling(period).sum() / (atr + 1e-9)
    di_minus = 100 * pd.Series(dm_minus, index=high.index).rolling(period).sum() / (atr + 1e-9)
    dx = 100 * (di_plus - di_minus).abs() / (di_plus + di_minus + 1e-9)
    return dx.rolling(period).mean()
