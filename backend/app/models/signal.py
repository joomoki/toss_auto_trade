from sqlalchemy import Column, BigInteger, Integer, String, Numeric, TIMESTAMP, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from app.core.database import Base


class TradeSignal(Base):
    """ML 모델이 생성한 매수/매도 신호"""
    __tablename__ = "trade_signals"
    __table_args__ = {"comment": "ML 모델 매매 신호 이력 테이블"}

    id              = Column(BigInteger,           primary_key=True,                          comment="신호 ID")
    stock_code      = Column(String(20),           nullable=False,                            comment="종목 코드 (예: 005930)")
    stock_name      = Column(String(100),                                                     comment="종목명 (예: 삼성전자)")
    signal_type     = Column(String(10),           nullable=False,                            comment="신호 유형 (BUY / SELL / HOLD)")
    confidence      = Column(Numeric(5, 4),        nullable=False,                            comment="모델 신뢰도 (0~1)")
    price_at_signal = Column(Numeric(15, 2),       nullable=False,                            comment="신호 발생 시점 주가 (원)")
    features        = Column(JSONB,                                                           comment="신호 생성에 사용된 기술적 지표 값 (JSON)")
    strategy_id     = Column(Integer,              ForeignKey("strategies.id"),               comment="참조 전략 ID")
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now(),             comment="신호 생성일시")
