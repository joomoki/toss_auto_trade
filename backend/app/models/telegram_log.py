from sqlalchemy import Column, BigInteger, String, Text, Boolean, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class TelegramLog(Base):
    """텔레그램 알림 전송 이력"""
    __tablename__ = "telegram_logs"
    __table_args__ = {"comment": "텔레그램 알림 전송 이력 테이블"}

    id         = Column(BigInteger,               primary_key=True,                        comment="이력 ID")
    msg_type   = Column(String(30),  nullable=False,                                       comment="알림 유형 (buy/sell/kill_switch/error/report/portfolio/hourly/close/screening/test/general)")
    stock_code = Column(String(10),                                                         comment="종목 코드 (해당 시)")
    stock_name = Column(String(100),                                                        comment="종목명 (해당 시)")
    message    = Column(Text,                                                               comment="전송 메시지 본문 (최대 1000자)")
    is_success = Column(Boolean,     nullable=False, default=True,                         comment="전송 성공 여부")
    sent_at    = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False, comment="전송 시각")
