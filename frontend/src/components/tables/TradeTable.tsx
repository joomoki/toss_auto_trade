import SignalBadge from '../common/SignalBadge'

export interface Trade {
  id: number
  stock_code: string
  stock_name: string
  trade_type: 'BUY' | 'SELL'
  order_qty: number
  order_price: number
  filled_price: number | null
  filled_amount: number | null
  status: string
  trade_date: string
  filled_at: string | null
}

const fmtKRW = (v: number | null) => v != null ? `${v.toLocaleString()}원` : '-'

export default function TradeTable({ trades }: { trades: Trade[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-800 text-gray-400 text-left">
            <th className="px-4 py-3">종목</th>
            <th className="px-4 py-3">구분</th>
            <th className="px-4 py-3 text-right">수량</th>
            <th className="px-4 py-3 text-right">주문가</th>
            <th className="px-4 py-3 text-right">체결가</th>
            <th className="px-4 py-3 text-right">체결금액</th>
            <th className="px-4 py-3">상태</th>
            <th className="px-4 py-3">체결시간</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr
              key={t.id}
              className={`border-t border-gray-800 ${
                t.trade_type === 'BUY' ? 'bg-green-950/20' : 'bg-red-950/20'
              }`}
            >
              <td className="px-4 py-3">
                <div className="font-medium">{t.stock_name || t.stock_code}</div>
                <div className="text-xs text-gray-500">{t.stock_code}</div>
              </td>
              <td className="px-4 py-3">
                <SignalBadge type={t.trade_type} />
              </td>
              <td className="px-4 py-3 text-right">{t.order_qty.toLocaleString()}</td>
              <td className="px-4 py-3 text-right">{fmtKRW(t.order_price)}</td>
              <td className="px-4 py-3 text-right">{fmtKRW(t.filled_price)}</td>
              <td className="px-4 py-3 text-right">{fmtKRW(t.filled_amount)}</td>
              <td className="px-4 py-3">
                <span className={`text-xs ${t.status === 'FILLED' ? 'text-green-400' : t.status === 'CANCELLED' ? 'text-red-400' : 'text-yellow-400'}`}>
                  {t.status}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-gray-400">
                {t.filled_at ? new Date(t.filled_at).toLocaleTimeString('ko-KR') : '-'}
              </td>
            </tr>
          ))}
          {trades.length === 0 && (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">매매 내역이 없습니다</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
