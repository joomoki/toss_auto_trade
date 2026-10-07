import { useState, useEffect, useCallback, useRef } from 'react'
import api from '../api/client'
import {
  ScrollText, RefreshCw, AlertTriangle,
  XCircle, Filter, ChevronDown, ChevronUp,
  TrendingUp, AlertCircle, Zap,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

interface Summary {
  cycles: number
  bought: number
  errors: string[]
  warnings: string[]
  skip_summary: { reason: string; count: number }[]
  last_cycle_line: string | null
  total_lines: number
}

interface TodayLogs {
  buy_count: number
  sell_count: number
  filled_buy_count: number
  filled_sell_count: number
  total_buy_amount: number
  logs: TradeLog[]
}

interface TradeLog {
  id: number
  stock_name: string
  stock_code: string
  action: string
  quantity: number
  order_price: number
  status: string
  composite_score: number | null
  created_at: string | null
  error_msg: string | null
}

// ── Line Classifier ───────────────────────────────────────────────

type LineType = 'cycle' | 'buy' | 'skip' | 'error' | 'warn' | 'info' | 'complete'

function classifyLine(line: string): LineType {
  if (line.includes('▶ 사이클 시작'))  return 'cycle'
  if (line.includes('■ 사이클 완료'))  return 'complete'
  if (line.includes('💰 매수 시도'))   return 'buy'
  if (line.includes('→ SKIP'))         return 'skip'
  if (line.includes('⛔'))             return 'error'
  if (line.includes('ERROR') || line.includes('오류') || line.includes('실패')) return 'error'
  if (line.includes('WARNING') || line.includes('경고')) return 'warn'
  return 'info'
}

const LINE_STYLE: Record<LineType, string> = {
  cycle:    'text-cyan-400 font-semibold',
  complete: 'text-blue-400',
  buy:      'text-green-400 font-semibold',
  skip:     'text-gray-500',
  error:    'text-red-400',
  warn:     'text-yellow-400',
  info:     'text-gray-400',
}

const FILTERS: { key: LineType | 'all'; label: string; color: string }[] = [
  { key: 'all',      label: '전체',       color: 'bg-gray-700' },
  { key: 'cycle',    label: '사이클',     color: 'bg-cyan-800' },
  { key: 'buy',      label: '매수 시도',  color: 'bg-green-800' },
  { key: 'skip',     label: 'SKIP',       color: 'bg-gray-800' },
  { key: 'error',    label: '에러',       color: 'bg-red-900' },
  { key: 'warn',     label: '경고',       color: 'bg-yellow-900' },
]

// ── Summary Cards ─────────────────────────────────────────────────

function SummaryCards({ summary, today }: { summary: Summary | null; today: TodayLogs | null }) {
  if (!summary && !today) return null

  const cards = [
    {
      label: '오늘 사이클',
      value: summary?.cycles ?? '—',
      icon: RefreshCw,
      color: 'text-cyan-400',
      sub: summary?.last_cycle_line
        ? `마지막: ${summary.last_cycle_line.split(' ')[0]}`
        : '아직 실행 없음',
    },
    {
      label: '매수 실행',
      value: today?.filled_buy_count ?? 0,
      icon: TrendingUp,
      color: 'text-green-400',
      sub: today ? `주문 ${today.buy_count}건 / 체결 ${today.filled_buy_count}건` : '—',
    },
    {
      label: '매수 시도',
      value: summary?.bought ?? 0,
      icon: Zap,
      color: 'text-blue-400',
      sub: '엔진 매수 호출 횟수',
    },
    {
      label: '에러/경고',
      value: (summary?.errors.length ?? 0),
      icon: AlertTriangle,
      color: (summary?.errors.length ?? 0) > 0 ? 'text-red-400' : 'text-gray-500',
      sub: `경고 ${summary?.warnings.length ?? 0}건 포함`,
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      {cards.map(({ label, value, icon: Icon, color, sub }) => (
        <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">{label}</span>
            <Icon size={13} className={color} />
          </div>
          <div className={`text-2xl font-bold ${color}`}>{value}</div>
          <div className="text-[10px] text-gray-600 mt-1">{sub}</div>
        </div>
      ))}
    </div>
  )
}

// ── Skip Reason Summary ───────────────────────────────────────────

function SkipSummary({ summary }: { summary: Summary | null }) {
  if (!summary?.skip_summary?.length && !summary?.errors?.length) return null

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
      {summary.skip_summary.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h4 className="text-xs font-semibold text-gray-400 mb-3 flex items-center gap-1.5">
            <Filter size={12} />SKIP 이유 집계
          </h4>
          <div className="space-y-1.5">
            {summary.skip_summary.map(({ reason, count }) => (
              <div key={reason} className="flex items-center justify-between text-xs">
                <span className="text-gray-400 truncate mr-2">{reason}</span>
                <span className="text-gray-500 shrink-0 font-mono">{count}건</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {summary.errors.length > 0 && (
        <div className="bg-gray-900 border border-red-900/40 rounded-xl p-4">
          <h4 className="text-xs font-semibold text-red-400 mb-3 flex items-center gap-1.5">
            <XCircle size={12} />최근 에러
          </h4>
          <div className="space-y-1">
            {summary.errors.slice(-5).map((line, i) => (
              <div key={i} className="text-[10px] text-red-400 font-mono truncate">{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Today's Trade Log Table ────────────────────────────────────────

function TodayTradeTable({ today }: { today: TodayLogs | null }) {
  const [open, setOpen] = useState(true)
  if (!today?.logs?.length) return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4">
      <p className="text-xs text-gray-500">오늘 매매 내역 없음</p>
    </div>
  )

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl mb-4">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-200"
      >
        <span className="flex items-center gap-2">
          <TrendingUp size={14} className="text-blue-400" />
          오늘 매매 내역 ({today.logs.length}건)
        </span>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-gray-800">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-600 border-b border-gray-800">
                <th className="text-left px-4 py-2">시각</th>
                <th className="text-left px-4 py-2">종목</th>
                <th className="text-left px-4 py-2">구분</th>
                <th className="text-right px-4 py-2">수량</th>
                <th className="text-right px-4 py-2">단가</th>
                <th className="text-left px-4 py-2">상태</th>
                <th className="text-right px-4 py-2">점수</th>
              </tr>
            </thead>
            <tbody>
              {today.logs.map(log => {
                const isBuy = log.action === 'BUY'
                const statusColor =
                  log.status === 'FILLED'  ? 'text-green-400' :
                  log.status === 'MOCK'    ? 'text-blue-400'  :
                  log.status === 'PENDING' ? 'text-yellow-400' : 'text-red-400'
                const timeStr = log.created_at
                  ? new Date(log.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '—'
                return (
                  <tr key={log.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-2 font-mono text-gray-500">{timeStr}</td>
                    <td className="px-4 py-2 text-gray-200">{log.stock_name || log.stock_code}</td>
                    <td className="px-4 py-2">
                      <span className={`font-semibold ${isBuy ? 'text-blue-400' : 'text-red-400'}`}>
                        {isBuy ? '매수' : '매도'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-gray-300">{(log.quantity ?? 0).toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-gray-300">{(log.order_price ?? 0).toLocaleString()}원</td>
                    <td className={`px-4 py-2 ${statusColor}`}>{log.status}</td>
                    <td className="px-4 py-2 text-right text-gray-500">
                      {log.composite_score != null ? log.composite_score.toFixed(3) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {today.logs.some(l => l.error_msg) && (
            <div className="px-4 py-3 border-t border-gray-800">
              {today.logs.filter(l => l.error_msg).map(l => (
                <div key={l.id} className="text-[10px] text-red-400 font-mono">
                  [{l.stock_name}] {l.error_msg}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Engine Log Viewer ─────────────────────────────────────────────

function EngineLogViewer({ lines, loading }: { lines: string[]; loading: boolean }) {
  const [filter, setFilter] = useState<LineType | 'all'>('all')
  const [search, setSearch] = useState('')
  const [lineCount, setLineCount] = useState(300)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const filtered = lines.filter(line => {
    if (filter !== 'all' && classifyLine(line) !== filter) return false
    if (search && !line.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [filtered.length, autoScroll])

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-800">
        <ScrollText size={14} className="text-blue-400 shrink-0" />
        <span className="text-sm font-semibold text-gray-200 mr-1">엔진 로그</span>

        <div className="flex gap-1 flex-wrap">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                filter === f.key
                  ? `${f.color} text-white ring-1 ring-white/20`
                  : 'bg-gray-800 text-gray-500 hover:text-white'
              }`}
            >
              {f.label}
              {f.key !== 'all' && (
                <span className="ml-1 opacity-60">
                  {lines.filter(l => classifyLine(l) === f.key).length}
                </span>
              )}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="검색…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="ml-auto w-36 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />

        <label className="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer">
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="w-3 h-3" />
          최하단 고정
        </label>

        <select
          value={lineCount}
          onChange={e => setLineCount(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-400 focus:outline-none"
        >
          <option value={200}>200줄</option>
          <option value={500}>500줄</option>
          <option value={1000}>1000줄</option>
        </select>
      </div>

      {/* log body */}
      <div className="h-[440px] overflow-y-auto font-mono text-[11px] leading-5 p-3">
        {loading && <div className="text-gray-600 text-center py-4">로딩 중…</div>}
        {!loading && filtered.length === 0 && (
          <div className="text-gray-600 text-center py-8">
            {lines.length === 0
              ? '아직 로그가 없습니다. 자동매매 엔진이 실행되면 기록됩니다.'
              : '해당 조건의 로그가 없습니다.'}
          </div>
        )}
        {filtered.map((line, i) => {
          const type = classifyLine(line)
          const cls  = LINE_STYLE[type]
          return (
            <div key={i} className={`whitespace-pre-wrap break-all py-0.5 ${cls}`}>
              {line}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-gray-800 text-[10px] text-gray-600">
        <span>표시 {filtered.length}줄 / 전체 {lines.length}줄</span>
        {search && <span>"{search}" 검색 결과</span>}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────

export default function LogPage() {
  const [lines,   setLines]   = useState<string[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [today,   setToday]   = useState<TodayLogs | null>(null)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [lineCount] = useState(300)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [logRes, sumRes, todayRes] = await Promise.all([
        api.get(`/auto-trade/engine-log?lines=${lineCount}`),
        api.get('/auto-trade/engine-log/summary'),
        api.get('/auto-trade/logs/today'),
      ])
      setLines(logRes.data.lines ?? [])
      setSummary(sumRes.data)
      setToday(todayRes.data)
      setLastUpdated(new Date())
    } catch {}
    setLoading(false)
  }, [lineCount])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [autoRefresh, load])

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold text-gray-100">
          <ScrollText size={17} className="text-blue-400" />
          실행 로그
        </h2>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-[10px] text-gray-600">
              업데이트: {lastUpdated.toLocaleTimeString('ko-KR')}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="w-3 h-3 accent-blue-500"
            />
            30초 자동 새로고침
          </label>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded transition-colors disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            새로고침
          </button>
        </div>
      </div>

      {/* today status banner */}
      {summary && summary.cycles === 0 && (
        <div className="flex items-start gap-3 p-4 bg-yellow-950/40 border border-yellow-800/40 rounded-xl text-sm">
          <AlertCircle size={16} className="text-yellow-400 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <div className="font-semibold text-yellow-300">
              ⚠️ AI 자동매매 엔진 — 오늘 매수 시도 없음
            </div>
            <div className="text-xs text-yellow-200/80 leading-relaxed">
              이 로그는 <b>AI 종목 선정 엔진</b> 기준입니다.{' '}
              매크로 탭의 <b>실거래 실행</b>과는 <b>별개</b>입니다.
            </div>
            <div className="text-xs text-yellow-600 space-y-1">
              <div className="font-medium text-yellow-500">AI 자동매매 엔진을 켜려면:</div>
              <div>① <b>전략 탭</b> → 전략 카드의 <b>[시작]</b> 버튼 클릭 (DB에 활성 전략 등록)</div>
              <div>② 우측 상단 <b>[자동매매 활성화]</b> 토글 ON (실전/모의 구분)</div>
              <div className="pt-1 text-yellow-700">
                ※ 매크로 탭의 실거래 실행은 섹터 로테이션 엔진(30분 주기)만 제어합니다.
              </div>
            </div>
          </div>
        </div>
      )}

      {summary && summary.bought === 0 && summary.cycles > 0 && (
        <div className="flex items-start gap-3 p-4 bg-blue-950/30 border border-blue-800/30 rounded-xl text-sm">
          <AlertCircle size={16} className="text-blue-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-semibold text-blue-300">
              AI 엔진이 실행됐지만 오늘 매수 주문이 없었습니다
            </div>
            <div className="text-xs text-blue-400/80 leading-relaxed">
              5분마다 후보 종목을 평가했으나 조건을 충족한 종목이 없었습니다.
            </div>
            <div className="text-xs text-blue-700 space-y-0.5 pt-1">
              <div>• <b>점수 미달</b>: 종합점수가 매수 임계값(전략 탭 설정) 미만</div>
              <div>• <b>예수금 부족</b>: 예수금 &lt; 종목 단가 (종목 단가 상한 설정 확인)</div>
              <div>• <b>이미 보유 중</b>: 동일 종목을 이미 보유한 경우 재매수 안 함</div>
              <div>• <b>BUY 신호 없음</b>: 모델이 HOLD/SELL 신호를 낸 경우</div>
              <div>• <b>손절 재매수 방지</b>: 당일 손절된 종목은 같은 날 재매수 차단</div>
              <div>• <b>뉴스 악재 차단</b>: 뉴스 감성 점수 0.30 미만 종목 자동 제외</div>
            </div>
          </div>
        </div>
      )}

      <SummaryCards summary={summary} today={today} />
      <SkipSummary summary={summary} />
      <TodayTradeTable today={today} />
      <EngineLogViewer lines={lines} loading={loading} />
    </div>
  )
}
