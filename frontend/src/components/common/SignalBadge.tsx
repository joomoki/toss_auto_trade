type SignalType = 'BUY' | 'SELL' | 'HOLD'

const badgeStyle: Record<SignalType, string> = {
  BUY: 'bg-green-900 text-green-300 border border-green-700',
  SELL: 'bg-red-900 text-red-300 border border-red-700',
  HOLD: 'bg-gray-800 text-gray-400 border border-gray-700',
}

export default function SignalBadge({ type }: { type: SignalType }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${badgeStyle[type]}`}>
      {type}
    </span>
  )
}
