from sqlalchemy import Column, Integer, String, JSON, TIMESTAMP, Numeric
from sqlalchemy.sql import func
from app.core.database import Base


class MacroRunLog(Base):
    """매크로 파이프라인 실행 이력"""
    __tablename__ = "macro_run_logs"

    id           = Column(Integer, primary_key=True)
    mode         = Column(String(10), default="paper", comment="paper / live")
    events_json  = Column(JSON, nullable=True, comment="감지된 이벤트 목록")
    signals_json = Column(JSON, nullable=True, comment="섹터 신호 목록")
    orders_count = Column(Integer, default=0,  comment="발주 건수")
    run_at       = Column(TIMESTAMP(timezone=True), server_default=func.now())


class MacroBacktestRun(Base):
    """백테스트 실행 이력"""
    __tablename__ = "macro_backtest_runs"

    id               = Column(Integer, primary_key=True)
    start_date       = Column(String(10), comment="시작일 YYYY-MM-DD")
    end_date         = Column(String(10), comment="종료일 YYYY-MM-DD")
    initial_capital  = Column(Numeric(15, 2))
    total_return     = Column(Numeric(8, 4))
    annualized_return= Column(Numeric(8, 4))
    max_drawdown     = Column(Numeric(8, 4))
    sharpe_ratio     = Column(Numeric(8, 4))
    win_rate         = Column(Numeric(5, 4))
    total_trades     = Column(Integer)
    benchmark_return = Column(Numeric(8, 4))
    excess_return    = Column(Numeric(8, 4))
    equity_curve     = Column(JSON, nullable=True)
    created_at       = Column(TIMESTAMP(timezone=True), server_default=func.now())
