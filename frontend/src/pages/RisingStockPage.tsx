import { useState, useEffect, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
} from 'recharts'
import { TrendingUp, RefreshCw, Download, CheckCircle2, AlertCircle } from 'lucide-react'
import {
  collectRisingStocks, getRisingStocks, getRisingStocksSummary, getRisingStocksDates,
} from '../api/client'

/* ── 타입 ──────────────────────────────────────────────────── */
interface RisingStock {
  id: number
  analysis_date: string
  stock_code: string
  stock_name: string
  market: string
  open_price: number | null
  close_price: number | null
  change_pct: number
  volume: number | null
  trading_value: number | null
  volume_ratio: number | null
  news_sentiment: number | null
  news_count: number
  top_news: string | null
  rise_causes: string[]
  rise_category: string
  was_in_watchlist: boolean
  was_bought: boolean
  ai_score: number | null
}

interface Summary {
  days: number
  total_records: number
  total_bought: number
  total_watched: number
  avg_change_pct: number
  category_dist: { category: string; count: number; avg_change: number }[]
  daily: { date: string; total: number; bought: number; avg_change: number; max_change: number }[]
}

interface CollectedDate { date: string; count: number }

/* ── 상수 ──────────────────────────────────────────────────── */
const CATEGORY_LABELS: Record<string, string> = {
  news: '뉴스호재',
  supply: '수급(외인·기관)',
  volume: '거래량급증',
  momentum: '강한모멘텀',
  unknown: '기타/불명',
}

const CATEGORY_COLORS: Record<string, string> = {
  news: '#6366f1',
  supply: '#22c55e',
  volume: '#f59e0b',
  momentum: '#ef4444',
  unknown: '#6b7280',
}

const MARKET_OPTIONS = ['전체', 'KOSPI', 'KOSDAQ']
const PERIOD_OPTIONS = [
  { label: '7일', days: 7 },
  { label: '30일', days: 30 },
  { label: '90일', days: 90 },
  { label: '180일', days: 180 },
]

/* ── 포맷 헬퍼 ─────────────────────────────────────────────── */
const fmtNum = (v: number | null | undefined) =>
  v == null ? '-' : v.toLocaleString()

const fmtPct = (v: number | null | undefined, decimals = 2) =>
  v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(decimals)}%`

const fmtVal = (v: number | null | undefined) => {
  if (v == null) return '-'
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}만`
  return v.toLocaleString()
}

/* ── 원인 뱃지 ─────────────────────────────────────────────── */
function CauseBadges({ causes, category }: { causes: string[]; category: string }) {
  if (!causes || causes.length === 0) return <span className="text-gray-500 text-xs">-</span>
  return (
    <div className="flex flex-wrap gap-1">
      {causes.map((c, i) => (
        <span
          key={i}
          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
          style={{
            background: `${CATEGORY_COLORS[category] || '#6b7280'}22`,
            color: CATEGORY_COLORS[category] || '#9ca3af',
            border: `1px solid ${CATEGORY_COLORS[category] || '#6b7280'}44`,
          }}
        >
          {c}
        </span>
      ))}
    </div>
  )
}

/* ── 수집 버튼 패널 ─────────────────────────────────────────── */
function CollectPanel({
  collectedDates,
  onCollected,
}: {
  collectedDates: CollectedDate[]
  onCollected: () => void
}) {
  const [targetDate, setTargetDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  })
  const [minChange, setMinChange] = useState(3)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const alreadyCollected = collectedDates.some(d => d.date === targetDate)

  const handleCollect = async () => {
    setLoading(true)
    setMsg(null)
    try {
      const res = await collectRisingStocks({
        analysis_date: targetDate,
        min_change_pct: minChange,
        max_stocks: 50,
        compute_vol_ratio: false,
      })
      setMsg({ text: res.message || '완료', ok: true })
      onCollected()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } }
      setMsg({ text: err?.response?.data?.detail || '수집 실패', ok: false })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">분석 날짜</label>
          <input
            type="date"
            value={targetDate}
            onChange={e => setTargetDate(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">최소 등락률</label>
          <select
            value={minChange}
            onChange={e => setMinChange(Number(e.target.value))}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {[2, 3, 5, 7, 10].map(v => (
              <option key={v} value={v}>{v}% 이상</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleCollect}
          disabled={loading}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          <Download size={14} />
          {loading ? '수집 중...' : alreadyCollected ? '재수집' : '수집'}
        </button>
        {alreadyCollected && (
          <span className="text-xs text-green-400 flex items-center gap-1">
            <CheckCircle2 size={12} /> 이미 수집됨
          </span>
        )}
        {msg && (
          <span className={`text-xs flex items-center gap-1 ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>
            {msg.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
            {msg.text}
          </span>
        )}
      </div>
      {collectedDates.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="text-xs text-gray-500">수집 완료:</span>
          {collectedDates.slice(0, 10).map(d => (
            <span key={d.date} className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-300">
              {d.date.slice(5)} <span className="text-gray-500">({d.count}개)</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── 요약 통계 카드 ─────────────────────────────────────────── */
function SummaryCards({ summary }: { summary: Summary }) {
  const buyRate = summary.total_records
    ? ((summary.total_bought / summary.total_records) * 100).toFixed(1)
    : '0'
  const watchRate = summary.total_records
    ? ((summary.total_watched / summary.total_records) * 100).toFixed(1)
    : '0'

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: '총 상승 종목', value: fmtNum(summary.total_records), sub: `최근 ${summary.days}일` },
        { label: '평균 등락률', value: fmtPct(summary.avg_change_pct), sub: '상위 종목 기준' },
        { label: '자동매매 포착', value: `${summary.total_bought}건`, sub: `포착률 ${buyRate}%` },
        { label: '워치리스트 포함', value: `${summary.total_watched}건`, sub: `비율 ${watchRate}%` },
      ].map(({ label, value, sub }) => (
        <div key={label} className="bg-gray-800 rounded-xl p-4 border border-gray-700">
          <div className="text-xs text-gray-400 mb-1">{label}</div>
          <div className="text-xl font-bold text-white">{value}</div>
          <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
        </div>
      ))}
    </div>
  )
}

/* ── 원인 분포 파이 차트 ────────────────────────────────────── */
function CategoryPie({ data }: { data: Summary['category_dist'] }) {
  const pieData = data.map(d => ({
    name: CATEGORY_LABELS[d.category] || d.category,
    value: d.count,
    color: CATEGORY_COLORS[d.category] || '#6b7280',
  }))

  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="text-sm font-semibold text-gray-200 mb-3">상승 원인 분포</div>
      <div className="flex items-center gap-4">
        <ResponsiveContainer width={160} height={160}>
          <PieChart>
            <Pie data={pieData} dataKey="value" cx="50%" cy="50%" outerRadius={65} innerRadius={35} paddingAngle={2}>
              {pieData.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v: number) => [`${v}건`, '종목 수']}
              contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex flex-col gap-1.5">
          {pieData.map(d => (
            <div key={d.name} className="flex items-center gap-2 text-xs">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
              <span className="text-gray-300">{d.name}</span>
              <span className="text-gray-500 ml-auto pl-4">{d.value}건</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── 일별 상승 종목 수 바차트 ───────────────────────────────── */
function DailyBarChart({ data }: { data: Summary['daily'] }) {
  const sliced = data.slice(-30)
  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="text-sm font-semibold text-gray-200 mb-3">일별 상승 종목 수</div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={sliced} barCategoryGap="30%">
          <XAxis
            dataKey="date"
            tickFormatter={v => v.slice(5)}
            tick={{ fill: '#6b7280', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
          <Tooltip
            contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
            formatter={(v: number, name: string) => [
              name === 'total' ? `${v}개` : `${v}건`,
              name === 'total' ? '상승 종목' : '자동매매 포착',
            ]}
            labelFormatter={v => v}
          />
          <Bar dataKey="total" fill="#3b82f6" radius={[3, 3, 0, 0]} />
          <Bar dataKey="bought" fill="#22c55e" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-4 mt-2 justify-center">
        {[{ color: '#3b82f6', label: '상승 종목 수' }, { color: '#22c55e', label: '자동매매 포착' }].map(l => (
          <div key={l.label} className="flex items-center gap-1 text-xs text-gray-400">
            <span className="w-2 h-2 rounded-full" style={{ background: l.color }} />
            {l.label}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── 메인 페이지 ────────────────────────────────────────────── */
export default function RisingStockPage() {
  const [stocks, setStocks] = useState<RisingStock[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [collectedDates, setCollectedDates] = useState<CollectedDate[]>([])

  const [days, setDays] = useState(30)
  const [market, setMarket] = useState('전체')
  const [category, setCategory] = useState('')
  const [minChange, setMinChange] = useState(0)
  const [wasBought, setWasBought] = useState<'all' | 'yes' | 'no'>('all')
  const [selectedDate, setSelectedDate] = useState('')

  const [loading, setLoading] = useState(false)

  const fetchDates = useCallback(async () => {
    try {
      const d = await getRisingStocksDates(90)
      setCollectedDates(d)
    } catch (_) {}
  }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params: Parameters<typeof getRisingStocks>[0] = {
        days,
        min_change: minChange,
        limit: 500,
      }
      if (market !== '전체') params.market = market
      if (category) params.category = category
      if (wasBought === 'yes') params.was_bought = true
      if (wasBought === 'no') params.was_bought = false
      if (selectedDate) {
        params.date_from = selectedDate
        params.date_to = selectedDate
        delete params.days
      }

      const [stockData, sumData] = await Promise.all([
        getRisingStocks(params),
        getRisingStocksSummary(days),
      ])
      setStocks(stockData)
      setSummary(sumData)
    } catch (_) {
    } finally {
      setLoading(false)
    }
  }, [days, market, category, minChange, wasBought, selectedDate])

  useEffect(() => { fetchDates() }, [fetchDates])
  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div className="space-y-5">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp size={20} className="text-blue-400" />
          <h1 className="text-lg font-bold text-white">상승 종목 분석 <span className="text-xs text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded-full ml-1">파일럿</span></h1>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 데이터 수집 패널 */}
      <CollectPanel collectedDates={collectedDates} onCollected={() => { fetchDates(); fetchData() }} />

      {/* 요약 카드 */}
      {summary && <SummaryCards summary={summary} />}

      {/* 차트 */}
      {summary && summary.category_dist.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <CategoryPie data={summary.category_dist} />
          <DailyBarChart data={summary.daily} />
        </div>
      )}

      {/* 필터 바 */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
        <div className="flex flex-wrap gap-3 items-end">
          {/* 기간 */}
          <div>
            <div className="text-xs text-gray-400 mb-1">기간</div>
            <div className="flex gap-1">
              {PERIOD_OPTIONS.map(o => (
                <button
                  key={o.days}
                  onClick={() => { setDays(o.days); setSelectedDate('') }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    days === o.days && !selectedDate
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* 날짜 직접 선택 */}
          <div>
            <div className="text-xs text-gray-400 mb-1">날짜 지정</div>
            <input
              type="date"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* 시장 */}
          <div>
            <div className="text-xs text-gray-400 mb-1">시장</div>
            <div className="flex gap-1">
              {MARKET_OPTIONS.map(m => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    market === m
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* 원인 필터 */}
          <div>
            <div className="text-xs text-gray-400 mb-1">상승 원인</div>
            <div className="flex gap-1 flex-wrap">
              <button
                onClick={() => setCategory('')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  !category ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                전체
              </button>
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setCategory(key)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    category === key ? 'text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                  style={category === key ? { background: CATEGORY_COLORS[key] } : {}}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 매수 여부 */}
          <div>
            <div className="text-xs text-gray-400 mb-1">자동매매</div>
            <div className="flex gap-1">
              {(['all', 'yes', 'no'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setWasBought(v)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    wasBought === v
                      ? 'bg-green-700 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {v === 'all' ? '전체' : v === 'yes' ? '포착' : '미포착'}
                </button>
              ))}
            </div>
          </div>

          {/* 최소 등락률 */}
          <div>
            <div className="text-xs text-gray-400 mb-1">최소 등락률</div>
            <select
              value={minChange}
              onChange={e => setMinChange(Number(e.target.value))}
              className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            >
              {[0, 2, 3, 5, 7, 10].map(v => (
                <option key={v} value={v}>{v === 0 ? '전체' : `${v}% 이상`}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 종목 테이블 */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-200">상승 종목 목록</span>
          <span className="text-xs text-gray-400">{stocks.length.toLocaleString()}건</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400">
                <th className="text-left px-4 py-2.5 font-medium">날짜</th>
                <th className="text-left px-3 py-2.5 font-medium">종목</th>
                <th className="text-left px-3 py-2.5 font-medium">시장</th>
                <th className="text-right px-3 py-2.5 font-medium">종가</th>
                <th className="text-right px-3 py-2.5 font-medium">등락률</th>
                <th className="text-right px-3 py-2.5 font-medium">거래량</th>
                <th className="text-right px-3 py-2.5 font-medium">거래대금</th>
                <th className="text-right px-3 py-2.5 font-medium">거래량비율</th>
                <th className="text-left px-3 py-2.5 font-medium">상승 원인</th>
                <th className="text-left px-3 py-2.5 font-medium">주요 뉴스</th>
                <th className="text-right px-3 py-2.5 font-medium">AI점수</th>
                <th className="text-center px-3 py-2.5 font-medium">매수</th>
              </tr>
            </thead>
            <tbody>
              {stocks.length === 0 ? (
                <tr>
                  <td colSpan={12} className="text-center py-12 text-gray-500">
                    {loading ? '불러오는 중...' : '데이터 없음 — 위에서 날짜를 선택하고 수집하세요'}
                  </td>
                </tr>
              ) : (
                stocks.map(s => (
                  <tr key={s.id} className="border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors">
                    <td className="px-4 py-2.5 text-gray-300 whitespace-nowrap">{s.analysis_date.slice(5)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="font-medium text-white">{s.stock_name}</div>
                      <div className="text-gray-500">{s.stock_code}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        s.market === 'KOSPI' ? 'bg-blue-900/50 text-blue-300' : 'bg-purple-900/50 text-purple-300'
                      }`}>
                        {s.market}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-gray-200 tabular-nums">{fmtNum(s.close_price)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-red-400">
                      {fmtPct(s.change_pct)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">{fmtNum(s.volume)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">{fmtVal(s.trading_value)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {s.volume_ratio != null ? (
                        <span className={s.volume_ratio >= 3 ? 'text-amber-400 font-semibold' : 'text-gray-300'}>
                          {s.volume_ratio.toFixed(1)}배
                        </span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <CauseBadges causes={s.rise_causes} category={s.rise_category} />
                    </td>
                    <td className="px-3 py-2.5 max-w-[200px]">
                      {s.top_news ? (
                        <span className="text-gray-400 truncate block" title={s.top_news}>
                          {s.top_news.slice(0, 40)}{s.top_news.length > 40 ? '…' : ''}
                        </span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {s.ai_score != null ? (
                        <span className={s.ai_score >= 0.7 ? 'text-green-400 font-semibold' : 'text-gray-400'}>
                          {(s.ai_score * 100).toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {s.was_bought ? (
                        <span className="text-green-400 font-semibold">✓</span>
                      ) : s.was_in_watchlist ? (
                        <span className="text-yellow-500 text-[10px]">관심</span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
