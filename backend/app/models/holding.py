from sqlalchemy import Column, BigInteger, Integer, String, Numeric, Boolean, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class Holding(Base):
    """자동매매 현재 보유 종목 (실시간 포지션)"""
    __tablename__ = "holdings"
    __table_args__ = {"comment": "자동매매 보유 종목 포지션 테이블 (종목당 1행)"}

    id              = Column(BigInteger,          primary_key=True,                          comment="보유 ID")
    stock_code      = Column(String(20),          nullable=False, unique=True,               comment="종목 코드 (고유)")
    stock_name      = Column(String(100),                                                     comment="종목명")
    quantity        = Column(Integer,             nullable=False,                            comment="보유 수량 (주)")
    avg_buy_price   = Column(Numeric(15, 2),      nullable=False,                            comment="평균 매수 단가 (원)")
    current_price   = Column(Numeric(15, 2),                                                  comment="현재가 (원, 주기적 갱신)")
    unrealized_pnl  = Column(Numeric(15, 2),                                                  comment="평가 손익 (원, 현재가 기준)")
    unrealized_pnl_pct = Column(Numeric(8, 4),                                               comment="평가 손익률 (%)")
    is_manual       = Column(Boolean,                  default=False,                                 comment="수동 매수 예약으로 체결된 종목 여부")
    is_long_term    = Column(Boolean,                  default=False,                                 comment="장기 보유 전략 종목 여부 (LongTermStrategy)")
    peak_pnl_pct    = Column(Numeric(8, 4),                                                    comment="보유 중 최고 수익률 (%, 트레일링 스탑 기준)")
    smart_hold_loss_cycles = Column(Integer,           default=0,                                     comment="스마트홀딩 중 -1.5% 이하 연속 사이클 수")
    updated_at      = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), comment="마지막 갱신일시")


class DailyPnl(Base):
    """일별 실현 손익 집계"""
    __tablename__ = "daily_pnl"
    __table_args__ = {"comment": "일별 자동매매 손익 집계 테이블 (날짜당 1행)"}

    id            = Column(BigInteger,    primary_key=True,                                  comment="집계 ID")
    trade_date    = Column(String(10),    nullable=False, unique=True,                       comment="거래일 (YYYY-MM-DD)")
    realized_pnl  = Column(Numeric(15, 2), default=0,                                        comment="당일 실현 손익 합계 (원)")
    total_buy_amt = Column(Numeric(15, 2), default=0,                                        comment="당일 총 매수 금액 (원)")
    total_sell_amt= Column(Numeric(15, 2), default=0,                                        comment="당일 총 매도 금액 (원)")
    trade_count   = Column(Integer,        default=0,                                        comment="당일 체결 건수")
    win_count     = Column(Integer,        default=0,                                        comment="당일 수익 거래 수")
    lose_count    = Column(Integer,        default=0,                                        comment="당일 손실 거래 수")
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now(),              comment="집계 생성일시")
