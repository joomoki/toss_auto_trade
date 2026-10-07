import { useEffect, useState, useCallback } from 'react'
import { TrendingUp, TrendingDown, Activity, Users, Building2 } from 'lucide-react'
import { getSupplyMarket, getSupplyWatchlist } from '../api/client'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

// ── 타입 ──────────────────────────────────────────────────────────────────────
interface IndexInfo {
  kospi: number
  kospi_change_pct: number
  kosdaq: number
  kosdaq_change_pct: number
  market_score: number
  available: boolean
}

interface TopStock {
  stock_code: string
  stock_name: string
  foreign_net: number
}

interface SupplyItem {
  stock_code: string
  stock_name?: string
  foreign_net: number
  institution_net: number
  supply_score: number
  available: boolean
  daily?: { date: string; foreign_net: number; institution_net: number }[]
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
const fmt = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : '+'
  if (abs >= 1_000_000_000_000) return sign + (abs / 1_000_000_000_000).toFixed(1) + '조'
  if (abs >= 100_000_000)       return sign + (abs / 100_000_000).toFixed(0) + '억'
  if (abs >= 10_000)            return sign + (abs / 10_000).toFixed(0) + '만'
  return sign + abs.toLocaleString()
}

const scoreColor = (s: number) =>
  s >= 0.65 ? 'text-emerald-400' : s <= 0.35 ? 'text-red-400' : 'text-gray-300'

const scoreBg = (s: number) =>
  s >= 0.65 ? 'bg-emerald-900/40 border-emerald-700' :
  s <= 0.35 ? 'bg-red-900/40 border-red-700' :
              'bg-gray-800 border-gray-700'

// ── 수급 바 컴포넌트 ──────────────────────────────────────────────────────────
function NetBar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (Math.abs(value) / (max + 1)) * 100)
  const pos = value >= 0
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-1.5 bg-gray-800 rounded-full overflow-hidden flex justify-center">
        <div
          className={`h-full rounded-full ${pos ? 'bg-emerald-500' : 'bg-red-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-mono ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
        {fmt(value)}
      </span>
    </div>
  )
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────
export default function Supply() {
  const [indexInfo, setIndexInfo]   = useState<IndexInfo | null>(null)
  const [topKospi, setTopKospi]     = useState<TopStock[]>([])
  const [topKosdaq, setTopKosdaq]   = useState<TopStock[]>([])
  const [watchlist, setWatchlist]   = useState<SupplyItem[]>([])
  const [days, setDays]             = useState(5)
  const [loading, setLoading]       = useState(false)
  const [tab, setTab]               = useState<'watchlist' | 'market'>('watchlist')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [mkt, wl] = await Promise.all([
        getSupplyMarket(),
        getSupplyWatchlist(days),
      ])
      setIndexInfo(mkt.index)
      setTopKospi(mkt.top_foreign_kospi  ?? [])
      setTopKosdaq(mkt.top_foreign_kosdaq ?? [])
      setWatchlist(wl.items ?? [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [days])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(1800, load)

  useEffect(() => { load() }, [load])

  const maxForeign = Math.max(...watchlist.map(w => Math.abs(w.foreign_net)), 1)
  const maxInst    = Math.max(...watchlist.map(w => Math.abs(w.institution_net)), 1)
  const maxTop     = Math.max(...[...topKospi, ...topKosdaq].map(t => Math.abs(t.foreign_net)), 1)

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">수급 분석</h1>
          <p className="text-xs text-gray-500 mt-0.5">지수: yfinance · 수급: pykrx (KRX 공식)</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 text-xs rounded px-2 py-1.5 text-gray-200"
          >
            {[3, 5, 10, 20].map(d => (
              <option key={d} value={d}>{d}거래일</option>
            ))}
          </select>
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={1800}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy || loading}
            onRefresh={timerRefresh}
            serverLabel="캐시 30분"
          />
        </div>
      </div>

      {/* 지수 카드 */}
      {indexInfo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'KOSPI', value: indexInfo.kospi, chg: indexInfo.kospi_change_pct },
            { label: 'KOSDAQ', value: indexInfo.kosdaq, chg: indexInfo.kosdaq_change_pct },
          ].map(({ label, value, chg }) => (
            <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="text-lg font-bold mt-0.5">{value.toLocaleString()}</p>
              <div className={`flex items-center gap-1 text-xs mt-1 font-medium ${chg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {chg >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
              </div>
            </div>
          ))}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-500">시장 점수</p>
            <p className={`text-lg font-bold mt-0.5 ${scoreColor(indexInfo.market_score)}`}>
              {(indexInfo.market_score * 100).toFixed(0)}점
            </p>
            <p className="text-xs text-gray-600 mt-1">
              {indexInfo.market_score >= 0.6 ? '긍정적' : indexInfo.market_score <= 0.4 ? '부정적' : '중립'}
            </p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-500">데이터 상태</p>
            <p className={`text-sm font-semibold mt-1 ${indexInfo.available ? 'text-emerald-400' : 'text-yellow-400'}`}>
              {indexInfo.available ? '정상' : '장외/주말'}
            </p>
            <p className="text-xs text-gray-600 mt-1">yfinance</p>
          </div>
        </div>
      )}

      {/* 탭 */}
      <div className="flex gap-1 border-b border-gray-800">
        {(['watchlist', 'market'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === t ? 'border-violet-500 text-violet-300' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t === 'watchlist' ? '워치리스트 수급' : '외국인 순매수 TOP'}
          </button>
        ))}
      </div>

      {/* 워치리스트 수급 탭 */}
      {tab === 'watchlist' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {watchlist.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-12">
              {loading ? '데이터 로딩 중…' : '워치리스트 종목이 없습니다.'}
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="text-left px-4 py-2.5">종목</th>
                  <th className="text-center px-3 py-2.5">수급점수</th>
                  <th className="text-left px-3 py-2.5">
                    <span className="flex items-center gap-1"><Users size={10} />외국인 순매수</span>
                  </th>
                  <th className="text-left px-3 py-2.5">
                    <span className="flex items-center gap-1"><Building2 size={10} />기관 순매수</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {watchlist.map(item => (
                  <tr key={item.stock_code} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-200">{item.stock_name || item.stock_code}</div>
                      <div className="text-gray-600">{item.stock_code}</div>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {item.available ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${scoreBg(item.supply_score)} ${scoreColor(item.supply_score)}`}>
                          <Activity size={9} />
                          {(item.supply_score * 100).toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.available
                        ? <NetBar value={item.foreign_net} max={maxForeign} />
                        : <span className="text-gray-600">-</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.available
                        ? <NetBar value={item.institution_net} max={maxInst} />
                        : <span className="text-gray-600">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 외국인 순매수 TOP 탭 */}
      {tab === 'market' && (
        <div className="grid md:grid-cols-2 gap-4">
          {[
            { label: 'KOSPI 외국인 순매수 TOP 10', items: topKospi },
            { label: 'KOSDAQ 외국인 순매수 TOP 10', items: topKosdaq },
          ].map(({ label, items }) => (
            <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-800">
                <h3 className="text-xs font-semibold text-gray-300">{label}</h3>
              </div>
              {items.length === 0 ? (
                <p className="text-xs text-gray-500 text-center py-8">
                  {loading ? '로딩 중…' : '데이터 없음 (장외 시간)'}
                </p>
              ) : (
                <div className="divide-y divide-gray-800/50">
                  {items.map((s, i) => (
                    <div key={s.stock_code} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/30">
                      <span className="text-xs text-gray-600 w-4">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-200 truncate">{s.stock_name || s.stock_code}</div>
                        <div className="text-gray-600 text-[10px]">{s.stock_code}</div>
                      </div>
                      <div className="shrink-0">
                        <NetBar value={s.foreign_net} max={maxTop} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
