import { useEffect, useState, useCallback } from 'react'
import {
  getModels, toggleModel, getModelPerformance,
} from '../api/client'
import {
  BrainCircuit, ChevronDown, ChevronUp,
  TrendingUp, ToggleLeft, ToggleRight,
  Info, Database, Zap, Newspaper, FileText, BarChart2, Globe,
} from 'lucide-react'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'

// ─── 타입 ─────────────────────────────────────────────────
interface Model {
  id: number
  model_id: string
  model_name: string
  model_type: string
  trade_style: string
  description: string
  version: string
  is_active: boolean
  weight: number
  win_rate: number | null
  profit_factor: number | null
  sharpe_ratio: number | null
  max_drawdown: number | null
  total_signals: number
}

// ─── 상수 ─────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  technical: 'bg-blue-900/60 text-blue-300 border border-blue-700',
  ml:        'bg-purple-900/60 text-purple-300 border border-purple-700',
  sentiment: 'bg-yellow-900/60 text-yellow-300 border border-yellow-700',
  ensemble:  'bg-emerald-900/60 text-emerald-300 border border-emerald-700',
}

const STYLE_LABELS: Record<string, string> = {
  scalping: '단타',
  swing:    '스윙',
  ensemble: '앙상블',
}

function TypeBadge({ type }: { type: string }) {
  const cls = TYPE_COLORS[type] ?? 'bg-gray-800 text-gray-300 border border-gray-700'
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{type}</span>
}

// ─── PnL 차트 ───────────────────────────────────────────
function MiniPnlChart({ modelId }: { modelId: string }) {
  const [data, setData] = useState<{ date: string; cumulative_pnl: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getModelPerformance(modelId, 30)
      .then(r => setData(r.timeline ?? []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [modelId])

  if (loading) return <div className="h-20 flex items-center justify-center text-xs text-gray-500">로딩…</div>
  if (!data.length) return <div className="h-20 flex items-center justify-center text-xs text-gray-500">성과 데이터 없음</div>

  const min = Math.min(...data.map(d => d.cumulative_pnl))
  const max = Math.max(...data.map(d => d.cumulative_pnl))
  const color = data[data.length - 1]?.cumulative_pnl >= 0 ? '#10b981' : '#ef4444'

  return (
    <ResponsiveContainer width="100%" height={80}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <XAxis dataKey="date" hide />
        <YAxis domain={[min * 1.1 - 1, max * 1.1 + 1]} hide />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 6, fontSize: 11 }}
          formatter={(v: number) => [`${v.toLocaleString()}원`, '누적손익']}
        />
        <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="3 3" />
        <Line type="monotone" dataKey="cumulative_pnl" stroke={color} strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ─── 모델 카드 ──────────────────────────────────────────
function ModelCard({ model, onToggle }: { model: Model; onToggle: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`bg-gray-900 rounded-xl border transition-colors ${model.is_active ? 'border-gray-700' : 'border-gray-800 opacity-60'}`}>
      {/* 카드 헤더 */}
      <div className="p-4 flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 bg-blue-900/40 rounded-lg flex items-center justify-center">
          <span className="text-xs font-bold text-blue-300">{model.model_id}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{model.model_name}</span>
            <TypeBadge type={model.model_type} />
            <span className="text-xs text-gray-500">{STYLE_LABELS[model.trade_style] ?? model.trade_style}</span>
          </div>
          <p className="text-xs text-gray-400 mt-1 line-clamp-2">{model.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-500">w={model.weight.toFixed(1)}</span>
          <button onClick={() => onToggle(model.model_id)} className="text-gray-400 hover:text-white">
            {model.is_active
              ? <ToggleRight size={20} className="text-blue-400" />
              : <ToggleLeft  size={20} />}
          </button>
          <button onClick={() => setExpanded(e => !e)} className="text-gray-500 hover:text-gray-300">
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      {/* 지표 행 */}
      <div className="grid grid-cols-4 gap-0 border-t border-gray-800 divide-x divide-gray-800 text-center">
        {[
          { label: '승률',     value: model.win_rate      != null ? `${(model.win_rate * 100).toFixed(1)}%` : '-' },
          { label: '수익팩터', value: model.profit_factor  != null ? model.profit_factor.toFixed(2)           : '-' },
          { label: '샤프',     value: model.sharpe_ratio   != null ? model.sharpe_ratio.toFixed(2)            : '-' },
          { label: '신호수',   value: model.total_signals  != null ? `${model.total_signals}건`               : '-' },
        ].map(({ label, value }) => (
          <div key={label} className="py-2">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="text-sm font-medium">{value}</div>
          </div>
        ))}
      </div>

      {/* 확장 영역 */}
      {expanded && (
        <div className="border-t border-gray-800 p-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={13} className="text-emerald-400" />
              <h3 className="text-xs font-semibold text-gray-300">30일 누적 PnL</h3>
            </div>
            <MiniPnlChart modelId={model.model_id} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 종목 선정 기준 패널 ─────────────────────────────────
function SelectionCriteriaPanel() {
  const [open, setOpen] = useState(false)

  const weights = [
    { label: 'AI 모델 점수',     pct: 35, icon: BrainCircuit, color: 'text-blue-400',   bar: 'bg-blue-500',   desc: '활성 모델(M1·M4·M5·M9) 가중 앙상블 — 기술적 지표·거래량·ML 종합' },
    { label: '외국인/기관 수급', pct: 25, icon: BarChart2,    color: 'text-green-400',  bar: 'bg-green-500',  desc: '외국인·기관 순매수(역지표: 개인) + 5일 지속성·가속도 분석' },
    { label: '시장 상황',        pct: 15, icon: Globe,         color: 'text-cyan-400',   bar: 'bg-cyan-500',   desc: '장 시간대·변동성·거래일 여부 보정' },
    { label: '뉴스 감성',        pct: 15, icon: Newspaper,     color: 'text-yellow-400', bar: 'bg-yellow-500', desc: '최근 24h 뉴스 감성 분석 (감성점수 < 0.3이면 매수 자동 차단)' },
    { label: 'DART 공시',        pct: 10, icon: FileText,      color: 'text-purple-400', bar: 'bg-purple-500', desc: '최근 7일 공시 내용 분석 — 호재/악재 판단' },
  ]

  const sources = [
    { icon: Zap,      color: 'text-cyan-400',  label: '섹터 스크리닝 BUY 종목', desc: '매크로 탭 → 섹터 스크리닝에서 최근 4시간 이내 BUY 신호를 받은 종목 (상위 50개)' },
    { icon: Database, color: 'text-green-400', label: '워치리스트 종목',        desc: '전략 탭 → 관심 종목에 추가된 활성 종목' },
  ]

  const conditions = [
    '종합점수 ≥ 매수 임계값 (기본 0.55 — config/model_weights.yaml에서 조정)',
    '뉴스 악재 없음 (감성점수 < 0.30이면 자동 차단)',
    '동일 종목 미보유 (중복 매수 방지)',
    '현재가 > 0 (가격 조회 성공)',
    '1주 가격 ≤ 예수금 (예수금 부족 시 자동 SKIP)',
    '종목 단가 상한 이하 (전략 탭에서 설정 가능)',
    '최대 보유 종목 수 미초과 (전략 탭에서 설정)',
  ]

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          <Info size={14} className="text-blue-400" />
          종목 선정 기준 — AI가 어떻게 종목을 고르나요?
        </span>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {open && (
        <div className="border-t border-gray-800 px-4 pb-5 pt-4 space-y-5">

          {/* Step 1: 후보 수집 */}
          <div>
            <h4 className="text-xs font-bold text-gray-300 mb-2 flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center shrink-0">1</span>
              후보 종목 수집 (2가지 소스)
            </h4>
            <div className="space-y-2">
              {sources.map(({ icon: Icon, color, label, desc }) => (
                <div key={label} className="flex items-start gap-3 bg-gray-800/50 rounded-lg px-3 py-2">
                  <Icon size={13} className={`${color} shrink-0 mt-0.5`} />
                  <div>
                    <div className="text-xs font-medium text-gray-200">{label}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Step 2: 종합 점수 */}
          <div>
            <h4 className="text-xs font-bold text-gray-300 mb-2 flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center shrink-0">2</span>
              종합 점수 계산 (0 ~ 1점)
            </h4>
            <div className="space-y-2">
              {weights.map(({ label, pct, icon: Icon, color, bar, desc }) => (
                <div key={label}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="flex items-center gap-1.5 text-xs text-gray-300">
                      <Icon size={11} className={color} />{label}
                    </span>
                    <span className={`text-xs font-bold ${color}`}>{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mb-0.5">
                    <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[10px] text-gray-600">{desc}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 p-2.5 bg-blue-950/30 border border-blue-900/40 rounded-lg text-[11px] text-blue-300">
              종합점수 = (AI모델×0.35) + (수급×0.25) + (시장×0.15) + (뉴스×0.15) + (공시×0.10)
            </div>
          </div>

          {/* Step 3: 매수 실행 조건 */}
          <div>
            <h4 className="text-xs font-bold text-gray-300 mb-2 flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center shrink-0">3</span>
              매수 실행 조건 (모두 충족해야 주문)
            </h4>
            <div className="space-y-1.5">
              {conditions.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-gray-400">
                  <span className="text-green-400 shrink-0 mt-0.5">✓</span>{c}
                </div>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-gray-600 border-t border-gray-800 pt-3">
            ※ 5분마다 위 과정이 자동 실행됩니다. 후보 종목은 매크로 섹터 스크리닝에서 자동 공급되며, 수동 지정 없이 AI가 실시간으로 선정합니다.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 메인 ───────────────────────────────────────────────
export default function Models() {
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getModels()
      setModels(r.models ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(0, load)

  const handleToggle = async (modelId: string) => {
    await toggleModel(modelId)
    setModels(prev => prev.map(m =>
      m.model_id === modelId ? { ...m, is_active: !m.is_active } : m
    ))
  }

  const filtered = filter === 'all' ? models : models.filter(m => m.model_type === filter)
  const types = ['all', 'technical', 'ml', 'ensemble']
  const activeCount = models.filter(m => m.is_active).length

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <BrainCircuit size={20} className="text-blue-400" />
            AI 모델 관리
          </h1>
          <p className="text-xs text-gray-500">
            {models.length}개 모델 중 {activeCount}개 활성 · 펼쳐서 종목/성과 확인
          </p>
        </div>
        <RefreshTimer
          secondsLeft={secondsLeft}
          intervalSec={0}
          lastRefreshed={lastRefreshed}
          isRefreshing={timerBusy || loading}
          onRefresh={timerRefresh}
          serverLabel="서버 5분"
        />
      </div>

      {/* 종목 선정 기준 */}
      <SelectionCriteriaPanel />

      {/* 필터 */}
      <div className="flex gap-1.5 flex-wrap">
        {types.map(t => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === t ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {t === 'all' ? `전체 (${models.length})` : t}
          </button>
        ))}
      </div>

      {/* 모델 카드 */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">로딩 중…</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {filtered.map(m => (
            <ModelCard key={m.model_id} model={m} onToggle={handleToggle} />
          ))}
        </div>
      )}

      {/* 앙상블 가중치 요약 */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <h2 className="text-sm font-semibold mb-2">앙상블 가중치 (M10 계산 기준)</h2>
        <div className="flex gap-2 flex-wrap">
          {models.map(m => (
            <div key={m.model_id}
              className={`text-xs px-2 py-1 rounded ${m.is_active ? 'bg-blue-900/40 text-blue-300' : 'bg-gray-800 text-gray-500'}`}>
              {m.model_id} w={m.weight.toFixed(1)}
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          M10은 활성 모델(M1·M4·M5·M9) 가중 평균 ≥ 0.55이면 BUY, ≤ 0.45이면 SELL (단일 임계값 — config/model_weights.yaml에서 조정)
        </p>
      </div>
    </div>
  )
}
