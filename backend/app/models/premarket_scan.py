from sqlalchemy import Column, Integer, String, Date, Numeric, BigInteger, Boolean, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from app.core.database import Base


class PremarketScanLog(Base):
    __tablename__ = "premarket_scan_logs"
    __table_args__ = (
        UniqueConstraint("scan_date", "stock_code", name="uq_premarket_date_code"),
        {"schema": "toss_stock"},
    )

    id            = Column(Integer, primary_key=True, index=True)
    scan_date     = Column(Date, nullable=False, index=True)
    stock_code    = Column(String(10), nullable=False)
    stock_name    = Column(String(100))

    # 프리장 데이터 (Naver Finance)
    premarket_price  = Column(BigInteger)       # 시간외 가격
    premarket_volume = Column(BigInteger)       # 시간외 거래량
    prev_close       = Column(BigInteger)       # 전일 종가
    prev_avg_volume  = Column(BigInteger)       # 20일 평균 거래량
    vol_ratio        = Column(Numeric(8, 2))    # 프리장 거래량 / 20일 평균
    price_change_pct = Column(Numeric(8, 2))    # 프리장 가격 변화율 (%)

    # 기존 신호
    news_sentiment   = Column(Numeric(5, 4))    # 최근 뉴스 감성 (-1~+1)
    model_score      = Column(Numeric(5, 4))    # AI 모델 종합 점수 (0~1)
    supply_score     = Column(Numeric(5, 4))    # 수급 점수 (0~1)

    # 종합 판단
    combined_score   = Column(Numeric(5, 4))    # 종합 점수
    signal           = Column(String(20))       # STRONG_BUY / BUY / WATCH / PASS
    signal_reasons   = Column(JSONB)            # 판단 근거 목록

    # 자동매매 우선순위 부스트 여부
    priority_boost   = Column(Boolean, default=False)
    was_traded       = Column(Boolean, default=False)  # 장 중 실제 매매됐는지

    created_at    = Column(DateTime(timezone=True), server_default=func.now())
