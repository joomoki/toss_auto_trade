import { useState, useCallback, useEffect } from 'react'
import { getAutoTradeLogs } from '../api/client'
import { TrendingUp, TrendingDown, RefreshCw, Download } from 'lucide-react'

interface Log {
  id: number
  trade_date: string
  stock_code: string
  stock_name: string
  action: string
  quantity: number
  order_price: number
  order_amount: number | null
  filled_price: number | null
  composite_score: number | null
  trigger_models: string[]
  status: string
  realized_pnl: number | null
  commission: number | null
  tax: number | null
  error_msg: string | null
  created_at: string
}

type ActionFilter = 'ALL' | 'BUY' | 'SELL'
type StatusFilter = 'SUCCESS' | 'CANCELLED' | 'ALL'
type PeriodKey = '1' | '7' | '30' | '90'

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: '1',  label: '오늘' },
  { key: '7',  label: '7일' },
  { key: '30', label: '1개월' },
  { key: '90', label: '3개월' },
]

const STATUS_BADGE: Record<string, string> = {
  PENDING:   'bg-yellow-900/40 text-yellow-300',
  FILLED:    'bg-green-900/40 text-green-300',
  MOCK:      'bg-blue-900/40 text-blue-300',
  CANCELLED: 'bg-gray-800 text-gray-500',
}

function fmt(n: number | null | undefined) {
  if (n == null) return '-'
  return n.toLocaleString('ko-KR') + '원'
}

export default function AutoTradeHistory() {
  const [period, setPeriod]         = useState<PeriodKey>('7')
  const [action, setAction]         = useState<ActionFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('SUCCESS')
  const [logs, setLogs]             = useState<Log[]>([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: Record<string, unknown> = { days: Number(period), limit: 500 }
      if (action !== 'ALL') params.action = action
      const data = await getAutoTradeLogs(params)
      setLogs(data.logs ?? [])
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? '조회 실패')
    } finally {
      setLoading(false)
    }
  }, [period, action])

  useEffect(() => { load() }, [load])

  // 요약 통계 (상태 필터 적용)
  const isSuccess = (l: Log) => l.status === 'PENDING' || l.status === 'FILLED' || l.status === 'MOCK'
  const filteredLogs = logs.filter(l => {
    if (statusFilter === 'SUCCESS')   return isSuccess(l)
    if (statusFilter === 'CANCELLED') return l.status === 'CANCELLED'
    return true
  })
  const buys  = filteredLogs.filter(l => l.action === 'BUY')
  const sells = filteredLogs.filter(l => l.action === 'SELL')
  const filledSells = sells.filter(l => isSuccess(l))
  const totalPnl = filledSells.reduce((s, l) => s + (l.realized_pnl ?? 0), 0)
  const winCount = filledSells.filter(l => (l.realized_pnl ?? 0) > 0).length
  const winRate  = filledSells.length > 0 ? (winCount / filledSells.length) * 100 : 0
  const totalCost = filteredLogs.reduce((s, l) => s + (l.commission ?? 0) + (l.tax ?? 0), 0)

  const exportCsv = () => {
    const header = ['날짜', '종목코드', '종목명', '구분', '수량', '주문가', '체결가', '상태', 'AI점수', '실현손익', '수수료', '세금']
    const rows = logs.map(l => [
      l.trade_date, l.stock_code, l.stock_name, l.action,
      l.quantity, l.order_price, l.filled_price ?? '',
      l.status, l.composite_score?.toFixed(3) ?? '',
      l.realized_pnl ?? '', l.commission ?? '', l.tax ?? '',
    ])
    const csv = [header, ...rows].map(r => r.join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }))
    a.download = `auto_trade_${period}d.csv`
    a.click()
  }

  return (
    <div className="space-y-3">
      {/* 필터 */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* 기간 */}
        <div className="flex rounded-lg overflow-hidden border border-gray-800">
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                period === p.key ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}>{p.label}</button>
          ))}
        </div>

        {/* 구분 */}
        <div className="flex rounded-lg overflow-hidden border border-gray-800">
          {(['ALL', 'BUY', 'SELL'] as ActionFilter[]).map(a => (
            <button key={a} onClick={() => setAction(a)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                action === a
                  ? a === 'BUY' ? 'bg-emerald-700 text-white' : a === 'SELL' ? 'bg-red-700 text-white' : 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}>{a === 'ALL' ? '전체' : a === 'BUY' ? '매수' : '매도'}</button>
          ))}
        </div>

        {/* 상태 */}
        <div className="flex rounded-lg overflow-hidden border border-gray-800">
          {([['SUCCESS','체결'],['CANCELLED','취소'],['ALL','전체']] as [StatusFilter,string][]).map(([v,label]) => (
            <button key={v} onClick={() => setStatusFilter(v)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === v
                  ? v === 'CANCELLED' ? 'bg-gray-600 text-white' : 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}>{label}</button>
          ))}
        </div>

        <button onClick={load} disabled={loading} className="p-1.5 text-gray-500 hover:text-white disabled:opacity-40">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <span className="text-[11px] text-gray-600">{filteredLogs.length}/{logs.length}건</span>
        <button onClick={exportCsv} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">
          <Download size={12} />CSV
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* KPI 요약 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {[
          { label: '매수', value: `${buys.length}건`, color: 'text-blue-400' },
          { label: '매도', value: `${sells.length}건`, color: 'text-purple-400' },
          { label: '실현손익', value: fmt(totalPnl), color: totalPnl >= 0 ? 'text-green-400' : 'text-red-400' },
          { label: '매도 승률', value: filledSells.length > 0 ? `${winRate.toFixed(1)}%` : '-', color: 'text-yellow-400' },
          { label: '수수료+세금', value: totalCost > 0 ? `-${fmt(totalCost)}` : '-', color: 'text-orange-400' },
        ].map(k => (
          <div key={k.label} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="text-[10px] text-gray-500 mb-0.5">{k.label}</div>
            <div className={`text-sm font-semibold ${k.color}`}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* 테이블 */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {logs.length === 0 && !loading ? (
          <div className="py-12 text-center text-gray-600 text-sm">이력이 없습니다.</div>
        ) : filteredLogs.length === 0 ? (
          <div className="py-12 text-center text-gray-600 text-sm">필터 조건에 맞는 내역이 없습니다.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="px-3 py-2 text-left font-medium">날짜</th>
                  <th className="px-3 py-2 text-left font-medium">종목</th>
                  <th className="px-3 py-2 text-center font-medium">구분</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2 text-right font-medium">단가</th>
                  <th className="px-3 py-2 text-right font-medium">금액</th>
                  <th className="px-3 py-2 text-right font-medium">수수료</th>
                  <th className="px-3 py-2 text-right font-medium">세금</th>
                  <th className="px-3 py-2 text-center font-medium">상태</th>
                  <th className="px-3 py-2 text-center font-medium">AI점수</th>
                  <th className="px-3 py-2 text-right font-medium">손익</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {filteredLogs.map(l => (
                  <tr key={l.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                      {l.trade_date}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-200">{l.stock_name || l.stock_code}</div>
                      <div className="text-[10px] text-gray-600">{l.stock_code}</div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {l.action === 'BUY'
                        ? <span className="inline-flex items-center gap-0.5 text-blue-400"><TrendingUp size={10} />매수</span>
                        : <span className="inline-flex items-center gap-0.5 text-red-400"><TrendingDown size={10} />매도</span>
                      }
                    </td>
                    <td className="px-3 py-2 text-right text-gray-300">{l.quantity.toLocaleString()}주</td>
                    <td className="px-3 py-2 text-right text-gray-300">{l.order_price.toLocaleString()}원</td>
                    <td className="px-3 py-2 text-right text-gray-400">
                      {fmt(l.order_amount ?? l.order_price * l.quantity)}
                    </td>
                    <td className="px-3 py-2 text-right text-orange-400/80 tabular-nums">
                      {l.commission != null && l.commission > 0 ? `-${Math.round(l.commission).toLocaleString()}` : '-'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.action === 'SELL' && l.tax != null && l.tax > 0
                        ? <span className="text-orange-400/80">-{Math.round(l.tax).toLocaleString()}</span>
                        : <span className="text-gray-700">-</span>
                      }
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_BADGE[l.status] ?? 'text-gray-400'}`}>
                        {l.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-gray-400">
                      {l.composite_score != null ? (l.composite_score * 100).toFixed(0) + '%' : '-'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {l.realized_pnl != null
                        ? <span className={l.realized_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {l.realized_pnl >= 0 ? '+' : ''}{l.realized_pnl.toLocaleString()}원
                          </span>
                        : <span className="text-gray-700">-</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-[10px] text-gray-600 text-right">{filteredLogs.length}건 표시 / 전체 {logs.length}건</p>
    </div>
  )
}
