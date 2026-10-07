from sqlalchemy import Column, BigInteger, Integer, String, Numeric, Boolean, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class ManualBuyOrder(Base):
    """수동 매수 예약 — 개장 시 자동 체결, 매도는 자동매매 규칙 적용"""
    __tablename__ = "manual_buy_orders"
    __table_args__ = {"comment": "수동 매수 예약 종목 (개장 시 즉시 매수)"}

    id             = Column(BigInteger, primary_key=True,                       comment="주문 ID")
    stock_code     = Column(String(20),  nullable=False,                         comment="종목 코드")
    stock_name     = Column(String(100),                                          comment="종목명")
    quantity       = Column(Integer,                                              comment="지정 수량 (NULL이면 budget 사용)")
    budget         = Column(Numeric(15, 2),                                       comment="투자 예산 원 단위 (quantity가 NULL일 때 사용)")
    status         = Column(String(20),  nullable=False, default="pending",       comment="pending/executed/cancelled/failed")
    created_at     = Column(TIMESTAMP(timezone=True), server_default=func.now(), comment="등록 일시")
    executed_at    = Column(TIMESTAMP(timezone=True),                             comment="체결 일시")
    executed_price = Column(Integer,                                              comment="체결 단가")
    executed_qty   = Column(Integer,                                              comment="체결 수량")
    error_msg      = Column(String(500),                                          comment="실패 사유")
