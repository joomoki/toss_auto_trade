import {
  ComposedChart, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts'

interface DataPoint {
  date: string
  cumulative_pnl: number
  daily_pnl: number
}

function fmtMoney(v: number, short = false): string {
  const sign = v >= 0 ? '+' : ''
  if (short) {
    if (Math.abs(v) >= 100_000_000) return `${sign}${(v / 100_000_000).toFixed(1)}억`
    if (Math.abs(v) >= 10_000)      return `${sign}${(v / 10_000).toFixed(0)}만`
    return `${sign}${v.toLocaleString()}`
  }
  return `${sign}${v.toLocaleString()}원`
}

function fmtDate(d: string): string {
  const dt = new Date(d)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const cum   = (payload.find((p: { dataKey: string; value: number }) => p.dataKey === 'cumulative_pnl')?.value ?? 0) as number
  const daily = (payload.find((p: { dataKey: string; value: number }) => p.dataKey === 'daily_pnl')?.value  ?? 0) as number
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-xs shadow-2xl min-w-[140px]">
      <div className="text-gray-400 font-medium mb-2">{label}</div>
      <div className="space-y-1">
        <div className="flex justify-between items-center gap-4">
          <span className="text-gray-500">누적 손익</span>
          <span className={`font-bold tabular-nums ${cum >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmtMoney(cum)}
          </span>
        </div>
        <div className="flex justify-between items-center gap-4">
          <span className="text-gray-500">당일 손익</span>
          <span className={`font-semibold tabular-nums ${daily >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmtMoney(daily)}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function PnLChart({ data }: { data: DataPoint[] }) {
  if (!data || data.length === 0) {
    return (
      <div className="h-64 flex flex-col items-center justify-center gap-1 text-gray-600">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-30 mb-1">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <p className="text-sm">아직 실현손익 데이터가 없습니다</p>
        <p className="text-xs">자동매매로 매도가 체결되면 차트에 표시됩니다</p>
      </div>
    )
  }

  const vals   = data.map(d => d.cumulative_pnl)
  const maxV   = Math.max(0, ...vals)
  const minV   = Math.min(0, ...vals)
  const range  = maxV - minV || 1
  // gradient stop at the zero crossing point (% from top)
  const zeroPct = `${((maxV / range) * 100).toFixed(1)}%`

  const lastVal    = data[data.length - 1]?.cumulative_pnl ?? 0
  const lineColor  = lastVal >= 0 ? '#10B981' : '#EF4444'

  // padding so bars don't clip at edges
  const yPad = range * 0.12

  return (
    <div className="space-y-1">
      {/* 범례 */}
      <div className="flex items-center gap-4 px-1 text-[11px] text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-emerald-400 inline-block rounded" />
          누적 손익
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2.5 bg-emerald-600/70 inline-block rounded-sm" />
          <span className="w-3 h-2.5 bg-red-700/70 inline-block rounded-sm" />
          일별 손익
        </span>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"    stopColor="#10B981" stopOpacity={0.35} />
              <stop offset={zeroPct} stopColor="#10B981" stopOpacity={0.04} />
              <stop offset={zeroPct} stopColor="#EF4444" stopOpacity={0.04} />
              <stop offset="100%" stopColor="#EF4444"  stopOpacity={0.35} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" vertical={false} />

          <XAxis
            dataKey="date"
            tickFormatter={fmtDate}
            tick={{ fill: '#6B7280', fontSize: 11 }}
            axisLine={{ stroke: '#374151' }}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            domain={[minV - yPad, maxV + yPad]}
            tickFormatter={v => fmtMoney(v, true)}
            tick={{ fill: '#6B7280', fontSize: 11 }}
            width={68}
            axisLine={false}
            tickLine={false}
            tickCount={6}
          />

          <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#374151', strokeWidth: 1 }} />

          {/* 0 기준선 */}
          <ReferenceLine y={0} stroke="#4B5563" strokeWidth={1.5} strokeDasharray="4 3" />

          {/* 일별 손익 바 (뒤) */}
          <Bar dataKey="daily_pnl" maxBarSize={20} radius={[2, 2, 0, 0]} opacity={0.75}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.daily_pnl >= 0 ? '#059669' : '#DC2626'} />
            ))}
          </Bar>

          {/* 누적 손익 에어리어 (앞) */}
          <Area
            type="monotone"
            dataKey="cumulative_pnl"
            stroke={lineColor}
            fill="url(#pnlGrad)"
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4.5, fill: lineColor, stroke: '#111827', strokeWidth: 2 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
