from sqlalchemy import Column, BigInteger, String, Numeric, TIMESTAMP, Text, Date
from sqlalchemy.sql import func
from app.core.database import Base


class PortfolioHolding(Base):
    """개인 보유 종목 (자동매매와 별도 관리)"""
    __tablename__ = "portfolio_holdings"
    __table_args__ = {"comment": "개인 포트폴리오 보유 종목 테이블 (자동매매 holdings와 분리)"}

    id                 = Column(BigInteger,       primary_key=True,                          comment="보유 ID")
    stock_code         = Column(String(20),       nullable=False, unique=True,               comment="종목 코드 (예: 005930, TSLA)")
    stock_name         = Column(String(100),                                                  comment="종목명 (예: 삼성전자, 테슬라)")
    quantity           = Column(Numeric(18, 6),   nullable=False,                            comment="보유 수량 (해외주식 소수점 지원, 예: 17.004809)")
    avg_buy_price      = Column(Numeric(20, 6),   nullable=False,                            comment="평균 매수 단가 (USD 소수점 지원)")
    current_price      = Column(Numeric(15, 2),                                               comment="현재가 (토스 API 동기화 시 갱신)")
    unrealized_pnl     = Column(Numeric(15, 2),                                               comment="평가 손익 (원 또는 USD, 현재가 기준)")
    unrealized_pnl_pct = Column(Numeric(8, 4),                                               comment="평가 손익률 (%)")
    buy_date           = Column(Date,                                                         comment="최초 매수일")
    memo               = Column(Text,                                                         comment="사용자 메모")
    source             = Column(String(20),       default="MANUAL",                          comment="데이터 출처 (MANUAL: 직접 입력 / TOSS_SYNC: 토스 API 동기화)")
    updated_at         = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), comment="마지막 수정일시")
    created_at         = Column(TIMESTAMP(timezone=True), server_default=func.now(),         comment="등록일시")


class PortfolioTransaction(Base):
    """개인 포트폴리오 매수/매도 거래 기록"""
    __tablename__ = "portfolio_transactions"
    __table_args__ = {"comment": "개인 포트폴리오 거래 내역 테이블 (수익률 추적용)"}

    id               = Column(BigInteger,         primary_key=True,                          comment="거래 ID")
    stock_code       = Column(String(20),         nullable=False,                            comment="종목 코드")
    stock_name       = Column(String(100),                                                    comment="종목명")
    transaction_type = Column(String(10),         nullable=False,                            comment="거래 유형 (BUY / SELL)")
    quantity         = Column(Numeric(18, 6),     nullable=False,                            comment="거래 수량 (소수점 지원)")
    price            = Column(Numeric(20, 6),     nullable=False,                            comment="거래 단가")
    amount           = Column(Numeric(20, 6),     nullable=False,                            comment="거래 금액 (단가 × 수량)")
    commission       = Column(Numeric(10, 2),     default=0,                                 comment="수수료")
    transaction_date = Column(Date,               nullable=False,                            comment="거래일 (YYYY-MM-DD)")
    memo             = Column(Text,                                                           comment="거래 메모")
    created_at       = Column(TIMESTAMP(timezone=True), server_default=func.now(),           comment="기록 생성일시")
