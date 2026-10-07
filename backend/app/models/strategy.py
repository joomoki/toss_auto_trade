from sqlalchemy import Column, Integer, String, Numeric, Boolean, TIMESTAMP, JSON
from sqlalchemy.sql import func
from app.core.database import Base


class Strategy(Base):
    """자동매매 전략 설정"""
    __tablename__ = "strategies"
    __table_args__ = {"comment": "자동매매 전략 설정 테이블"}

    id              = Column(Integer,              primary_key=True,                          comment="전략 ID")
    name            = Column(String(100),          nullable=False,                            comment="전략명")
    model_version   = Column(String(50),                                                      comment="ML 모델 버전 (예: lgbm_v1)")
    buy_threshold   = Column(Numeric(5, 4),        default=0.57,                              comment="매수 신호 임계값 (0~1, 이 값 이상이면 매수)")
    sell_threshold  = Column(Numeric(5, 4),        default=0.6,                               comment="매도 신호 임계값 (0~1, 이 값 이상이면 매도)")
    stop_loss_pct   = Column(Numeric(5, 2),        default=3.0,                               comment="손절 기준 (%, 예: 3.0 → -3% 하락 시 매도)")
    take_profit_pct = Column(Numeric(5, 2),        default=5.0,                               comment="익절 기준 (%, 예: 5.0 → +5% 상승 시 매도)")
    max_position_amt    = Column(Numeric(15, 2),                                               comment="종목당 최대 투자 금액 (원)")
    max_daily_loss_pct  = Column(Numeric(5, 2),    default=5.0,                               comment="일일 최대 손실률 (%, 이 비율 초과 시 킬스위치 자동 발동)")
    kill_switch_active  = Column(Boolean,          default=False,                             comment="킬스위치 활성화 여부 (True면 모든 자동매매 즉시 중단)")
    model_weights       = Column(JSON,             nullable=True,                             comment="모델별 가중치 {'M1': 1.2, 'M2': 0.8, ...} — 적중률 기반, null이면 균등 가중치")
    is_active           = Column(Boolean,          default=False,                             comment="자동매매 활성화 여부")

    # 동적 익절: 수급이 좋으면 익절 기준을 자동으로 상향
    dynamic_tp_enabled          = Column(Boolean,       default=False,  comment="동적 익절 활성화")
    dynamic_tp_supply_threshold = Column(Numeric(4, 2), default=0.65,   comment="수급 점수 기준 (이 값 이상이면 동적 익절 적용)")
    dynamic_tp_multiplier       = Column(Numeric(4, 2), default=1.5,    comment="동적 익절 배수 (기본 익절 × 이 값)")
    total_deposited             = Column(Numeric(15, 2), default=0,     comment="총 입금액 (원) — 사용자 수동 입력, 실손익 계산 기준")
    created_at          = Column(TIMESTAMP(timezone=True), server_default=func.now(),         comment="생성일시")
    updated_at          = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), comment="수정일시")
