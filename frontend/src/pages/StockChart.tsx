import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import { getStockCodes, getStockChart } from '../api/client'
import { TrendingUp, TrendingDown, BarChart2 } from 'lucide-react'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

// ── 타입 ─────────────────────────────────────────────────
interface StockCode {
  stock_code: string
  stock_name: string
  market: string
  latest_date: string | null
  latest_close: number | null
}
interface Candle {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}
interface ChartData {
  stock_code: string
  stock_name: string
  candles: Candle[]
  stats: {
    latest_close: number
    high_3m: number
    low_3m: number
    change_pct: number
  }
}

const PERIODS = [
  { label: '1개월', days: 30 },
  { label: '2개월', days: 60 },
  { label: '3개월', days: 90 },
]

function fmtPrice(v: number | null) {
  if (v == null) return '-'
  return v.toLocaleString() + '원'
}

// ── 캔들스틱 차트 컴포넌트 ───────────────────────────────
function CandleChart({ candles }: { candles: Candle[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)
  const candleRef    = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef       = useRef<ISeriesApi<'Histogram'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // 기존 차트 제거
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#111827' },
        textColor: '#9ca3af',
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#374151' },
      timeScale: {
        borderColor: '#374151',
        timeVisible: true,
        secondsVisible: false,
      },
      width:  containerRef.current.clientWidth,
      height: 380,
    })
    chartRef.current = chart

    // 캔들스틱
    const candleSeries = chart.addCandlestickSeries({
      upColor:          '#10b981',
      downColor:        '#ef4444',
      borderUpColor:    '#10b981',
      borderDownColor:  '#ef4444',
      wickUpColor:      '#10b981',
      wickDownColor:    '#ef4444',
    })
    candleRef.current = candleSeries

    // 거래량 히스토그램 (하단 20%)
    const volSeries = chart.addHistogramSeries({
      color:       '#3b82f680',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    })
    volRef.current = volSeries

    // 데이터 세팅 (OHLC null 방어: close로 대체)
    const validCandles = candles.filter(c => c.close > 0)
    const candleData = validCandles.map(c => ({
      time:  c.date as `${number}-${number}-${number}`,
      open:  c.open  || c.close,
      high:  c.high  || c.close,
      low:   c.low   || c.close,
      close: c.close,
    }))
    const volData = validCandles.map(c => ({
      time:  c.date as `${number}-${number}-${number}`,
      value: c.volume || 0,
      color: c.close >= (c.open || c.close) ? '#10b98150' : '#ef444450',
    }))

    if (candleData.length === 0) {
      chart.remove()
      chartRef.current = null
      return
    }
    candleSeries.setData(candleData)
    volSeries.setData(volData)
    chart.timeScale().fitContent()

    // 리사이즈 대응
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [candles])

  return <div ref={containerRef} className="w-full rounded-lg overflow-hidden" />
}

// ── 통계 배지 ───────────────────────────────────────────
function StatBadge({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-gray-800 rounded-lg px-3 py-2 text-center min-w-[90px]">
      <div className="text-xs text-gray-400 mb-0.5">{label}</div>
      <div className={`text-sm font-bold ${color ?? 'text-white'}`}>{value}</div>
    </div>
  )
}

// ── 메인 페이지 ─────────────────────────────────────────
export default function StockChart() {
  const [codes,        setCodes]        = useState<StockCode[]>([])
  const [selected,     setSelected]     = useState<string>('')
  const [chartData,    setChartData]    = useState<ChartData | null>(null)
  const [days,         setDays]         = useState(90)
  const [loading,      setLoading]      = useState(false)
  const [codesLoading, setCodesLoading] = useState(true)

  // 종목 목록 로드
  useEffect(() => {
    getStockCodes()
      .then(r => {
        setCodes(r.codes ?? [])
        if (r.codes?.length) setSelected(r.codes[0].stock_code)
      })
      .finally(() => setCodesLoading(false))
  }, [])

  // 차트 데이터 로드
  const loadChart = useCallback(async (code: string, d: number) => {
    if (!code) return
    setLoading(true)
    try {
      const data = await getStockChart(code, d)
      setChartData(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selected) loadChart(selected, days)
  }, [selected, days, loadChart])

  const chartLoad = useCallback(async () => {
    if (selected) await loadChart(selected, days)
  }, [selected, days, loadChart])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(0, chartLoad)

  const stock = codes.find(c => c.stock_code === selected)
  const stats = chartData?.stats

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <BarChart2 size={20} className="text-blue-400" />
            주가 차트 분석
          </h1>
          <p className="text-xs text-gray-500">일봉 종가 기준 · 키움증권 실데이터</p>
        </div>
        <RefreshTimer
          secondsLeft={secondsLeft}
          intervalSec={0}
          lastRefreshed={lastRefreshed}
          isRefreshing={timerBusy || loading}
          onRefresh={timerRefresh}
        />
      </div>

      {/* 종목 탭 */}
      <div className="flex gap-1.5 flex-wrap">
        {codesLoading ? (
          <div className="text-xs text-gray-500">종목 목록 로딩 중…</div>
        ) : (
          codes.map(c => (
            <button
              key={c.stock_code}
              onClick={() => setSelected(c.stock_code)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                selected === c.stock_code
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              <span className="font-semibold">{c.stock_name}</span>
              <span className="ml-1 opacity-60 font-mono">{c.stock_code}</span>
            </button>
          ))
        )}
      </div>

      {/* 차트 패널 */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {/* 종목명 + 통계 헤더 */}
        <div className="px-4 pt-4 pb-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-base">
                {chartData?.stock_name || stock?.stock_name || '-'}
              </h2>
              <span className="text-xs text-gray-500 font-mono">{selected}</span>
              {stats && (
                <span className={`text-sm font-bold flex items-center gap-1 ${
                  stats.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}>
                  {stats.change_pct >= 0
                    ? <TrendingUp size={14} />
                    : <TrendingDown size={14} />}
                  {stats.change_pct >= 0 ? '+' : ''}{stats.change_pct.toFixed(2)}%
                  <span className="text-xs text-gray-500 font-normal ml-1">기간 등락</span>
                </span>
              )}
            </div>
            {stats && (
              <div className="text-2xl font-bold mt-1">
                {fmtPrice(stats.latest_close)}
              </div>
            )}
          </div>

          {/* 통계 배지 */}
          {stats && (
            <div className="flex gap-2 flex-wrap">
              <StatBadge label="기간 고점" value={fmtPrice(stats.high_3m)} color="text-emerald-400" />
              <StatBadge label="기간 저점" value={fmtPrice(stats.low_3m)}  color="text-red-400" />
              <StatBadge
                label="등락률"
                value={`${stats.change_pct >= 0 ? '+' : ''}${stats.change_pct.toFixed(2)}%`}
                color={stats.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}
              />
              <StatBadge label="데이터" value={`${chartData?.candles.length ?? 0}일`} />
            </div>
          )}
        </div>

        {/* 기간 탭 */}
        <div className="px-4 pb-3 flex gap-1.5">
          {PERIODS.map(p => (
            <button key={p.days} onClick={() => setDays(p.days)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                days === p.days ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}>
              {p.label}
            </button>
          ))}
        </div>

        {/* 캔들 차트 */}
        <div className="px-2 pb-3">
          {loading ? (
            <div className="h-96 flex items-center justify-center text-gray-500 text-sm">
              차트 데이터 로딩 중…
            </div>
          ) : chartData?.candles.length ? (
            <CandleChart candles={chartData.candles} />
          ) : (
            <div className="h-96 flex items-center justify-center text-gray-500 text-sm">
              데이터 없음 — 백필을 먼저 실행하세요
            </div>
          )}
        </div>
      </div>

      {/* 종목 전체 비교 — 최신 종가 카드 */}
      <div>
        <h2 className="text-sm font-semibold mb-2 text-gray-300">워치리스트 전체 현황</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {codes.map(c => {
            const isSelected = c.stock_code === selected
            return (
              <button
                key={c.stock_code}
                onClick={() => setSelected(c.stock_code)}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  isSelected
                    ? 'border-blue-600 bg-blue-900/20'
                    : 'border-gray-800 bg-gray-900 hover:border-gray-600'
                }`}
              >
                <div className="font-semibold text-sm truncate">{c.stock_name}</div>
                <div className="text-xs text-gray-500 font-mono mb-1">{c.stock_code}</div>
                <div className="text-base font-bold">
                  {c.latest_close ? c.latest_close.toLocaleString() : '-'}
                  <span className="text-xs font-normal text-gray-500">원</span>
                </div>
                {c.latest_date && (
                  <div className="text-[10px] text-gray-600 mt-0.5">{c.latest_date}</div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
