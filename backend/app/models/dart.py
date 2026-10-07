from sqlalchemy import Column, Integer, String, Numeric, Boolean, Date, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class DartDisclosure(Base):
    """OpenDART 공시 정보"""
    __tablename__ = "dart_disclosures"
    __table_args__ = {"comment": "OpenDART 공시 수집 테이블"}

    id              = Column(Integer,      primary_key=True)
    rcept_no        = Column(String(20),   unique=True, nullable=False,  comment="접수번호 (DART 고유 키)")
    rcept_dt        = Column(Date,         nullable=False,               comment="접수일")
    corp_code       = Column(String(20),   nullable=True,                comment="DART 기업코드 (8자리)")
    corp_name       = Column(String(100),  nullable=True,                comment="기업명")
    stock_code      = Column(String(10),   nullable=True, index=True,    comment="종목코드 (6자리, 상장사만)")
    corp_cls        = Column(String(5),    nullable=True,                comment="시장구분 Y=유가증권 K=코스닥 N=코넥스 E=기타")
    report_nm       = Column(String(500),  nullable=False,               comment="공시명")
    filer_nm        = Column(String(100),  nullable=True,                comment="제출인")
    disclosure_type = Column(String(50),   nullable=True,                comment="분류된 공시 유형 (공급계약/유상증자 등)")
    dart_score      = Column(Numeric(4,2), nullable=True,                comment="공시 자동 점수 (-1~+1, 양수=호재)")
    is_positive     = Column(Boolean,      nullable=True,                comment="호재 여부")
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
