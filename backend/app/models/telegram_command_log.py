from sqlalchemy import Column, BigInteger, Integer, String, Text, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class TelegramCommandLog(Base):
    """텔레그램 명령어 수신·실행 이력"""
    __tablename__ = "telegram_command_logs"
    __table_args__ = {"comment": "텔레그램 봇 명령어 수신 및 실행 이력"}

    id           = Column(BigInteger, primary_key=True,                          comment="이력 ID")
    received_at  = Column(TIMESTAMP(timezone=True), server_default=func.now(),   comment="수신 시각")
    source       = Column(String(20),  default="telegram",                       comment="명령 출처 (telegram/web)")
    chat_id      = Column(String(50),                                            comment="텔레그램 chat_id")
    user_name    = Column(String(100),                                           comment="발신자 이름")
    raw_text     = Column(Text,                                                  comment="수신 원본 텍스트")
    command_type = Column(String(20),                                            comment="명령 유형 (buy/sell/sellall/holdings/status/help/unknown)")
    stock_code   = Column(String(10),                                            comment="대상 종목 코드")
    stock_name   = Column(String(100),                                           comment="대상 종목명")
    quantity     = Column(Integer,                                               comment="수량")
    result       = Column(String(20),                                            comment="실행 결과 (success/error/rejected/unknown)")
    result_msg   = Column(Text,                                                  comment="결과 메시지")
