from sqlalchemy import Column, BigInteger, String, Numeric, Text, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class DailyAccountSnapshot(Base):
    """일별 계좌 잔고·보유종목 스냅샷 (15:40 자동 저장)"""
    __tablename__ = "daily_account_snapshots"
    __table_args__ = {"comment": "키움 계좌 일별 잔고 스냅샷 (15:40 자동 저장)"}

    id              = Column(BigInteger,          primary_key=True)
    trade_date      = Column(String(10),          nullable=False, unique=True,  comment="거래일 YYYY-MM-DD")
    cash            = Column(Numeric(18, 2),      default=0,                    comment="D+0 예수금")
    available_cash  = Column(Numeric(18, 2),      default=0,                    comment="D+2 주문가능금액")
    total_asset     = Column(Numeric(18, 2),      default=0,                    comment="총자산 (d2예수금+주식평가)")
    total_buy_amount= Column(Numeric(18, 2),      default=0,                    comment="총매입금액")
    total_pnl       = Column(Numeric(18, 2),      default=0,                    comment="평가손익")
    total_pnl_rate  = Column(Numeric(10, 4),      default=0,                    comment="손익률(%)")
    holdings_json   = Column(Text,                nullable=True,                comment="보유종목 JSON 배열")
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
