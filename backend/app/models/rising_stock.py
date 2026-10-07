from sqlalchemy import Column, Integer, String, Date, Numeric, BigInteger, Boolean, Text, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from app.core.database import Base


class RisingStockLog(Base):
    __tablename__ = "rising_stock_logs"
    __table_args__ = (
        UniqueConstraint("analysis_date", "stock_code", name="uq_rising_date_code"),
        {"schema": "toss_stock"},
    )

    id            = Column(Integer, primary_key=True, index=True)
    analysis_date = Column(Date, nullable=False, index=True)
    stock_code    = Column(String(10), nullable=False)
    stock_name    = Column(String(100))
    market        = Column(String(10))           # KOSPI / KOSDAQ

    # 가격
    open_price    = Column(Integer)
    close_price   = Column(Integer)
    high_price    = Column(Integer)
    low_price     = Column(Integer)
    change_pct    = Column(Numeric(7, 2))
    volume        = Column(BigInteger)
    trading_value = Column(BigInteger)           # 거래대금 (원)
    volume_ratio  = Column(Numeric(7, 2))        # 오늘 거래량 / 20일 평균

    # 수급
    foreign_net   = Column(BigInteger)           # 외국인 순매수
    institution_net = Column(BigInteger)         # 기관 순매수

    # 뉴스
    news_sentiment = Column(Numeric(5, 4))
    news_count    = Column(Integer, default=0)
    news_keywords = Column(JSONB)
    top_news      = Column(Text)

    # 원인 분석
    rise_causes   = Column(JSONB)                # ["뉴스호재", "거래량급증", ...]
    rise_category = Column(String(30))           # news / supply / volume / momentum / unknown

    # 자동매매 시스템 매칭
    was_in_watchlist = Column(Boolean, default=False)
    was_bought    = Column(Boolean, default=False)
    ai_score      = Column(Numeric(5, 4))        # 당일 종합점수 (있으면)

    created_at    = Column(DateTime(timezone=True), server_default=func.now())
