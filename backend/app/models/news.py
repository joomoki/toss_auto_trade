from sqlalchemy import Column, BigInteger, Integer, String, Numeric, Boolean, Text, TIMESTAMP, Date, ARRAY
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from app.core.database import Base


class MlModel(Base):
    """ML 모델 레지스트리"""
    __tablename__ = "ml_models"
    __table_args__ = {"comment": "자동매매 ML 모델 목록 및 성과 지표 테이블"}

    id                  = Column(Integer,       primary_key=True,                           comment="모델 ID")
    model_id            = Column(String(20),    nullable=False, unique=True,                comment="모델 식별자 (M1~M10)")
    model_name          = Column(String(100),   nullable=False,                             comment="모델 이름")
    model_type          = Column(String(20),    default="technical",                        comment="유형 (technical/ml/sentiment/ensemble)")
    trade_style         = Column(String(20),                                                comment="매매 스타일 (scalping/swing/ensemble)")
    description         = Column(Text,                                                      comment="모델 설명")
    version             = Column(String(20),                                                comment="모델 버전")
    file_path           = Column(Text,                                                      comment="모델 파일 경로")
    is_active           = Column(Boolean,       nullable=False, default=True,               comment="활성화 여부")
    recommended_stocks       = Column(ARRAY(String), default=list,  comment="모델 추천 종목 코드 배열")
    recommended_stock_names  = Column(ARRAY(String), default=list,  comment="모델 추천 종목명 배열 (recommended_stocks 와 1:1 대응)")
    weight              = Column(Numeric(5, 4), default=1.0,                                comment="앙상블 가중치 (0~1)")
    win_rate            = Column(Numeric(5, 4),                                             comment="승률 (최근 30거래 기준)")
    profit_factor       = Column(Numeric(8, 4),                                             comment="수익팩터 (총이익 / 총손실)")
    sharpe_ratio        = Column(Numeric(8, 4),                                             comment="샤프 지수")
    max_drawdown        = Column(Numeric(5, 4),                                             comment="최대 낙폭 MDD")
    total_signals       = Column(Integer,       default=0,                                  comment="누적 신호 발생 수")
    last_trained_at     = Column(TIMESTAMP(timezone=True),                                  comment="마지막 학습일시")
    created_at          = Column(TIMESTAMP(timezone=True), server_default=func.now(),       comment="등록일시")


class AutoTradeLog(Base):
    """자동매매 실행 이력"""
    __tablename__ = "auto_trade_logs"
    __table_args__ = {"comment": "자동매매 주문 실행 및 체결 이력 테이블"}

    id               = Column(BigInteger,    primary_key=True,                           comment="이력 ID")
    trade_date       = Column(Date,          nullable=False,                             comment="거래일")
    stock_code       = Column(String(10),    nullable=False,                             comment="종목 코드")
    stock_name       = Column(String(100),                                               comment="종목명")
    action           = Column(String(10),    nullable=False,                             comment="매수/매도 (BUY/SELL)")
    quantity         = Column(Integer,       nullable=False,                             comment="주문 수량")
    order_price      = Column(Integer,       nullable=False,                             comment="주문 단가")
    order_amount     = Column(BigInteger,                                                comment="주문 금액")
    filled_price     = Column(Integer,                                                   comment="체결 단가")
    filled_amount    = Column(BigInteger,                                                comment="체결 금액")
    model_scores     = Column(JSONB,                                                     comment="모델별 신호 점수 {M1:0.7, M2:0.6, ...}")
    news_sentiment   = Column(Numeric(5, 4),                                             comment="뉴스 감성 점수 (-1~+1)")
    dart_score       = Column(Numeric(5, 4),                                             comment="DART 공시 점수 (0~1, 0.5=중립)")
    supply_score     = Column(Numeric(5, 4),                                             comment="외국인/기관 수급 점수 (0~1, 0.5=중립)")
    market_score     = Column(Numeric(5, 4),                                             comment="시장 상황 점수 (0~1)")
    composite_score  = Column(Numeric(5, 4),                                             comment="종합 점수 (0~1)")
    trigger_models   = Column(ARRAY(String),                                             comment="신호 발생 모델 목록")
    order_id         = Column(String(100),                                               comment="키움 주문 번호")
    status           = Column(String(20),    default="PENDING",                          comment="상태 (PENDING/FILLED/CANCELLED/MOCK)")
    realized_pnl     = Column(Numeric(15, 2),                                            comment="실현 손익 (매도 시)")
    commission       = Column(Numeric(10, 2),                                            comment="수수료 (원, 매수·매도 공통 0.015%)")
    tax              = Column(Numeric(10, 2),                                            comment="증권거래세 (원, 매도 시 0.20%)")
    error_msg        = Column(Text,                                                      comment="오류 메시지")
    created_at       = Column(TIMESTAMP(timezone=True), server_default=func.now(),       comment="주문 생성일시")
    filled_at        = Column(TIMESTAMP(timezone=True),                                  comment="체결일시")


class NewsItem(Base):
    """수집된 뉴스 및 공시 이력"""
    __tablename__ = "news_items"
    __table_args__ = {"comment": "뉴스/공시 수집 이력 및 감성 분석 결과 테이블"}

    id               = Column(BigInteger,   primary_key=True,                           comment="뉴스 ID")
    url_hash         = Column(String(64),   nullable=False, unique=True,                comment="URL SHA256 해시 (중복 방지)")
    title            = Column(Text,         nullable=False,                             comment="뉴스 제목")
    content_summary  = Column(Text,                                                     comment="본문 요약 (500자 이내)")
    source           = Column(String(50),                                               comment="출처 (naver / yonhap / dart / krx)")
    stock_codes      = Column(ARRAY(String),                                            comment="관련 종목 코드 배열")
    sentiment_score  = Column(Numeric(5, 4),                                            comment="감성 점수 (-1 매우부정 ~ +1 매우긍정)")
    sentiment_label  = Column(String(10),                                               comment="감성 레이블 (POSITIVE / NEGATIVE / NEUTRAL)")
    is_disclosure    = Column(Boolean,      default=False,                              comment="공시 여부")
    disclosure_type  = Column(String(50),                                               comment="공시 유형 (실적발표 / 유상증자 / 자사주매입 등)")
    published_at     = Column(TIMESTAMP(timezone=True),                                 comment="뉴스 발행일시")
    collected_at     = Column(TIMESTAMP(timezone=True), server_default=func.now(),      comment="수집일시")


class ModelDailyPerformance(Base):
    """모델별 일별 성과 집계"""
    __tablename__ = "model_daily_performance"
    __table_args__ = {"comment": "모델별 일별 신호/수익 성과 집계 테이블"}

    id             = Column(Integer,        primary_key=True,                           comment="집계 ID")
    model_id       = Column(String(20),     nullable=False,                             comment="모델 식별자")
    perf_date      = Column(Date,           nullable=False,                             comment="성과 날짜")
    signal_count   = Column(Integer,        default=0,                                  comment="신호 발생 건수")
    executed_count = Column(Integer,        default=0,                                  comment="실제 주문 실행 건수")
    win_count      = Column(Integer,        default=0,                                  comment="수익 거래 건수")
    lose_count     = Column(Integer,        default=0,                                  comment="손실 거래 건수")
    realized_pnl   = Column(Numeric(15, 2), default=0,                                  comment="당일 실현 손익 (원)")
    win_rate       = Column(Numeric(5, 4),                                              comment="당일 승률")
    profit_factor  = Column(Numeric(8, 4),                                              comment="당일 수익팩터")
    created_at     = Column(TIMESTAMP(timezone=True), server_default=func.now(),        comment="생성일시")


class ModelPortfolioStock(Base):
    """모델별 가상 포트폴리오 종목 — 수익률 분석용"""
    __tablename__ = "model_portfolio_stocks"
    __table_args__ = {"comment": "모델별 가상 매수 포트폴리오 종목 및 수익률 이력 테이블"}

    id              = Column(Integer,        primary_key=True,                           comment="ID")
    model_id        = Column(String(20),     nullable=False,                             comment="모델 식별자 (M1~M10)")
    stock_code      = Column(String(10),     nullable=False,                             comment="종목 코드")
    stock_name      = Column(String(100),                                                comment="종목명")
    buy_date        = Column(Date,           nullable=False,                             comment="가상 매수일")
    buy_price       = Column(Integer,        nullable=False,                             comment="가상 매수가 (원)")
    quantity        = Column(Integer,        nullable=False, default=1,                  comment="매수 수량")
    current_price   = Column(Integer,                                                    comment="현재가 (마지막 조회)")
    return_pct      = Column(Numeric(8, 4),                                              comment="수익률 % ((현재가-매수가)/매수가*100)")
    return_amt      = Column(Numeric(15, 2),                                             comment="평가손익 (원)")
    is_active       = Column(Boolean,        nullable=False, default=True,               comment="분석 포함 여부")
    memo            = Column(Text,                                                       comment="메모")
    price_updated_at = Column(TIMESTAMP(timezone=True),                                 comment="현재가 마지막 조회일시")
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now(),       comment="등록일시")
