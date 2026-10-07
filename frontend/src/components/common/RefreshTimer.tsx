import { RefreshCw, Clock, Timer } from 'lucide-react'

interface Props {
  secondsLeft: number
  intervalSec: number     // 0 = 수동 전용
  lastRefreshed: Date
  isRefreshing: boolean
  onRefresh: () => void
  serverLabel?: string    // 예: "서버 5분", "캐시 30분"
}

function fmtCountdown(s: number): string {
  if (s <= 0) return '...'
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m > 0) return `${m}:${sec.toString().padStart(2, '0')}`
  return `${sec}s`
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export default function RefreshTimer({
  secondsLeft, intervalSec, lastRefreshed, isRefreshing, onRefresh, serverLabel,
}: Props) {
  const isManual = intervalSec <= 0
  const urgent   = !isManual && secondsLeft <= 10
  const warn     = !isManual && secondsLeft <= 30

  const countColor = urgent ? 'text-red-400' :
                     warn   ? 'text-yellow-400' : 'text-gray-400'

  return (
    <div className="flex items-center gap-2 text-xs select-none">
      {/* 서버 사이클 레이블 */}
      {serverLabel && (
        <span className="hidden sm:inline text-[10px] text-gray-600 bg-gray-800/60 px-1.5 py-0.5 rounded">
          {serverLabel}
        </span>
      )}

      {/* 카운트다운 or 수동 배지 */}
      {isManual ? (
        <span className="flex items-center gap-1 text-gray-600">
          <Timer size={10} />
          수동
        </span>
      ) : (
        <span className={`flex items-center gap-1 font-mono font-medium ${countColor}`}>
          <Clock size={10} />
          {fmtCountdown(secondsLeft)}
        </span>
      )}

      {/* 구분점 + 마지막 갱신 시각 */}
      <span className="text-gray-700">·</span>
      <span className="text-gray-500 text-[11px]">{fmtTime(lastRefreshed)}</span>

      {/* 수동 새로고침 버튼 */}
      <button
        onClick={onRefresh}
        disabled={isRefreshing}
        title="새로고침"
        className="p-1 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-200 disabled:opacity-40 transition-colors"
      >
        <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}
