from sqlalchemy import Column, BigInteger, Integer, String, Date, UniqueConstraint, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class StockDailyPrice(Base):
    """종목별 일별 종가 이력 — 하루 1행 (종목코드 + 날짜 unique)"""
    __tablename__ = "stock_daily_prices"
    __table_args__ = (
        UniqueConstraint("stock_code", "trade_date", name="uq_stock_daily_price"),
        {"comment": "종목별 일별 종가 스냅샷 테이블 (자동 수집)"},
    )

    id          = Column(BigInteger, primary_key=True)
    stock_code  = Column(String(10), nullable=False,  comment="종목 코드")
    stock_name  = Column(String(100),                 comment="종목명")
    trade_date  = Column(Date,       nullable=False,  comment="기준일 (거래일)")
    close_price = Column(Integer,    nullable=False,  comment="종가 (원)")
    open_price  = Column(Integer,                     comment="시가")
    high_price  = Column(Integer,                     comment="고가")
    low_price   = Column(Integer,                     comment="저가")
    volume      = Column(BigInteger,                  comment="거래량")
    created_at  = Column(TIMESTAMP(timezone=True), server_default=func.now(), comment="수집일시")
