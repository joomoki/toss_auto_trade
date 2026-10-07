"""
뉴스 필터 게이트 (Phase 3)

역할: composite_score 계산과 별개로 뉴스 악재를 하드 차단한다.
  - news_score < BLOCK_THRESHOLD  → BUY 진입 금지 (악재 차단)
  - news_score >= BLOCK_THRESHOLD → 통과 (점수 가중치는 이미 composite에 반영됨)

news_score 범위: 0 (최악) ~ 1 (최호재), 중립 = 0.5
"""
from __future__ import annotations

BLOCK_THRESHOLD = 0.30   # 이 이하면 명확한 악재 뉴스로 간주하여 BUY 차단


def check_news_gate(news_score: float) -> tuple[bool, str]:
    """
    Returns:
      (allowed: bool, reason: str)
      allowed=False 이면 호출자는 BUY 주문을 생략해야 한다.
    """
    if news_score < BLOCK_THRESHOLD:
        return False, f"뉴스 악재 차단 (score={news_score:.2f} < {BLOCK_THRESHOLD})"
    return True, "OK"
