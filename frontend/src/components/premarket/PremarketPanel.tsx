import { useState, useEffect, useCallback } from 'react'
import { Sunrise, RefreshCw, AlertCircle, Zap } from 'lucide-react'
import { getPremarketToday, triggerPremarketScan } from '../../api/client'

interface PremarketItem {
  id: number
  scan_date: string
  stock_code: string
  stock_name: string
  premarket_volume: number | null
  prev_avg_volume: number | null
  vol_ratio: number | null
  price_change_pct: number | null
  news_sentiment: number | null
  model_score: number | null
  combined_score: number | null
  signal: string
  signal_reasons: string[]
  priority_boost: boolean
  was_traded: boolean
}

const SIGNAL_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  STRONG_BUY: { bg: 'bg-red-500/20 border-red-500/50',   text: 'text-red-400',    label: '강력매수' },
  BUY:        { bg: 'bg-orange-500/20 border-orange-500/50', text: 'text-orange-400', label: '매수'   },
  WATCH:      { bg: 'bg-yellow-500/20 border-yellow-500/50', text: 'text-yellow-400', label: '관망'   },
  PASS:       { bg: 'bg-gray-800/60 border-gray-700',    text: 'text-gray-500',   label: '패스'   },
}

function fmtVol(v: number | null) {
  if (v == null) return '-'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`
  return String(v)
}

export default function PremarketPanel() {
  const [items, setItems] = useState<PremarketItem[]>([])
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getPremarketToday()
      setItems(data)
    } catch (_) {}
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleScan = async () => {
    setScanning(true)
    setMsg(null)
    try {
      const res = await triggerPremarketScan()
      setMsg(res.message || '스캔 완료')
      await load()
    } catch (_) {
      setMsg('스캔 실패')
    } finally {
      setScanning(false)
    }
  }

  const actionable = items.filter(i => i.signal === 'STRONG_BUY' || i.signal === 'BUY')
  const watch      = items.filter(i => i.signal === 'WATCH')

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
      {/* 헤더 */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <Sunrise size={15} className="text-amber-400" />
          <span className="text-sm font-semibold text-gray-100">프리장 거래량 신호</span>
          <span className="text-xs text-gray-500">08:10 자동 스캔</span>
          {actionable.length > 0 && (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 font-medium">
              <Zap size={10} />매수 후보 {actionable.length}개
            </span>
          )}
        </div>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={scanning ? 'animate-spin' : ''} />
            {scanning ? '스캔중…' : '재스캔'}
          </button>
          {loading && <RefreshCw size={13} className="text-gray-500 animate-spin" />}
        </div>
      </div>

      {msg && (
        <div className="mx-4 mb-2 px-3 py-1.5 rounded-lg bg-blue-900/40 text-xs text-blue-300 border border-blue-700/40">
          {msg}
        </div>
      )}

      {expanded && (
        <div className="border-t border-gray-800">
          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-500 flex flex-col items-center gap-2">
              <AlertCircle size={20} className="text-gray-600" />
              오늘 프리장 스캔 데이터 없음
              <span className="text-xs text-gray-600">08:10 자동 실행 또는 재스캔 버튼 클릭</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400">
                    <th className="text-left px-4 py-2 font-medium">종목</th>
                    <th className="text-right px-3 py-2 font-medium">프리장 거래량</th>
                    <th className="text-right px-3 py-2 font-medium">20일 평균 대비</th>
                    <th className="text-right px-3 py-2 font-medium">가격 변화</th>
                    <th className="text-right px-3 py-2 font-medium">뉴스</th>
                    <th className="text-right px-3 py-2 font-medium">AI 점수</th>
                    <th className="text-right px-3 py-2 font-medium">종합</th>
                    <th className="text-center px-3 py-2 font-medium">신호</th>
                  </tr>
                </thead>
                <tbody>
                  {/* 매수 후보 먼저 */}
                  {[...actionable, ...watch].map(item => {
                    const s = SIGNAL_STYLE[item.signal] || SIGNAL_STYLE.PASS
                    return (
                      <tr
                        key={item.id}
                        className={`border-b border-gray-800/60 hover:bg-gray-800/30 transition-colors ${
                          item.priority_boost ? 'bg-amber-950/10' : ''
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {item.priority_boost && (
                              <Zap size={10} className="text-amber-400 shrink-0" />
                            )}
                            <div>
                              <div className="font-medium text-white">{item.stock_name}</div>
                              <div className="text-gray-500">{item.stock_code}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">
                          {fmtVol(item.premarket_volume)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {item.vol_ratio != null ? (
                            <span className={
                              item.vol_ratio >= 5 ? 'text-red-400 font-bold' :
                              item.vol_ratio >= 2 ? 'text-orange-400 font-semibold' :
                              'text-gray-300'
                            }>
                              {item.vol_ratio.toFixed(1)}배
                            </span>
                          ) : <span className="text-gray-600">-</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {item.price_change_pct != null ? (
                            <span className={item.price_change_pct >= 0 ? 'text-red-400' : 'text-blue-400'}>
                              {item.price_change_pct > 0 ? '+' : ''}{item.price_change_pct.toFixed(1)}%
                            </span>
                          ) : <span className="text-gray-600">-</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {item.news_sentiment != null ? (
                            <span className={item.news_sentiment >= 0 ? 'text-green-400' : 'text-red-400'}>
                              {item.news_sentiment > 0 ? '+' : ''}{item.news_sentiment.toFixed(2)}
                            </span>
                          ) : <span className="text-gray-500">-</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {item.model_score != null ? (
                            <span className={item.model_score >= 0.65 ? 'text-green-400 font-semibold' : 'text-gray-300'}>
                              {(item.model_score * 100).toFixed(0)}
                            </span>
                          ) : <span className="text-gray-500">-</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                          {item.combined_score != null ? (
                            <span className={item.combined_score >= 0.7 ? 'text-red-400' : item.combined_score >= 0.55 ? 'text-orange-400' : 'text-gray-300'}>
                              {(item.combined_score * 100).toFixed(0)}
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${s.bg} ${s.text}`}>
                            {s.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
