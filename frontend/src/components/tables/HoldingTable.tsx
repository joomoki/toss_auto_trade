import { Clock } from 'lucide-react'

export interface Holding {
  id: number
  stock_code: string
  stock_name: string
  quantity: number
  avg_buy_price: number
  current_price: number | null
  unrealized_pnl: number | null
  unrealized_pnl_pct: number | null
  is_manual?: boolean
  is_long_term?: boolean
}

export interface PendingBuy {
  stock_code: string
  stock_name: string
  order_price: number
  quantity: number
  order_amount: number | null
  ordered_at: string | null
  wait_minutes: number
}

const fmtKRW = (v: number | null) => v != null ? `${v.toLocaleString()}원` : '-'
const fmtPct = (v: number | null) => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '-'

export default function HoldingTable({
  holdings,
  pendingBuys = [],
}: {
  holdings: Holding[]
  pendingBuys?: PendingBuy[]
}) {
  const pendingCodes = new Set(pendingBuys.map(p => p.stock_code))
  const completedHoldings = holdings.filter(h => !pendingCodes.has(h.stock_code))
  const totalRows = pendingBuys.length + completedHoldings.length

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-800 text-gray-400 text-left">
            <th className="px-4 py-3">종목</th>
            <th className="px-4 py-3 text-right">수량</th>
            <th className="px-4 py-3 text-right">평균단가</th>
            <th className="px-4 py-3 text-right">현재가</th>
            <th className="px-4 py-3 text-right">평가손익</th>
            <th className="px-4 py-3 text-right">수익률</th>
          </tr>
        </thead>
        <tbody>
          {/* ── 매수 진행중 ──────────────────────────── */}
          {pendingBuys.map((p) => (
            <tr key={`pending-${p.stock_code}`}
                className="border-t border-amber-900/40 bg-amber-950/20 hover:bg-amber-950/30">
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-amber-200">{p.stock_name || p.stock_code}</span>
                  <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded
                                   bg-amber-900/60 border border-amber-600/60 text-amber-300">
                    <Clock size={9} className="shrink-0" />
                    매수 진행중
                  </span>
                </div>
                <div className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
                  <span>{p.stock_code}</span>
                  {p.wait_minutes > 0 && (
                    <span className="text-amber-600">{p.wait_minutes}분 대기</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-right text-amber-200">{p.quantity.toLocaleString()}</td>
              <td className="px-4 py-3 text-right">
                <div className="text-amber-200">{fmtKRW(p.order_price)}</div>
                <div className="text-[10px] text-gray-500">주문가</div>
              </td>
              <td className="px-4 py-3 text-right text-gray-500">-</td>
              <td className="px-4 py-3 text-right text-gray-500">-</td>
              <td className="px-4 py-3 text-right text-gray-500">-</td>
            </tr>
          ))}

          {/* ── 매수 완료 (보유 중) ────────────────── */}
          {completedHoldings.map((h) => {
            const isProfit = (h.unrealized_pnl ?? 0) >= 0
            return (
              <tr key={h.id} className="border-t border-gray-800 hover:bg-gray-800/40">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{h.stock_name || h.stock_code}</span>
                    {h.is_long_term ? (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-900/60 border border-emerald-700/50 text-emerald-300">
                        🌱 장기
                      </span>
                    ) : (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-900/60 border border-sky-700/50 text-sky-300">
                        ⚡ 단기
                      </span>
                    )}
                    {h.is_manual && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-900/60 border border-violet-700/50 text-violet-300">
                        수동
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">{h.stock_code}</div>
                </td>
                <td className="px-4 py-3 text-right">{h.quantity.toLocaleString()}</td>
                <td className="px-4 py-3 text-right">{fmtKRW(h.avg_buy_price)}</td>
                <td className="px-4 py-3 text-right">{fmtKRW(h.current_price)}</td>
                <td className={`px-4 py-3 text-right font-medium ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
                  {fmtKRW(h.unrealized_pnl)}
                </td>
                <td className={`px-4 py-3 text-right ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
                  {fmtPct(h.unrealized_pnl_pct)}
                </td>
              </tr>
            )
          })}

          {totalRows === 0 && (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">보유 종목이 없습니다</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
