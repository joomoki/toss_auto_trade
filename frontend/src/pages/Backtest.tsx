import { useEffect, useRef, useState, useCallback } from 'react'
import { runBacktest, listBacktests, getBacktest, deleteBacktest } from '../api/client'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell
} from 'recharts'
import { Play, Trash2, ChevronDown, ChevronUp, RefreshCw, Info, TrendingUp, ShieldAlert, BarChart3, Trophy } from 'lucide-react'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

// ── 타입 ───────────────────────────────────────────────
interface BacktestSummary {
  total_return_pct: number
  cagr_pct: number
  max_drawdown_pct: number
  sharpe_ratio: number
  win_rate: number
  profit_factor: number
  total_trades: number
  win_trades: number
  lose_trades: number
  final_capital: number
}

interface BacktestRun {
  id: number
  name: string
  stock_codes: string[]
  start_date: string
  end_date: string
  initial_capital: number
  status: 'RUNNING' | 'DONE' | 'FAILED'
  created_at: string
  summary: BacktestSummary | null
  equity_curve?: { date: string; value: number; cash: number; invested: number }[]
  trade_log?: { date: string; stock_code: string; type: string; price: number; qty: number; amount: number; pnl: number; pnl_pct: number }[]
  error_msg?: string
}

interface FormState {
  name: string
  stock_codes: string
  start_date: string
  end_date: string
  initial_capital: number
  buy_threshold: number
  sell_threshold: number
  stop_loss_pct: number
  take_profit_pct: number
  max_position_amt: number
  max_holdings: number
}

// ── 헬퍼 ───────────────────────────────────────────────
const fmtKRW = (v: number) => `${v.toLocaleString()}원`
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const color = (v: number) => v >= 0 ? 'text-green-400' : 'text-red-400'

function MetricCard({ label, value, sub, highlight, tip }: {
  label: string; value: string; sub?: string
  highlight?: 'good' | 'bad' | 'neutral'; tip?: string
}) {
  const cls = highlight === 'good' ? 'text-green-400' : highlight === 'bad' ? 'text-red-400' : 'text-blue-400'
  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="flex items-center gap-1 mb-1">
        <p className="text-xs text-gray-400">{label}</p>
        {tip && (
          <span title={tip} className="text-gray-600 hover:text-gray-400 cursor-help">
            <Info size={10} />
          </span>
        )}
      </div>
      <p className={`text-xl font-bold ${cls}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── 기능 안내 배너 ──────────────────────────────────────
function HowItWorks() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-blue-950/30 border border-blue-900/50 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-blue-900/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info size={14} className="text-blue-400" />
          <span className="text-sm font-semibold text-blue-300">백테스트란? — 작동 방식 안내</span>
        </div>
        {open ? <ChevronUp size={14} className="text-blue-400" /> : <ChevronDown size={14} className="text-blue-400" />}
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-blue-900/40">
          <p className="text-xs text-blue-200/70 pt-3 leading-relaxed">
            과거 주가 데이터에 현재 자동매매 전략(M1~M10 AI 모델)을 적용해 <strong className="text-blue-300">실제 돈을 쓰지 않고</strong> 수익률·리스크를 미리 검증하는 도구입니다.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              {
                icon: <BarChart3 size={14} className="text-blue-400" />,
                title: '시뮬레이션 방식',
                desc: '지정 기간의 과거 일봉 데이터를 날짜 순으로 재생. 매 거래일마다 M1~M10 모델이 매수 신호를 계산하고, 임계값 이상이면 가상 매수합니다.',
              },
              {
                icon: <ShieldAlert size={14} className="text-yellow-400" />,
                title: '손절·익절 자동 적용',
                desc: '설정한 손절(%) 도달 시 즉시 매도, 익절(%) 도달 시 이익 실현. 종료일에 남은 포지션은 전량 청산하여 최종 수익을 계산합니다.',
              },
              {
                icon: <TrendingUp size={14} className="text-green-400" />,
                title: '수수료 반영',
                desc: '매매 건마다 편도 0.015% 수수료가 자동 차감됩니다. 실제 키움증권 온라인 수수료 수준입니다.',
              },
              {
                icon: <Trophy size={14} className="text-yellow-400" />,
                title: '성과 지표',
                desc: '총 수익률, CAGR(연복리), MDD(최대 낙폭), Sharpe Ratio, 승률, 수익팩터를 자동 계산해 전략 품질을 다각도로 평가합니다.',
              },
            ].map(item => (
              <div key={item.title} className="flex gap-2.5 bg-blue-900/20 rounded-lg p-3">
                <div className="mt-0.5 shrink-0">{item.icon}</div>
                <div>
                  <p className="text-xs font-semibold text-blue-200 mb-0.5">{item.title}</p>
                  <p className="text-[11px] text-blue-200/60 leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="bg-yellow-900/20 border border-yellow-800/40 rounded-lg px-3 py-2">
            <p className="text-[11px] text-yellow-300/80 leading-relaxed">
              ⚠️ <strong>과최적화 주의</strong> — 백테스트 결과가 좋다고 실전에서도 동일하게 동작한다는 보장은 없습니다.
              과거 수익률은 미래 수익률을 보장하지 않으며, 단기·소수 종목 테스트는 결과가 왜곡될 수 있습니다.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 파라미터 설명 툴팁 ──────────────────────────────────
const PARAM_TIPS: Record<string, string> = {
  buy_threshold:    '0~1 사이 값. M1~M10 모델 종합 점수가 이 값 이상일 때만 매수. 높을수록 신중하게 매수 (기본 0.60)',
  sell_threshold:   '현재 미사용 (손절/익절로 매도 결정). 추후 확장용',
  stop_loss_pct:    '매수가 대비 이 비율만큼 하락하면 즉시 손절 매도 (기본 3%)',
  take_profit_pct:  '매수가 대비 이 비율만큼 상승하면 익절 매도 (기본 5%)',
  max_position_amt: '종목 하나에 투입할 최대 금액. 초기 자본의 10~20% 수준 권장',
  max_holdings:     '동시에 보유할 수 있는 최대 종목 수. 초기 자본 ÷ 종목당 투자금과 맞추세요',
  initial_capital:  '시뮬레이션 시작 자본금 (원). 실제 예수금과 맞추면 현실적인 결과 확인 가능',
}

// ── 폼 기본값 ───────────────────────────────────────────
const oneYearAgo = () => {
  const d = new Date(); d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 10)
}
const today = () => new Date().toISOString().slice(0, 10)

const DEFAULT_FORM: FormState = {
  name: '백테스트',
  stock_codes: '005930,000660,035720',
  start_date: oneYearAgo(),
  end_date: today(),
  initial_capital: 10_000_000,
  buy_threshold: 0.6,
  sell_threshold: 0.6,
  stop_loss_pct: 3.0,
  take_profit_pct: 5.0,
  max_position_amt: 1_000_000,
  max_holdings: 10,
}

// ── 메인 컴포넌트 ────────────────────────────────────────
export default function Backtest() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [runs, setRuns] = useState<BacktestRun[]>([])
  const [selected, setSelected] = useState<BacktestRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(true)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadList = useCallback(async () => {
    const data = await listBacktests()
    setRuns(data)
  }, [])

  useEffect(() => {
    loadList()
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [loadList])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(0, loadList)

  // RUNNING 상태면 3초마다 폴링
  useEffect(() => {
    const hasRunning = runs.some(r => r.status === 'RUNNING')
    if (hasRunning && !pollingRef.current) {
      pollingRef.current = setInterval(async () => {
        await loadList()
        // 선택된 항목도 갱신
        if (selected?.status === 'RUNNING') {
          const updated = await getBacktest(selected.id)
          setSelected(updated)
        }
      }, 3000)
    } else if (!hasRunning && pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [runs, selected])

  const handleRun = async () => {
    setLoading(true)
    try {
      await runBacktest({
        ...form,
        stock_codes: form.stock_codes.split(',').map(s => s.trim()).filter(Boolean),
      })
      await loadList()
      setFormOpen(false)
    } finally {
      setLoading(false)
    }
  }

  const handleSelect = async (run: BacktestRun) => {
    if (run.status !== 'DONE') { setSelected(run); return }
    const detail = await getBacktest(run.id)
    setSelected(detail)
  }

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    await deleteBacktest(id)
    if (selected?.id === id) setSelected(null)
    await loadList()
  }

  const field = (key: keyof FormState, label: string, type: 'text' | 'number' = 'number', step = 0.01) => (
    <div>
      <div className="flex items-center gap-1 mb-1">
        <label className="text-xs text-gray-400">{label}</label>
        {PARAM_TIPS[key] && (
          <span title={PARAM_TIPS[key]} className="text-gray-600 hover:text-gray-400 cursor-help">
            <Info size={10} />
          </span>
        )}
      </div>
      <input
        type={type}
        step={step}
        value={form[key] as string | number}
        onChange={e => setForm(f => ({ ...f, [key]: type === 'number' ? parseFloat(e.target.value) : e.target.value }))}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
      />
    </div>
  )

  const s = selected?.summary

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">가상 트레이딩 (백테스트)</h1>
          <p className="text-xs text-gray-500 mt-0.5">과거 데이터로 M1~M10 AI 모델 전략을 시뮬레이션합니다</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={0}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy}
            onRefresh={timerRefresh}
          />
          <button onClick={() => setFormOpen(v => !v)} className="flex items-center gap-1 text-sm text-gray-400 hover:text-white">
            {formOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {formOpen ? '접기' : '새 백테스트'}
          </button>
        </div>
      </div>

      <HowItWorks />

      {/* ── 설정 폼 ── */}
      {formOpen && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
          <h2 className="font-semibold text-sm text-gray-300">백테스트 설정</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs text-gray-400 mb-1">이름</label>
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-gray-400 mb-1">종목코드 (쉼표 구분)</label>
              <input type="text" value={form.stock_codes} onChange={e => setForm(f => ({ ...f, stock_codes: e.target.value }))}
                placeholder="005930,000660,035720"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">시작일</label>
              <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">종료일</label>
              <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
            {field('initial_capital', '초기 자본 (원)', 'number', 100000)}
            {field('max_position_amt', '종목당 최대 투자금 (원)', 'number', 100000)}
            {field('buy_threshold', '매수 임계값', 'number', 0.01)}
            {field('sell_threshold', '매도 임계값', 'number', 0.01)}
            {field('stop_loss_pct', '손절 (%)', 'number', 0.1)}
            {field('take_profit_pct', '익절 (%)', 'number', 0.1)}
            {field('max_holdings', '최대 보유 종목 수', 'number', 1)}
          </div>
          <button
            onClick={handleRun}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            <Play size={14} />
            {loading ? '시작 중...' : '백테스트 실행'}
          </button>
        </div>
      )}

      {/* ── 이력 목록 + 결과 ── */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* 목록 */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-sm">실행 이력</h2>
            <button onClick={loadList} className="text-gray-500 hover:text-white"><RefreshCw size={14} /></button>
          </div>
          {runs.length === 0 && <p className="text-sm text-gray-500 text-center py-4">실행 이력 없음</p>}
          {runs.map(run => (
            <div
              key={run.id}
              onClick={() => handleSelect(run)}
              className={`flex items-center justify-between p-3 rounded-lg cursor-pointer border transition-colors ${
                selected?.id === run.id ? 'border-blue-500 bg-blue-950/30' : 'border-gray-800 hover:border-gray-600'
              }`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{run.name}</p>
                <p className="text-xs text-gray-500">{run.start_date} ~ {run.end_date}</p>
                {run.status === 'DONE' && run.summary && (
                  <p className={`text-xs font-semibold ${color(run.summary.total_return_pct)}`}>
                    {fmtPct(run.summary.total_return_pct)}
                  </p>
                )}
                {run.status === 'RUNNING' && <p className="text-xs text-yellow-400 animate-pulse">실행 중...</p>}
                {run.status === 'FAILED' && <p className="text-xs text-red-400">실패</p>}
              </div>
              <button onClick={e => handleDelete(run.id, e)} className="ml-2 text-gray-600 hover:text-red-400 shrink-0">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* 결과 */}
        <div className="lg:col-span-2 space-y-4">
          {!selected && (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center text-gray-500">
              왼쪽에서 백테스트를 선택하세요
            </div>
          )}

          {selected?.status === 'RUNNING' && (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center">
              <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-gray-400 text-sm">백테스트 실행 중... (자동으로 갱신됩니다)</p>
            </div>
          )}

          {selected?.status === 'FAILED' && (
            <div className="bg-gray-900 rounded-xl border border-red-800 p-6">
              <p className="text-red-400 font-semibold">실행 실패</p>
              <p className="text-sm text-gray-400 mt-1">{selected.error_msg}</p>
            </div>
          )}

          {selected?.status === 'DONE' && s && (
            <>
              {/* 성과 지표 */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <MetricCard label="총 수익률" value={fmtPct(s.total_return_pct)} highlight={s.total_return_pct >= 0 ? 'good' : 'bad'} sub={`최종 ${fmtKRW(s.final_capital)}`}
                  tip="기간 전체의 수익률. (최종 자본 - 초기 자본) / 초기 자본 × 100" />
                <MetricCard label="연평균 수익률 (CAGR)" value={fmtPct(s.cagr_pct)} highlight={s.cagr_pct >= 0 ? 'good' : 'bad'}
                  tip="복리 기준으로 환산한 연간 수익률. 기간이 다른 전략과 공정하게 비교할 때 사용" />
                <MetricCard label="최대 낙폭 (MDD)" value={`-${s.max_drawdown_pct.toFixed(2)}%`} highlight="bad"
                  tip="고점 대비 최대 손실 폭. 낮을수록 하락 리스크가 작음. 20% 이하면 양호" />
                <MetricCard label="Sharpe Ratio" value={s.sharpe_ratio.toFixed(2)} highlight={s.sharpe_ratio >= 1 ? 'good' : 'neutral'} sub="≥1.0 양호"
                  tip="수익 대비 위험 효율. (수익률 - 무위험금리 2.5%) / 변동성. 1 이상이면 리스크 대비 충분한 수익" />
                <MetricCard label="승률" value={`${s.win_rate.toFixed(1)}%`} highlight={s.win_rate >= 50 ? 'good' : 'bad'} sub={`${s.win_trades}승 ${s.lose_trades}패`}
                  tip="전체 매도 중 수익 실현 비율. 단, 수익팩터와 함께 봐야 함 (낮은 승률 + 높은 수익팩터도 좋은 전략)" />
                <MetricCard label="수익팩터" value={s.profit_factor >= 999 ? '∞' : s.profit_factor.toFixed(2)} highlight={s.profit_factor >= 1.5 ? 'good' : 'neutral'} sub="≥1.5 양호"
                  tip="총 이익 ÷ 총 손실. 1.0 = 손익 동일, 1.5 이상이면 손실보다 수익이 충분히 큼" />
              </div>

              {/* 자산 곡선 */}
              {selected.equity_curve && selected.equity_curve.length > 0 && (
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <h3 className="text-sm font-semibold mb-3">자산 곡선</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={selected.equity_curve}>
                      <defs>
                        <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
                      <XAxis dataKey="date" tick={{ fill: '#6B7280', fontSize: 10 }} tickFormatter={d => d.slice(5)} />
                      <YAxis tickFormatter={v => `${(v / 10000).toFixed(0)}만`} tick={{ fill: '#6B7280', fontSize: 10 }} width={55} />
                      <Tooltip
                        formatter={(v: number) => [fmtKRW(v)]}
                        labelStyle={{ color: '#9CA3AF' }}
                        contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', fontSize: 12 }}
                      />
                      <ReferenceLine y={selected.initial_capital} stroke="#6B7280" strokeDasharray="4 4" />
                      <Area type="monotone" dataKey="value" stroke="#3B82F6" fill="url(#equityGrad)" strokeWidth={2} dot={false} name="평가금액" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* 거래별 손익 바 차트 */}
              {selected.trade_log && selected.trade_log.filter(t => t.type.startsWith('SELL')).length > 0 && (
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <h3 className="text-sm font-semibold mb-3">매도 손익 분포</h3>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={selected.trade_log.filter(t => t.type.startsWith('SELL'))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
                      <XAxis dataKey="date" tick={{ fill: '#6B7280', fontSize: 10 }} tickFormatter={d => d.slice(5)} />
                      <YAxis tickFormatter={v => `${(v / 10000).toFixed(0)}만`} tick={{ fill: '#6B7280', fontSize: 10 }} width={45} />
                      <Tooltip formatter={(v: number) => [fmtKRW(v), '손익']} contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', fontSize: 12 }} />
                      <Bar dataKey="pnl" radius={[3, 3, 0, 0]} name="손익">
                        {selected.trade_log.filter(t => t.type.startsWith('SELL')).map((t, i) => (
                          <Cell key={i} fill={t.pnl >= 0 ? '#22C55E' : '#EF4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* 거래 로그 */}
              {selected.trade_log && (
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <h3 className="text-sm font-semibold mb-3">거래 로그 ({selected.trade_log.length}건)</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-400 border-b border-gray-700">
                          <th className="pb-2 text-left">날짜</th>
                          <th className="pb-2 text-left">종목</th>
                          <th className="pb-2 text-left">구분</th>
                          <th className="pb-2 text-right">가격</th>
                          <th className="pb-2 text-right">수량</th>
                          <th className="pb-2 text-right">손익</th>
                          <th className="pb-2 text-right">수익률</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.trade_log.slice(0, 100).map((t, i) => (
                          <tr key={i} className="border-b border-gray-800">
                            <td className="py-1.5 text-gray-400">{t.date}</td>
                            <td className="py-1.5">{t.stock_code}</td>
                            <td className={`py-1.5 font-medium ${t.type === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{t.type}</td>
                            <td className="py-1.5 text-right">{t.price.toLocaleString()}</td>
                            <td className="py-1.5 text-right">{t.qty}</td>
                            <td className={`py-1.5 text-right font-medium ${t.pnl >= 0 ? 'text-green-400' : t.pnl < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                              {t.pnl !== 0 ? fmtKRW(t.pnl) : '-'}
                            </td>
                            <td className={`py-1.5 text-right ${t.pnl_pct >= 0 ? 'text-green-400' : t.pnl_pct < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                              {t.pnl_pct !== 0 ? fmtPct(t.pnl_pct) : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {selected.trade_log.length > 100 && (
                      <p className="text-xs text-gray-500 mt-2 text-center">처음 100건만 표시 (전체 {selected.trade_log.length}건)</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
