# 키움 Open API 기반 AI 자동매매 시스템

LightGBM 멀티모델 앙상블 + 감성분석 기반의 국내 주식 자동매매 시스템입니다.  
FastAPI 백엔드, React 대시보드, APScheduler 10분 사이클로 운영됩니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| **AI 매수 신호** | LightGBM 기반 M1~M10 멀티모델 앙상블 (기술적 지표, 수급, 뉴스 감성) |
| **자동 매매** | 10분 사이클 APScheduler — 매수/매도 자동 실행 |
| **시장 방어 모드** | KOSPI 등락에 따라 자동 전환 — 경계(< -0.8%) / 수비(< -1.5%) / 전면수비(< -2.5%, 신규 매수 차단) |
| **손절/익절** | 손절 -3%, 익절 +5% (전략 기본값, 장기 보유: -7% / +30%) — 청산 주문은 시장가 |
| **트레일링 스탑** | 고점 대비 -3% 하락 시 자동 익절 |
| **3영업일 쿨다운** | 손절 후 3영업일간 동일 종목 재매수 차단 (주말·KRX 휴장일 제외) |
| **킬스위치** | 일일 손실 한도 초과 또는 수동 ON 시 신규 매수 중단 — 손절·익절 감시는 계속 |
| **KRX 휴장일** | `holidays` XKRX 달력으로 공휴일·연말휴장일 자동 스킵 (`MARKET_EXTRA_HOLIDAYS`로 임시 휴장일 추가) |
| **텔레그램 알림** | 매수·매도·에러·일일 리포트 자동 발송 |
| **React 대시보드** | 실시간 보유 현황, 매매 이력, 모델 분석, 백테스트 |
| **DART 공시 수집** | 매일 자동 수집 및 점수 반영 |
| **뉴스 감성 분석** | KR-FinBERT 기반 뉴스 감성 점수 |

---

## 시스템 구성

```
toss_auto_trade/
├── backend/                  # FastAPI 서버
│   ├── app/
│   │   ├── api/v1/           # REST API 엔드포인트
│   │   ├── services/
│   │   │   ├── auto_trade_engine.py   # 핵심 매매 엔진
│   │   │   ├── kiwoom_api.py          # 키움 Open API+ 연동
│   │   │   ├── sector_screener.py     # 섹터 스크리닝 (pykrx)
│   │   │   └── telegram_notifier.py   # 텔레그램 알림
│   │   ├── ml/               # LightGBM 모델 학습/추론
│   │   ├── models/           # SQLAlchemy DB 모델
│   │   └── macro/            # 매크로 지표 / 섹터 로테이션
│   ├── alembic/              # DB 마이그레이션
│   ├── config/               # YAML 설정 (모델 가중치 등)
│   └── requirements.txt
├── frontend/                 # React + TypeScript 대시보드
│   └── src/
│       ├── pages/            # Dashboard, AutoTrade, Holdings 등
│       └── components/       # 차트, 테이블, KPI 카드
├── docker-compose.yml        # PostgreSQL + Redis + Backend
├── start.bat                 # Windows 서버 시작 스크립트
└── stop.bat
```

---

## 기술 스택

**Backend**
- Python 3.11+ / FastAPI / SQLAlchemy 2.0 / asyncpg
- APScheduler 3.x (10분 자동매매 사이클)
- LightGBM · XGBoost · scikit-learn (멀티모델 앙상블)
- Transformers (KR-FinBERT 감성 분석)
- pykrx · finance-datareader (시장 데이터)
- PostgreSQL 15 / Redis 7

**Frontend**
- React 18 + TypeScript / Vite
- Recharts · lightweight-charts (차트)
- Zustand (상태 관리)
- Tailwind CSS

---

## 설치 및 실행

### 사전 요구 사항

- 키움증권 계좌 + [Open API+ 신청](https://openapi.kiwoom.com)
- Python 3.11+
- Node.js 18+
- PostgreSQL 15 / Redis 7 (또는 Docker)

### 1. 환경 변수 설정

```bash
cp backend/.env.example backend/.env
```

`backend/.env` 편집:

```env
DATABASE_URL=postgresql+asyncpg://toss_stock:PASSWORD@localhost:5432/toss_auto_trade
KIWOOM_APP_KEY=your_app_key
KIWOOM_SECRET_KEY=your_secret_key
KIWOOM_ACCOUNT_NO=your_account_number
TELEGRAM_BOT_TOKEN=your_bot_token    # 선택
TELEGRAM_CHAT_ID=your_chat_id        # 선택
AUTO_TRADE_ENABLED=true
MAX_HOLDINGS=5
```

### 2. 백엔드 실행

```bash
cd backend
pip install -r requirements.txt
alembic upgrade head          # DB 마이그레이션
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 3. 프론트엔드 실행

```bash
cd frontend
npm install
npm run dev
```

### Docker로 한번에 실행

```bash
docker-compose up -d
```

### Windows (start.bat)

```
start.bat   # 백엔드 + 프론트엔드 동시 시작
stop.bat    # 서버 종료
```

---

## 매매 전략 파라미터

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `buy_threshold` | 0.57 | 매수 종합 점수 임계값 |
| `stop_loss_pct` | 3.0% | 손절 기준 |
| `take_profit_pct` | 5.0% | 익절 기준 |
| `max_daily_loss_pct` | 5.0% | 일일 손실 한도 (0 = 비활성) |
| `MAX_HOLDINGS` (.env) | 10 | 최대 동시 보유 종목 수 |
| `max_position_amt` | 미설정 시 1,000,000원 | 종목당 최대 투자금 (1주 단가가 이보다 비싸면 매수 안 함) |

대시보드 → **전략** 탭에서 실시간 변경 가능합니다.

---

## 모델 구성 (M1~M10)

| 모델 | 신호 기반 |
|------|----------|
| M1 | 이동평균 크로스 (골든/데드 크로스) |
| M4 | 볼린저 밴드 %B |
| M5 | 거래량 이상 감지 |
| M8 | 스토캐스틱 골든 크로스 |
| M9 | 복합 지표 앙상블 |
| M10 | 전체 모델 앙상블 |

---

## API 문서

서버 실행 후 http://localhost:8000/docs 에서 Swagger UI 확인

---

## 주의 사항

> **실제 계좌로 자동매매 실행 시 손실이 발생할 수 있습니다.**  
> 처음에는 `AUTO_TRADE_ENABLED=false`로 설정하여 신호만 확인하고,  
> 충분한 백테스트 후 실거래를 시작하세요.

- `.env` 파일에 실제 API 키를 보관하고 **절대 커밋하지 마세요**
- 키움 Open API+는 Windows 환경에서만 지원됩니다

---

## 라이선스

MIT License
