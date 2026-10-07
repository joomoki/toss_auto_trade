from sqlalchemy import Column, BigInteger, Integer, String, Numeric, TIMESTAMP, Boolean
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from app.core.database import Base


class BacktestRun(Base):
    """백테스트 실행 설정 및 결과"""
    __tablename__ = "backtest_runs"
    __table_args__ = {"comment": "백테스트 실행 이력 및 결과 테이블"}

    id               = Column(BigInteger,        primary_key=True,                           comment="백테스트 ID")
    name             = Column(String(100),                                                    comment="백테스트 이름 (사용자 지정)")
    stock_codes      = Column(JSONB,             nullable=False,                             comment="테스트 대상 종목 코드 목록 (JSON 배열)")
    start_date       = Column(String(10),        nullable=False,                             comment="백테스트 시작일 (YYYY-MM-DD)")
    end_date         = Column(String(10),        nullable=False,                             comment="백테스트 종료일 (YYYY-MM-DD)")
    initial_capital  = Column(Numeric(15, 2),    nullable=False,                             comment="초기 투자 원금 (원)")
    buy_threshold    = Column(Numeric(5, 4),                                                  comment="매수 신호 임계값 (0~1)")
    sell_threshold   = Column(Numeric(5, 4),                                                  comment="매도 신호 임계값 (0~1)")
    stop_loss_pct    = Column(Numeric(5, 2),                                                  comment="손절 기준 (%)")
    take_profit_pct  = Column(Numeric(5, 2),                                                  comment="익절 기준 (%)")
    max_position_amt = Column(Numeric(15, 2),                                                 comment="종목당 최대 투자 금액 (원)")
    max_holdings     = Column(Integer,           default=10,                                 comment="최대 동시 보유 종목 수")

    # 성과 지표
    total_return_pct = Column(Numeric(10, 4),                                                comment="총 수익률 (%)")
    cagr_pct         = Column(Numeric(10, 4),                                                comment="연평균 복합 성장률 CAGR (%)")
    max_drawdown_pct = Column(Numeric(10, 4),                                                comment="최대 낙폭 MDD (%)")
    sharpe_ratio     = Column(Numeric(8, 4),                                                 comment="샤프 지수 (위험 조정 수익률)")
    win_rate         = Column(Numeric(8, 4),                                                 comment="승률 (%, 수익 거래 / 전체 거래)")
    profit_factor    = Column(Numeric(8, 4),                                                 comment="손익비 (총수익 / 총손실)")
    total_trades     = Column(Integer,                                                        comment="전체 거래 횟수")
    win_trades       = Column(Integer,                                                        comment="수익 거래 횟수")
    lose_trades      = Column(Integer,                                                        comment="손실 거래 횟수")
    final_capital    = Column(Numeric(15, 2),                                                comment="최종 평가 자산 (원)")

    # 상세 이력
    equity_curve     = Column(JSONB,                                                         comment="자산 곡선 [{date, value}, ...]")
    trade_log        = Column(JSONB,                                                         comment="거래 로그 [{date, stock, type, price, qty, pnl}, ...]")

    status           = Column(String(20),        default="RUNNING",                          comment="실행 상태 (RUNNING / DONE / FAILED)")
    error_msg        = Column(String(500),                                                    comment="실패 시 오류 메시지")
    created_at       = Column(TIMESTAMP(timezone=True), server_default=func.now(),           comment="백테스트 시작일시")
    completed_at     = Column(TIMESTAMP(timezone=True),                                      comment="백테스트 완료일시")
