import React, { useEffect, useState, useCallback, useRef } from 'react'
import api, {
  getAutoTradeToday, getAutoTradeStats, getSignalPreview,
  runAutoTradeNow, sendReportNow, getAutoTradeLogs, toggleAutoTrade, getStrategy,
  getTradeMode, setTradeMode, getCycleLogs,
  getManualBuyOrders, createManualBuyOrder, cancelManualBuyOrder,
  searchStocks, getStockMasterStatus, refreshStockMaster,
} from '../api/client'
import PremarketPanel from '../components/premarket/PremarketPanel'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'
import {
  Play, RefreshCw, TrendingUp, TrendingDown, Minus,
  CircleDollarSign, Activity, BarChart3, Zap, ShieldCheck, BrainCircuit,
  Info, ChevronDown, ChevronUp, ArrowRight, ShieldAlert,
  AlertTriangle, X, FlaskConical, Swords, Send, Globe,
  BookmarkPlus, Trash2, Clock, CheckCircle2, XCircle,
} from 'lucide-react'

// ─── 매크로 섹터 패널 ──────────────────────────────────────────
interface MacroSignal {
  sector_id: string; sector_name: string
  net_score: number; direction: string
}
interface MacroEvent {
  event_id: string; name: string; category: string
  score: number; magnitude: number; evidence: string[]
}

const CATEGORY_KO: Record<string, string> = {
  market: '시장지표', risk: '리스크', macro: '거시경제', policy: '정책',
}
const CATEGORY_COLOR: Record<string, string> = {
  market: 'text-blue-400 bg-blue-900/30 border-blue-800',
  risk:   'text-red-400 bg-red-900/30 border-red-800',
  macro:  'text-yellow-400 bg-yellow-900/30 border-yellow-800',
  policy: 'text-purple-400 bg-purple-900/30 border-purple-800',
}

function HowItWorks() {
  return (
    <div className="border-t border-gray-800 bg-gray-950/60 px-4 py-4 space-y-4 text-xs">

      {/* 한 줄 요약 */}
      <p className="text-gray-300 leading-relaxed">
        국제 시장 데이터와 뉴스를 분석해서 <strong className="text-white">어떤 업종이 지금 유리한지</strong>를 자동으로 판단합니다.
        유리한 섹터의 종목이 <strong className="text-cyan-300">섹터 스크리닝 → AI 자동매매 후보</strong>로 이어집니다.
      </p>

      {/* 3단계 플로우 */}
      <div className="grid grid-cols-3 gap-2">
        {[
          {
            step: '1',
            icon: '📡',
            title: '데이터 수집',
            color: 'border-blue-800',
            desc: '30분마다 자동 갱신',
            items: ['국제 유가 (WTI · Brent)', '원달러 환율', '공포지수 (VIX)', '미국 10년 금리', '금 가격', '국내 뉴스 키워드'],
          },
          {
            step: '2',
            icon: '🔍',
            title: '이벤트 감지',
            color: 'border-yellow-800',
            desc: '임계값 초과 시 발동',
            items: [
              '원화 0.7% 이상 약세 → 원화약세',
              '유가 3% 이상 급등 → 유가상승',
              'VIX 25 이상 → 지정학리스크',
              '방산 뉴스 2건↑ → 방산정책',
            ],
          },
          {
            step: '3',
            icon: '📊',
            title: '섹터 영향 계산',
            color: 'border-emerald-800',
            desc: '업종별 점수 합산',
            items: [
              '원화약세 → 반도체 +80점',
              '원화약세 → 항공 -60점',
              '유가상승 → 정유 +90점',
              '유가상승 → 항공 -80점',
            ],
          },
        ].map(({ step, icon, title, color, desc, items }) => (
          <div key={step} className={`border ${color} rounded-xl p-3 space-y-2`}>
            <div className="flex items-center gap-2">
              <span className="text-base">{icon}</span>
              <div>
                <p className="font-bold text-gray-200">{step}단계. {title}</p>
                <p className="text-[10px] text-gray-500">{desc}</p>
              </div>
            </div>
            <ul className="space-y-0.5">
              {items.map((it, i) => (
                <li key={i} className="text-[10px] text-gray-400 flex gap-1">
                  <span className="text-gray-600 shrink-0">·</span>{it}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* 읽는 법 */}
      <div className="bg-gray-900 rounded-xl p-3 space-y-2">
        <p className="font-semibold text-gray-300">📖 결과 읽는 법</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 px-2 py-0.5 rounded border bg-emerald-900/30 border-emerald-700 text-emerald-300 text-[10px] font-bold shrink-0">↑ 반도체 +80</span>
            <p className="text-[10px] text-gray-400">현재 이 업종에 <strong className="text-emerald-300">유리한 환경</strong>. 매수 후보 검토 추천.</p>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 px-2 py-0.5 rounded border bg-red-900/30 border-red-700 text-red-300 text-[10px] font-bold shrink-0">↓ 항공 -80</span>
            <p className="text-[10px] text-gray-400">현재 이 업종에 <strong className="text-red-300">불리한 환경</strong>. 신규 매수 자제 권고.</p>
          </div>
        </div>
        <p className="text-[10px] text-gray-500 border-t border-gray-800 pt-2 mt-1">
          ℹ 이 섹터 신호를 바탕으로 <strong className="text-cyan-400">섹터 스크리닝</strong>이 BUY 종목을 추출하고, 해당 종목들이 <strong className="text-blue-400">AI 자동매매 후보</strong>로 공급됩니다.
        </p>
      </div>
    </div>
  )
}

function MacroSectorPanel() {
  const [signals, setSignals] = useState<MacroSignal[]>([])
  const [events,  setEvents]  = useState<MacroEvent[]>([])
  const [showHow, setShowHow] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/macro/status').then(r => {
      setSignals(r.data.sector_signals ?? [])
      setEvents(r.data.events ?? [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const active = signals.filter(s => s.direction !== 'neutral')

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-4 py-3">
        <Globe size={13} className="text-blue-400 shrink-0" />
        <span className="text-xs font-semibold text-gray-300">매크로 섹터 신호</span>
        <span className={`text-[10px] rounded px-1.5 py-0.5 border shrink-0 ${
          events.length > 0
            ? 'bg-blue-900/50 text-blue-300 border-blue-700'
            : 'bg-gray-800 text-gray-500 border-gray-700'
        }`}>
          이벤트 {events.length}개
        </span>

        <button
          onClick={() => setShowHow(v => !v)}
          className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 border border-blue-900 hover:border-blue-700 rounded px-1.5 py-0.5 transition-colors"
        >
          <Info size={9} />
          {showHow ? '설명 닫기' : '이게 뭐야?'}
        </button>

        <span className="text-[10px] text-cyan-700 ml-auto">섹터 스크리닝 → 자동매매 후보 공급</span>
      </div>

      {/* 작동 원리 설명 */}
      {showHow && <HowItWorks />}

      {/* 감지된 이벤트 목록 */}
      {events.length > 0 && (
        <div className="border-t border-gray-800 px-4 py-2 space-y-1.5">
          <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide">현재 감지된 이벤트</p>
          {events.map(ev => (
            <div key={ev.event_id} className="flex items-start gap-2">
              <span className={`shrink-0 text-[9px] border rounded px-1.5 py-0.5 font-semibold mt-0.5 ${
                CATEGORY_COLOR[ev.category] ?? 'text-gray-400 bg-gray-800 border-gray-700'
              }`}>
                {CATEGORY_KO[ev.category] ?? ev.category}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-200">{ev.name}</span>
                  <span className="text-[10px] text-gray-500">강도 {(ev.magnitude * 100).toFixed(0)}점</span>
                </div>
                {ev.evidence.length > 0 && (
                  <p className="text-[10px] text-gray-500 truncate">{ev.evidence[0]}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 섹터 신호 칩 */}
      <div className="px-4 pb-3 pt-2">
        {loading ? (
          <span className="text-[11px] text-gray-600 flex items-center gap-1">
            <RefreshCw size={10} className="animate-spin" /> 분석 중…
          </span>
        ) : active.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {active
              .sort((a, b) => Math.abs(b.net_score) - Math.abs(a.net_score))
              .map(s => (
                <span
                  key={s.sector_id}
                  className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border font-medium ${
                    s.direction === 'long'
                      ? 'bg-emerald-900/30 border-emerald-700 text-emerald-300'
                      : 'bg-red-900/30 border-red-700 text-red-300'
                  }`}
                  title={s.direction === 'long' ? '수혜 업종 — 매수 유리한 환경' : '피해 업종 — 신규 매수 자제'}
                >
                  {s.direction === 'long'
                    ? <TrendingUp size={10} />
                    : <TrendingDown size={10} />}
                  {s.sector_name}
                  <span className="opacity-60 text-[10px]">
                    {s.net_score > 0 ? '+' : ''}{(s.net_score * 100).toFixed(0)}
                  </span>
                </span>
              ))}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 flex items-center gap-1">
              <Minus size={10} /> 관망 — 현재 모든 업종 중립
            </span>
            <span className="text-[10px] text-gray-600">(이벤트 임계값 미달 또는 데이터 수집 중)</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 타입 ─────────────────────────────────────────────────
interface TradeLog {
  id: number
  stock_code: string
  stock_name: string
  action: 'BUY' | 'SELL'
  quantity: number
  order_price: number
  composite_score: number | null
  trigger_models: string[]
  status: string
  created_at: string
}

interface PreviewItem {
  stock_code: string
  stock_name: string
  current_price: number
  model_score: number
  news_score: number
  composite_score: number
  final_signal: string
  trigger_models: string[]
}

// ─── 공통 유틸 ───────────────────────────────────────────
function fmtAmt(v: number) {
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}억`
  if (v >= 10_000) return `${(v / 10_000).toFixed(0)}만`
  return v.toLocaleString()
}

function SignalChip({ signal }: { signal: string }) {
  const styles: Record<string, string> = {
    BUY:  'bg-emerald-900/60 text-emerald-300 border border-emerald-700',
    SELL: 'bg-red-900/60 text-red-300 border border-red-700',
    HOLD: 'bg-gray-800 text-gray-400 border border-gray-700',
  }
  const icons: Record<string, React.ReactNode> = {
    BUY:  <TrendingUp size={11} />,
    SELL: <TrendingDown size={11} />,
    HOLD: <Minus size={11} />,
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[signal] || styles.HOLD}`}>
      {icons[signal] ?? <Minus size={11} />}{signal}
    </span>
  )
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color = pct >= 63 ? 'bg-emerald-500' : pct <= 37 ? 'bg-red-500' : 'bg-yellow-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    FILLED:    'text-emerald-400',
    MOCK:      'text-blue-400',
    PENDING:   'text-yellow-400',
    CANCELLED: 'text-red-400',
  }
  return <span className={`text-xs font-medium ${map[status] ?? 'text-gray-400'}`}>{status}</span>
}

// ─── 모델별 설명 (Phase 2: 활성 M1·M4·M5·M9, 나머지 비활성) ──
const MODEL_DESC: Record<string, { desc: string; active: boolean }> = {
  M1:  { desc: '이동평균(EMA5/20) 골든·데드크로스',          active: true  },
  M2:  { desc: 'RSI 14 과매도 반등 (M4와 상관 0.78 — 비활성)', active: false },
  M3:  { desc: 'MACD 모멘텀 (M1과 중복 — 비활성)',            active: false },
  M4:  { desc: '볼린저밴드 %B 하단 반등 / 상단 과열',          active: true  },
  M5:  { desc: '거래량 20일 평균 대비 급증 (독립 신호)',        active: true  },
  M6:  { desc: 'CCI 20 과매도 (M4와 상관 0.93 — 비활성)',      active: false },
  M7:  { desc: 'VWAP 이탈·회귀 (M4 클러스터 — 비활성)',        active: false },
  M8:  { desc: '스토캐스틱 K/D 크로스 (비활성)',               active: false },
  M9:  { desc: 'LightGBM 스윙 ML — 피처 종합 (최고 가중치)',   active: true  },
  M10: { desc: '활성 모델(M1·M4·M5·M9) 가중 앙상블 — 단일 임계값(≥0.55 BUY / ≤0.45 SELL)', active: true },
}

// ─── 수동 매수 예약 패널 ──────────────────────────────────
interface ManualOrder {
  id: number
  stock_code: string
  stock_name: string
  quantity: number | null
  budget: number | null
  status: 'pending' | 'executed' | 'cancelled' | 'failed'
  created_at: string
  executed_at: string | null
  executed_price: number | null
  executed_qty: number | null
  error_msg: string | null
}

const STATUS_BADGE: Record<string, string> = {
  pending:   'bg-blue-900/50 border-blue-700/50 text-blue-300',
  executed:  'bg-emerald-900/50 border-emerald-700/50 text-emerald-300',
  cancelled: 'bg-gray-800 border-gray-700 text-gray-500',
  failed:    'bg-red-900/50 border-red-700/50 text-red-300',
}
const STATUS_LABEL: Record<string, string> = {
  pending: '대기', executed: '체결', cancelled: '취소', failed: '실패',
}

interface StockResult { stock_code: string; stock_name: string; market: string }

const MARKET_COLOR: Record<string, string> = {
  KOSPI: 'text-blue-400', KOSDAQ: 'text-emerald-400',
}

// ── 종목 검색 모달 ──────────────────────────────────────────
function StockSearchModal({ onSelect, onClose }: {
  onSelect: (s: StockResult) => void
  onClose: () => void
}) {
  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState<StockResult[]>([])
  const [searching, setSearching] = useState(false)
  const [masterCount, setMasterCount] = useState<number | null>(null)
  const [refreshing, setRefreshing]   = useState(false)
  const [refreshMsg, setRefreshMsg]   = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 모달 열릴 때 포커스 + 종목 수 확인
  useEffect(() => {
    inputRef.current?.focus()
    getStockMasterStatus()
      .then(s => setMasterCount(s.count))
      .catch(() => setMasterCount(0))
  }, [])

  // 검색 디바운스
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); return }
    setSearching(true)
    const t = setTimeout(async () => {
      try { setResults(await searchStocks(q, 30)) }
      catch { setResults([]) }
      finally { setSearching(false) }
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  // ESC로 닫기
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  const handleRefresh = async () => {
    setRefreshing(true)
    setRefreshMsg('')
    try {
      const r = await refreshStockMaster()
      setRefreshMsg(r.message ?? '갱신 완료')
      const s = await getStockMasterStatus()
      setMasterCount(s.count)
    } catch {
      setRefreshMsg('갱신 실패 — 서버 로그를 확인하세요')
    } finally {
      setRefreshing(false)
    }
  }

  const isEmpty = masterCount === 0

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg mx-4 shadow-2xl flex flex-col"
        style={{ maxHeight: '80vh' }}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-100">종목 검색</span>
            {masterCount !== null && (
              <span className="text-[10px] text-gray-500">
                {masterCount > 0 ? `${masterCount.toLocaleString()}종목` : '데이터 없음'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="종목 데이터 갱신"
              className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-violet-400 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? '갱신 중…' : '종목 갱신'}
            </button>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-200 transition-colors ml-1">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 갱신 결과 메시지 */}
        {refreshMsg && (
          <div className="px-5 py-2 bg-violet-950/40 border-b border-violet-800/30 text-[11px] text-violet-300">
            {refreshMsg}
          </div>
        )}

        {/* 데이터 없음 안내 */}
        {isEmpty && !refreshing && (
          <div className="px-5 py-4 border-b border-gray-800 bg-yellow-950/20">
            <p className="text-xs text-yellow-400 font-medium mb-1">종목 데이터가 없습니다</p>
            <p className="text-[10px] text-gray-500">
              서버 시작 시 자동 갱신됩니다. 위 <span className="text-violet-400">종목 갱신</span> 버튼을 눌러 수동으로 불러올 수 있습니다.
            </p>
          </div>
        )}

        {/* 검색 입력 */}
        <div className="px-4 py-3 border-b border-gray-800">
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={isEmpty ? '종목 데이터를 먼저 갱신하세요' : '종목명 또는 코드 입력 (예: 카카오, 035720)'}
            disabled={isEmpty && !refreshing}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors disabled:opacity-40"
          />
        </div>

        {/* 결과 목록 */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {searching && (
            <div className="flex items-center justify-center py-10 text-xs text-gray-500">
              <RefreshCw size={13} className="animate-spin mr-2" /> 검색 중…
            </div>
          )}
          {!searching && query.trim() && results.length === 0 && (
            <div className="text-center py-10 text-xs text-gray-500">
              검색 결과가 없습니다.
            </div>
          )}
          {!searching && !query.trim() && !isEmpty && (
            <div className="text-center py-10 text-xs text-gray-600">
              종목명 또는 6자리 코드를 입력하세요
            </div>
          )}
          {!searching && results.map((s, i) => (
            <button
              key={s.stock_code}
              onClick={() => { onSelect(s); onClose() }}
              className={`w-full flex items-center gap-3 px-5 py-3 hover:bg-gray-800 text-left transition-colors ${i > 0 ? 'border-t border-gray-800/60' : ''}`}
            >
              <span className="font-mono text-xs text-gray-500 w-14 shrink-0">{s.stock_code}</span>
              <span className="text-sm text-gray-100 flex-1 truncate">{s.stock_name}</span>
              <span className={`text-[10px] font-medium shrink-0 ${MARKET_COLOR[s.market] ?? 'text-gray-500'}`}>{s.market}</span>
            </button>
          ))}
        </div>

        <div className="px-5 py-2.5 border-t border-gray-800 text-[10px] text-gray-600 text-right">
          ESC 또는 바깥 클릭으로 닫기
        </div>
      </div>
    </div>
  )
}

// ── 수동 매수 예약 패널 본체 ────────────────────────────────
function ManualBuyPanel() {
  const [orders, setOrders]       = useState<ManualOrder[]>([])
  const [selected, setSelected]   = useState<StockResult | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [mode, setMode]           = useState<'qty' | 'budget'>('budget')
  const [value, setValue]         = useState('')
  const [adding, setAdding]       = useState(false)
  const [errMsg, setErrMsg]       = useState('')
  const [open, setOpen]           = useState(true)

  const load = useCallback(async () => {
    try {
      setOrders(await getManualBuyOrders())
    } catch (e: any) {
      setErrMsg(e?.response?.data?.detail ?? '목록 로드 실패')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const pending   = orders.filter(o => o.status === 'pending')
  const completed = orders.filter(o => o.status === 'executed' || o.status === 'failed')

  const handleAdd = async () => {
    if (!selected) { setErrMsg('종목을 선택하세요.'); return }
    const numVal = Number(value)
    if (!value || isNaN(numVal) || numVal <= 0) {
      setErrMsg(mode === 'qty' ? '수량(주)을 입력하세요.' : '예산(원)을 입력하세요.')
      return
    }
    setAdding(true); setErrMsg('')
    try {
      await createManualBuyOrder({
        stock_code: selected.stock_code,
        stock_name: selected.stock_name,
        quantity:   mode === 'qty'    ? numVal : undefined,
        budget:     mode === 'budget' ? numVal : undefined,
      })
      setSelected(null); setValue('')
      await load()
    } catch (e: any) {
      setErrMsg(e?.response?.data?.detail ?? '등록 실패')
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      {/* 종목 검색 모달 */}
      {showModal && (
        <StockSearchModal
          onSelect={s => setSelected(s)}
          onClose={() => setShowModal(false)}
        />
      )}

      <div className="bg-gray-900 rounded-xl border border-violet-900/50 overflow-hidden">
        {/* 패널 헤더 */}
        <button
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-4 py-3 hover:bg-gray-800/40 transition-colors"
        >
          <BookmarkPlus size={14} className="text-violet-400 shrink-0" />
          <span className="text-sm font-semibold text-gray-100">수동 매수 예약</span>
          {pending.length > 0 && (
            <span className="text-[10px] bg-violet-900/60 border border-violet-700/50 text-violet-300 px-2 py-0.5 rounded-full">
              대기 {pending.length}건
            </span>
          )}
          <span className="ml-auto text-xs text-gray-400 flex items-center gap-1">
            개장 시 자동 매수 · 자동매매 규칙으로 매도
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </span>
        </button>

        {open && (
          <div className="border-t border-gray-800 p-4 space-y-4">
            {/* 추가 폼 */}
            <div className="bg-gray-800/50 rounded-lg p-3 space-y-3">

              {/* 종목 선택 버튼 */}
              <div>
                <label className="block text-[10px] text-gray-500 mb-1">종목 선택 *</label>
                <button
                  onClick={() => setShowModal(true)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${
                    selected
                      ? 'border-violet-600 bg-violet-950/30'
                      : 'border-gray-700 bg-gray-900 hover:border-violet-600/60'
                  }`}
                >
                  {selected ? (
                    <>
                      <span className="font-mono text-xs text-gray-400">{selected.stock_code}</span>
                      <span className="text-sm font-medium text-gray-100 flex-1">{selected.stock_name}</span>
                      <span className={`text-[10px] ${MARKET_COLOR[selected.market] ?? 'text-gray-500'}`}>{selected.market}</span>
                      <span
                        role="button"
                        onClick={e => { e.stopPropagation(); setSelected(null) }}
                        className="text-gray-600 hover:text-gray-300 ml-1"
                      >
                        <X size={12} />
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-gray-500 flex-1">종목을 검색해서 선택하세요</span>
                  )}
                  {!selected && <ChevronDown size={13} className="text-gray-600 shrink-0" />}
                </button>
              </div>

              {/* 수량/예산 + 추가 */}
              <div className="flex items-center gap-2">
                <div className="flex rounded overflow-hidden border border-gray-700 text-[10px] shrink-0">
                  <button
                    onClick={() => setMode('budget')}
                    className={`px-2.5 py-1.5 transition-colors ${mode === 'budget' ? 'bg-violet-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
                  >예산(원)</button>
                  <button
                    onClick={() => setMode('qty')}
                    className={`px-2.5 py-1.5 transition-colors ${mode === 'qty' ? 'bg-violet-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
                  >수량(주)</button>
                </div>
                <input
                  type="number"
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  placeholder={mode === 'budget' ? '1000000' : '10'}
                  min={1}
                  onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500"
                />
                <button
                  onClick={handleAdd}
                  disabled={adding || !selected}
                  className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white text-xs rounded transition-colors shrink-0"
                >
                  {adding ? '추가 중…' : '예약 추가'}
                </button>
              </div>
              {errMsg && <p className="text-[10px] text-red-400">{errMsg}</p>}
            </div>

            {/* 대기 목록 */}
            {pending.length > 0 && (
              <div>
                <p className="text-[10px] text-gray-400 mb-2 flex items-center gap-1">
                  <Clock size={10} /> 개장 시 매수 대기 중
                </p>
                <div className="space-y-1.5">
                  {pending.map(o => (
                    <div key={o.id} className="flex items-center gap-3 bg-gray-800/60 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-gray-100">{o.stock_name}</span>
                        <span className="text-[10px] text-gray-500 ml-1.5 font-mono">{o.stock_code}</span>
                      </div>
                      <span className="text-[10px] text-gray-300 shrink-0">
                        {o.quantity ? `${o.quantity.toLocaleString()}주` : `${(o.budget ?? 0).toLocaleString()}원`}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${STATUS_BADGE[o.status]}`}>
                        {STATUS_LABEL[o.status]}
                      </span>
                      <button
                        onClick={async () => { try { await cancelManualBuyOrder(o.id); load() } catch {} }}
                        className="text-gray-600 hover:text-red-400 transition-colors shrink-0"
                        title="취소"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {pending.length === 0 && completed.length === 0 && (
              <p className="text-xs text-gray-500 text-center py-2">
                예약된 종목이 없습니다. 위에서 종목을 선택해 추가하세요.
              </p>
            )}

            {/* 오늘 처리된 주문 */}
            {completed.length > 0 && (
              <div>
                <p className="text-[10px] text-gray-400 mb-2">오늘 처리된 주문</p>
                <div className="space-y-1">
                  {completed.map(o => (
                    <div key={o.id} className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-gray-800/30">
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-gray-200">{o.stock_name}</span>
                        <span className="text-[10px] text-gray-600 ml-1.5 font-mono">{o.stock_code}</span>
                      </div>
                      {o.status === 'executed' && o.executed_qty && o.executed_price ? (
                        <span className="text-[10px] text-emerald-400 shrink-0">
                          {o.executed_qty}주 × {o.executed_price.toLocaleString()}원
                        </span>
                      ) : o.error_msg ? (
                        <span className="text-[10px] text-red-400 truncate max-w-36 shrink-0">{o.error_msg}</span>
                      ) : null}
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${STATUS_BADGE[o.status]}`}>
                        {o.status === 'executed'
                          ? <><CheckCircle2 size={8} className="inline mr-0.5" />{STATUS_LABEL[o.status]}</>
                          : <><XCircle size={8} className="inline mr-0.5" />{STATUS_LABEL[o.status]}</>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ─── 사이클 로그 패널 ─────────────────────────────────────
interface CycleLogLine {
  ts: string
  level: 'info' | 'warn' | 'error' | 'success'
  step: string
  msg: string
  data?: Record<string, unknown> | null
}
interface CycleEntry {
  id: string
  started_at: string
  ended_at: string | null
  status: 'running' | 'done'
  lines: CycleLogLine[]
  summary: { bought: number; candidates: number; scored: number } | null
}

const STEP_LABEL: Record<string, string> = {
  start:   '시작',
  collect: '수집',
  exit:    '손절/익절',
  score:   '점수',
  rank:    '순위',
  order:   '주문',
  end:     '완료',
}
const LEVEL_COLOR: Record<string, string> = {
  info:    'text-gray-200',
  warn:    'text-yellow-300',
  error:   'text-red-400',
  success: 'text-emerald-300',
}
const STEP_COLOR: Record<string, string> = {
  start:   'text-blue-400   bg-blue-900/40',
  collect: 'text-cyan-400   bg-cyan-900/30',
  exit:    'text-orange-400 bg-orange-900/30',
  score:   'text-purple-400 bg-purple-900/30',
  rank:    'text-yellow-400 bg-yellow-900/30',
  order:   'text-emerald-400 bg-emerald-900/30',
  end:     'text-gray-400   bg-gray-800',
}

function CycleLogLine({ line }: { line: CycleLogLine }) {
  const stepCls = STEP_COLOR[line.step] ?? 'text-gray-500 bg-gray-800'
  const msgCls  = LEVEL_COLOR[line.level] ?? 'text-gray-400'
  return (
    <div className="flex items-start gap-2 py-0.5 hover:bg-gray-700/20 px-2 rounded group">
      <span className="text-[10px] text-gray-400 shrink-0 w-14 pt-0.5 font-mono">{line.ts}</span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium ${stepCls}`}>
        {STEP_LABEL[line.step] ?? line.step}
      </span>
      <span className={`text-[11px] leading-snug flex-1 ${msgCls}`}>{line.msg}</span>
    </div>
  )
}

function CycleBlock({ cycle, defaultOpen }: { cycle: CycleEntry; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  const isRunning = cycle.status === 'running'
  const startTime = cycle.started_at ? new Date(cycle.started_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
  const bought = cycle.summary?.bought ?? 0

  return (
    <div className={`rounded-xl border overflow-hidden ${isRunning ? 'border-blue-700/60 bg-blue-950/20' : 'border-gray-800 bg-gray-900/50'}`}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/30 transition-colors"
      >
        {isRunning
          ? <RefreshCw size={13} className="text-blue-400 animate-spin shrink-0" />
          : bought > 0
            ? <TrendingUp size={13} className="text-emerald-400 shrink-0" />
            : <Minus size={13} className="text-gray-600 shrink-0" />}
        <span className={`text-xs font-semibold ${isRunning ? 'text-blue-300' : 'text-gray-300'}`}>
          {startTime}
        </span>
        {isRunning
          ? <span className="text-[11px] text-blue-400/80 animate-pulse">실행 중…</span>
          : cycle.summary && (
              <span className="text-[11px] text-gray-300">
                후보 {cycle.summary.candidates}개 · 평가 {cycle.summary.scored}개
                {bought > 0 && <span className="text-emerald-300 font-medium"> · 매수 {bought}건</span>}
              </span>
            )}
        <span className="ml-auto text-gray-400">
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-800 py-2 max-h-80 overflow-y-auto">
          {cycle.lines.length === 0
            ? <p className="text-[11px] text-gray-400 px-4 py-2">로그 없음</p>
            : cycle.lines.map((ln, i) => <CycleLogLine key={i} line={ln} />)}
        </div>
      )}
    </div>
  )
}

function CycleLogPanel() {
  const [cycles, setCycles] = useState<CycleEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(true)

  const fetch = useCallback(async () => {
    try {
      const r = await getCycleLogs()
      setCycles(r.cycles ?? [])
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch()
    const id = setInterval(fetch, 5000)
    return () => clearInterval(id)
  }, [fetch])

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-gray-800/40 transition-colors"
      >
        <Activity size={14} className="text-blue-400 shrink-0" />
        <span className="text-sm font-semibold">자동매매 실행 로그</span>
        {cycles[0]?.status === 'running' && (
          <span className="text-[10px] bg-blue-900/60 border border-blue-700/50 text-blue-300 px-2 py-0.5 rounded-full animate-pulse">
            실행 중
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-gray-400">
          {!loading && cycles.length > 0 && `최근 ${cycles.length}사이클`}
          <button
            onClick={e => { e.stopPropagation(); fetch() }}
            className="text-gray-400 hover:text-gray-200"
          >
            <RefreshCw size={11} />
          </button>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-800 p-3 space-y-2">
          {loading && <p className="text-xs text-gray-300 text-center py-4">로딩 중…</p>}
          {!loading && cycles.length === 0 && (
            <p className="text-xs text-gray-300 text-center py-4">
              아직 실행된 사이클이 없습니다. 즉시실행 버튼을 눌러보세요.
            </p>
          )}
          {cycles.map((c, i) => (
            <CycleBlock key={c.id} cycle={c} defaultOpen={i === 0} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 즉시실행 결과 패널 ──────────────────────────────────
interface RunRow {
  stock_code: string
  stock_name: string
  composite_score: number
  model_score: number
  news_score: number
  final_signal: string
  current_price: number
  trigger_models: string[]
  result: string
  skip_reason: string | null
  qty: number
}

function RunResultPanel({ result, onClose }: { result: Record<string, unknown>; onClose: () => void }) {
  const [showAll, setShowAll] = useState(false)
  const status       = result.status as string
  const skipReason   = result.skip_reason as string | null
  const mode         = result.mode as string | undefined
  const stratName    = result.strategy_name as string | undefined
  const cash         = result.available_cash as number | undefined
  const marketScore  = result.market_score as number | undefined
  const threshold    = result.buy_threshold as number | undefined
  const candidates   = result.candidates_count as number | undefined
  const scored       = result.scored_count as number | undefined
  const bought       = result.bought_count as number | undefined
  const elapsed      = result.elapsed as number | undefined
  const rows         = (result.rows as RunRow[] | undefined) ?? []

  const marketOpen  = result.market_open as boolean | undefined
  const boughtRows  = rows.filter(r => r.result === 'BOUGHT' || r.result === 'BOUGHT(평가전용)')
  const skipRows    = rows.filter(r => r.result === 'SKIP')
  const displayRows = showAll ? rows : rows.slice(0, 8)

  if (status === 'skipped') {
    return (
      <div className="bg-yellow-950/40 border border-yellow-700/60 rounded-xl p-4 flex items-start gap-3">
        <AlertTriangle size={16} className="text-yellow-400 shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-yellow-300">사이클 건너뜀</p>
          <p className="text-xs text-yellow-400/80 mt-0.5">{skipReason}</p>
        </div>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-400"><X size={14} /></button>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center gap-3 px-4 py-3 bg-emerald-950/30 border-b border-gray-800">
        <Activity size={14} className="text-emerald-400 shrink-0" />
        <span className="text-sm font-bold text-emerald-300">사이클 완료</span>
        {marketOpen === false && (
          <span className="text-[10px] bg-yellow-900/50 border border-yellow-700/50 text-yellow-300 px-2 py-0.5 rounded-full">
            장 외 시간 · 평가 전용 (실제 주문 없음)
          </span>
        )}
        <div className="flex items-center gap-2 ml-1 flex-wrap text-[11px]">
          {mode && <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{mode} 모드</span>}
          {stratName && <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{stratName}</span>}
          {elapsed !== undefined && <span className="text-gray-600">{elapsed}초</span>}
        </div>
        <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-400"><X size={14} /></button>
      </div>

      {/* KPI 요약 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 divide-x divide-y divide-gray-800 border-b border-gray-800">
        {[
          { label: '후보 종목', value: `${candidates ?? 0}개`, color: 'text-cyan-300' },
          { label: 'AI 평가', value: `${scored ?? 0}개`, color: 'text-blue-300' },
          { label: '매수 실행', value: `${bought ?? 0}건`, color: bought ? 'text-emerald-400 text-lg font-bold' : 'text-gray-400' },
          { label: '시장 점수', value: marketScore !== undefined ? `${(marketScore * 100).toFixed(0)}점` : '-', color: 'text-yellow-300' },
        ].map(({ label, value, color }) => (
          <div key={label} className="px-4 py-3 text-center">
            <div className="text-[10px] text-gray-500 mb-0.5">{label}</div>
            <div className={`text-sm font-bold ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* 계좌 상태 */}
      {cash !== undefined && (
        <div className="px-4 py-2 bg-gray-800/40 border-b border-gray-800 flex items-center gap-4 text-xs text-gray-400">
          <span>가용 예수금 <strong className="text-white">{cash.toLocaleString()}원</strong></span>
          {threshold !== undefined && <span>매수 임계값 <strong className="text-white">{(threshold * 100).toFixed(0)}점</strong></span>}
        </div>
      )}

      {/* 매수 체결 내역 */}
      {boughtRows.length > 0 && (
        <div className="border-b border-gray-800 p-4 space-y-2">
          <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
            <TrendingUp size={11} />
            {marketOpen === false ? `장 개시 시 매수 예정 ${boughtRows.length}건 (현재 평가 전용)` : `매수 체결 ${boughtRows.length}건`}
          </p>
          {boughtRows.map(r => (
            <div key={r.stock_code} className="flex items-center gap-3 bg-emerald-950/30 border border-emerald-900/40 rounded-lg px-3 py-2">
              <span className="text-xs font-bold text-emerald-300 shrink-0">{r.stock_name || r.stock_code}</span>
              <span className="text-[11px] text-gray-500">{r.stock_code}</span>
              <span className="text-xs text-emerald-400">{r.qty}주 @ {r.current_price.toLocaleString()}원</span>
              <span className="ml-auto text-[11px] text-gray-400">종합점수 {(r.composite_score * 100).toFixed(0)}점</span>
            </div>
          ))}
        </div>
      )}

      {/* 전체 평가 결과 테이블 */}
      {rows.length > 0 && (
        <div className="p-4 space-y-2">
          <p className="text-xs font-semibold text-gray-400">전체 평가 결과 ({rows.length}종목)</p>
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {displayRows.map((r, i) => (
              <div key={r.stock_code} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
                r.result === 'BOUGHT' ? 'bg-emerald-950/40 border border-emerald-900/30' : 'bg-gray-800/50'
              }`}>
                <span className="w-4 text-gray-600 shrink-0">{i + 1}</span>
                <span className={`font-medium w-24 truncate shrink-0 ${r.result === 'BOUGHT' ? 'text-emerald-300' : 'text-gray-300'}`}>
                  {r.stock_name || r.stock_code}
                </span>
                {/* 점수 바 */}
                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden min-w-0">
                  <div
                    className={`h-full rounded-full ${r.composite_score >= (threshold ?? 0.55) ? 'bg-emerald-500' : 'bg-gray-600'}`}
                    style={{ width: `${Math.round(r.composite_score * 100)}%` }}
                  />
                </div>
                <span className={`w-8 text-right shrink-0 ${r.composite_score >= (threshold ?? 0.55) ? 'text-emerald-400' : 'text-gray-500'}`}>
                  {(r.composite_score * 100).toFixed(0)}%
                </span>
                {/* 신호 */}
                <span className={`w-10 text-center text-[10px] font-bold shrink-0 ${
                  r.final_signal === 'BUY' ? 'text-emerald-400' : 'text-gray-600'
                }`}>{r.final_signal}</span>
                {/* 결과 */}
                {r.result === 'BOUGHT'
                  ? <span className="text-emerald-400 font-bold text-[11px] shrink-0">매수</span>
                  : r.result === 'BOUGHT(평가전용)'
                    ? <span className="text-yellow-400 font-bold text-[11px] shrink-0">매수예정*</span>
                    : r.skip_reason
                      ? <span className="text-gray-500 text-[10px] truncate max-w-36">{r.skip_reason}</span>
                      : null}
              </div>
            ))}
          </div>
          {rows.length > 8 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="w-full text-[11px] text-gray-500 hover:text-gray-300 py-1"
            >
              {showAll ? '접기' : `+${rows.length - 8}개 더 보기`}
            </button>
          )}
          {skipRows.length > 0 && (
            <div className="text-[11px] text-gray-600 border-t border-gray-800 pt-2 mt-1">
              SKIP 종목 {skipRows.length}개 — 점수 미달·예수금 부족·이미 보유 등
            </div>
          )}
        </div>
      )}

      {rows.length === 0 && bought === 0 && (
        <div className="px-4 py-5 text-center text-sm text-gray-500">
          평가할 후보 종목이 없습니다 — 매크로 탭에서 섹터 스크리닝을 실행하세요
        </div>
      )}
    </div>
  )
}

// ─── 자동매매 설명 패널 ──────────────────────────────────
function HowAutoTradeWorks() {
  const [open, setOpen] = useState(false)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info size={14} className="text-blue-400" />
          <span className="text-sm font-semibold">자동매매 작동 방식</span>
          <span className="text-xs text-gray-500">종목 선정 흐름 · 스케줄 · 점수 기준</span>
        </div>
        {open
          ? <ChevronUp size={14} className="text-gray-500" />
          : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {open && (
        <div className="px-4 pb-5 space-y-5 border-t border-gray-800">

          {/* ── 전체 흐름 ── */}
          <div className="pt-4">
            <p className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">종목 선정 → 매매 실행 흐름</p>
            <div className="flex items-start gap-2 flex-wrap">
              {[
                { icon: <Globe size={12} />, label: '①  매크로 섹터 스크리닝', sub: '09:05 / 11:00 / 13:30', color: 'border-cyan-800 text-cyan-300' },
                { icon: <ArrowRight size={12} />, label: '', sub: '', color: 'text-gray-600 border-transparent bg-transparent px-0 py-0' },
                { icon: <BrainCircuit size={12} />, label: '②  AI 모델(M1~M10) 점수', sub: '5분마다 자동 실행', color: 'border-blue-800 text-blue-300' },
                { icon: <ArrowRight size={12} />, label: '', sub: '', color: 'text-gray-600 border-transparent bg-transparent px-0 py-0' },
                { icon: <Zap size={12} />, label: '③  종합점수 순위 정렬', sub: '뉴스·수급·공시 반영', color: 'border-yellow-800 text-yellow-300' },
                { icon: <ArrowRight size={12} />, label: '', sub: '', color: 'text-gray-600 border-transparent bg-transparent px-0 py-0' },
                { icon: <TrendingUp size={12} />, label: '④  매수 / 매도 실행', sub: '조건 충족 시 주문', color: 'border-emerald-800 text-emerald-300' },
              ].map((step, i) => (
                step.label
                  ? <div key={i} className={`border rounded-xl px-3 py-2 text-xs font-semibold flex flex-col items-center gap-0.5 ${step.color}`}>
                      <span className="flex items-center gap-1">{step.icon}{step.label}</span>
                      {step.sub && <span className="text-[10px] font-normal opacity-60">{step.sub}</span>}
                    </div>
                  : <span key={i} className={`self-center text-xs ${step.color}`}>{step.icon}</span>
              ))}
            </div>
          </div>

          {/* ── 스케줄 ── */}
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">자동 실행 스케줄</p>
            <div className="bg-gray-800/60 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-700">
                    <th className="text-left px-3 py-2 text-gray-500 font-medium">작업</th>
                    <th className="text-left px-3 py-2 text-gray-500 font-medium">주기 / 시간</th>
                    <th className="text-left px-3 py-2 text-gray-500 font-medium">설명</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {[
                    { job: '섹터 스크리닝', time: '09:05 / 11:00 / 13:30', desc: '장중 3회 — BUY 종목 발굴 (자동매매 후보 공급)', color: 'text-cyan-300' },
                    { job: 'AI 자동매매', time: '5분마다 (상시)', desc: '스크리닝 결과를 M1~M10으로 재평가 후 매수·매도', color: 'text-blue-300' },
                    { job: '뉴스 수집·감성 분석', time: '30분마다 (상시)', desc: '네이버 뉴스 수집 → 감성점수 산출 → 자동매매 반영', color: 'text-purple-300' },
                    { job: 'DART 공시 수집', time: '30분마다 (상시)', desc: '기업 공시 수집 → 호재/악재 판단 점수 반영', color: 'text-yellow-300' },
                    { job: '모닝 리포트', time: '08:40 (평일)', desc: '텔레그램 — 장전 시간외 10분 전 매수 후보 요약', color: 'text-gray-300' },
                    { job: '정시 리포트', time: '10:00~15:00 매 정시', desc: '텔레그램 — 장중 진행 현황 6회', color: 'text-gray-300' },
                    { job: '마감 리포트', time: '15:35 (평일)', desc: '텔레그램 — 오늘 매매 결산', color: 'text-gray-300' },
                    { job: '종가 갱신', time: '15:35 (평일)', desc: '보유 종목 종가 DB 갱신', color: 'text-gray-500' },
                  ].map(({ job, time, desc, color }) => (
                    <tr key={job}>
                      <td className={`px-3 py-2 font-medium ${color}`}>{job}</td>
                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{time}</td>
                      <td className="px-3 py-2 text-gray-500">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── 종합 점수 ── */}
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">종합 점수 산정 (0.0 ~ 1.0)</p>
            <div className="bg-gray-800/60 rounded-xl p-4">
              <div className="flex items-center gap-0 mb-3 h-4 rounded-full overflow-hidden">
                <div className="bg-blue-500  flex items-center justify-center text-[10px] font-bold text-white" style={{ width: '35%' }}>35%</div>
                <div className="bg-green-500  flex items-center justify-center text-[10px] font-bold text-white" style={{ width: '25%' }}>25%</div>
                <div className="bg-yellow-500 flex items-center justify-center text-[10px] font-bold text-black" style={{ width: '15%' }}>15%</div>
                <div className="bg-purple-500 flex items-center justify-center text-[10px] font-bold text-white" style={{ width: '15%' }}>15%</div>
                <div className="bg-pink-500   flex items-center justify-center text-[10px] font-bold text-white" style={{ width: '10%' }}>10%</div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
                {[
                  { color: 'bg-blue-500',   label: 'AI 모델',        pct: '35%', desc: 'M1·M4·M5·M9 앙상블' },
                  { color: 'bg-green-500',  label: '외인·기관 수급',  pct: '25%', desc: '외국인·기관+개인역지표·지속성' },
                  { color: 'bg-yellow-500', label: '시장 상황',       pct: '15%', desc: '시간대·요일 보정' },
                  { color: 'bg-purple-500', label: '뉴스 감성',       pct: '15%', desc: '최근 24h (악재 < 0.3 차단)' },
                  { color: 'bg-pink-500',   label: 'DART 공시',       pct: '10%', desc: '공시 호재·악재' },
                ].map(({ color, label, pct, desc }) => (
                  <div key={label} className="flex items-start gap-1.5">
                    <div className={`w-2.5 h-2.5 rounded-full ${color} mt-0.5 shrink-0`} />
                    <div>
                      <p className="font-semibold text-gray-300">{label} <span className="text-gray-500">({pct})</span></p>
                      <p className="text-gray-600 mt-0.5">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── 매수 / 매도 조건 ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-emerald-950/30 border border-emerald-900/50 rounded-xl p-4">
              <p className="text-xs font-semibold text-emerald-400 mb-3 flex items-center gap-1.5">
                <TrendingUp size={12} /> 매수 조건 (모두 충족 시)
              </p>
              <ul className="space-y-1.5 text-[11px] text-gray-300">
                {[
                  ['후보 소스',   '섹터 스크리닝 BUY 종목 or 워치리스트'],
                  ['종합 점수',  '≥ 매수 임계값 (전략 탭 설정, 기본 0.60)'],
                  ['뉴스 게이트', '감성점수 ≥ 0.30 (악재 심하면 자동 차단)'],
                  ['보유 여부',  '미보유 종목만'],
                  ['예수금',     '현재가 이상 (단가 상한 적용 가능)'],
                  ['보유 한도',  '최대 보유 종목 수 미만'],
                  ['손절 재매수', '당일 손절된 종목은 당일 재매수 차단'],
                  ['익절 재매수', '당일 익절 종목은 점수 ≥ 기준+10%p 시만 허용'],
                ].map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span className="text-gray-500 shrink-0">{k}</span>
                    <span className="text-right">{v}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-4">
              <p className="text-xs font-semibold text-red-400 mb-3 flex items-center gap-1.5">
                <TrendingDown size={12} /> 매도 조건 (둘 중 하나)
              </p>
              <ul className="space-y-1.5 text-[11px] text-gray-300">
                {[
                  ['손절 (Stop Loss)',    '매수가 대비 –손절% 이하 → 즉시 자동 매도'],
                  ['익절 (Take Profit)', '매수가 대비 +익절% 이상 → 수익 확정'],
                  ['AI 신호 매도',       'AI 점수가 매도 임계값 이하로 하락 → 매도 검토'],
                ].map(([k, v]) => (
                  <li key={k} className="space-y-0.5">
                    <p className="text-gray-400 font-medium">{k}</p>
                    <p className="text-gray-300 pl-2">{v}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-3 pt-3 border-t border-red-900/30 text-[11px] text-gray-500">
                <ShieldAlert size={10} className="inline mr-1 text-yellow-500" />
                손절·익절 비율은 <span className="text-gray-300">전략</span> 탭에서 수정 가능 · 손절 후 당일 재매수 자동 차단
              </div>
            </div>
          </div>

          {/* ── M1~M10 모델 설명 ── */}
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
              M1~M10 모델 역할
              <span className="ml-2 normal-case font-normal text-gray-600">(활성: M1·M4·M5·M9 / 비활성: M2·M3·M6·M7·M8)</span>
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              {Object.entries(MODEL_DESC).map(([id, { desc, active }]) => (
                <div key={id} className={`rounded-lg p-2.5 ${
                  id === 'M10'
                    ? 'bg-blue-900/30 border border-blue-800/50 col-span-2 sm:col-span-5'
                    : active ? 'bg-gray-800/60' : 'bg-gray-900/40 opacity-50'
                }`}>
                  <p className={`text-xs font-bold mb-0.5 flex items-center gap-1 ${id === 'M10' ? 'text-blue-300' : active ? 'text-gray-300' : 'text-gray-600'}`}>
                    {id}
                    {!active && id !== 'M10' && <span className="text-[9px] font-normal text-gray-600">비활성</span>}
                  </p>
                  <p className="text-[10px] text-gray-500 leading-snug">{desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── 주문 상태 ── */}
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">주문 상태 구분</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { status: 'FILLED',    color: 'text-emerald-400', desc: '키움증권 실계좌 체결 완료' },
                { status: 'MOCK',      color: 'text-blue-400',    desc: '모의 주문 (모의투자 모드)' },
                { status: 'PENDING',   color: 'text-yellow-400',  desc: '주문 접수 완료, 체결 대기' },
                { status: 'CANCELLED', color: 'text-red-400',     desc: 'API 오류 등으로 취소' },
              ].map(item => (
                <div key={item.status} className="bg-gray-800/60 rounded-lg p-2.5">
                  <p className={`text-xs font-bold mb-0.5 ${item.color}`}>{item.status}</p>
                  <p className="text-[10px] text-gray-500 leading-snug">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-3 py-2.5 text-[11px] text-gray-400 leading-relaxed">
            💡 예수금 20만원 운영 시 <strong className="text-gray-200">전략 탭 → 종목당 최대 투자금</strong>을 <strong className="text-yellow-300">10~15만원</strong>, <strong className="text-gray-200">단가 상한</strong>을 <strong className="text-yellow-300">20만원</strong>으로 설정 권장. 섹터 스크리닝이 저가 BUY 종목을 우선 공급합니다.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 실전/모의 확인 다이얼로그 ──────────────────────────
function TradeModeDialog({
  toReal, maxPositionAmt, onConfirm, onCancel,
}: { toReal: boolean; maxPositionAmt: number | null; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl">
        {/* 헤더 */}
        <div className={`flex items-center justify-between px-5 py-4 rounded-t-2xl border-b border-gray-800 ${toReal ? 'bg-emerald-900/30' : 'bg-blue-900/20'}`}>
          <div className="flex items-center gap-2">
            {toReal
              ? <Swords size={16} className="text-emerald-400" />
              : <FlaskConical size={16} className="text-blue-400" />}
            <span className={`font-bold text-sm ${toReal ? 'text-emerald-300' : 'text-blue-300'}`}>
              {toReal ? '실전매매로 전환' : '모의투자로 전환'}
            </span>
          </div>
          <button onClick={onCancel} className="text-gray-500 hover:text-gray-300">
            <X size={16} />
          </button>
        </div>

        {/* 본문 */}
        <div className="px-5 py-4 space-y-3 text-sm">
          {toReal ? (
            <>
              <div className="flex items-start gap-2 bg-red-900/20 border border-red-800/40 rounded-xl p-3 text-[12px] text-red-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
                <p><strong>키움증권 실계좌</strong>로 실제 주문이 발생합니다. 잘못된 매매로 인한 손실은 복구할 수 없습니다.</p>
              </div>
              <ul className="space-y-2 text-[12px] text-gray-300">
                <li className="flex items-start gap-2">
                  <span className="text-yellow-400 shrink-0 mt-0.5">⚠</span>
                  <span><strong className="text-white">종목당 최대 투자금</strong>이 현재 <strong className="text-yellow-300">{maxPositionAmt != null ? maxPositionAmt.toLocaleString('ko-KR') + '원' : '미설정'}</strong>입니다. 소액 운영 시 <strong>전략 탭</strong>에서 예수금의 50~80% 수준으로 낮추세요.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-gray-500 shrink-0 mt-0.5">•</span>
                  <span>자동매매가 켜진 상태에서 즉시 적용됩니다.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-gray-500 shrink-0 mt-0.5">•</span>
                  <span>서버 재시작 후에도 설정이 유지됩니다(.env 저장).</span>
                </li>
              </ul>
            </>
          ) : (
            <ul className="space-y-2 text-[12px] text-gray-400">
              <li className="flex items-start gap-2">
                <span className="text-blue-400 shrink-0 mt-0.5">•</span>
                <span>이후 모든 주문은 <strong className="text-white">MOCK</strong> 상태로 기록되며 실제 체결되지 않습니다.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-blue-400 shrink-0 mt-0.5">•</span>
                <span>기존 보유 포지션은 영향받지 않습니다.</span>
              </li>
            </ul>
          )}
        </div>

        {/* 버튼 */}
        <div className="px-5 pb-5 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 font-medium transition-colors"
          >
            취소
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors ${
              toReal
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {toReal ? '실전매매 시작' : '모의투자로 전환'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 메인 페이지 ──────────────────────────────────────────
export default function AutoTrade() {
  const [today, setToday] = useState<Record<string, number & unknown> | null>(null)
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [previews, setPreviews] = useState<PreviewItem[]>([])
  const [logs, setLogs] = useState<TradeLog[]>([])
  const [autoOn, setAutoOn] = useState(false)
  const [maxPositionAmt, setMaxPositionAmt] = useState<number | null>(null)
  const [realTrade, setRealTrade] = useState(false)
  const [modeDialogOpen, setModeDialogOpen] = useState(false)
  const [modeChanging, setModeChanging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<Record<string, unknown> | null>(null)
  const [reporting, setReporting] = useState(false)
  const [reportMsg, setReportMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [marketScore, setMarketScore] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, s, st, logsData, mode] = await Promise.all([
        getAutoTradeToday(),
        getStrategy(),
        getAutoTradeStats(30),
        getAutoTradeLogs({ days: 3, limit: 50 }),
        getTradeMode(),
      ])
      setToday(t)
      setAutoOn(s?.is_active ?? false)
      setMaxPositionAmt(s?.max_position_amt ?? null)
      setStats(st)
      setLogs(logsData.logs ?? [])
      setRealTrade(mode?.real_trade ?? false)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true)
    try {
      const r = await getSignalPreview()
      setPreviews(r.previews ?? [])
      setMarketScore(r.market_score ?? 0)
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    loadPreview()
  }, [load, loadPreview])

  const loadAll = useCallback(async () => {
    await Promise.all([load(), loadPreview()])
  }, [load, loadPreview])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(60, loadAll)

  const handleRunNow = async () => {
    setRunning(true)
    setRunResult(null)
    try {
      const result = await runAutoTradeNow()
      setRunResult(result)
      await load()
    } finally {
      setRunning(false)
    }
  }

  const handleToggle = async () => {
    await toggleAutoTrade()
    setAutoOn(v => !v)
    await load()
  }

  const handleSendReport = async () => {
    setReporting(true)
    setReportMsg(null)
    try {
      const r = await sendReportNow()
      setReportMsg({ text: `📨 ${r.message}`, ok: true })
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setReportMsg({ text: detail ?? '리포트 전송 실패 (텔레그램 설정 확인)', ok: false })
    } finally {
      setReporting(false)
      setTimeout(() => setReportMsg(null), 8000)
    }
  }

  const handleModeConfirm = async () => {
    setModeChanging(true)
    try {
      const result = await setTradeMode(!realTrade)
      setRealTrade(result.real_trade)
    } finally {
      setModeChanging(false)
      setModeDialogOpen(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 모드 다이얼로그 */}
      {modeDialogOpen && (
        <TradeModeDialog
          toReal={!realTrade}
          maxPositionAmt={maxPositionAmt}
          onConfirm={handleModeConfirm}
          onCancel={() => setModeDialogOpen(false)}
        />
      )}

      {/* 실전/모의 모드 배너 */}
      <div className={`flex items-center justify-between rounded-xl px-4 py-3 border ${
        realTrade
          ? 'bg-emerald-950/40 border-emerald-700/60'
          : 'bg-blue-950/30 border-blue-800/40'
      }`}>
        <div className="flex items-center gap-3">
          {realTrade
            ? <Swords size={18} className="text-emerald-400" />
            : <FlaskConical size={18} className="text-blue-400" />}
          <div>
            <p className={`text-sm font-bold ${realTrade ? 'text-emerald-300' : 'text-blue-300'}`}>
              {realTrade ? '실전매매 모드' : '모의투자 모드'}
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {realTrade
                ? '키움증권 실계좌로 실제 주문이 실행됩니다'
                : '주문이 실제 체결되지 않으며 MOCK으로 기록됩니다'}
            </p>
          </div>
        </div>
        <button
          onClick={() => setModeDialogOpen(true)}
          disabled={modeChanging}
          className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
            realTrade
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-emerald-700 hover:bg-emerald-600 text-white'
          }`}
        >
          {modeChanging ? '전환 중…' : realTrade ? '모의투자로 전환' : '실전매매 시작'}
        </button>
      </div>

      {/* 프리장 거래량 신호 패널 */}
      <PremarketPanel />

      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">자동매매 현황</h1>
          <p className="text-xs text-gray-500 mt-0.5">섹터 스크리닝 BUY 종목 → M1·M4·M5·M9 + 수급·뉴스게이트 → 종합 랭킹 → 자동 매수·매도</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={60}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy || loading}
            onRefresh={timerRefresh}
            serverLabel="서버 5분"
          />
          <button
            onClick={handleRunNow}
            disabled={running}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
          >
            <Play size={12} />{running ? '실행중…' : '즉시실행'}
          </button>
          <button
            onClick={handleSendReport}
            disabled={reporting}
            title="현재 시장 기준 매수 후보를 텔레그램으로 전송"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-white text-xs font-medium disabled:opacity-50"
          >
            <Send size={12} />{reporting ? '전송중…' : '리포트 전송'}
          </button>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800">
            <span className="text-xs text-gray-400">자동매매</span>
            <div onClick={handleToggle} className="cursor-pointer">
              <div className={`relative w-9 h-5 rounded-full transition-colors ${autoOn ? 'bg-blue-600' : 'bg-gray-700'}`}>
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${autoOn ? 'translate-x-4' : ''}`} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 리포트 전송 결과 토스트 */}
      {reportMsg && (
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium ${
          reportMsg.ok ? 'bg-violet-900/60 border border-violet-700 text-violet-200' : 'bg-red-900/60 border border-red-700 text-red-200'
        }`}>
          {reportMsg.text}
        </div>
      )}

      {/* 수동 매수 예약 */}
      <ManualBuyPanel />

      {/* 사이클 실행 로그 */}
      <CycleLogPanel />

      {/* 즉시실행 진행 / 결과 */}
      {running && (
        <div className="bg-blue-950/40 border border-blue-800/60 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-blue-300">
            <RefreshCw size={14} className="animate-spin" />
            자동매매 사이클 실행 중…
          </div>
          <div className="space-y-2">
            {[
              '① 섹터 스크리닝 BUY 종목 + 워치리스트 수집',
              '② M1~M10 AI 모델 종합 점수 계산',
              '③ 매수 조건 검토 및 주문 실행',
            ].map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-blue-400/70">
                <RefreshCw size={10} className="animate-spin shrink-0" />
                {step}
              </div>
            ))}
          </div>
        </div>
      )}
      {!running && runResult && <RunResultPanel result={runResult} onClose={() => setRunResult(null)} />}

      {/* 자동매매 설명 */}
      <HowAutoTradeWorks />

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center gap-2 mb-1">
            <Activity size={14} className="text-blue-400" />
            <span className="text-xs text-gray-400">오늘 주문</span>
          </div>
          <div className="text-xl font-bold">
            {(today as {buy_count?: number})?.buy_count ?? 0}매수 / {(today as {sell_count?: number})?.sell_count ?? 0}매도
          </div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center gap-2 mb-1">
            <CircleDollarSign size={14} className="text-emerald-400" />
            <span className="text-xs text-gray-400">오늘 매수금액</span>
          </div>
          <div className="text-xl font-bold text-emerald-400">
            {fmtAmt((today as {total_buy_amount?: number})?.total_buy_amount ?? 0)}
          </div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={14} className="text-purple-400" />
            <span className="text-xs text-gray-400">30일 실현손익</span>
          </div>
          <div className={`text-xl font-bold ${((stats as {total_realized_pnl?: number})?.total_realized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmtAmt((stats as {total_realized_pnl?: number})?.total_realized_pnl ?? 0)}원
          </div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck size={14} className="text-yellow-400" />
            <span className="text-xs text-gray-400">시장 점수</span>
          </div>
          <div className="text-xl font-bold text-yellow-400">
            {(marketScore * 100).toFixed(0)}점
          </div>
        </div>
      </div>

      {/* 매크로 섹터 신호 */}
      <MacroSectorPanel />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 종목 신호 랭킹 */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Zap size={14} className="text-yellow-400" />
              <h2 className="text-sm font-semibold">종목 신호 랭킹</h2>
            </div>
            <button
              onClick={() => loadPreview()}
              disabled={previewLoading}
              className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
            >
              <RefreshCw size={11} className={previewLoading ? 'animate-spin' : ''} /> 갱신
            </button>
          </div>

          {/* 후보 소스 안내 */}
          <div className="mb-3 bg-cyan-950/30 border border-cyan-900/40 rounded-lg px-3 py-2 text-[11px] text-cyan-300/70 leading-relaxed">
            <span className="font-semibold text-cyan-400">후보 소스:</span> 매크로 섹터 스크리닝 BUY 종목 (최근 24h) + 워치리스트 → M1~M10 종합 점수 계산
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {previews.length === 0 && (
              <div className="text-center py-6 space-y-1.5">
                {previewLoading
                  ? <p className="text-sm text-gray-500">점수 계산 중…</p>
                  : <>
                      <p className="text-sm text-gray-500">섹터 스크리닝 결과 없음</p>
                      <p className="text-[11px] text-gray-600">매크로 탭 → 섹터 스크리닝 실행 후 종목이 표시됩니다<br />(장중 09:05 / 11:00 / 13:30 자동 실행)</p>
                    </>}
              </div>
            )}
            {previews.map((p, i) => (
              <div key={p.stock_code} className="bg-gray-800 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-4">{i + 1}</span>
                    <div>
                      <span className="font-medium text-sm">{p.stock_name || p.stock_code}</span>
                      <span className="text-xs text-gray-500 ml-1.5">{p.stock_code}</span>
                    </div>
                    <SignalChip signal={p.final_signal} />
                  </div>
                  <span className="text-xs text-gray-400">{p.current_price.toLocaleString()}원</span>
                </div>
                <ScoreBar score={p.composite_score} />
                <div className="flex gap-3 text-xs text-gray-500">
                  <span>모델 {(p.model_score * 100).toFixed(0)}%</span>
                  <span>뉴스 {(p.news_score * 100).toFixed(0)}%</span>
                  <span className="text-blue-400">{p.trigger_models.join(' ')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 최근 거래 이력 */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-semibold mb-3">최근 자동매매 이력</h2>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {logs.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-6">이력 없음</p>
            )}
            {logs.map(l => (
              <div key={l.id} className="bg-gray-800 rounded-lg px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <SignalChip signal={l.action} />
                    <span className="font-medium text-sm truncate">{l.stock_name || l.stock_code}</span>
                    {l.stock_name && <span className="text-xs text-gray-500 shrink-0">{l.stock_code}</span>}
                  </div>
                  <div className="flex gap-2 mt-1 text-xs text-gray-500">
                    <span>{l.quantity}주 @ {l.order_price.toLocaleString()}원</span>
                    {l.composite_score != null && (
                      <span className="text-blue-400">점수 {(l.composite_score * 100).toFixed(0)}%</span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <StatusBadge status={l.status} />
                  <div className="text-xs text-gray-600 mt-0.5">
                    {new Date(l.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 모델별 트리거 현황 */}
      {stats && (stats as {model_trigger_counts?: Record<string, number>}).model_trigger_counts && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-semibold mb-3">모델별 매수 신호 기여 (30일)</h2>
          <div className="grid grid-cols-5 lg:grid-cols-10 gap-2">
            {Object.entries((stats as {model_trigger_counts: Record<string, number>}).model_trigger_counts)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([model, count]) => (
                <div key={model} className="bg-gray-800 rounded-lg p-2 text-center">
                  <div className="text-xs text-blue-400 font-medium">{model}</div>
                  <div className="text-lg font-bold">{count}</div>
                  <div className="text-xs text-gray-500">건</div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
