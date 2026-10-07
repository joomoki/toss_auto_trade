import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ComposedChart, Bar, Line, Area, AreaChart,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell, ReferenceLine,
} from 'recharts'
import { Search, RefreshCw, X, BarChart2, ArrowLeft } from 'lucide-react'
import { getTradedStocks, getStockAnalysisLogs } from '../api/client'

// ── 타입 ─────────────────────────────────────────────────
interface TradeLog {
  id: number
  trade_date: string
  stock_code: string
  stock_name: string
  action: 'BUY' | 'SELL'
  quantity: number
  order_price: number
  filled_price: number | null
  filled_amount: number | null
  order_amount: number | null
  realized_pnl: number | null
  composite_score: number | null
  status: string
  created_at: string | null
}

interface TradedStock {
  stock_code: string
  stock_name: string
  total: number
  buy_count: number
  sell_count: number
  buy_amount: number
  total_pnl: number
}

// ── 유틸 ─────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('ko-KR')
const fmtM = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}백만`
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(0)}만`
  return fmt(n)
}
const fmtDate = (s: string) => s.slice(5)   // MM-DD
const fmtTime = (iso: string | null) => {
  if (!iso) return '--:--'
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const toTs = (iso: string | null) => iso ? new Date(iso).getTime() : 0

const PERIODS = [
  { label: '7일',  days: 7   },
  { label: '30일', days: 30  },
  { label: '90일', days: 90  },
  { label: '1년',  days: 365 },
  { label: '전체', days: 730 },
]

// ── KPI 타일 ─────────────────────────────────────────────
function KpiCard({ label, value, sub, color = 'text-white' }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  )
}

// ── 툴팁 커스텀 ──────────────────────────────────────────
function TradeTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as TradeLog & { ts: number }
  if (!d) return null
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs space-y-1 shadow-xl">
      <div className="font-bold text-gray-200">{d.stock_name} ({d.stock_code})</div>
      <div className="text-gray-400">{d.trade_date} {fmtTime(d.created_at)}</div>
      <div className={d.action === 'BUY' ? 'text-blue-400' : 'text-orange-400'}>
        {d.action === 'BUY' ? '매수' : '매도'} {fmt(d.quantity)}주
      </div>
      <div className="text-gray-300">단가: {fmt(d.order_price)}원</div>
      <div className="text-gray-300">금액: {fmt(d.filled_amount ?? d.order_amount ?? 0)}원</div>
      {d.realized_pnl != null && (
        <div className={d.realized_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
          손익: {d.realized_pnl >= 0 ? '+' : ''}{fmt(d.realized_pnl)}원
        </div>
      )}
      <div className="text-gray-500">상태: {d.status}</div>
    </div>
  )
}

function BarTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs space-y-1 shadow-xl">
      <div className="font-bold text-gray-200">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {fmt(Math.abs(p.value ?? 0))}원
        </div>
      ))}
    </div>
  )
}

// ── 메인 페이지 ──────────────────────────────────────────
export default function StockAnalysisPage() {
  const [tradedStocks, setTradedStocks] = useState<TradedStock[]>([])
  const [logs, setLogs]     = useState<TradeLog[]>([])
  const [loading, setLoading] = useState(false)

  // 필터 상태
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [days, setDays]   = useState(90)
  const [action, setAction] = useState<'ALL' | 'BUY' | 'SELL'>('ALL')
  const [search, setSearch] = useState('')
  const [showDrop, setShowDrop] = useState(false)

  // 차트 탭 (단일 종목 뷰)
  const [chartTab, setChartTab] = useState<'scatter' | 'bar' | 'pnl'>('scatter')

  // 하이라이트 날짜 (Bar 클릭 시)
  const [hlDate, setHlDate] = useState<string | null>(null)

  // ── 데이터 패치 ─────────────────────────────────────
  const fetchTradedStocks = useCallback(async () => {
    try { setTradedStocks(await getTradedStocks()) } catch {}
  }, [])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = { days }
      if (selectedCode) params.stock_code = selectedCode
      if (action !== 'ALL') params.action = action
      const res = await getStockAnalysisLogs(params)
      setLogs(res.logs ?? [])
    } catch { setLogs([]) }
    finally { setLoading(false) }
  }, [selectedCode, days, action])

  useEffect(() => { fetchTradedStocks() }, [fetchTradedStocks])
  useEffect(() => { fetchLogs() }, [fetchLogs])

  // ── 파생 데이터 ────────────────────────────────────
  const filledLogs = useMemo(
    () => logs.filter(l => ['FILLED', 'MOCK', 'PENDING'].includes(l.status)),
    [logs]
  )

  // 전체 뷰 KPI
  const allKpi = useMemo(() => {
    const buys  = filledLogs.filter(l => l.action === 'BUY')
    const sells = filledLogs.filter(l => l.action === 'SELL')
    const totalBuyAmt = buys.reduce((s, l) => s + (l.filled_amount ?? l.order_amount ?? 0), 0)
    const totalPnl    = sells.reduce((s, l) => s + (l.realized_pnl ?? 0), 0)
    const wins  = sells.filter(l => (l.realized_pnl ?? 0) > 0).length
    const wr    = sells.length ? Math.round(wins / sells.length * 100) : null
    const stocks = new Set(filledLogs.map(l => l.stock_code)).size
    return { stocks, totalBuyAmt, totalPnl, wr }
  }, [filledLogs])

  // 단일 종목 KPI
  const singleKpi = useMemo(() => {
    if (!selectedCode) return null
    const buys  = filledLogs.filter(l => l.action === 'BUY')
    const sells = filledLogs.filter(l => l.action === 'SELL')
    const totalBuyAmt = buys.reduce((s, l) => s + (l.filled_amount ?? l.order_amount ?? 0), 0)
    const totalPnl    = sells.reduce((s, l) => s + (l.realized_pnl ?? 0), 0)
    const wins = sells.filter(l => (l.realized_pnl ?? 0) > 0).length
    const wr   = sells.length ? Math.round(wins / sells.length * 100) : null
    return { buys: buys.length, sells: sells.length, totalBuyAmt, totalPnl, wr }
  }, [filledLogs, selectedCode])

  // 일별 집계 (Bar 차트용)
  const byDate = useMemo(() => {
    const map: Record<string, { date: string; buyAmt: number; sellAmt: number; pnl: number }> = {}
    filledLogs.forEach(l => {
      const d = l.trade_date
      if (!map[d]) map[d] = { date: d, buyAmt: 0, sellAmt: 0, pnl: 0 }
      const amt = l.filled_amount ?? l.order_amount ?? 0
      if (l.action === 'BUY')  map[d].buyAmt  += amt
      if (l.action === 'SELL') { map[d].sellAmt += amt; map[d].pnl += l.realized_pnl ?? 0 }
    })
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date))
  }, [filledLogs])

  // 종목별 집계 (전체 뷰 테이블)
  const byStock = useMemo(() => {
    const map: Record<string, { code: string; name: string; buys: number; sells: number; buyAmt: number; pnl: number; wins: number }> = {}
    filledLogs.forEach(l => {
      if (!map[l.stock_code]) map[l.stock_code] = { code: l.stock_code, name: l.stock_name, buys: 0, sells: 0, buyAmt: 0, pnl: 0, wins: 0 }
      const r = map[l.stock_code]
      if (l.action === 'BUY')  { r.buys++; r.buyAmt += l.filled_amount ?? l.order_amount ?? 0 }
      if (l.action === 'SELL') { r.sells++; r.pnl += l.realized_pnl ?? 0; if ((l.realized_pnl ?? 0) > 0) r.wins++ }
    })
    return Object.values(map).sort((a, b) => b.buys + b.sells - (a.buys + a.sells))
  }, [filledLogs])

  // Scatter 차트용 (타임스탬프 → 숫자)
  const scatterData = useMemo(() =>
    filledLogs.map(l => ({ ...l, ts: toTs(l.created_at) }))
  , [filledLogs])

  // 누적 PnL
  const cumPnl = useMemo(() => {
    let cum = 0
    return filledLogs
      .filter(l => l.action === 'SELL' && l.realized_pnl != null)
      .sort((a, b) => a.trade_date.localeCompare(b.trade_date))
      .map(l => { cum += l.realized_pnl!; return { date: l.trade_date, pnl: l.realized_pnl!, cum } })
  }, [filledLogs])

  // 검색 필터링된 종목 목록
  const filteredStocks = useMemo(() =>
    tradedStocks.filter(s =>
      s.stock_name.includes(search) || s.stock_code.includes(search)
    )
  , [tradedStocks, search])

  // 선택 종목명
  const selectedName = selectedCode
    ? tradedStocks.find(s => s.stock_code === selectedCode)?.stock_name ?? selectedCode
    : null

  // Scatter 커스텀 도트
  const renderDot = (props: any) => {
    const { cx, cy, payload } = props
    const isBuy = payload.action === 'BUY'
    const isHL  = hlDate === payload.trade_date
    const size  = isHL ? 10 : 7
    return isBuy
      ? <polygon key={payload.id}
          points={`${cx},${cy - size} ${cx - size * 0.87},${cy + size * 0.5} ${cx + size * 0.87},${cy + size * 0.5}`}
          fill={isHL ? '#60a5fa' : '#3b82f6'} stroke="#1e40af" strokeWidth={1}
        />
      : <polygon key={payload.id}
          points={`${cx},${cy + size} ${cx - size * 0.87},${cy - size * 0.5} ${cx + size * 0.87},${cy - size * 0.5}`}
          fill={isHL ? '#fb923c' : '#f97316'} stroke="#c2410c" strokeWidth={1}
        />
  }

  // XAxis 타임스탬프 포맷
  const fmtTs = (ts: number) => {
    if (!ts) return ''
    const d = new Date(ts)
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="space-y-4">
      {/* ── 헤더 ─────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <BarChart2 size={20} className="text-blue-400" />
        <h1 className="text-lg font-bold text-white">종목별 매매 분석</h1>
        {selectedCode && (
          <button onClick={() => { setSelectedCode(null); setHlDate(null) }}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-white bg-gray-800 px-2 py-1 rounded-lg transition-colors">
            <ArrowLeft size={12} /> 전체보기
          </button>
        )}
        <button onClick={() => { fetchTradedStocks(); fetchLogs() }}
          className="ml-auto p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* ── 필터 바 ──────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        {/* 종목 검색 */}
        <div className="relative">
          <div className="flex items-center gap-2 bg-gray-900 rounded-lg px-3 py-2">
            <Search size={14} className="text-gray-400 shrink-0" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setShowDrop(true) }}
              onFocus={() => setShowDrop(true)}
              placeholder={selectedCode ? `${selectedName} (${selectedCode})` : '종목명 또는 코드 검색...'}
              className="bg-transparent text-sm text-white placeholder-gray-500 flex-1 outline-none"
            />
            {selectedCode && (
              <button onClick={() => { setSelectedCode(null); setSearch(''); setHlDate(null) }}>
                <X size={14} className="text-gray-400 hover:text-white" />
              </button>
            )}
          </div>

          {showDrop && search && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 max-h-56 overflow-y-auto">
              <div
                className="px-3 py-2 text-xs text-gray-400 hover:bg-gray-800 cursor-pointer"
                onClick={() => { setSelectedCode(null); setSearch(''); setShowDrop(false) }}
              >
                전체 종목
              </div>
              {filteredStocks.map(s => (
                <div key={s.stock_code}
                  className="px-3 py-2 text-sm hover:bg-gray-800 cursor-pointer flex justify-between items-center"
                  onClick={() => { setSelectedCode(s.stock_code); setSearch(''); setShowDrop(false) }}
                >
                  <span className="text-white">{s.stock_name}</span>
                  <span className="text-gray-500 text-xs">{s.stock_code} · {s.total}건</span>
                </div>
              ))}
              {filteredStocks.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-500">검색 결과 없음</div>
              )}
            </div>
          )}
        </div>
        {/* 클릭 외부 닫기 */}
        {showDrop && <div className="fixed inset-0 z-40" onClick={() => setShowDrop(false)} />}

        {/* 기간 + 구분 */}
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-1">
            {PERIODS.map(p => (
              <button key={p.days} onClick={() => setDays(p.days)}
                className={`px-3 py-1 text-xs rounded-lg transition-colors ${days === p.days ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 ml-auto">
            {(['ALL', 'BUY', 'SELL'] as const).map(a => (
              <button key={a} onClick={() => setAction(a)}
                className={`px-3 py-1 text-xs rounded-lg transition-colors ${action === a
                  ? a === 'BUY' ? 'bg-blue-600 text-white' : a === 'SELL' ? 'bg-orange-600 text-white' : 'bg-gray-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:text-white'}`}>
                {a === 'ALL' ? '전체' : a === 'BUY' ? '매수' : '매도'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── KPI 타일 ─────────────────────────────────── */}
      {!selectedCode ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard label="거래 종목 수"  value={`${allKpi.stocks}종목`} />
          <KpiCard label="총 매수금액"   value={fmtM(allKpi.totalBuyAmt) + '원'} />
          <KpiCard label="실현손익"
            value={(allKpi.totalPnl >= 0 ? '+' : '') + fmtM(allKpi.totalPnl) + '원'}
            color={allKpi.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
          <KpiCard label="매도 승률"
            value={allKpi.wr != null ? `${allKpi.wr}%` : '-'}
            color={allKpi.wr != null && allKpi.wr >= 50 ? 'text-green-400' : 'text-orange-400'} />
        </div>
      ) : singleKpi && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard label="총 매수 횟수"  value={`${singleKpi.buys}회`} />
          <KpiCard label="총 매도 횟수"  value={`${singleKpi.sells}회`} />
          <KpiCard label="총 매수금액"   value={fmtM(singleKpi.totalBuyAmt) + '원'} />
          <KpiCard label="실현손익"
            value={(singleKpi.totalPnl >= 0 ? '+' : '') + fmtM(singleKpi.totalPnl) + '원'}
            sub={singleKpi.wr != null ? `승률 ${singleKpi.wr}%` : undefined}
            color={singleKpi.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
        </div>
      )}

      {/* ── 차트 영역 ─────────────────────────────────── */}
      {loading ? (
        <div className="bg-gray-800 rounded-xl p-10 text-center text-gray-400 text-sm">데이터 로딩 중...</div>
      ) : filledLogs.length === 0 ? (
        <div className="bg-gray-800 rounded-xl p-10 text-center text-gray-500 text-sm">
          {selectedCode ? `${selectedName}의 거래 내역이 없습니다.` : '거래 내역이 없습니다.'}
        </div>
      ) : selectedCode ? (
        /* ── 단일 종목 뷰 ─────────────────────────── */
        <div className="bg-gray-800 rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">{selectedName}</span>
            <span className="text-xs text-gray-400">{selectedCode}</span>
            <div className="flex gap-1 ml-auto">
              {([['scatter', '타임라인'], ['bar', '일별금액'], ['pnl', '누적손익']] as const).map(([t, label]) => (
                <button key={t} onClick={() => setChartTab(t)}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${chartTab === t ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {chartTab === 'scatter' && (
            <div>
              <p className="text-xs text-gray-500 mb-2">▲ 매수 · ▽ 매도 — X축: 거래 시각, Y축: 거래 단가</p>
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="ts" type="number" domain={['auto','auto']} scale="time"
                    tickFormatter={fmtTs} tick={{ fill: '#9ca3af', fontSize: 10 }}
                    tickCount={6} />
                  <YAxis dataKey="order_price" type="number"
                    tickFormatter={v => fmtM(v)}
                    tick={{ fill: '#9ca3af', fontSize: 10 }} width={70} />
                  <Tooltip content={<TradeTooltip />} />
                  <Scatter data={scatterData} shape={renderDot} />
                </ScatterChart>
              </ResponsiveContainer>
              <div className="flex gap-4 justify-center mt-1 text-xs">
                <span className="flex items-center gap-1 text-blue-400">▲ 매수</span>
                <span className="flex items-center gap-1 text-orange-400">▽ 매도</span>
              </div>
            </div>
          )}

          {chartTab === 'bar' && (
            <div>
              <p className="text-xs text-gray-500 mb-2">일별 매수/매도 금액 합산 (하루 여러 건은 합산 표시)</p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={byDate} margin={{ top: 10, right: 50, left: 10, bottom: 10 }}
                  onClick={d => d && setHlDate(d.activeLabel ?? null)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis yAxisId="amt" tickFormatter={fmtM} tick={{ fill: '#9ca3af', fontSize: 10 }} width={70} />
                  <YAxis yAxisId="pnl" orientation="right" tickFormatter={fmtM} tick={{ fill: '#9ca3af', fontSize: 10 }} width={65} />
                  <Tooltip content={<BarTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="amt" dataKey="buyAmt"  name="매수금액" fill="#3b82f6" radius={[3,3,0,0]}>
                    {byDate.map(d => (
                      <Cell key={d.date} fill={hlDate === d.date ? '#60a5fa' : '#3b82f6'} />
                    ))}
                  </Bar>
                  <Bar yAxisId="amt" dataKey="sellAmt" name="매도금액" fill="#f97316" radius={[3,3,0,0]}>
                    {byDate.map(d => (
                      <Cell key={d.date} fill={hlDate === d.date ? '#fb923c' : '#f97316'} />
                    ))}
                  </Bar>
                  <Line yAxisId="pnl" dataKey="pnl" name="실현손익" stroke="#34d399" strokeWidth={2} dot={false} />
                  <ReferenceLine yAxisId="pnl" y={0} stroke="#6b7280" strokeDasharray="3 3" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {chartTab === 'pnl' && (
            <div>
              <p className="text-xs text-gray-500 mb-2">매도 기준 누적 실현손익 추이</p>
              {cumPnl.length === 0 ? (
                <div className="h-[280px] flex items-center justify-center text-gray-500 text-sm">매도 내역 없음</div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={cumPnl} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                    <defs>
                      <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#34d399" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#34d399" stopOpacity={0}   />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#9ca3af', fontSize: 10 }} />
                    <YAxis tickFormatter={fmtM} tick={{ fill: '#9ca3af', fontSize: 10 }} width={70} />
                    <Tooltip formatter={(v: any) => [`${fmt(v)}원`, '누적손익']}
                      labelStyle={{ color: '#9ca3af' }} contentStyle={{ background: '#111827', border: '1px solid #374151' }} />
                    <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
                    <Area dataKey="cum" name="누적손익" stroke="#34d399" fill="url(#pnlGrad)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          )}
        </div>
      ) : (
        /* ── 전체 종목 뷰 ─────────────────────────── */
        <div className="bg-gray-800 rounded-xl p-4 space-y-4">
          <p className="text-sm font-medium text-gray-300">일별 전체 매매 금액</p>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={byDate} margin={{ top: 10, right: 50, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#9ca3af', fontSize: 10 }} />
              <YAxis yAxisId="amt" tickFormatter={fmtM} tick={{ fill: '#9ca3af', fontSize: 10 }} width={70} />
              <YAxis yAxisId="pnl" orientation="right" tickFormatter={fmtM} tick={{ fill: '#9ca3af', fontSize: 10 }} width={65} />
              <Tooltip content={<BarTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="amt" dataKey="buyAmt"  name="매수금액" fill="#3b82f6" radius={[3,3,0,0]} />
              <Bar yAxisId="amt" dataKey="sellAmt" name="매도금액" fill="#f97316" radius={[3,3,0,0]} />
              <Line yAxisId="pnl" dataKey="pnl" name="실현손익" stroke="#34d399" strokeWidth={2} dot={false} />
              <ReferenceLine yAxisId="pnl" y={0} stroke="#6b7280" strokeDasharray="3 3" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── 거래 내역 테이블 ──────────────────────────── */}
      {!selectedCode ? (
        /* 종목별 집계 테이블 */
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700">
            <span className="text-sm font-medium text-gray-300">종목별 거래 요약</span>
            <span className="ml-2 text-xs text-gray-500">클릭하면 해당 종목 상세로 이동</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 bg-gray-900">
                  <th className="px-4 py-2 text-left">종목</th>
                  <th className="px-3 py-2 text-right">매수</th>
                  <th className="px-3 py-2 text-right">매도</th>
                  <th className="px-3 py-2 text-right">매수금액</th>
                  <th className="px-3 py-2 text-right">실현손익</th>
                  <th className="px-3 py-2 text-right">승률</th>
                </tr>
              </thead>
              <tbody>
                {byStock.map(s => {
                  const wr = s.sells ? Math.round(s.wins / s.sells * 100) : null
                  return (
                    <tr key={s.code}
                      className="border-t border-gray-700 hover:bg-gray-750 cursor-pointer transition-colors"
                      onClick={() => { setSelectedCode(s.code); setSearch('') }}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-white">{s.name}</div>
                        <div className="text-gray-500">{s.code}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right text-blue-400">{s.buys}회</td>
                      <td className="px-3 py-2.5 text-right text-orange-400">{s.sells}회</td>
                      <td className="px-3 py-2.5 text-right text-gray-300">{fmtM(s.buyAmt)}원</td>
                      <td className={`px-3 py-2.5 text-right font-medium ${s.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {s.pnl >= 0 ? '+' : ''}{fmtM(s.pnl)}원
                      </td>
                      <td className={`px-3 py-2.5 text-right ${wr != null && wr >= 50 ? 'text-green-400' : 'text-orange-400'}`}>
                        {wr != null ? `${wr}%` : '-'}
                      </td>
                    </tr>
                  )
                })}
                {byStock.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">거래 내역 없음</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* 단일 종목 개별 거래 테이블 */
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-2">
            <span className="text-sm font-medium text-gray-300">개별 거래 내역</span>
            <span className="text-xs text-gray-500">하루 여러 건 모두 표시 · 시간순</span>
            {hlDate && (
              <button onClick={() => setHlDate(null)}
                className="ml-auto text-xs text-gray-400 hover:text-white flex items-center gap-1">
                <X size={11} /> 필터 해제
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 bg-gray-900">
                  <th className="px-4 py-2 text-left">날짜</th>
                  <th className="px-3 py-2 text-left">시간</th>
                  <th className="px-3 py-2 text-center">구분</th>
                  <th className="px-3 py-2 text-right">수량</th>
                  <th className="px-3 py-2 text-right">단가</th>
                  <th className="px-3 py-2 text-right">금액</th>
                  <th className="px-3 py-2 text-right">손익</th>
                  <th className="px-3 py-2 text-center">상태</th>
                </tr>
              </thead>
              <tbody>
                {logs
                  .filter(l => !hlDate || l.trade_date === hlDate)
                  .sort((a, b) => toTs(b.created_at) - toTs(a.created_at))
                  .map(l => {
                    const amt  = l.filled_amount ?? l.order_amount ?? 0
                    const isHL = hlDate === l.trade_date
                    return (
                      <tr key={l.id}
                        className={`border-t border-gray-700 transition-colors ${isHL ? 'bg-gray-700' : 'hover:bg-gray-750'}`}>
                        <td className="px-4 py-2.5 text-gray-300 font-mono">{l.trade_date}</td>
                        <td className="px-3 py-2.5 text-gray-400 font-mono">{fmtTime(l.created_at)}</td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${l.action === 'BUY' ? 'bg-blue-900 text-blue-300' : 'bg-orange-900 text-orange-300'}`}>
                            {l.action === 'BUY' ? '매수' : '매도'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-300">{fmt(l.quantity)}주</td>
                        <td className="px-3 py-2.5 text-right text-gray-300">{fmt(l.order_price)}원</td>
                        <td className="px-3 py-2.5 text-right text-gray-300">{fmtM(amt)}원</td>
                        <td className={`px-3 py-2.5 text-right font-medium ${l.realized_pnl == null ? 'text-gray-600' : l.realized_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {l.realized_pnl != null ? `${l.realized_pnl >= 0 ? '+' : ''}${fmtM(l.realized_pnl)}원` : '-'}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                            l.status === 'FILLED'    ? 'bg-green-900 text-green-300' :
                            l.status === 'MOCK'      ? 'bg-purple-900 text-purple-300' :
                            l.status === 'PENDING'   ? 'bg-yellow-900 text-yellow-300' :
                            l.status === 'CANCELLED' ? 'bg-gray-700 text-gray-400' :
                            'bg-gray-700 text-gray-400'}`}>
                            {l.status}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                {logs.filter(l => !hlDate || l.trade_date === hlDate).length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">거래 내역 없음</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
