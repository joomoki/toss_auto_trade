import { useEffect, useState, useCallback } from 'react'
import {
  getModelPortfolioAll, getModelPortfolioSummary,
  addModelPortfolioStock, deleteModelPortfolioStock,
  refreshModelPortfolioPrices, patchModelPortfolioStock,
  getModelHitRate, saveModelWeights,
} from '../api/client'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimerComp from '../components/common/RefreshTimer'
import {
  RefreshCw, Plus, Trash2, TrendingUp, TrendingDown,
  BarChart3, ChevronDown, ChevronUp, Pencil, Check, X,
  Target, Save, Zap,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell, RadialBarChart, RadialBar,
} from 'recharts'

// ── 모델 설명 ────────────────────────────────────────────
const MODEL_DESC: Record<string, string> = {
  M1: '이동평균 골든크로스', M2: 'RSI 과매도 반등',   M3: 'MACD 상향 전환',
  M4: '볼린저밴드 반등',    M5: '거래량 급증 돌파',   M6: '스토캐스틱 크로스',
  M7: 'ADX 추세 강도',     M8: '캔들 패턴 신호',     M9: '지지선 돌파',
  M10: '앙상블 종합',
}

// ── 타입 ────────────────────────────────────────────────
interface ModelHitStat {
  model_id: string
  signal_count: number
  completed_count: number
  win_count: number
  loss_count: number
  pending_count: number
  hit_rate: number | null
  total_pnl: number
  avg_pnl: number | null
  suggested_weight: number
}

interface PortfolioStock {
  id: number
  model_id: string
  stock_code: string
  stock_name: string
  buy_date: string
  buy_price: number
  quantity: number
  buy_amount: number
  current_price: number | null
  return_pct: number | null
  return_amt: number | null
  is_active: boolean
  memo: string | null
}

interface ModelSummary {
  model_id: string
  stock_count: number
  avg_return_pct: number | null
  total_return_amt: number
  total_buy_amt: number
  best_stock: PortfolioStock | null
  worst_stock: PortfolioStock | null
}

// ── 유틸 ────────────────────────────────────────────────
function fmtPct(v: number | null) {
  if (v == null) return '-'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}
function fmtAmt(v: number | null) {
  if (v == null) return '-'
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}백만`
  if (Math.abs(v) >= 10_000)    return `${(v / 10_000).toFixed(0)}만`
  return v.toLocaleString()
}
function colorPct(v: number | null) {
  if (v == null) return 'text-gray-400'
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-300'
}

// ── 종목 추가 폼 ─────────────────────────────────────────
function AddForm({ modelId, onAdded }: { modelId: string; onAdded: () => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({ stock_code: '', stock_name: '', buy_date: today, buy_price: '', quantity: '1' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.stock_code || !form.buy_price) { setErr('종목코드·매수가 필수'); return }
    setSaving(true); setErr('')
    try {
      await addModelPortfolioStock({
        model_id: modelId,
        stock_code: form.stock_code.trim(),
        stock_name: form.stock_name || undefined,
        buy_date: form.buy_date,
        buy_price: parseInt(form.buy_price),
        quantity: parseInt(form.quantity) || 1,
      })
      setForm({ stock_code: '', stock_name: '', buy_date: today, buy_price: '', quantity: '1' })
      onAdded()
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? '추가 실패')
    } finally { setSaving(false) }
  }

  return (
    <div className="bg-gray-800 rounded-xl p-3 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <input value={form.stock_code} onChange={e => set('stock_code', e.target.value)}
          placeholder="종목코드 *" maxLength={6}
          className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
        <input value={form.stock_name} onChange={e => set('stock_name', e.target.value)}
          placeholder="종목명 (선택)"
          className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
        <input type="date" value={form.buy_date} onChange={e => set('buy_date', e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
        <input value={form.buy_price} onChange={e => set('buy_price', e.target.value)}
          placeholder="매수가 (원) *" type="number"
          className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
        <input value={form.quantity} onChange={e => set('quantity', e.target.value)}
          placeholder="수량" type="number" min="1"
          className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <button onClick={submit} disabled={saving}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-medium">
        <Plus size={12} />{saving ? '추가중…' : '종목 추가'}
      </button>
    </div>
  )
}

// ── 인라인 편집 행 ───────────────────────────────────────
function StockRow({ stock, onDeleted, onPatched }: {
  stock: PortfolioStock
  onDeleted: (id: number) => void
  onPatched: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [buyPrice, setBuyPrice] = useState(String(stock.buy_price))
  const [qty, setQty] = useState(String(stock.quantity))
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await patchModelPortfolioStock(stock.id, {
        buy_price: parseInt(buyPrice) || stock.buy_price,
        quantity: parseInt(qty) || stock.quantity,
      })
      setEditing(false)
      onPatched()
    } finally { setSaving(false) }
  }

  const del = async () => {
    if (!confirm(`${stock.stock_name} 삭제하시겠습니까?`)) return
    await deleteModelPortfolioStock(stock.id)
    onDeleted(stock.id)
  }

  return (
    <tr className="border-t border-gray-800 hover:bg-gray-800/50 transition-colors">
      <td className="py-2.5 px-3">
        <div className="font-medium text-sm">{stock.stock_name}</div>
        <div className="text-xs text-gray-500">{stock.stock_code}</div>
      </td>
      <td className="py-2.5 px-3 text-sm text-gray-300">{stock.buy_date}</td>
      <td className="py-2.5 px-3">
        {editing ? (
          <input value={buyPrice} onChange={e => setBuyPrice(e.target.value)} type="number"
            className="w-24 bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs" />
        ) : (
          <span className="text-sm">{stock.buy_price.toLocaleString()}원</span>
        )}
      </td>
      <td className="py-2.5 px-3">
        {editing ? (
          <input value={qty} onChange={e => setQty(e.target.value)} type="number" min="1"
            className="w-16 bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs" />
        ) : (
          <span className="text-sm">{stock.quantity}주</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-sm text-gray-400">
        {stock.current_price ? stock.current_price.toLocaleString() + '원' : '-'}
      </td>
      <td className={`py-2.5 px-3 text-sm font-bold ${colorPct(stock.return_pct)}`}>
        {fmtPct(stock.return_pct)}
      </td>
      <td className={`py-2.5 px-3 text-sm ${colorPct(stock.return_amt)}`}>
        {fmtAmt(stock.return_amt)}원
      </td>
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1.5">
          {editing ? (
            <>
              <button onClick={save} disabled={saving} className="text-emerald-400 hover:text-emerald-300">
                <Check size={14} />
              </button>
              <button onClick={() => setEditing(false)} className="text-gray-500 hover:text-gray-300">
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} className="text-gray-500 hover:text-blue-400">
                <Pencil size={13} />
              </button>
              <button onClick={del} className="text-gray-500 hover:text-red-400">
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── 모델 패널 ────────────────────────────────────────────
function ModelPanel({ modelId, stocks, onChanged }: {
  modelId: string
  stocks: PortfolioStock[]
  onChanged: () => void
}) {
  const [open, setOpen] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  const active = stocks.filter(s => s.is_active)
  const priced = active.filter(s => s.return_pct != null)
  const avgRet = priced.length ? priced.reduce((a, s) => a + (s.return_pct ?? 0), 0) / priced.length : null
  const totalBuy = active.reduce((a, s) => a + s.buy_amount, 0)
  const totalRet = active.reduce((a, s) => a + (s.return_amt ?? 0), 0)

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-900/50 rounded-lg flex items-center justify-center">
            <span className="text-xs font-bold text-blue-300">{modelId}</span>
          </div>
          <div>
            <span className="font-semibold text-sm">{modelId} 포트폴리오</span>
            <span className="text-xs text-gray-500 ml-2">{active.length}종목</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <div className={`text-sm font-bold ${colorPct(avgRet)}`}>{fmtPct(avgRet)}</div>
            <div className="text-xs text-gray-500">평균 수익률</div>
          </div>
          <div className={`text-sm font-bold hidden sm:block ${colorPct(totalRet)}`}>
            {totalRet >= 0 ? '+' : ''}{fmtAmt(totalRet)}원
          </div>
          {open ? <ChevronUp size={15} className="text-gray-500" /> : <ChevronDown size={15} className="text-gray-500" />}
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-800">
          {/* 종목 테이블 */}
          {stocks.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-800">
                    <th className="py-2 px-3">종목</th>
                    <th className="py-2 px-3">매수일</th>
                    <th className="py-2 px-3">매수가</th>
                    <th className="py-2 px-3">수량</th>
                    <th className="py-2 px-3">현재가</th>
                    <th className="py-2 px-3">수익률</th>
                    <th className="py-2 px-3">평가손익</th>
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.map(s => (
                    <StockRow key={s.id} stock={s}
                      onDeleted={_id => onChanged()}
                      onPatched={onChanged}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-700 bg-gray-800/30 text-xs text-gray-400">
                    <td className="py-2 px-3 font-medium" colSpan={4}>합계 (투자금 {fmtAmt(totalBuy)}원)</td>
                    <td className="py-2 px-3" />
                    <td className={`py-2 px-3 font-bold ${colorPct(avgRet)}`}>{fmtPct(avgRet)}</td>
                    <td className={`py-2 px-3 font-bold ${colorPct(totalRet)}`}>
                      {totalRet >= 0 ? '+' : ''}{fmtAmt(totalRet)}원
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-6">등록된 종목 없음</p>
          )}

          {/* 추가 폼 */}
          <div className="p-3 border-t border-gray-800">
            {showAdd ? (
              <AddForm modelId={modelId} onAdded={() => { setShowAdd(false); onChanged() }} />
            ) : (
              <button onClick={() => setShowAdd(true)}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-400">
                <Plus size={12} /> 종목 추가
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 적중률 게이지 ────────────────────────────────────────
function HitGauge({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-xs text-gray-500">데이터 없음</span>
  const pct = Math.round(rate * 100)
  const color = pct >= 60 ? '#10b981' : pct >= 45 ? '#f59e0b' : '#ef4444'
  const data = [{ value: pct, fill: color }]
  return (
    <div className="flex items-center gap-2">
      <div style={{ width: 52, height: 52 }}>
        <RadialBarChart width={52} height={52} cx={26} cy={26} innerRadius={18} outerRadius={26}
          startAngle={90} endAngle={-270} data={data}>
          <RadialBar dataKey="value" cornerRadius={4} background={{ fill: '#374151' }} />
        </RadialBarChart>
      </div>
      <div>
        <div className="text-lg font-bold" style={{ color }}>{pct}%</div>
        <div className="text-xs text-gray-500">적중률</div>
      </div>
    </div>
  )
}

// ── 적중률 분석 탭 ───────────────────────────────────────
function HitRateSection() {
  const [stats, setStats] = useState<ModelHitStat[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [weights, setWeights] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const MODEL_IDS = ['M1','M2','M3','M4','M5','M6','M7','M8','M9','M10']

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getModelHitRate(days)
      setStats(data.models ?? [])
      // 가중치 초기값: 저장된 값 없으면 suggested_weight
      setWeights(prev => {
        const next: Record<string, number> = {}
        for (const m of (data.models ?? []) as ModelHitStat[]) {
          next[m.model_id] = prev[m.model_id] ?? m.suggested_weight
        }
        return next
      })
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { load() }, [load])

  const applySuggested = () => {
    const next: Record<string, number> = {}
    for (const m of stats) next[m.model_id] = m.suggested_weight
    setWeights(next)
  }

  const handleSave = async () => {
    setSaving(true); setSaveMsg(null)
    try {
      await saveModelWeights(weights)
      setSaveMsg('가중치가 저장되었습니다. 다음 매매 사이클부터 반영됩니다.')
    } catch {
      setSaveMsg('저장 실패')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 5000)
    }
  }

  const totalSignals = stats.reduce((a, m) => a + m.signal_count, 0)
  const totalCompleted = stats.reduce((a, m) => a + m.completed_count, 0)
  const totalPnl = stats.reduce((a, m) => a + m.total_pnl, 0) / Math.max(stats.filter(m => m.signal_count > 0).length, 1)
  const avgHitRate = (() => {
    const withData = stats.filter(m => m.hit_rate !== null)
    return withData.length ? withData.reduce((a, m) => a + (m.hit_rate ?? 0), 0) / withData.length : null
  })()

  return (
    <div className="space-y-4">
      {/* 기간 선택 + 요약 KPI */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${days === d ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {d}일
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">최근 {days}일 자동매매 체결 기반 분석</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: '총 매수 신호', value: `${totalSignals}건` },
          { label: '완료된 거래', value: `${totalCompleted}건` },
          { label: '평균 적중률', value: avgHitRate !== null ? `${(avgHitRate * 100).toFixed(1)}%` : '-' },
          { label: '평균 손익/모델', value: `${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}원` },
        ].map(k => (
          <div key={k.label} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <div className="text-xs text-gray-400 mb-1">{k.label}</div>
            <div className="text-xl font-bold">{k.value}</div>
          </div>
        ))}
      </div>

      {/* 모델 카드 그리드 */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">분석 중…</div>
      ) : totalSignals === 0 ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center">
          <Target size={32} className="mx-auto text-gray-600 mb-3" />
          <p className="text-sm text-gray-400">아직 자동매매 체결 데이터가 없습니다.</p>
          <p className="text-xs text-gray-600 mt-1">자동매매가 실행되고 매도가 발생하면 적중률이 계산됩니다.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {stats.map(m => {
            const completed = m.completed_count
            const hasData = completed > 0
            const hitPct = m.hit_rate !== null ? Math.round(m.hit_rate * 100) : null
            const pnlColor = m.total_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'
            return (
              <div key={m.model_id} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="w-10 h-10 bg-blue-900/50 rounded-lg flex items-center justify-center text-xs font-bold text-blue-300">
                        {m.model_id}
                      </span>
                      <div>
                        <div className="text-sm font-semibold">{MODEL_DESC[m.model_id]}</div>
                        <div className="text-xs text-gray-500">신호 {m.signal_count}건 · 완료 {completed}건 · 미결 {m.pending_count}건</div>
                      </div>
                    </div>
                  </div>
                  <HitGauge rate={m.hit_rate} />
                </div>

                {/* 승/패 바 */}
                {hasData && (
                  <div className="mb-3">
                    <div className="flex h-2 rounded-full overflow-hidden bg-gray-700">
                      <div className="bg-emerald-500" style={{ width: `${(m.win_count / completed) * 100}%` }} />
                      <div className="bg-red-500" style={{ width: `${(m.loss_count / completed) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                      <span className="text-emerald-400">✓ 수익 {m.win_count}건</span>
                      <span className="text-red-400">✗ 손실 {m.loss_count}건</span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between text-sm">
                  <div>
                    <span className="text-gray-400 text-xs">누적손익 </span>
                    <span className={`font-semibold ${pnlColor}`}>
                      {m.total_pnl >= 0 ? '+' : ''}{Math.round(m.total_pnl).toLocaleString()}원
                    </span>
                  </div>
                  {m.avg_pnl !== null && (
                    <div>
                      <span className="text-gray-400 text-xs">건당 </span>
                      <span className={`font-medium text-xs ${m.avg_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {m.avg_pnl >= 0 ? '+' : ''}{Math.round(m.avg_pnl).toLocaleString()}원
                      </span>
                    </div>
                  )}
                </div>

                {/* 적중률 히스토리 바 */}
                {hitPct !== null && (
                  <div className="mt-3 pt-3 border-t border-gray-800">
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <span>적중률</span>
                      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${hitPct >= 60 ? 'bg-emerald-500' : hitPct >= 45 ? 'bg-yellow-500' : 'bg-red-500'}`}
                          style={{ width: `${hitPct}%` }}
                        />
                      </div>
                      <span className="font-semibold w-8 text-right">{hitPct}%</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 가중치 설정 테이블 */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Zap size={14} className="text-yellow-400" />
              모델 가중치 설정
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              가중치가 높을수록 해당 모델 신호가 AI 점수에 더 많이 반영됩니다.
              (1.0 = 기본, 0~2.0 범위 권장)
            </p>
          </div>
          <button onClick={applySuggested}
            className="text-xs px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300">
            권장값 자동입력
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-800">
                <th className="py-2 px-2 text-left">모델</th>
                <th className="py-2 px-2 text-left">설명</th>
                <th className="py-2 px-2 text-center">적중률</th>
                <th className="py-2 px-2 text-center">권장 가중치</th>
                <th className="py-2 px-2 text-center">설정 가중치</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_IDS.map(mid => {
                const m = stats.find(s => s.model_id === mid)
                const hit = m?.hit_rate !== null && m?.hit_rate !== undefined
                  ? `${Math.round(m.hit_rate * 100)}%` : '-'
                const suggested = m?.suggested_weight ?? 1.0
                return (
                  <tr key={mid} className="border-t border-gray-800 hover:bg-gray-800/30">
                    <td className="py-2 px-2">
                      <span className="text-xs font-bold text-blue-300 bg-blue-900/30 px-1.5 py-0.5 rounded">{mid}</span>
                    </td>
                    <td className="py-2 px-2 text-xs text-gray-400">{MODEL_DESC[mid]}</td>
                    <td className="py-2 px-2 text-center text-xs">
                      <span className={
                        m?.hit_rate === null || m?.hit_rate === undefined ? 'text-gray-500' :
                        m.hit_rate >= 0.6 ? 'text-emerald-400 font-semibold' :
                        m.hit_rate >= 0.45 ? 'text-yellow-400' : 'text-red-400'
                      }>{hit}</span>
                    </td>
                    <td className="py-2 px-2 text-center text-xs text-gray-300">{suggested.toFixed(2)}</td>
                    <td className="py-2 px-2 text-center">
                      <input
                        type="number" min="0" max="3" step="0.1"
                        value={weights[mid] ?? 1.0}
                        onChange={e => setWeights(w => ({ ...w, [mid]: parseFloat(e.target.value) || 1.0 }))}
                        className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-center focus:outline-none focus:border-blue-500"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {saveMsg && (
          <div className="mt-3 text-xs px-3 py-2 rounded-lg bg-blue-900/40 border border-blue-700 text-blue-300">
            {saveMsg}
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-xs font-medium">
            <Save size={12} />{saving ? '저장 중…' : '가중치 저장'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 수익률 차트 ──────────────────────────────────────────
function SummaryChart({ summary }: { summary: ModelSummary[] }) {
  const data = summary
    .filter(s => s.avg_return_pct != null)
    .map(s => ({ model: s.model_id, ret: parseFloat((s.avg_return_pct ?? 0).toFixed(2)) }))
    .sort((a, b) => b.ret - a.ret)

  if (!data.length) return <p className="text-sm text-gray-500 text-center py-8">수익률 데이터 없음</p>

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <XAxis dataKey="model" tick={{ fontSize: 11, fill: '#9ca3af' }} />
        <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 10, fill: '#9ca3af' }} width={44} />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
          formatter={(v: number) => [`${v >= 0 ? '+' : ''}${v.toFixed(2)}%`, '평균 수익률']}
        />
        <ReferenceLine y={0} stroke="#4b5563" />
        <Bar dataKey="ret" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.ret >= 0 ? '#10b981' : '#ef4444'} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── 메인 페이지 ──────────────────────────────────────────
const MODEL_IDS = ['M1','M2','M3','M4','M5','M6','M7','M8','M9','M10']

export default function ModelAnalysis() {
  const [tab, setTab] = useState<'hitrate' | 'portfolio'>('hitrate')
  const [byModel, setByModel] = useState<Record<string, PortfolioStock[]>>({})
  const [summary, setSummary] = useState<ModelSummary[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [all, sum] = await Promise.all([
        getModelPortfolioAll(),
        getModelPortfolioSummary(),
      ])
      setByModel(all.by_model ?? {})
      setSummary(sum.summary ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshModelPortfolioPrices()
      await load()
    } finally { setRefreshing(false) }
  }

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(0, load)

  // 전체 합산
  const allStocks = Object.values(byModel).flat()
  const totalBuy = allStocks.reduce((a, s) => a + s.buy_amount, 0)
  const totalRet = allStocks.reduce((a, s) => a + (s.return_amt ?? 0), 0)
  const avgRetAll = summary.length
    ? summary.filter(s => s.avg_return_pct != null).reduce((a, s) => a + (s.avg_return_pct ?? 0), 0)
      / summary.filter(s => s.avg_return_pct != null).length
    : null

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <BarChart3 size={20} className="text-purple-400" />
            모델별 수익률 분석
          </h1>
          <p className="text-xs text-gray-500">실제 자동매매 적중률 분석 및 가중치 설정</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshTimerComp
            secondsLeft={secondsLeft}
            intervalSec={0}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy || loading}
            onRefresh={timerRefresh}
          />
          {tab === 'portfolio' && (
            <button onClick={handleRefresh} disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-300">
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              현재가 갱신
            </button>
          )}
        </div>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        <button onClick={() => setTab('hitrate')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            tab === 'hitrate' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
          }`}>
          <Target size={12} />적중률 분석
        </button>
        <button onClick={() => setTab('portfolio')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            tab === 'portfolio' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
          }`}>
          <TrendingUp size={12} />가상 포트폴리오
        </button>
      </div>

      {/* 적중률 분석 탭 */}
      {tab === 'hitrate' && <HitRateSection />}

      {/* 가상 포트폴리오 탭 */}
      {tab === 'portfolio' && (<>

      {/* 전체 요약 KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="text-xs text-gray-400 mb-1">총 투자금 (가상)</div>
          <div className="text-xl font-bold">{fmtAmt(totalBuy)}원</div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="text-xs text-gray-400 mb-1">총 평가손익</div>
          <div className={`text-xl font-bold ${colorPct(totalRet)}`}>
            {totalRet >= 0 ? '+' : ''}{fmtAmt(totalRet)}원
          </div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="text-xs text-gray-400 mb-1">모델 평균 수익률</div>
          <div className={`text-xl font-bold ${colorPct(avgRetAll)}`}>{fmtPct(avgRetAll)}</div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="text-xs text-gray-400 mb-1">분석 종목 수</div>
          <div className="text-xl font-bold">{allStocks.length}종목</div>
        </div>
      </div>

      {/* 모델별 수익률 차트 + 랭킹 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-semibold mb-3">모델별 평균 수익률</h2>
          <SummaryChart summary={summary} />
        </div>

        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-semibold mb-3">모델 수익률 랭킹</h2>
          <div className="space-y-2">
            {summary.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-6">종목을 추가하면 랭킹이 표시됩니다</p>
            )}
            {summary.map((s, i) => (
              <div key={s.model_id} className="flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2.5">
                <span className="text-xs text-gray-500 w-5 text-center font-medium">{i + 1}</span>
                <span className="w-8 text-xs font-bold text-blue-300">{s.model_id}</span>
                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  {s.avg_return_pct != null && (
                    <div
                      className={`h-full rounded-full ${s.avg_return_pct >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}
                      style={{ width: `${Math.min(Math.abs(s.avg_return_pct) * 5, 100)}%` }}
                    />
                  )}
                </div>
                <span className={`text-sm font-bold w-16 text-right ${colorPct(s.avg_return_pct)}`}>
                  {fmtPct(s.avg_return_pct)}
                </span>
                <span className={`text-xs w-16 text-right hidden sm:block ${colorPct(s.total_return_amt)}`}>
                  {fmtAmt(s.total_return_amt)}원
                </span>
                <div className="text-xs text-gray-600 w-4 text-center">{s.stock_count}개</div>
                {s.best_stock && (
                  <div className="hidden lg:flex items-center gap-1 text-xs text-gray-500">
                    <TrendingUp size={10} className="text-emerald-400" />
                    {s.best_stock.stock_name}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 모델별 종목 패널 */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">로딩 중…</div>
      ) : (
        <div className="space-y-3">
          {MODEL_IDS.map(mid => (
            <ModelPanel
              key={mid}
              modelId={mid}
              stocks={byModel[mid] ?? []}
              onChanged={load}
            />
          ))}
        </div>
      )}

      {/* 종목별 수익률 Top/Bottom */}
      {allStocks.filter(s => s.return_pct != null).length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <TrendingUp size={14} className="text-emerald-400" /> 수익률 상위 종목
            </h2>
            <div className="space-y-2">
              {[...allStocks]
                .filter(s => s.return_pct != null)
                .sort((a, b) => (b.return_pct ?? 0) - (a.return_pct ?? 0))
                .slice(0, 5)
                .map(s => (
                  <div key={s.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
                    <div>
                      <span className="text-sm font-medium">{s.stock_name}</span>
                      <span className="text-xs text-gray-500 ml-1.5">{s.model_id}</span>
                    </div>
                    <span className="text-sm font-bold text-emerald-400">{fmtPct(s.return_pct)}</span>
                  </div>
                ))}
            </div>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <TrendingDown size={14} className="text-red-400" /> 수익률 하위 종목
            </h2>
            <div className="space-y-2">
              {[...allStocks]
                .filter(s => s.return_pct != null)
                .sort((a, b) => (a.return_pct ?? 0) - (b.return_pct ?? 0))
                .slice(0, 5)
                .map(s => (
                  <div key={s.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
                    <div>
                      <span className="text-sm font-medium">{s.stock_name}</span>
                      <span className="text-xs text-gray-500 ml-1.5">{s.model_id}</span>
                    </div>
                    <span className="text-sm font-bold text-red-400">{fmtPct(s.return_pct)}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  )
}
