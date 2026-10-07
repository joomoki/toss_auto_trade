from sqlalchemy import Column, BigInteger, String, Boolean, Text, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class Watchlist(Base):
    """자동매매 관심 종목 (신호 생성 대상)"""
    __tablename__ = "watchlist"
    __table_args__ = {"comment": "자동매매 신호 생성 대상 관심 종목 테이블"}

    id         = Column(BigInteger,  primary_key=True,                              comment="종목 ID")
    stock_code = Column(String(20),  nullable=False, unique=True,                   comment="종목 코드 (예: 005930)")
    stock_name = Column(String(100), nullable=False,                                comment="종목명 (예: 삼성전자)")
    market     = Column(String(20),  nullable=False, default="KOSPI",               comment="시장 구분 (KOSPI / KOSDAQ / US)")
    sector     = Column(String(50),                                                  comment="섹터 (예: 반도체, IT, 바이오)")
    reason     = Column(Text,                                                        comment="편입 사유 (예: 시가총액 상위, 유동성 우수)")
    is_active  = Column(Boolean,     nullable=False, default=True,                  comment="신호 생성 활성화 여부")
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now(),        comment="등록일시")
