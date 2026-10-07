import { useEffect, useState, useCallback } from 'react'
import { getTradeHistory } from '../api/client'
import KPICard from '../components/common/KPICard'
import TradeTable, { type Trade } from '../components/tables/TradeTable'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

type RangeKey = '1w' | '1m' | '3m' | '6m' | '1y' | 'all'
const RANGES: RangeKey[] = ['1w', '1m', '3m', '6m', '1y', 'all']

function dateRange(key: RangeKey) {
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date()
  const map: Record<RangeKey, number> = { '1w': 7, '1m': 30, '3m': 90, '6m': 180, '1y': 365, 'all': 0 }
  if (key === 'all') return {}
  from.setDate(from.getDate() - map[key])
  return { from: from.toISOString().slice(0, 10), to }
}

export default function History() {
  const [range, setRange] = useState<RangeKey>('1m')
  const [stockCode, setStockCode] = useState('')
  const [trades, setTrades] = useState<Trade[]>([])
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    const { from, to } = dateRange(range)
    const data = await getTradeHistory({ from, to, stock_code: stockCode || undefined, page: String(page) })
    setTrades(data)
  }, [range, stockCode, page])

  useEffect(() => { load() }, [load])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(0, load)

  const sells = trades.filter(t => t.trade_type === 'SELL' && t.status === 'FILLED')
  const totalPnl = sells.reduce((s, t) => s + (t.filled_amount ?? 0) - t.order_price * t.order_qty, 0)
  const winCount = sells.filter(t => (t.filled_amount ?? 0) > t.order_price * t.order_qty).length
  const winRate = sells.length > 0 ? winCount / sells.length * 100 : 0

  const monthly: Record<string, number> = {}
  for (const t of sells) {
    const ym = t.trade_date.slice(0, 7)
    monthly[ym] = (monthly[ym] ?? 0) + ((t.filled_amount ?? 0) - t.order_price * t.order_qty)
  }
  const monthlyData = Object.entries(monthly)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, pnl]) => ({ month, pnl }))

  const exportCsv = () => {
    const header = ['종목코드', '종목명', '구분', '수량', '주문가', '체결가', '체결금액', '상태', '날짜']
    const rows = trades.map(t => [t.stock_code, t.stock_name, t.trade_type, t.order_qty, t.order_price, t.filled_price ?? '', t.filled_amount ?? '', t.status, t.trade_date])
    const csv = [header, ...rows].map(r => r.join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }))
    a.download = 'trades.csv'; a.click()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold sm:text-xl">이력 분석</h1>
        <RefreshTimer
          secondsLeft={secondsLeft}
          intervalSec={0}
          lastRefreshed={lastRefreshed}
          isRefreshing={timerBusy}
          onRefresh={timerRefresh}
        />
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex gap-1 flex-wrap">
          {RANGES.map(r => (
            <button key={r} onClick={() => { setRange(r); setPage(1) }}
              className={`px-2.5 py-1 text-xs rounded-lg ${range === r ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
              {r}
            </button>
          ))}
        </div>
        <input value={stockCode} onChange={e => setStockCode(e.target.value)}
          placeholder="종목코드 검색"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm w-32" />
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPICard title="총 거래" value={`${trades.length}건`} />
        <KPICard title="승률" value={`${winRate.toFixed(1)}%`} color={winRate >= 50 ? 'green' : 'red'} />
        <KPICard title="총 손익" value={`${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}원`} color={totalPnl >= 0 ? 'green' : 'red'} />
        <KPICard title="매도 건수" value={`${sells.length}건`} />
      </div>

      {/* 월별 차트 */}
      {monthlyData.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-semibold mb-3">월별 손익</h2>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
              <XAxis dataKey="month" tick={{ fill: '#6B7280', fontSize: 10 }} />
              <YAxis tick={{ fill: '#6B7280', fontSize: 10 }} tickFormatter={v => `${(v / 10000).toFixed(0)}만`} width={45} />
              <Tooltip contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', fontSize: 12 }} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {monthlyData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#22C55E' : '#EF4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 테이블 + CSV */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">전체 이력</h2>
          <button onClick={exportCsv} className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg">
            CSV
          </button>
        </div>
        <div className="overflow-x-auto -mx-4 px-4">
          <TradeTable trades={trades} />
        </div>
        <div className="flex gap-2 mt-3 justify-center">
          {page > 1 && <button onClick={() => setPage(p => p - 1)} className="px-3 py-1 bg-gray-800 rounded text-sm">이전</button>}
          <span className="px-3 py-1 text-sm text-gray-400">{page}p</span>
          {trades.length === 50 && <button onClick={() => setPage(p => p + 1)} className="px-3 py-1 bg-gray-800 rounded text-sm">다음</button>}
        </div>
      </div>
    </div>
  )
}
