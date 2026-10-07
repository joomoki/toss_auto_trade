from sqlalchemy import Column, BigInteger, String, Text, TIMESTAMP
from sqlalchemy.sql import func
from app.core.database import Base


class TelegramUserMessage(Base):
    """사용자가 텔레그램 봇에게 보낸 메시지 수신함 (명령어 + 일반 텍스트)"""
    __tablename__ = "telegram_user_messages"
    __table_args__ = {"comment": "사용자가 텔레그램에서 보낸 메시지 (웹 뷰어용)"}

    id          = Column(BigInteger,          primary_key=True)
    tg_msg_id   = Column(BigInteger,          nullable=True, unique=True,  comment="텔레그램 message_id (중복 방지)")
    received_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), comment="수신 시각")
    from_user   = Column(String(100),         nullable=True,               comment="발신자 이름")
    text        = Column(Text,                nullable=False,              comment="메시지 전문")
    is_command  = Column(String(1),           default='N',                 comment="명령어 여부 (Y/N)")
