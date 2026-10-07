"""감성 분석기 — KR-FinBERT 우선, 실패 시 한국어 금융 사전 기반 fallback"""
import re
from typing import Optional

# ── 한국어 금융 감성 사전 (fallback용) ─────────────────────
POSITIVE_WORDS = [
    "상승", "급등", "호재", "실적개선", "흑자", "매수", "추천", "목표가 상향",
    "성장", "수혜", "회복", "반등", "신고가", "돌파", "확대", "수주", "합의",
    "개선", "증가", "호조", "강세", "긍정", "기대", "배당", "자사주",
]
NEGATIVE_WORDS = [
    "하락", "급락", "악재", "실적악화", "적자", "매도", "목표가 하향",
    "감소", "부진", "조정", "신저가", "우려", "리스크", "손실", "부채",
    "위기", "침체", "약세", "부정", "경고", "제재", "리콜", "소송",
]

_bert_pipeline = None
_bert_loaded = False


def _load_bert():
    global _bert_pipeline, _bert_loaded
    if _bert_loaded:
        return _bert_pipeline
    try:
        from transformers import pipeline
        _bert_pipeline = pipeline(
            "text-classification",
            model="snunlp/KR-FinBert-SC",
            tokenizer="snunlp/KR-FinBert-SC",
            device=-1,   # CPU
            truncation=True,
            max_length=512,
        )
        print("[SentimentAnalyzer] KR-FinBERT 로드 완료")
    except Exception as e:
        print(f"[SentimentAnalyzer] KR-FinBERT 로드 실패, lexicon fallback 사용: {e}")
        _bert_pipeline = None
    _bert_loaded = True
    return _bert_pipeline


def _lexicon_score(text: str) -> tuple[float, str]:
    """간단한 사전 기반 감성 점수 (-1 ~ +1)"""
    pos = sum(1 for w in POSITIVE_WORDS if w in text)
    neg = sum(1 for w in NEGATIVE_WORDS if w in text)
    total = pos + neg
    if total == 0:
        return 0.0, "NEUTRAL"
    score = (pos - neg) / total
    label = "POSITIVE" if score > 0.1 else ("NEGATIVE" if score < -0.1 else "NEUTRAL")
    return round(score, 4), label


def analyze(text: str) -> tuple[float, str]:
    """
    텍스트 감성 분석.
    반환: (score, label)  score: -1 ~ +1
    """
    if not text or not text.strip():
        return 0.0, "NEUTRAL"

    pipe = _load_bert()
    if pipe:
        try:
            result = pipe(text[:512])[0]
            label_raw = result["label"].upper()
            conf = float(result["score"])
            # KR-FinBert-SC 레이블: positive / negative / neutral
            if "POS" in label_raw:
                score = conf
                label = "POSITIVE"
            elif "NEG" in label_raw:
                score = -conf
                label = "NEGATIVE"
            else:
                score = 0.0
                label = "NEUTRAL"
            return round(score, 4), label
        except Exception as e:
            print(f"[SentimentAnalyzer] BERT inference error: {e}")

    return _lexicon_score(text)


def batch_analyze(texts: list[str]) -> list[tuple[float, str]]:
    """여러 텍스트 일괄 감성 분석"""
    return [analyze(t) for t in texts]


def aggregate_scores(scores: list[float]) -> float:
    """여러 뉴스 감성 점수 → 종목별 통합 점수 (가중평균)"""
    if not scores:
        return 0.0
    # 절댓값이 클수록 더 강한 신호 → 가중치로 사용
    weights = [abs(s) + 0.01 for s in scores]
    total_w = sum(weights)
    return round(sum(s * w for s, w in zip(scores, weights)) / total_w, 4)
