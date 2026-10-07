from sqlalchemy import Column, String, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class StockMaster(Base):
    """KOSPI/KOSDAQ 전종목 마스터 — 서버 시작 시 1회 갱신"""
    __tablename__ = "stock_master"
    __table_args__ = {"comment": "KOSPI/KOSDAQ 종목 마스터 (pykrx 갱신)"}

    stock_code = Column(String(20), primary_key=True,  comment="종목 코드 (6자리)")
    stock_name = Column(String(100), nullable=False,    comment="종목명")
    market     = Column(String(20),  nullable=False,    comment="KOSPI / KOSDAQ")
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())
