from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # Database
    database_url: str = Field(..., env="DATABASE_URL")

    # Redis
    redis_url: str = Field("redis://localhost:6379/0", env="REDIS_URL")

    # 키움증권 Open API REST
    kiwoom_app_key: str = Field("", env="KIWOOM_APP_KEY")
    kiwoom_secret_key: str = Field("", env="KIWOOM_SECRET_KEY")
    kiwoom_account_no: str = Field("", env="KIWOOM_ACCOUNT_NO")  # 비워두면 첫 번째 계좌 자동 사용

    # Telegram 알림
    telegram_bot_token: str = Field("", env="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: str   = Field("", env="TELEGRAM_CHAT_ID")
    telegram_status_interval: int = Field(0, env="TELEGRAM_STATUS_INTERVAL")  # 분 단위 (0=비활성)
    telegram_notify_buy: bool          = Field(True, env="TELEGRAM_NOTIFY_BUY")
    telegram_notify_sell: bool         = Field(True, env="TELEGRAM_NOTIFY_SELL")
    telegram_notify_error: bool        = Field(True, env="TELEGRAM_NOTIFY_ERROR")
    telegram_notify_kill_switch: bool  = Field(True, env="TELEGRAM_NOTIFY_KILL_SWITCH")
    telegram_notify_morning: bool      = Field(True, env="TELEGRAM_NOTIFY_MORNING")
    telegram_notify_hourly: bool       = Field(True, env="TELEGRAM_NOTIFY_HOURLY")
    telegram_notify_close: bool        = Field(True, env="TELEGRAM_NOTIFY_CLOSE")
    telegram_notify_screening: bool    = Field(True, env="TELEGRAM_NOTIFY_SCREENING")
    telegram_notify_from: str          = Field("00:00", env="TELEGRAM_NOTIFY_FROM")    # 발송 시작 시각 HH:MM
    telegram_notify_to: str            = Field("23:59", env="TELEGRAM_NOTIFY_TO")      # 발송 종료 시각 HH:MM
    telegram_notify_business_only: bool = Field(False,  env="TELEGRAM_NOTIFY_BUSINESS_ONLY")

    # OpenDART 공시 API (https://opendart.fss.or.kr)
    dart_api_key: str = Field("", env="DART_API_KEY")

    # 네이버 검색 API (https://developers.naver.com)
    naver_client_id: str     = Field("", env="NAVER_CLIENT_ID")
    naver_client_secret: str = Field("", env="NAVER_CLIENT_SECRET")

    # Auto trading
    auto_trade_enabled: bool = Field(False, env="AUTO_TRADE_ENABLED")
    signal_interval_minutes: int = Field(10, env="SIGNAL_INTERVAL_MINUTES")
    max_holdings: int = Field(10, env="MAX_HOLDINGS")
    max_stock_price: int = Field(0, env="MAX_STOCK_PRICE")  # 종목 단가 상한 (원, 0=제한없음)
    market_extra_holidays: str = Field("", env="MARKET_EXTRA_HOLIDAYS")  # KRX 달력에 없는 임시 휴장일 (YYYY-MM-DD,콤마 구분)

    # ML model
    model_path: str = Field("./app/ml/models/lgbm_v1.pkl", env="MODEL_PATH")

    # KRX 데이터 인증 (pykrx 수급 데이터)
    krx_id: str = Field("", env="KRX_ID")
    krx_pw: str = Field("", env="KRX_PW")

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
