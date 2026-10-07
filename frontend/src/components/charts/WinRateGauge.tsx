import { RadialBarChart, RadialBar, ResponsiveContainer } from 'recharts'

export default function WinRateGauge({ rate }: { rate: number }) {
  const data = [{ value: rate, fill: rate >= 50 ? '#22C55E' : '#EF4444' }]
  return (
    <div className="flex flex-col items-center">
      <ResponsiveContainer width={120} height={120}>
        <RadialBarChart innerRadius="60%" outerRadius="90%" data={data} startAngle={180} endAngle={0}>
          <RadialBar dataKey="value" cornerRadius={6} />
        </RadialBarChart>
      </ResponsiveContainer>
      <span className="text-xl font-bold -mt-6">{rate.toFixed(1)}%</span>
      <span className="text-xs text-gray-500">승률</span>
    </div>
  )
}
