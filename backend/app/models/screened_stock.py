from sqlalchemy import Column, BigInteger, Integer, String, Numeric, Boolean, TIMESTAMP, ARRAY
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from app.core.database import Base


class ScreenedStock(Base):
    """종목 스크리닝 결과 이력 — 스캘핑/스윙 후보 스냅샷"""
    __tablename__ = "screened_stocks"
    __table_args__ = {"comment": "자동 종목 스크리닝 결과 이력 테이블 (스캘핑/스윙 후보 스냅샷)"}

    id               = Column(BigInteger,            primary_key=True,                           comment="스크리닝 ID")
    screened_at      = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now(), comment="스크리닝 실행 일시")
    stock_code       = Column(String(20),            nullable=False,                             comment="종목 코드")
    stock_name       = Column(String(100),                                                       comment="종목명")
    screen_style     = Column(String(20),            nullable=False,                             comment="스크리닝 유형 (scalping / swing / full)")
    sentiment_score  = Column(Numeric(6, 4),                                                     comment="뉴스 감성 집계 점수 (-1~+1)")
    news_count       = Column(Integer,               default=0,                                  comment="분석에 사용된 뉴스 건수")
    has_disclosure   = Column(Boolean,               default=False,                              comment="최근 공시 존재 여부")
    model_score      = Column(Numeric(6, 4),                                                     comment="M1-M10 앙상블 모델 점수 (0~1)")
    news_score       = Column(Numeric(6, 4),                                                     comment="정규화 뉴스 감성 점수 (0~1, 0.5=중립)")
    dart_score       = Column(Numeric(6, 4),                                                     comment="DART 공시 점수 (0~1, 0.5=중립)")
    supply_score     = Column(Numeric(6, 4),                                                     comment="외국인/기관 수급 점수 (0~1, 0.5=중립)")
    market_score     = Column(Numeric(6, 4),                                                     comment="시장 상황 점수 (0~1)")
    composite_score  = Column(Numeric(6, 4),                                                     comment="최종 종합 점수 (0~1)")
    final_signal     = Column(String(10),                                                        comment="최종 신호 (BUY / SELL / HOLD)")
    trigger_models   = Column(ARRAY(String),                                                     comment="BUY 신호를 낸 모델 목록")
    model_scores     = Column(JSONB,                                                             comment="모델별 상세 점수 {M1: {score, signal}, ...}")
    current_price    = Column(Integer,                                                           comment="스크리닝 시점 현재가 (원)")
