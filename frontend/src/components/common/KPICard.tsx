interface KPICardProps {
  title: string
  value: string | number
  subtitle?: string
  color?: 'default' | 'green' | 'red' | 'blue'
}

const colorMap = {
  default: 'text-white',
  green: 'text-green-400',
  red: 'text-red-400',
  blue: 'text-blue-400',
}

export default function KPICard({ title, value, subtitle, color = 'default' }: KPICardProps) {
  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <p className="text-sm text-gray-400 mb-1">{title}</p>
      <p className={`text-2xl font-bold ${colorMap[color]}`}>{value}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  )
}
