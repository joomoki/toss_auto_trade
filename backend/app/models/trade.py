from sqlalchemy import Column, BigInteger, Integer, String, Numeric, TIMESTAMP, ForeignKey, Date
from sqlalchemy.sql import func
from app.core.database import Base


class Trade(Base):
    """자동매매 주문 및 체결 이력"""
    __tablename__ = "trades"
    __table_args__ = {"comment": "자동매매 주문/체결 이력 테이블"}

    id           = Column(BigInteger,          primary_key=True,                             comment="거래 ID")
    signal_id    = Column(BigInteger,          ForeignKey("trade_signals.id"),               comment="연결된 매매 신호 ID")
    order_id     = Column(String(50),          unique=True,                                  comment="토스증권 주문 번호")
    stock_code   = Column(String(20),          nullable=False,                               comment="종목 코드")
    stock_name   = Column(String(100),                                                       comment="종목명")
    trade_type   = Column(String(10),          nullable=False,                               comment="거래 유형 (BUY / SELL)")
    order_qty    = Column(Integer,             nullable=False,                               comment="주문 수량 (주)")
    order_price  = Column(Numeric(15, 2),      nullable=False,                               comment="주문 단가 (원)")
    filled_qty   = Column(Integer,             default=0,                                    comment="체결 수량 (주)")
    filled_price = Column(Numeric(15, 2),                                                    comment="체결 단가 (원)")
    filled_amount= Column(Numeric(15, 2),                                                    comment="체결 금액 (원, 체결단가 × 체결수량)")
    commission   = Column(Numeric(10, 2),      default=0,                                    comment="수수료 (원)")
    status       = Column(String(20),          default="PENDING",                            comment="주문 상태 (PENDING / FILLED / CANCELLED / FAILED)")
    trade_date   = Column(Date,                nullable=False,                               comment="거래일 (YYYY-MM-DD)")
    created_at   = Column(TIMESTAMP(timezone=True), server_default=func.now(),               comment="주문 생성일시")
    filled_at    = Column(TIMESTAMP(timezone=True),                                          comment="체결 완료일시")
