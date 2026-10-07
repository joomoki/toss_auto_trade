import { useEffect, useState, useCallback } from 'react'
import api from '../api/client'
import { TrendingUp, TrendingDown, AlertTriangle, ExternalLink, FileText, Zap } from 'lucide-react'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

// ── 타입 ────────────────────────────────────────────────
interface DartItem {
  id: number
  rcept_no: string
  rcept_dt: string
  corp_name: string
  stock_code: string | null
  corp_cls: string | null
  report_nm: string
  filer_nm: string | null
  disclosure_type: string | null
  dart_score: number | null
  is_positive: boolean | null
  dart_url: string
}

interface DartStats {
  days: number
  total: number
  positive: number
  negative: number
  by_type: { type: string; count: number }[]
  hot_disclosures: DartItem[]
  risk_disclosures: DartItem[]
  dart_api_configured: boolean
}

// ── 유틸 ────────────────────────────────────────────────
const CLS_LABEL: Record<string, string> = { Y: '유가증권', K: '코스닥', N: '코넥스', E: '기타' }

function ScoreBadge({ score, type }: { score: number | null; type: string | null }) {
  if (score === null || score === 0) {
    return <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{type ?? '기타'}</span>
  }
  const isPos = score > 0
  const abs = Math.abs(score)
  const intensity = abs >= 0.7 ? 'font-bold' : ''
  return (
    <span className={`text-xs px-2 py-0.5 rounded flex items-center gap-1 ${
      isPos ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/50 text-red-300'
    } ${intensity}`}>
      {isPos ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {type ?? '기타'}
      <span className="opacity-70">({isPos ? '+' : ''}{score.toFixed(2)})</span>
    </span>
  )
}

function DartRow({ item }: { item: DartItem }) {
  const isSignal = item.dart_score !== null && item.dart_score !== 0
  return (
    <tr className={`border-t border-gray-800 hover:bg-gray-800/40 transition-colors ${
      isSignal && !item.is_positive ? 'bg-red-950/10' : isSignal ? 'bg-emerald-950/10' : ''
    }`}>
      <td className="py-2.5 px-3 text-xs text-gray-400 whitespace-nowrap">{item.rcept_dt}</td>
      <td className="py-2.5 px-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium">{item.corp_name}</span>
          {item.stock_code && (
            <span className="text-xs text-gray-500">{item.stock_code}
              {item.corp_cls && <span className="ml-1 text-gray-600">{CLS_LABEL[item.corp_cls] ?? item.corp_cls}</span>}
            </span>
          )}
        </div>
      </td>
      <td className="py-2.5 px-3">
        <a href={item.dart_url} target="_blank" rel="noreferrer"
          className="text-sm text-gray-200 hover:text-blue-400 flex items-start gap-1.5 group">
          <span className="leading-snug">{item.report_nm}</span>
          <ExternalLink size={11} className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-70 transition-opacity" />
        </a>
      </td>
      <td className="py-2.5 px-3">
        <ScoreBadge score={item.dart_score} type={item.disclosure_type} />
      </td>
    </tr>
  )
}

// ── 통계 카드 ────────────────────────────────────────────
function StatsPanel({ stats }: { stats: DartStats }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: `최근 ${stats.days}일 공시`, value: `${stats.total.toLocaleString()}건`, icon: <FileText size={14} className="text-blue-400" /> },
          { label: '호재 공시', value: `${stats.positive}건`, icon: <TrendingUp size={14} className="text-emerald-400" />, cls: 'text-emerald-400' },
          { label: '악재 공시', value: `${stats.negative}건`, icon: <TrendingDown size={14} className="text-red-400" />, cls: 'text-red-400' },
          { label: '시그널 비율', value: stats.total > 0 ? `${(((stats.positive + stats.negative) / stats.total) * 100).toFixed(1)}%` : '-', icon: <Zap size={14} className="text-yellow-400" /> },
        ].map(k => (
          <div key={k.label} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              {k.icon}
              <span className="text-xs text-gray-400">{k.label}</span>
            </div>
            <div className={`text-xl font-bold ${k.cls ?? ''}`}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 공시 유형 TOP */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold mb-3">공시 유형 TOP</h3>
          <div className="space-y-2">
            {stats.by_type.slice(0, 8).map(t => (
              <div key={t.type} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-24 truncate">{t.type ?? '기타'}</span>
                <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-600 rounded-full"
                    style={{ width: `${Math.min((t.count / (stats.by_type[0]?.count || 1)) * 100, 100)}%` }} />
                </div>
                <span className="text-xs text-gray-300 w-8 text-right">{t.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 주요 호재 */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <TrendingUp size={13} className="text-emerald-400" />주요 호재
          </h3>
          <div className="space-y-2">
            {stats.hot_disclosures.length === 0
              ? <p className="text-xs text-gray-500">없음</p>
              : stats.hot_disclosures.map(d => (
                <a key={d.id} href={d.dart_url} target="_blank" rel="noreferrer"
                  className="block bg-emerald-900/20 border border-emerald-800/30 rounded-lg px-3 py-2 hover:bg-emerald-900/30">
                  <div className="text-sm font-medium text-emerald-300">{d.corp_name}</div>
                  <div className="text-xs text-gray-400 mt-0.5 truncate">{d.report_nm}</div>
                  <div className="text-xs text-emerald-500 mt-0.5">점수 +{d.dart_score?.toFixed(2)}</div>
                </a>
              ))}
          </div>
        </div>

        {/* 주요 악재 */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle size={13} className="text-red-400" />주요 악재
          </h3>
          <div className="space-y-2">
            {stats.risk_disclosures.length === 0
              ? <p className="text-xs text-gray-500">없음</p>
              : stats.risk_disclosures.map(d => (
                <a key={d.id} href={d.dart_url} target="_blank" rel="noreferrer"
                  className="block bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2 hover:bg-red-900/30">
                  <div className="text-sm font-medium text-red-300">{d.corp_name}</div>
                  <div className="text-xs text-gray-400 mt-0.5 truncate">{d.report_nm}</div>
                  <div className="text-xs text-red-500 mt-0.5">점수 {d.dart_score?.toFixed(2)}</div>
                </a>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 메인 ────────────────────────────────────────────────
export default function Dart() {
  const [tab, setTab] = useState<'list' | 'stats'>('stats')
  const [stats, setStats] = useState<DartStats | null>(null)
  const [items, setItems] = useState<DartItem[]>([])
  const [days, setDays] = useState(7)
  const [onlySignal, setOnlySignal] = useState(false)
  const [corpCls, setCorpCls] = useState('')
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [collectMsg, setCollectMsg] = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    const data = await api.get(`/dart/stats?days=${days}`).then(r => r.data)
    setStats(data)
  }, [days])

  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ days: String(days) })
    if (onlySignal) params.set('only_signal', 'true')
    if (corpCls) params.set('corp_cls', corpCls)
    const data = await api.get(`/dart/list?${params}`).then(r => r.data)
    setItems(data.disclosures ?? [])
  }, [days, onlySignal, corpCls])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      await Promise.all([loadStats(), loadList()])
    } finally {
      setLoading(false)
    }
  }, [loadStats, loadList])

  useEffect(() => { load() }, [load])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(1800, load)

  const handleCollect = async () => {
    setCollecting(true); setCollectMsg(null)
    try {
      const data = await api.post('/dart/collect?days_back=1').then(r => r.data)
      setCollectMsg(data.message)
      await load()
    } catch {
      setCollectMsg('수집 실패')
    } finally {
      setCollecting(false)
      setTimeout(() => setCollectMsg(null), 6000)
    }
  }

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <FileText size={20} className="text-blue-400" />
            DART 공시 모니터링
          </h1>
          <p className="text-xs text-gray-500">OpenDART(금융감독원) 공시 자동 수집 · 호재/악재 자동 분류 · 30분마다 갱신</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={1800}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy || loading}
            onRefresh={timerRefresh}
            serverLabel="서버 30분"
          />
          <button onClick={handleCollect} disabled={collecting}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-xs font-medium">
            <Zap size={12} />{collecting ? '수집 중…' : '즉시 수집'}
          </button>
        </div>
      </div>

      {collectMsg && (
        <div className="px-4 py-2.5 rounded-lg bg-blue-900/40 border border-blue-700 text-blue-200 text-sm">
          {collectMsg}
        </div>
      )}

      {/* 기간 필터 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {[3, 7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${days === d ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {d}일
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {[['', '전체'], ['Y', '유가증권'], ['K', '코스닥']].map(([val, label]) => (
            <button key={val} onClick={() => setCorpCls(val)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${corpCls === val ? 'bg-gray-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" checked={onlySignal} onChange={e => setOnlySignal(e.target.checked)}
            className="rounded" />
          시그널만 (호재·악재)
        </label>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {[
          { key: 'stats', label: '현황 요약' },
          { key: 'list', label: `공시 목록 ${items.length > 0 ? `(${items.length})` : ''}` },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as 'list' | 'stats')}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
              tab === t.key ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* 통계 탭 */}
      {tab === 'stats' && (
        loading ? <div className="text-center py-12 text-gray-500">로딩 중…</div>
        : stats ? <StatsPanel stats={stats} />
        : null
      )}

      {/* 목록 탭 */}
      {tab === 'list' && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          {loading ? (
            <div className="text-center py-12 text-gray-500">로딩 중…</div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-gray-500">공시 데이터 없음 — 즉시 수집을 눌러주세요</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-800 bg-gray-900/80">
                    <th className="py-2.5 px-3">날짜</th>
                    <th className="py-2.5 px-3">기업</th>
                    <th className="py-2.5 px-3">공시명</th>
                    <th className="py-2.5 px-3">분류</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => <DartRow key={item.id} item={item} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
