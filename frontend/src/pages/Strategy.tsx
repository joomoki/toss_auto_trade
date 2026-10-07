import { useEffect, useState, useCallback } from 'react'
import {
  getStrategy, updateStrategy, toggleAutoTrade, initStrategy,
  getWatchlist, addWatchlist, updateWatchlist, deleteWatchlist,
  getAutoTradeStats, getTelegramStatus, sendTelegramTest, saveTelegramConfig,
} from '../api/client'
import api from '../api/client'
import {
  Plus, Trash2, ToggleLeft, ToggleRight, Info, X,
  ChevronDown, ChevronUp, ShieldAlert, ShieldCheck, Zap,
  BookOpen, TrendingUp, TrendingDown, Target,
  DollarSign, BarChart2, Lock, Unlock, Send, CheckCircle, XCircle,
} from 'lucide-react'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

// ─── 타입 ──────────────────────────────────────────────
interface StrategyData {
  id: number
  name: string
  model_version: string
  buy_threshold: number
  sell_threshold: number
  stop_loss_pct: number
  take_profit_pct: number
  max_position_amt: number | null
  max_daily_loss_pct: number
  kill_switch_active: boolean
  is_active: boolean
  updated_at: string
  dynamic_tp_enabled: boolean
  dynamic_tp_supply_threshold: number
  dynamic_tp_multiplier: number
}

interface WatchItem {
  id: number
  stock_code: string
  stock_name: string
  market: string
  sector: string | null
  reason: string | null
  is_active: boolean
}

interface WatchlistData {
  items: WatchItem[]
  active_count: number
  total_count: number
  criteria: string[]
}

// ─── 유틸 ──────────────────────────────────────────────
function fmtWon(v: number | null | undefined) {
  if (v == null) return '미설정'
  return Math.round(v).toLocaleString('ko-KR') + '원'
}

// ─── 파라미터 설명 데이터 ──────────────────────────────
const PARAM_GUIDE = {
  buy_threshold: {
    icon: <TrendingUp size={13} className="text-emerald-400" />,
    label: '매수 임계값',
    unit: '(0.0 ~ 1.0)',
    desc: 'AI 종합 점수가 이 값 이상인 종목만 매수합니다.',
    example: '0.60 → "AI 확신도 60% 이상인 종목만 매수"',
    safeRange: '0.55 ~ 0.70',
    low: '너무 낮으면(< 0.5): 신호가 너무 잦아 수수료 손실 증가',
    high: '너무 높으면(> 0.75): 매수 기회가 거의 오지 않아 현금만 보유',
    step: 0.01,
  },
  sell_threshold: {
    icon: <TrendingDown size={13} className="text-red-400" />,
    label: '매도 임계값',
    unit: '(0.0 ~ 1.0)',
    desc: '보유 종목의 AI 점수가 이 값 미만으로 내려가면 매도를 검토합니다. (손절·익절이 우선)',
    example: '0.60 → "점수가 60% 아래로 떨어지면 매도 신호"',
    safeRange: '0.50 ~ 0.65',
    low: '너무 낮으면: 손실이 커질 때까지 팔지 않음',
    high: '너무 높으면: 조금만 떨어져도 팔아서 수익 기회 놓침',
    step: 0.01,
  },
  stop_loss_pct: {
    icon: <ShieldAlert size={13} className="text-orange-400" />,
    label: '손절 기준',
    unit: '(%)',
    desc: '매수가 대비 이 비율만큼 떨어지면 즉시 자동 매도합니다. 손실 확대를 막는 안전망입니다.',
    example: '3.0 → 10,000원에 산 주식이 9,700원이 되면 즉시 매도',
    safeRange: '2.0 ~ 5.0',
    low: '너무 낮으면(< 2%): 작은 변동에도 팔려서 정상 등락도 손절됨',
    high: '너무 높으면(> 7%): 손실이 크게 날 때까지 팔지 않음',
    step: 0.5,
  },
  take_profit_pct: {
    icon: <Target size={13} className="text-yellow-400" />,
    label: '익절 기준',
    unit: '(%)',
    desc: '매수가 대비 이 비율만큼 오르면 즉시 자동 매도하여 이익을 실현합니다.',
    example: '5.0 → 10,000원에 산 주식이 10,500원이 되면 이익 실현',
    safeRange: '3.0 ~ 8.0',
    low: '너무 낮으면(< 2%): 수수료를 빼면 실제 이익이 거의 없음',
    high: '너무 높으면(> 10%): 목표에 도달 전에 하락해 이익을 날릴 수 있음',
    step: 0.5,
  },
  max_position_amt: {
    icon: <DollarSign size={13} className="text-blue-400" />,
    label: '종목당 최대 투자금',
    unit: '(원)',
    desc: '종목 하나에 최대 이 금액까지만 투자합니다. 예수금의 50~80% 이하로 설정하세요.',
    example: '예수금 10만원 → 5만원 설정 권장 (최대 2종목 동시 보유 가능)',
    safeRange: '예수금의 30~70%',
    low: '너무 낮으면: 수수료 비중이 커져 수익률 악화',
    high: '너무 높으면: 한 종목 손실 시 계좌 전체에 큰 타격',
    step: 10000,
  },
  max_daily_loss_pct: {
    icon: <Lock size={13} className="text-red-400" />,
    label: '일일 최대 손실 한도 (킬스위치)',
    unit: '(%)',
    desc: '오늘 하루 체결 확정(FILLED) 매도의 실현 손실 합계가 이 비율을 초과하면 자동매매를 즉시 멈춥니다. 가장 중요한 안전장치입니다. 기준금액 = 종목당 최대 투자금 × 최대 보유 종목 수.',
    example: '5.0, 종목당 5만원 × 10종목 = 기준 50만원 → 하루 2.5만원 이상 손실 시 중단',
    safeRange: '3.0 ~ 7.0',
    low: '너무 낮으면(< 2%): 정상적인 손절 1건에도 발동될 수 있음',
    high: '너무 높으면(> 10%): 큰 손실이 나도 멈추지 않아 안전장치 역할 못 함',
    step: 0.5,
  },
}

// ─── 파라미터 입력 필드 (일반 숫자) ──────────────────
function NumberField({ paramKey, value, onChange, expanded, onToggle }: {
  paramKey: keyof typeof PARAM_GUIDE
  value: number | string
  onChange: (v: number) => void
  expanded: boolean
  onToggle: () => void
}) {
  const g = PARAM_GUIDE[paramKey]
  return (
    <div className="bg-gray-800/50 rounded-xl border border-gray-700/50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="shrink-0">{g.icon}</div>
        <div className="flex-1 min-w-0">
          <label className="text-xs font-semibold text-gray-300">{g.label} <span className="text-gray-600 font-normal">{g.unit}</span></label>
        </div>
        <input
          type="number"
          step={g.step}
          value={value ?? ''}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="w-24 bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-right focus:outline-none focus:border-blue-500"
        />
        <button onClick={onToggle} className="text-gray-500 hover:text-gray-300 ml-1">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {expanded && (
        <div className="px-4 pb-3 space-y-2 border-t border-gray-700/40 pt-3">
          <p className="text-[12px] text-gray-300">{g.desc}</p>
          <p className="text-[11px] text-blue-300 bg-blue-900/20 rounded px-2 py-1">📌 예시: {g.example}</p>
          <p className="text-[11px] text-gray-500">✅ 권장 범위: <span className="text-gray-300">{g.safeRange}</span></p>
          <div className="space-y-0.5">
            <p className="text-[11px] text-orange-400/80">⬇ {g.low}</p>
            <p className="text-[11px] text-yellow-400/80">⬆ {g.high}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 종목당 최대 투자금 (콤마 포맷) ──────────────────
function MoneyField({ value, onChange, expanded, onToggle }: {
  value: number | null | undefined
  onChange: (v: number) => void
  expanded: boolean
  onToggle: () => void
}) {
  const g = PARAM_GUIDE.max_position_amt
  const [display, setDisplay] = useState(
    value != null ? Math.round(value).toLocaleString('ko-KR') : ''
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '')
    const num = parseInt(raw, 10)
    setDisplay(raw === '' ? '' : num.toLocaleString('ko-KR'))
    if (!isNaN(num)) onChange(num)
  }

  const formatted = value != null ? Math.round(value).toLocaleString('ko-KR') : ''
  if (display === '' && formatted !== '') setDisplay(formatted)

  return (
    <div className="bg-gray-800/50 rounded-xl border border-gray-700/50 overflow-hidden sm:col-span-2">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="shrink-0">{g.icon}</div>
        <div className="flex-1 min-w-0">
          <label className="text-xs font-semibold text-gray-300">{g.label}</label>
        </div>
        <div className="relative">
          <input
            type="text"
            inputMode="numeric"
            value={display}
            onChange={handleChange}
            className="w-36 bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 pr-7 text-sm text-right focus:outline-none focus:border-blue-500"
          />
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-500 pointer-events-none">원</span>
        </div>
        <button onClick={onToggle} className="text-gray-500 hover:text-gray-300 ml-1">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {expanded && (
        <div className="px-4 pb-3 space-y-2 border-t border-gray-700/40 pt-3">
          <p className="text-[12px] text-gray-300">{g.desc}</p>
          <p className="text-[11px] text-blue-300 bg-blue-900/20 rounded px-2 py-1">📌 예시: {g.example}</p>
          <p className="text-[11px] text-gray-500">✅ 권장: <span className="text-gray-300">{g.safeRange}</span></p>
          <div className="space-y-0.5">
            <p className="text-[11px] text-orange-400/80">⬇ {g.low}</p>
            <p className="text-[11px] text-yellow-400/80">⬆ {g.high}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 텔레그램 설정 패널 ──────────────────────────────────
function TelegramPanel() {
  const [status, setStatus]       = useState<{ configured: boolean; bot_token_masked: string; chat_id: string } | null>(null)
  const [token, setToken]         = useState('')
  const [chatId, setChatId]       = useState('')
  const [saving, setSaving]       = useState(false)
  const [testing, setTesting]     = useState(false)
  const [msg, setMsg]             = useState<{ text: string; ok: boolean } | null>(null)
  const [open, setOpen]           = useState(false)
  const [showGuide, setShowGuide] = useState(false)

  useEffect(() => {
    getTelegramStatus().then(s => {
      setStatus(s)
      if (s.chat_id) setChatId(s.chat_id)
    }).catch(() => {})
  }, [])

  const handleSave = async () => {
    if (!token.trim() || !chatId.trim()) {
      setMsg({ text: '봇 토큰과 Chat ID를 모두 입력하세요.', ok: false }); return
    }
    setSaving(true); setMsg(null)
    try {
      const r = await saveTelegramConfig(token.trim(), chatId.trim())
      setStatus(r); setToken('')
      setMsg({ text: '저장 완료. 테스트 메시지를 보내보세요.', ok: true })
    } catch { setMsg({ text: '저장 실패. 서버를 확인하세요.', ok: false }) }
    finally { setSaving(false) }
  }

  const handleTest = async () => {
    setTesting(true); setMsg(null)
    try {
      await sendTelegramTest()
      setMsg({ text: '✅ 테스트 메시지 전송 완료. 텔레그램을 확인하세요.', ok: true })
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setMsg({ text: `전송 실패: ${detail ?? '봇 토큰·Chat ID 확인'}`, ok: false })
    } finally { setTesting(false) }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Send size={14} className="text-blue-400" />
          <span className="text-sm font-semibold">텔레그램 알림 설정</span>
          {status?.configured
            ? <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle size={11} />연결됨</span>
            : <span className="flex items-center gap-1 text-xs text-gray-500"><XCircle size={11} />미설정</span>}
        </div>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {open && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4">
          {/* 알림 종류 */}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            {[
              { icon: '🟢', label: '매수 체결', desc: '종목명·수량·금액·AI점수' },
              { icon: '🔴', label: '매도 체결', desc: '손익·손절/익절 사유' },
              { icon: '🚨', label: '킬스위치 발동', desc: '일일 손실 한도 초과 시' },
              { icon: '⚠️', label: '시스템 오류', desc: 'API 오류 등 비정상 상황' },
            ].map(item => (
              <div key={item.label} className="bg-gray-800/50 rounded-lg px-3 py-2">
                <p className="font-medium text-gray-300">{item.icon} {item.label}</p>
                <p className="text-gray-500 mt-0.5">{item.desc}</p>
              </div>
            ))}
          </div>

          {/* 봇 생성 가이드 */}
          <div>
            <button
              onClick={() => setShowGuide(v => !v)}
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
            >
              <ChevronDown size={11} className={`transition-transform ${showGuide ? 'rotate-180' : ''}`} />
              텔레그램 봇 만드는 방법 (처음이라면 클릭)
            </button>
            {showGuide && (
              <div className="mt-2 bg-gray-800/60 rounded-xl p-3 space-y-2 text-[11px] text-gray-400 leading-relaxed">
                <div>
                  <p className="text-white font-medium mb-0.5">① 봇 토큰 발급</p>
                  <p className="pl-2">텔레그램 앱에서 <span className="text-blue-300 font-medium">@BotFather</span> 검색 → 메시지 보내기</p>
                  <p className="pl-2">→ /newbot 입력 → 봇 이름 설정 → 토큰 발급</p>
                  <p className="pl-2 text-yellow-400/80 mt-0.5">예: <code>7123456789:AAFxxxxxxxx...</code></p>
                </div>
                <div>
                  <p className="text-white font-medium mb-0.5">② Chat ID 확인</p>
                  <p className="pl-2">발급받은 봇에게 텔레그램으로 아무 메시지 전송</p>
                  <p className="pl-2">그 다음 브라우저에서 아래 주소 접속:</p>
                  <p className="pl-2 mt-1 bg-gray-900 rounded px-2 py-1.5 text-gray-300 break-all font-mono text-[10px]">
                    https://api.telegram.org/bot<span className="text-yellow-300">[토큰]</span>/getUpdates
                  </p>
                  <p className="pl-2 mt-1">응답에서 <code className="text-blue-300">result[0].message.chat.id</code> 값 복사</p>
                  <p className="pl-2 text-yellow-400/80">예: <code>123456789</code> (그룹 채팅은 -123456789 형태)</p>
                </div>
              </div>
            )}
          </div>

          {/* 현재 연결 상태 */}
          {status?.configured && (
            <div className="bg-emerald-900/20 border border-emerald-800/40 rounded-lg px-3 py-2 text-[11px] text-emerald-300">
              ✅ 연결된 봇: <span className="font-mono">{status.bot_token_masked}</span>
              &nbsp;/ Chat ID: <span className="font-mono">{status.chat_id}</span>
            </div>
          )}

          {/* 입력 폼 */}
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                봇 토큰 <span className="text-gray-600">(BotFather에서 발급한 값)</span>
              </label>
              <input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder={status?.configured ? '변경하려면 새 토큰 입력' : '7123456789:AAFxxxxxxxx...'}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Chat ID <span className="text-gray-600">(getUpdates에서 확인한 숫자)</span>
              </label>
              <input
                type="text"
                value={chatId}
                onChange={e => setChatId(e.target.value)}
                placeholder="123456789"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {msg && (
            <p className={`text-xs ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-bold disabled:opacity-50 transition-colors"
            >
              {saving ? '저장 중…' : '💾 저장'}
            </button>
            <button
              onClick={handleTest}
              disabled={testing || !status?.configured}
              className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-bold disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
            >
              <Send size={11} />{testing ? '전송 중…' : '테스트 전송'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 초보자 가이드 ────────────────────────────────────
function BeginnerGuide() {
  const [open, setOpen] = useState(false)
  const sections = [
    {
      title: '🤖 자동매매란 무엇인가요?',
      content: 'AI가 매일 9시~15시 30분 사이에 5분마다 코스피·코스닥 전종목을 분석해서 스스로 주식을 사고 팝니다. 사람이 컴퓨터 앞에 없어도 됩니다. 단, 이익을 보장하지 않으므로 반드시 감당 가능한 소액으로 시작하세요.',
    },
    {
      title: '📊 AI는 어떻게 종목을 고르나요?',
      content: '5가지 요소를 합산해 0~1점의 "종합 점수"를 계산합니다.\n\n① AI 모델 (35%): M1~M10 기술적 지표 앙상블 (이동평균·RSI·MACD·볼린저 등)\n② 외인·기관 수급 (25%): 외국인·기관의 최근 매매 동향\n③ 시장 상황 (15%): 시간대·요일별 시장 강도 보정\n④ 뉴스 감성 (15%): 최근 24시간 언론 감성분석 (악재 심하면 차단)\n⑤ DART 공시 (10%): 기업 공시 호재·악재 반영\n\n종합 점수가 매수 임계값(기본 0.60) 이상이면 매수를 검토합니다.',
    },
    {
      title: '💰 얼마로 시작해야 하나요?',
      content: '처음에는 10만원 이하로 시작하세요. 종목당 최대 투자금을 예수금의 50% 이하로 설정하면 여러 종목에 분산됩니다.\n예: 예수금 10만원 → 종목당 4만원 설정 → 최대 2종목 동시 보유.',
    },
    {
      title: '🛡️ 손실을 어떻게 막나요?',
      content: '손절(-3%): 매수가 대비 3% 이상 떨어지면 즉시 자동 매도합니다.\n익절(+5%): 5% 이상 오르면 수익을 확정합니다.\n킬스위치: 하루 손실이 설정 한도를 넘으면 그날은 더 이상 거래하지 않습니다.\n손절 재매수 방지: 당일 손절한 종목은 같은 날 다시 매수하지 않습니다.',
    },
    {
      title: '📱 텔레그램 명령어로 원격 주문',
      content: '텔레그램 봇을 연결하면 채팅으로 직접 주문할 수 있습니다.\n\n/buy 삼성전자 3 → 삼성전자 3주 시장가 매수\n/sell 005930 2 → 삼성전자 2주 시장가 매도\n/sellall 카카오 → 카카오 전량 매도\n/holdings → 현재 보유 종목 목록\n/status → 계좌 현황 (총자산·가용현금·손익)\n/help → 전체 명령어 목록\n\n종목명(삼성전자) 또는 종목코드(005930) 모두 사용 가능합니다. 웹 화면 "텔레그램 → 명령어" 탭에서도 동일하게 사용할 수 있습니다.',
    },
    {
      title: '⚠️ 주의사항',
      content: '• 실전 매매 전 반드시 모의투자로 최소 1주일 테스트하세요.\n• 자동매매 중에도 매일 한 번은 화면을 확인하세요.\n• 키움증권 API 키는 절대 타인에게 공유하지 마세요.\n• 수수료(0.015%)가 매수·매도마다 발생합니다.\n• 대시보드 → "정합성 검사" 버튼으로 실계좌 보유 종목과 화면 표시가 맞는지 주기적으로 확인하세요.',
    },
    {
      title: '🔑 키움증권 API 연결 방법',
      content: '키움증권 홈페이지 → OpenAPI → REST API 신청 → AppKey/SecretKey 발급\n→ backend/.env 파일에 아래 두 줄 입력 후 서버 재시작:\n  KIWOOM_APP_KEY=발급된값\n  KIWOOM_SECRET_KEY=발급된값\n  KIWOOM_ACCOUNT_NO=계좌번호 (비워두면 첫 번째 계좌 자동 선택)',
    },
  ]

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BookOpen size={14} className="text-yellow-400" />
          <span className="text-sm font-semibold">초보자 가이드</span>
          <span className="text-xs text-gray-500">자동매매를 처음 시작하는 분께</span>
        </div>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>
      {open && (
        <div className="border-t border-gray-800 divide-y divide-gray-800">
          {sections.map((s, i) => (
            <div key={i} className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-200 mb-1">{s.title}</p>
              <p className="text-[11px] text-gray-400 leading-relaxed whitespace-pre-line">{s.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 종목 단가 상한 ──────────────────────────────────
function MaxStockPriceField() {
  const [price, setPrice] = useState<number>(0)
  const [display, setDisplay] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api.get('/auto-trade/price-limit').then(r => {
      const v = r.data.max_stock_price ?? 0
      setPrice(v)
      setDisplay(v > 0 ? Math.round(v).toLocaleString('ko-KR') : '')
    }).catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const r = await api.post('/auto-trade/price-limit', { max_stock_price: price })
      setMsg(r.data.message)
    } catch { setMsg('저장 실패') }
    finally {
      setSaving(false)
      setTimeout(() => setMsg(''), 3000)
    }
  }

  return (
    <div className="bg-gray-800/50 rounded-xl border border-yellow-700/40 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <DollarSign size={13} className="text-yellow-400 shrink-0" />
        <span className="text-xs font-semibold text-gray-300">종목 단가 상한</span>
        <span className="text-[11px] text-gray-500">이 금액 초과 종목은 매수 후보에서 제외</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          placeholder="0 (제한 없음)"
          value={display}
          onChange={e => {
            const raw = e.target.value.replace(/,/g, '')
            if (/^\d*$/.test(raw)) {
              setDisplay(raw ? Number(raw).toLocaleString('ko-KR') : '')
              setPrice(raw ? Number(raw) : 0)
            }
          }}
          className="w-40 bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white text-right focus:outline-none focus:border-yellow-500"
        />
        <span className="text-xs text-gray-500">원</span>
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-40 text-white text-xs rounded transition-colors"
        >
          {saving ? '저장 중…' : '저장'}
        </button>
        {price > 0 && (
          <span className="text-[11px] text-yellow-400">{price.toLocaleString()}원 이하만 매수</span>
        )}
        {price === 0 && (
          <span className="text-[11px] text-gray-600">제한 없음 (예수금 부족 시 자동 SKIP)</span>
        )}
      </div>
      {msg && <p className="text-xs text-emerald-400 mt-1.5">{msg}</p>}
      <p className="text-[11px] text-gray-600 mt-1.5">
        예) 예수금 20만원 → 200,000원으로 설정하면 1주 단가가 20만원 초과인 종목은 고려하지 않음
      </p>
    </div>
  )
}

// ─── 킬스위치 패널 ────────────────────────────────────
function KillSwitchPanel({
  active, maxLossPct, todayPnl, budgetRef,
  onReset,
}: {
  active: boolean
  maxLossPct: number
  todayPnl: number
  budgetRef: number
  onReset: () => void
}) {
  const threshold = -budgetRef * (maxLossPct / 100)
  const usedPct   = budgetRef > 0 ? Math.min(Math.abs(Math.min(todayPnl, 0)) / Math.abs(threshold) * 100, 100) : 0

  if (active) {
    return (
      <div className="bg-red-950/50 border-2 border-red-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-red-400" />
            <span className="text-sm font-bold text-red-300">킬스위치 발동 중 — 자동매매 완전 중단</span>
          </div>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded-lg text-xs font-bold text-white transition-colors"
          >
            <Unlock size={12} /> 해제
          </button>
        </div>
        <p className="text-[11px] text-red-300/80 leading-relaxed">
          오늘 손실 한도를 초과하여 자동매매가 중단되었습니다.<br />
          내일은 자동으로 재개됩니다. 오늘 추가 거래를 원하면 위 "해제" 버튼을 누르세요.<br />
          <span className="text-yellow-300">⚠ 해제 전 반드시 손실 원인을 확인하세요.</span>
        </p>
      </div>
    )
  }

  return (
    <div className={`border rounded-xl p-4 ${usedPct >= 80 ? 'bg-red-950/20 border-red-800/60' : usedPct >= 50 ? 'bg-yellow-950/20 border-yellow-800/40' : 'bg-gray-900 border-gray-800'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={15} className={usedPct >= 80 ? 'text-red-400' : usedPct >= 50 ? 'text-yellow-400' : 'text-emerald-400'} />
          <span className="text-sm font-semibold">킬스위치 (일일 손실 안전장치)</span>
        </div>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
          usedPct >= 80 ? 'bg-red-900/50 text-red-300' :
          usedPct >= 50 ? 'bg-yellow-900/50 text-yellow-300' :
          'bg-emerald-900/50 text-emerald-300'
        }`}>
          {usedPct >= 80 ? '위험' : usedPct >= 50 ? '주의' : '정상'}
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-xs text-gray-400">
          <span>오늘 손실</span>
          <span className={todayPnl < 0 ? 'text-red-400 font-medium' : 'text-gray-400'}>
            {todayPnl < 0 ? '-' : ''}{Math.abs(todayPnl).toLocaleString()}원
          </span>
        </div>
        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              usedPct >= 80 ? 'bg-red-500' : usedPct >= 50 ? 'bg-yellow-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-gray-500">
          <span>소진 {usedPct.toFixed(0)}%</span>
          <span>한도: {Math.abs(threshold).toLocaleString()}원 ({maxLossPct}%)</span>
        </div>
      </div>

      <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
        하루 손실이 <strong className="text-gray-300">{Math.abs(threshold).toLocaleString()}원</strong>을 초과하면 당일 자동매매를 즉시 중단합니다.
        손실 한도는 아래 "일일 최대 손실 한도" 항목에서 조정할 수 있습니다.
      </p>
    </div>
  )
}

// ─── 시스템 진단 체크리스트 ───────────────────────────
function SystemDiagnostics({ strategy, todayPnl }: { strategy: StrategyData; todayPnl: number }) {
  const [open, setOpen] = useState(false)
  const items = [
    { label: '자동매매 활성화',        ok: strategy.is_active,                         tip: '전략 페이지 상단 ▶시작 버튼' },
    { label: '손절 설정',              ok: (strategy.stop_loss_pct ?? 0) > 0,           tip: `현재 -${strategy.stop_loss_pct}%` },
    { label: '익절 설정',              ok: (strategy.take_profit_pct ?? 0) > 0,         tip: `현재 +${strategy.take_profit_pct}%` },
    { label: '종목당 투자금 제한',      ok: (strategy.max_position_amt ?? 0) > 0,        tip: strategy.max_position_amt ? fmtWon(strategy.max_position_amt) : '미설정' },
    { label: '킬스위치 설정',          ok: (strategy.max_daily_loss_pct ?? 0) > 0,      tip: `현재 ${strategy.max_daily_loss_pct}%` },
    { label: '킬스위치 비발동',        ok: !strategy.kill_switch_active,                tip: strategy.kill_switch_active ? '⚠ 발동 중' : '정상' },
    { label: '오늘 손실 없음',         ok: todayPnl >= 0,                               tip: todayPnl < 0 ? `${todayPnl.toLocaleString()}원` : '이익/보합' },
  ]

  const okCount = items.filter(i => i.ok).length

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BarChart2 size={14} className="text-blue-400" />
          <span className="text-sm font-semibold">시스템 진단</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            okCount === items.length ? 'bg-emerald-900/50 text-emerald-300' :
            okCount >= 5 ? 'bg-yellow-900/50 text-yellow-300' :
            'bg-red-900/50 text-red-300'
          }`}>{okCount}/{items.length} 정상</span>
        </div>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>
      {open && (
        <div className="border-t border-gray-800 px-4 py-3 space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className={item.ok ? 'text-emerald-400' : 'text-red-400'}>{item.ok ? '✅' : '❌'}</span>
                <span className={item.ok ? 'text-gray-300' : 'text-gray-400'}>{item.label}</span>
              </div>
              <span className="text-gray-500 text-[11px]">{item.tip}</span>
            </div>
          ))}
          <div className="pt-2 border-t border-gray-800 text-[11px] text-gray-500 space-y-0.5">
            <p>ℹ️ Rate Limit: 키움 REST API TR당 초당 1회 제한 — 5분 스케줄러가 자동으로 준수합니다.</p>
            <p>✅ 텔레그램 알림: 매수·매도·킬스위치·오류·모닝·시간별·결산 리포트 모두 지원합니다.</p>
            <p>✅ 텔레그램 명령어: /buy·/sell·/sellall·/holdings·/status 로 실시간 원격 주문 가능합니다.</p>
            <p>ℹ️ 시세: REST 폴링 방식 (5분 주기 갱신, 실시간 호가 스트리밍 미지원)</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 종목 추가 모달 ───────────────────────────────────
function AddModal({ onSave, onClose }: { onSave: (d: Record<string, unknown>) => void; onClose: () => void }) {
  const [form, setForm] = useState({ stock_code: '', stock_name: '', market: 'KOSPI', sector: '', reason: '' })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-gray-900 rounded-2xl border border-gray-700 p-5 w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-sm">관심 종목 추가</h2>
          <button onClick={onClose}><X size={16} className="text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">종목코드 *</label>
              <input value={form.stock_code} onChange={e => setForm(f => ({ ...f, stock_code: e.target.value }))}
                placeholder="005930" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">종목명 *</label>
              <input value={form.stock_name} onChange={e => setForm(f => ({ ...f, stock_name: e.target.value }))}
                placeholder="삼성전자" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">시장</label>
              <select value={form.market} onChange={e => setForm(f => ({ ...f, market: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
                <option>KOSPI</option><option>KOSDAQ</option><option>US</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">섹터</label>
              <input value={form.sector} onChange={e => setForm(f => ({ ...f, sector: e.target.value }))}
                placeholder="반도체" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">편입 사유</label>
            <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="시가총액 상위, 유동성 우수" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm">취소</button>
          <button
            onClick={() => onSave({ stock_code: form.stock_code, stock_name: form.stock_name, market: form.market, sector: form.sector || null, reason: form.reason || null })}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium"
          >추가</button>
        </div>
      </div>
    </div>
  )
}

const MARKET_COLOR: Record<string, string> = {
  KOSPI:  'bg-blue-900 text-blue-300',
  KOSDAQ: 'bg-purple-900 text-purple-300',
  US:     'bg-green-900 text-green-300',
}

// ─── 메인 페이지 ──────────────────────────────────────
export default function Strategy() {
  const [strategy, setStrategy]     = useState<StrategyData | null>(null)
  const [form, setForm]             = useState<Partial<StrategyData>>({})
  const [saving, setSaving]         = useState(false)
  const [msg, setMsg]               = useState('')
  const [todayPnl, setTodayPnl]     = useState(0)
  const [expanded, setExpanded]     = useState<Record<string, boolean>>({})

  const [wl, setWl]                 = useState<WatchlistData | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showCriteria, setShowCriteria] = useState(false)

  const loadStrategy = useCallback(() =>
    getStrategy().then((s: StrategyData) => { setStrategy(s); setForm(s) })
      .catch(async (e: { response?: { status: number } }) => {
        if (e?.response?.status === 404) {
          const s = await initStrategy(); setStrategy(s); setForm(s)
        }
      }), [])

  const loadWatchlist = () => getWatchlist().then(setWl)

  useEffect(() => {
    loadStrategy()
    loadWatchlist()
    getAutoTradeStats(1).then((s: { total_realized_pnl?: number }) => {
      setTodayPnl(s?.total_realized_pnl ?? 0)
    }).catch(() => {})
  }, [])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(0, loadStrategy)

  const toggle = (key: string) => setExpanded(e => ({ ...e, [key]: !e[key] }))

  const handleSave = async () => {
    setSaving(true); setMsg('')
    try {
      const updated = await updateStrategy({
        buy_threshold:               form.buy_threshold,
        sell_threshold:              form.sell_threshold,
        stop_loss_pct:               form.stop_loss_pct,
        take_profit_pct:             form.take_profit_pct,
        max_position_amt:            form.max_position_amt,
        max_daily_loss_pct:          form.max_daily_loss_pct,
        dynamic_tp_enabled:          form.dynamic_tp_enabled,
        dynamic_tp_supply_threshold: form.dynamic_tp_supply_threshold,
        dynamic_tp_multiplier:       form.dynamic_tp_multiplier,
      })
      setStrategy(updated)
      setForm(updated)
      setMsg('저장되었습니다.')
    } catch { setMsg('저장 실패') }
    finally { setSaving(false) }
  }

  const handleToggle = async () => {
    const result = await toggleAutoTrade()
    setStrategy(s => s ? { ...s, is_active: result.is_active } : s)
    setMsg(result.message)
  }

  const handleKillSwitchReset = async () => {
    try {
      await api.post('/strategy/kill-switch/reset')
      setStrategy(s => s ? { ...s, kill_switch_active: false } : s)
      setMsg('킬스위치가 해제되었습니다.')
    } catch { setMsg('킬스위치 해제 실패') }
  }

  const handleAddWatch = async (data: Record<string, unknown>) => {
    await addWatchlist(data)
    await loadWatchlist()
    setShowAddModal(false)
  }

  const handleToggleWatch  = async (item: WatchItem) => {
    await updateWatchlist(item.id, { is_active: !item.is_active })
    await loadWatchlist()
  }

  const handleDeleteWatch = async (item: WatchItem) => {
    if (!confirm(`${item.stock_name}(${item.stock_code})을 삭제하시겠습니까?`)) return
    await deleteWatchlist(item.id)
    await loadWatchlist()
  }

  if (!strategy) return <div className="text-gray-400 text-sm">로딩 중...</div>

  const budgetRef = (form.max_position_amt ?? 1_000_000) * 10

  return (
    <div className="space-y-4 max-w-2xl mx-auto">

      {/* ── 헤더 + 시작/중지 ── */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold sm:text-xl">전략 설정</h1>
        <div className="flex items-center gap-2">
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={0}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy}
            onRefresh={timerRefresh}
          />
          <button
            onClick={handleToggle}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              strategy.is_active ? 'bg-red-700 hover:bg-red-600' : 'bg-emerald-700 hover:bg-emerald-600'
            }`}
          >
            {strategy.is_active ? '⏹ 중지' : '▶ 시작'}
          </button>
        </div>
      </div>

      {/* ── 상태 배너 ── */}
      <div className={`rounded-xl border px-4 py-3 text-sm font-medium flex items-center justify-between ${
        strategy.kill_switch_active ? 'border-red-700 bg-red-950/30 text-red-400' :
        strategy.is_active ? 'border-emerald-700 bg-emerald-950/30 text-emerald-400' :
        'border-gray-700 bg-gray-900 text-gray-400'
      }`}>
        <span>
          {strategy.kill_switch_active ? '🔒 킬스위치 발동 — 자동매매 중단' :
           strategy.is_active ? '🟢 자동매매 실행 중' : '🔴 자동매매 중지됨'}
          <span className="ml-3 text-xs font-normal opacity-70">
            모델: {strategy.model_version} · 수정: {strategy.updated_at ? new Date(strategy.updated_at).toLocaleDateString('ko-KR') : '-'}
          </span>
        </span>
        {!strategy.is_active && !strategy.kill_switch_active && (
          <span className="text-xs text-gray-500">위 ▶ 시작 버튼을 눌러 자동매매를 시작하세요</span>
        )}
      </div>

      {/* ── 텔레그램 알림 ── */}
      <TelegramPanel />

      {/* ── 초보자 가이드 ── */}
      <BeginnerGuide />

      {/* ── 시스템 진단 ── */}
      <SystemDiagnostics strategy={strategy} todayPnl={todayPnl} />

      {/* ── 킬스위치 패널 ── */}
      <section>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <ShieldAlert size={11} /> 안전장치
        </p>
        <KillSwitchPanel
          active={strategy.kill_switch_active}
          maxLossPct={form.max_daily_loss_pct ?? strategy.max_daily_loss_pct ?? 5}
          todayPnl={todayPnl}
          budgetRef={budgetRef}
          onReset={handleKillSwitchReset}
        />
      </section>

      {/* ── 전략 파라미터 ── */}
      <section>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Zap size={11} /> 전략 파라미터
          <span className="text-gray-600 font-normal normal-case">항목을 클릭하면 상세 설명이 펼쳐집니다</span>
        </p>
        <div className="space-y-2">
          {/* 매수/매도 임계값 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(['buy_threshold', 'sell_threshold'] as const).map(k => (
              <NumberField
                key={k}
                paramKey={k}
                value={form[k] ?? ''}
                onChange={v => setForm(f => ({ ...f, [k]: v }))}
                expanded={!!expanded[k]}
                onToggle={() => toggle(k)}
              />
            ))}
          </div>
          {/* 손절/익절 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(['stop_loss_pct', 'take_profit_pct'] as const).map(k => (
              <NumberField
                key={k}
                paramKey={k}
                value={form[k] ?? ''}
                onChange={v => setForm(f => ({ ...f, [k]: v }))}
                expanded={!!expanded[k]}
                onToggle={() => toggle(k)}
              />
            ))}
          </div>

          {/* 동적 익절 */}
          <div className="bg-gray-800/50 rounded-xl border border-yellow-700/40 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3">
              <Target size={13} className="text-yellow-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold text-gray-300">동적 익절</span>
                <span className="ml-2 text-[11px] text-gray-500">수급이 좋으면 익절 기준 자동 상향</span>
              </div>
              <button
                onClick={() => setForm(f => ({ ...f, dynamic_tp_enabled: !f.dynamic_tp_enabled }))}
                className="shrink-0"
              >
                {form.dynamic_tp_enabled
                  ? <ToggleRight size={22} className="text-yellow-400" />
                  : <ToggleLeft  size={22} className="text-gray-600" />}
              </button>
            </div>

            {form.dynamic_tp_enabled && (
              <div className="border-t border-yellow-700/20 px-4 pb-4 pt-3 space-y-3">
                {/* 미리보기 */}
                <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 text-xs text-yellow-300">
                  기본 익절 <strong>{form.take_profit_pct ?? 5}%</strong> →
                  수급 좋을 때 <strong className="text-emerald-400">
                    {((form.take_profit_pct ?? 5) * (form.dynamic_tp_multiplier ?? 1.5)).toFixed(1)}%
                  </strong>
                  <span className="ml-2 text-gray-400">
                    (× {form.dynamic_tp_multiplier ?? 1.5} 배)
                  </span>
                </div>

                {/* 수급 점수 기준 */}
                <div>
                  <label className="text-[11px] text-gray-400 block mb-1.5">
                    수급 점수 기준 <span className="text-gray-600">(이 점수 이상이면 상향 적용, 0~100)</span>
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={0.4} max={0.9} step={0.05}
                      value={form.dynamic_tp_supply_threshold ?? 0.65}
                      onChange={e => setForm(f => ({ ...f, dynamic_tp_supply_threshold: parseFloat(e.target.value) }))}
                      className="flex-1 accent-yellow-400"
                    />
                    <span className="text-sm font-bold text-yellow-300 w-10 text-right">
                      {Math.round((form.dynamic_tp_supply_threshold ?? 0.65) * 100)}점
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-600 mt-0.5 px-0.5">
                    <span>40점 (느슨)</span><span>65점 (권장)</span><span>90점 (엄격)</span>
                  </div>
                </div>

                {/* 익절 배수 */}
                <div>
                  <label className="text-[11px] text-gray-400 block mb-1.5">
                    익절 배수 <span className="text-gray-600">(기본 익절 기준에 곱할 배수)</span>
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={1.1} max={3.0} step={0.1}
                      value={form.dynamic_tp_multiplier ?? 1.5}
                      onChange={e => setForm(f => ({ ...f, dynamic_tp_multiplier: parseFloat(e.target.value) }))}
                      className="flex-1 accent-yellow-400"
                    />
                    <span className="text-sm font-bold text-yellow-300 w-12 text-right">
                      ×{(form.dynamic_tp_multiplier ?? 1.5).toFixed(1)}
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-600 mt-0.5 px-0.5">
                    <span>×1.1 (소폭)</span><span>×1.5 (권장)</span><span>×3.0 (공격적)</span>
                  </div>
                </div>

                <p className="text-[11px] text-gray-500 leading-relaxed">
                  수급 점수 기준 이상 <strong className="text-gray-300">AND</strong> 시장 점수 50점 이상인 경우에만 상향 적용됩니다.
                  두 조건 중 하나라도 충족 안 되면 기본 익절 기준({form.take_profit_pct ?? 5}%)을 사용합니다.
                </p>
              </div>
            )}
          </div>
          {/* 종목당 최대 투자금 */}
          <div className="grid grid-cols-1">
            <MoneyField
              value={form.max_position_amt}
              onChange={v => setForm(f => ({ ...f, max_position_amt: v }))}
              expanded={!!expanded['max_position_amt']}
              onToggle={() => toggle('max_position_amt')}
            />
          </div>
          {/* 종목 단가 상한 */}
          <MaxStockPriceField />
          {/* 일일 손실 한도 */}
          <div className="grid grid-cols-1">
            <NumberField
              paramKey="max_daily_loss_pct"
              value={form.max_daily_loss_pct ?? ''}
              onChange={v => setForm(f => ({ ...f, max_daily_loss_pct: v }))}
              expanded={!!expanded['max_daily_loss_pct']}
              onToggle={() => toggle('max_daily_loss_pct')}
            />
          </div>
        </div>
      </section>

      {/* ── 저장 ── */}
      {msg && (
        <p className={`text-sm text-center ${msg.includes('실패') ? 'text-red-400' : 'text-emerald-400'}`}>{msg}</p>
      )}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-bold disabled:opacity-50 transition-colors"
      >
        {saving ? '저장 중...' : '💾 설정 저장'}
      </button>

      {/* ── 관심 종목 ── */}
      <section>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-300">자동매매 관심 종목</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                활성 <span className="text-blue-400 font-medium">{wl?.active_count ?? 0}</span>종목에 대해 5분마다 AI 신호 생성
                <span className="ml-2 text-gray-600">· 비활성 종목은 신호 생성에서 제외됩니다</span>
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowCriteria(v => !v)}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400"
              >
                <Info size={12} /> 선정 기준
              </button>
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 rounded-lg"
              >
                <Plus size={12} /> 종목 추가
              </button>
            </div>
          </div>

          {showCriteria && wl && (
            <div className="bg-gray-800 rounded-xl p-4 space-y-1.5">
              <p className="text-xs font-semibold text-yellow-400 mb-2">종목 선정 기준</p>
              <p className="text-[11px] text-gray-400 mb-2">아래 기준을 참고해 관심 종목을 추가하세요. 종목 수가 너무 많으면 AI 분석이 느려집니다. 10~20종목 권장.</p>
              {wl.criteria.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-gray-300">
                  <span className="text-blue-400 shrink-0 mt-0.5">·</span>{c}
                </div>
              ))}
            </div>
          )}

          {wl && wl.items.length > 0 ? (
            <div className="space-y-2">
              {wl.items.map(item => (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
                    item.is_active ? 'border-gray-700 bg-gray-800/50' : 'border-gray-800 bg-gray-900 opacity-50'
                  }`}
                >
                  <button onClick={() => handleToggleWatch(item)} className="shrink-0" title={item.is_active ? '비활성화' : '활성화'}>
                    {item.is_active
                      ? <ToggleRight size={20} className="text-blue-400" />
                      : <ToggleLeft size={20} className="text-gray-600" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{item.stock_name}</span>
                      <span className="text-xs text-gray-500">{item.stock_code}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${MARKET_COLOR[item.market] ?? 'bg-gray-700 text-gray-300'}`}>
                        {item.market}
                      </span>
                      {item.sector && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{item.sector}</span>
                      )}
                    </div>
                    {item.reason && (
                      <p className="text-[11px] text-gray-500 mt-0.5 truncate">{item.reason}</p>
                    )}
                  </div>
                  <button onClick={() => handleDeleteWatch(item)} className="shrink-0 p-1 hover:text-red-400 text-gray-600" title="삭제">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-500 text-center py-4">
              종목이 없습니다. "+ 종목 추가"를 눌러 관심 종목을 등록하세요.
            </p>
          )}
        </div>
      </section>

      {showAddModal && <AddModal onSave={handleAddWatch} onClose={() => setShowAddModal(false)} />}

      {/* 매매 결정 로그 패널 */}
      <EngineLogPanel />
    </div>
  )
}

// ── 자동매매 엔진 결정 로그 ──────────────────────────────────────────────
function EngineLogPanel() {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/auto-trade/engine-log?lines=300')
      setLines(r.data.lines ?? [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  const colorLine = (line: string) => {
    if (line.includes('SKIP:'))    return 'text-gray-500'
    if (line.includes('매수 시도')) return 'text-green-400 font-bold'
    if (line.includes('⛔'))       return 'text-red-400'
    if (line.includes('▶'))       return 'text-cyan-400 font-semibold'
    if (line.includes('■'))       return 'text-blue-400'
    if (line.includes('BUY'))     return 'text-yellow-400'
    if (line.includes('가격필터')) return 'text-orange-400'
    return 'text-gray-300'
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition-colors"
      >
        <span className="text-sm font-semibold flex items-center gap-2">
          <BookOpen size={14} className="text-cyan-400" />
          매매 결정 로그 <span className="text-xs text-gray-500 font-normal">(후보 종목 평가 이유 · 스킵 원인)</span>
        </span>
        <span className="flex items-center gap-2">
          {open && <button onClick={e => { e.stopPropagation(); load() }} className="text-xs text-cyan-400 hover:underline">새로고침</button>}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-800">
          {loading ? (
            <p className="text-xs text-gray-500 text-center py-6">로그 불러오는 중…</p>
          ) : lines.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-6">
              아직 로그가 없습니다. 전략을 활성화하면 5분 후 첫 사이클이 기록됩니다.
            </p>
          ) : (
            <div className="overflow-y-auto max-h-80 bg-black font-mono text-[11px] p-3 space-y-0.5">
              {lines.map((line, i) => (
                <div key={i} className={colorLine(line)}>{line}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
