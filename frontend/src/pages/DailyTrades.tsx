import { useEffect, useState, useCallback } from 'react'
import { getAutoTradeLogsByDate, getAutoTradeDailySummary } from '../api/client'
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown } from 'lucide-react'

interface Log {
  id: number
  stock_code: string; stock_name: string
  action: string; quantity: number
  order_price: number; order_amount: number | null
  filled_price: number | null; filled_amount: number | null
  composite_score: number | null; realized_pnl: number | null
  commission: number | null; tax: number | null
  trigger_models: string[]; status: string; error_msg: string | null
  created_at: string | null
}

interface DaySummary {
  date: string; total: number
  buy_count: number; sell_count: number
  buy_filled: number; sell_filled: number
  buy_amount: number; sell_amount: number
  realized_pnl: number
  total_commission: number; total_tax: number
}

const STATUS_BADGE: Record<string, string> = {
  PENDING:   'bg-yellow-900/50 text-yellow-300',
  FILLED:    'bg-emerald-900/50 text-emerald-300',
  MOCK:      'bg-blue-900/50 text-blue-300',
  CANCELLED: 'bg-gray-800 text-gray-500',
}
const STATUS_KO: Record<string, string> = {
  PENDING: '접수완료', FILLED: '체결완료', MOCK: '모의', CANCELLED: '취소',
}

type ActionFilter = 'ALL' | 'BUY' | 'SELL'
type StatusFilter = 'SUCCESS' | 'CANCELLED' | 'ALL'

function today() { return new Date().toISOString().slice(0, 10) }
function fmtAmt(n: number) {
  if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`
  if (Math.abs(n) >= 10_000)      return `${(n / 10_000).toFixed(0)}만`
  return n.toLocaleString()
}
function fmtFee(n: number) {
  return Math.round(n).toLocaleString()
}

export default function DailyTrades() {
  const [selectedDate, setSelectedDate] = useState(today())
  const [logs, setLogs]                 = useState<Log[]>([])
  const [summary, setSummary]           = useState<DaySummary[]>([])
  const [loading, setLoading]           = useState(false)
  const [actionFilter, setActionFilter] = useState<ActionFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('SUCCESS')

  const loadLogs = useCallback(async (d: string) => {
    setLoading(true)
    try {
      const data = await getAutoTradeLogsByDate(d)
      setLogs(data.logs ?? [])
    } catch { setLogs([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    getAutoTradeDailySummary(90).then(setSummary).catch(() => setSummary([]))
  }, [])

  useEffect(() => { loadLogs(selectedDate) }, [loadLogs, selectedDate])

  const moveDay = (delta: number) => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + delta)
    setSelectedDate(d.toISOString().slice(0, 10))
  }

  const isSuccess   = (l: Log) => l.status === 'PENDING' || l.status === 'FILLED' || l.status === 'MOCK'
  const filledBuys  = logs.filter(l => l.action === 'BUY'  && isSuccess(l))
  const filledSells = logs.filter(l => l.action === 'SELL' && isSuccess(l))

  const filteredLogs = logs.filter(l => {
    if (actionFilter !== 'ALL' && l.action !== actionFilter) return false
    if (statusFilter === 'SUCCESS')   return isSuccess(l)
    if (statusFilter === 'CANCELLED') return l.status === 'CANCELLED'
    return true
  })

  const buyAmt        = filledBuys.reduce((s, l)  => s + (l.filled_amount ?? l.order_amount ?? 0), 0)
  const sellAmt       = filledSells.reduce((s, l) => s + (l.filled_amount ?? l.order_amount ?? 0), 0)
  const totalPnl      = filledSells.reduce((s, l) => s + (l.realized_pnl ?? 0), 0)
  const totalFee      = logs.filter(isSuccess).reduce((s, l) => s + (l.commission ?? 0), 0)
  const totalTax      = logs.filter(isSuccess).reduce((s, l) => s + (l.tax ?? 0), 0)

  const selectedSummary = summary.find(s => s.date === selectedDate)
  const summaryFee  = selectedSummary?.total_commission ?? totalFee
  const summaryTax  = selectedSummary?.total_tax ?? totalTax
  const summaryPnl  = selectedSummary?.realized_pnl ?? totalPnl
  const summaryNet  = summaryPnl - summaryFee - summaryTax

  return (
    <div className="space-y-4">

      {/* 날짜 선택 */}
      <div className="flex items-center gap-2">
        <button onClick={() => moveDay(-1)} className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400">
          <ChevronLeft size={16} />
        </button>
        <input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 [color-scheme:dark]"
        />
        <button onClick={() => moveDay(1)} className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400"
          disabled={selectedDate >= today()}>
          <ChevronRight size={16} />
        </button>
        <button onClick={() => setSelectedDate(today())}
          className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400">
          오늘
        </button>
      </div>

      {/* KPI 카드 — 2줄 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* 1행: 매수/매도/수수료+세금/순손익 */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-[10px] text-gray-500 mb-1">매수금액</div>
          <div className="text-base font-semibold text-blue-400">
            {fmtAmt(selectedSummary?.buy_amount ?? buyAmt)}원
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">
            {selectedSummary?.buy_filled ?? filledBuys.length}건 체결
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-[10px] text-gray-500 mb-1">매도금액</div>
          <div className="text-base font-semibold text-purple-400">
            {fmtAmt(selectedSummary?.sell_amount ?? sellAmt)}원
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">
            {selectedSummary?.sell_filled ?? filledSells.length}건 체결
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-[10px] text-gray-500 mb-1">수수료 + 세금</div>
          <div className="text-base font-semibold text-orange-400">
            -{fmtFee(summaryFee + summaryTax)}원
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5 flex gap-2">
            <span>수수료 {fmtFee(summaryFee)}원</span>
            <span className="text-gray-700">|</span>
            <span>세금 {fmtFee(summaryTax)}원</span>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-[10px] text-gray-500 mb-1">순손익 <span className="text-gray-700">(실현 − 수수료 − 세금)</span></div>
          <div className={`text-base font-semibold ${summaryNet >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {summaryNet >= 0 ? '+' : ''}{fmtFee(summaryNet)}원
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">
            실현손익 {summaryPnl >= 0 ? '+' : ''}{fmtFee(summaryPnl)}원
          </div>
        </div>
      </div>

      {/* 매매 내역 테이블 */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold shrink-0">매매 내역</h2>

          <div className="flex rounded-lg overflow-hidden border border-gray-700/60">
            {([['ALL','전체'],['BUY','매수'],['SELL','매도']] as [ActionFilter,string][]).map(([v,label]) => (
              <button key={v} onClick={() => setActionFilter(v)}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  actionFilter === v
                    ? v === 'BUY' ? 'bg-emerald-700 text-white' : v === 'SELL' ? 'bg-red-700 text-white' : 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`}>{label}</button>
            ))}
          </div>

          <div className="flex rounded-lg overflow-hidden border border-gray-700/60">
            {([['SUCCESS','체결'],['CANCELLED','취소'],['ALL','전체']] as [StatusFilter,string][]).map(([v,label]) => (
              <button key={v} onClick={() => setStatusFilter(v)}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  statusFilter === v
                    ? v === 'CANCELLED' ? 'bg-gray-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`}>{label}</button>
            ))}
          </div>

          <span className="text-xs text-gray-600 ml-auto">
            {loading ? '조회중...' : `${filteredLogs.length}/${logs.length}건`}
          </span>
        </div>

        {logs.length === 0 && !loading ? (
          <div className="py-10 text-center text-gray-600 text-sm">
            {selectedDate}에 자동매매 내역이 없습니다
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="py-10 text-center text-gray-600 text-sm">
            필터 조건에 맞는 내역이 없습니다
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[720px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-2 text-left font-medium">종목</th>
                  <th className="px-3 py-2 text-center font-medium">구분</th>
                  <th className="px-3 py-2 text-center font-medium">상태</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2 text-right font-medium">체결가</th>
                  <th className="px-3 py-2 text-right font-medium">체결금액</th>
                  <th className="px-3 py-2 text-right font-medium">수수료</th>
                  <th className="px-3 py-2 text-right font-medium">세금</th>
                  <th className="px-3 py-2 text-right font-medium">실현손익</th>
                  <th className="px-3 py-2 text-right font-medium">순손익</th>
                  <th className="px-3 py-2 text-left font-medium">사유</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {filteredLogs.map(l => {
                  const reason  = l.error_msg ?? (l.trigger_models ?? []).join(', ')
                  const fee     = l.commission ?? 0
                  const tax     = l.tax ?? 0
                  const pnl     = l.realized_pnl
                  const netRow  = pnl != null ? pnl - fee - tax : null
                  return (
                    <tr key={l.id} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-200">{l.stock_name || l.stock_code}</div>
                        <div className="text-[10px] text-gray-600">{l.stock_code}</div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {l.action === 'BUY'
                          ? <span className="inline-flex items-center gap-0.5 text-emerald-400"><TrendingUp size={10}/>매수</span>
                          : <span className="inline-flex items-center gap-0.5 text-red-400"><TrendingDown size={10}/>매도</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_BADGE[l.status] ?? 'text-gray-400'}`}>
                          {STATUS_KO[l.status] ?? l.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-300">{l.quantity.toLocaleString()}주</td>
                      <td className="px-3 py-2.5 text-right text-gray-300">
                        {l.filled_price != null ? l.filled_price.toLocaleString() + '원' : l.order_price.toLocaleString() + '원'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-400">
                        {l.filled_amount != null
                          ? fmtAmt(l.filled_amount) + '원'
                          : l.order_amount != null ? fmtAmt(l.order_amount) + '원' : '-'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-orange-400/80">
                        {fee > 0 ? `-${fmtFee(fee)}원` : <span className="text-gray-700">-</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right text-orange-400/60">
                        {tax > 0 ? `-${fmtFee(tax)}원` : <span className="text-gray-700">-</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {pnl != null
                          ? <span className={pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                              {pnl >= 0 ? '+' : ''}{Math.round(pnl).toLocaleString()}원
                            </span>
                          : <span className="text-gray-700">-</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {netRow != null
                          ? <span className={`font-medium ${netRow >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                              {netRow >= 0 ? '+' : ''}{Math.round(netRow).toLocaleString()}원
                            </span>
                          : <span className="text-gray-700">-</span>}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 max-w-[160px] truncate" title={reason}>
                        {reason || '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {/* 합계 행 */}
              {filteredLogs.some(isSuccess) && (() => {
                const visibleSuccess = filteredLogs.filter(isSuccess)
                const sumFee    = visibleSuccess.reduce((s, l) => s + (l.commission ?? 0), 0)
                const sumTax    = visibleSuccess.reduce((s, l) => s + (l.tax ?? 0), 0)
                const sumPnl    = visibleSuccess.reduce((s, l) => s + (l.realized_pnl ?? 0), 0)
                const sumNet    = sumPnl - sumFee - sumTax
                return (
                  <tfoot>
                    <tr className="border-t border-gray-700 bg-gray-800/40 text-[11px] font-medium">
                      <td colSpan={6} className="px-4 py-2 text-gray-500">필터 합계 ({visibleSuccess.length}건)</td>
                      <td className="px-3 py-2 text-right text-orange-400/80">-{fmtFee(sumFee)}원</td>
                      <td className="px-3 py-2 text-right text-orange-400/60">-{fmtFee(sumTax)}원</td>
                      <td className="px-3 py-2 text-right">
                        <span className={sumPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {sumPnl >= 0 ? '+' : ''}{fmtFee(sumPnl)}원
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={sumNet >= 0 ? 'text-emerald-300' : 'text-red-300'}>
                          {sumNet >= 0 ? '+' : ''}{fmtFee(sumNet)}원
                        </span>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )
              })()}
            </table>
          </div>
        )}
      </div>

      {/* 최근 날짜별 요약 */}
      {summary.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <h2 className="text-sm font-semibold">최근 매매 현황 <span className="text-gray-600 font-normal text-xs ml-1">(클릭하면 해당 날짜 조회)</span></h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[600px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-2 text-left font-medium">날짜</th>
                  <th className="px-3 py-2 text-right font-medium">매수</th>
                  <th className="px-3 py-2 text-right font-medium">매도</th>
                  <th className="px-3 py-2 text-right font-medium">매수금액</th>
                  <th className="px-3 py-2 text-right font-medium">매도금액</th>
                  <th className="px-3 py-2 text-right font-medium">수수료+세금</th>
                  <th className="px-3 py-2 text-right font-medium">실현손익</th>
                  <th className="px-3 py-2 text-right font-medium">순손익</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {summary.map(s => {
                  const fee = (s.total_commission ?? 0) + (s.total_tax ?? 0)
                  const net = s.realized_pnl - fee
                  return (
                    <tr
                      key={s.date}
                      onClick={() => setSelectedDate(s.date)}
                      className={`cursor-pointer transition-colors ${
                        s.date === selectedDate
                          ? 'bg-blue-950/40 hover:bg-blue-950/60'
                          : 'hover:bg-gray-800/40'
                      }`}
                    >
                      <td className="px-4 py-2.5 font-medium text-gray-300">{s.date}</td>
                      <td className="px-3 py-2.5 text-right text-emerald-400">{s.buy_count}건</td>
                      <td className="px-3 py-2.5 text-right text-red-400">{s.sell_count}건</td>
                      <td className="px-3 py-2.5 text-right text-gray-400">{fmtAmt(s.buy_amount)}원</td>
                      <td className="px-3 py-2.5 text-right text-gray-400">{fmtAmt(s.sell_amount)}원</td>
                      <td className="px-3 py-2.5 text-right text-orange-400/70">
                        {fee > 0 ? `-${fmtFee(fee)}원` : '-'}
                      </td>
                      <td className={`px-3 py-2.5 text-right ${s.realized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {s.realized_pnl >= 0 ? '+' : ''}{Math.round(s.realized_pnl).toLocaleString()}원
                      </td>
                      <td className={`px-3 py-2.5 text-right font-medium ${net >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                        {net >= 0 ? '+' : ''}{Math.round(net).toLocaleString()}원
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
