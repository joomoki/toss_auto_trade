import { useEffect, useState, useCallback } from 'react'
import {
  getHoldings, refreshHoldings, getAccountBalance,
  syncHoldingsWithKiwoom, getAccountSnapshots,
  saveAccountSnapshotNow, toggleLongTerm, toggleManual,
} from '../api/client'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'
import { type Holding } from '../components/tables/HoldingTable'
import {
  RefreshCw, TrendingUp, TrendingDown, Wallet,
  PiggyBank, BarChart2, CircleDollarSign, Minus,
  AlertTriangle, ShieldCheck, History, Bot, User,
} from 'lucide-react'

interface SyncResult {
  removed: { stock_code: string; stock_name: string }[]
  updated: string[]
  added: { stock_code: string; stock_name: string; is_manual?: boolean }[]
}

interface DailySnapshot {
  trade_date: string
  cash: number; available_cash: number; total_asset: number
  total_buy_amount: number; total_pnl: number
  total_pnl_rate: number; realized_pnl: number; holdings_count: number
}

interface Balance {
  cash: number; available_cash: number; total_asset: number
  total_buy_amount: number; total_pnl: number
  total_pnl_rate: number; account_name: string
  kiwoom_available?: boolean; synced_at?: string
}

function fmt(v: number) {
  if (Math.abs(v) >= 100_000_000) return `${(v / 100_000_000).toFixed(2)}억`
  if (Math.abs(v) >= 10_000)      return `${Math.round(v / 10_000)}만`
  return v.toLocaleString()
}
function fmtWon(v: number) { return `${v.toLocaleString()}원` }

// ─── 잔고 섹션 ───────────────────────────────────────────────
function BalanceSection({ bal, loading }: { bal: Balance | null; loading: boolean }) {
  if (loading) return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse h-20" />
      ))}
    </div>
  )
  if (!bal) return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-sm text-gray-500 text-center">
      잔고를 불러오지 못했습니다. 키움증권 API 연결을 확인하세요.
    </div>
  )
  const pnlColor = bal.total_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'
  const pnlBg   = bal.total_pnl >= 0 ? 'bg-emerald-900/20 border-emerald-800/40' : 'bg-red-900/20 border-red-800/40'
  const isMaint = bal.kiwoom_available === false
  return (
    <div className="space-y-2">
      {isMaint && (
        <div className="flex items-center gap-2 px-3 py-2 bg-yellow-900/20 border border-yellow-700/30 rounded-lg text-xs text-yellow-400">
          <AlertTriangle size={12} className="shrink-0" />
          <span>원장 점검 중 (18:00~08:00) — 마지막 연동 데이터 표시</span>
          {bal.synced_at && (
            <span className="ml-auto text-yellow-600">
              {new Date(bal.synced_at).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })} 기준
            </span>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className={`border rounded-xl p-4 ${isMaint ? 'bg-gray-900/60 border-gray-800/60' : 'bg-gray-900 border-gray-800'}`}>
          <div className="flex items-center gap-1.5 mb-2"><Wallet size={13} className={isMaint ? 'text-blue-400/60' : 'text-blue-400'} /><span className="text-[11px] text-gray-400">주문가능 예수금</span></div>
          <p className={`text-lg font-bold ${isMaint ? 'text-gray-400' : ''}`}>{fmt(bal.available_cash)}<span className="text-xs text-gray-500 ml-1">원</span></p>
          <p className="text-[11px] text-gray-500 mt-0.5">현금 잔고 {fmtWon(bal.cash)}</p>
        </div>
        <div className={`border rounded-xl p-4 ${isMaint ? 'bg-gray-900/60 border-gray-800/60' : 'bg-gray-900 border-gray-800'}`}>
          <div className="flex items-center gap-1.5 mb-2"><PiggyBank size={13} className={isMaint ? 'text-purple-400/60' : 'text-purple-400'} /><span className="text-[11px] text-gray-400">총 평가자산</span></div>
          <p className={`text-lg font-bold ${isMaint ? 'text-gray-400' : ''}`}>{fmt(bal.total_asset)}<span className="text-xs text-gray-500 ml-1">원</span></p>
          <p className="text-[11px] text-gray-500 mt-0.5">매수금액 {fmtWon(bal.total_buy_amount)}</p>
        </div>
        <div className={`border rounded-xl p-4 ${isMaint ? 'bg-gray-900/60 border-gray-800/60' : pnlBg}`}>
          <div className="flex items-center gap-1.5 mb-2">
            {bal.total_pnl >= 0 ? <TrendingUp size={13} className={isMaint ? 'text-emerald-400/60' : 'text-emerald-400'} /> : <TrendingDown size={13} className={isMaint ? 'text-red-400/60' : 'text-red-400'} />}
            <span className="text-[11px] text-gray-400">총 평가손익</span>
          </div>
          <p className={`text-lg font-bold ${isMaint ? 'text-gray-400' : pnlColor}`}>{bal.total_pnl >= 0 ? '+' : ''}{fmt(bal.total_pnl)}<span className="text-xs ml-1">원</span></p>
          <p className={`text-[11px] mt-0.5 ${isMaint ? 'text-gray-500' : pnlColor}`}>{bal.total_pnl_rate >= 0 ? '+' : ''}{bal.total_pnl_rate.toFixed(2)}%</p>
        </div>
        <div className={`border rounded-xl p-4 ${isMaint ? 'bg-gray-900/60 border-gray-800/60' : 'bg-gray-900 border-gray-800'}`}>
          <div className="flex items-center gap-1.5 mb-2"><BarChart2 size={13} className={isMaint ? 'text-yellow-400/60' : 'text-yellow-400'} /><span className="text-[11px] text-gray-400">계좌명</span></div>
          <p className="text-sm font-bold text-gray-200 truncate">{bal.account_name || '—'}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">키움증권</p>
        </div>
      </div>
    </div>
  )
}

// ─── 종목 카드 ────────────────────────────────────────────────
function HoldingCard({ h, onToggleLongTerm, onToggleManual }: {
  h: Holding
  onToggleLongTerm: (code: string) => void
  onToggleManual:   (code: string) => void
}) {
  const pnl   = h.unrealized_pnl ?? 0
  const pct   = h.unrealized_pnl_pct ?? 0
  const isPos = pnl >= 0
  const color = isPos ? 'text-emerald-400' : 'text-red-400'
  const evalAmt = (h.current_price ?? h.avg_buy_price) * h.quantity
  const buyAmt  = h.avg_buy_price * h.quantity

  // 카드 테두리: 장기=초록, 수동=보라, 자동=기본
  const borderCls = h.is_long_term
    ? 'border-emerald-800/50'
    : h.is_manual
      ? 'border-violet-800/50'
      : 'border-gray-800'

  return (
    <div className={`bg-gray-900 rounded-xl border p-4 ${borderCls}`}>
      {/* 헤더 */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* 매매 방식 아이콘 배지 */}
            {h.is_manual ? (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-violet-900/60 border border-violet-700/50 text-violet-300">
                <User size={10} />수동
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-blue-900/50 border border-blue-700/40 text-blue-300">
                <Bot size={10} />자동
              </span>
            )}
            {h.is_long_term && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-emerald-900/60 border border-emerald-700/50 text-emerald-300">
                🌱 장기
              </span>
            )}
            <p className="font-semibold text-sm leading-tight truncate">{h.stock_name || h.stock_code}</p>
          </div>
          <p className="text-[11px] text-gray-500 mt-0.5">{h.stock_code}</p>
        </div>
        <div className={`flex items-center gap-1 text-sm font-bold ${color} shrink-0 ml-2`}>
          {isPos ? <TrendingUp size={14} /> : pct === 0 ? <Minus size={14} /> : <TrendingDown size={14} />}
          {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
        </div>
      </div>

      {/* 수치 그리드 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <span className="text-gray-500">수량</span>
        <span className="text-right font-medium">{h.quantity.toLocaleString()}주</span>
        <span className="text-gray-500">평균단가</span>
        <span className="text-right">{h.avg_buy_price.toLocaleString()}원</span>
        <span className="text-gray-500">현재가</span>
        <span className="text-right font-medium">{h.current_price?.toLocaleString() ?? '—'}원</span>
        <span className="text-gray-500">매수금액</span>
        <span className="text-right text-gray-400">{buyAmt.toLocaleString()}원</span>
        <span className="text-gray-500">평가금액</span>
        <span className="text-right">{evalAmt.toLocaleString()}원</span>
        <span className="text-gray-500">평가손익</span>
        <span className={`text-right font-semibold ${color}`}>{pnl >= 0 ? '+' : ''}{pnl.toLocaleString()}원</span>
      </div>

      {/* 수익률 바 */}
      <div className="mt-3 h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isPos ? 'bg-emerald-500' : 'bg-red-500'}`}
          style={{ width: `${Math.min(Math.abs(pct) * 4, 100)}%` }}
        />
      </div>

      {/* 액션 버튼 2개 */}
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <button
          onClick={() => onToggleManual(h.stock_code)}
          className={`text-[10px] py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1 ${
            h.is_manual
              ? 'bg-violet-900/40 border border-violet-700/50 text-violet-400 hover:bg-violet-900/60'
              : 'bg-gray-800/60 border border-gray-700/40 text-gray-500 hover:text-gray-300'
          }`}
        >
          {h.is_manual ? <><User size={9} />수동 보호 중</> : <><Bot size={9} />자동매매 중</>}
        </button>
        <button
          onClick={() => onToggleLongTerm(h.stock_code)}
          className={`text-[10px] py-1.5 rounded-lg transition-colors ${
            h.is_long_term
              ? 'bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-900/60'
              : 'bg-gray-800/60 border border-gray-700/40 text-gray-500 hover:text-gray-300'
          }`}
        >
          {h.is_long_term ? '🌱 장기 해제' : '+ 장기 지정'}
        </button>
      </div>
    </div>
  )
}

// ─── 종목 그룹 섹션 ───────────────────────────────────────────
function HoldingGroup({
  label, icon, count, holdings, color,
  onToggleLongTerm, onToggleManual,
}: {
  label: string; icon: React.ReactNode; count: number
  holdings: Holding[]; color: string
  onToggleLongTerm: (code: string) => void
  onToggleManual:   (code: string) => void
}) {
  if (holdings.length === 0) return null
  return (
    <div>
      <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5 ${color}`}>
        {icon}{label} ({count}종목)
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {holdings.map(h => (
          <HoldingCard key={h.id} h={h} onToggleLongTerm={onToggleLongTerm} onToggleManual={onToggleManual} />
        ))}
      </div>
    </div>
  )
}

// ─── 일별 잔고 이력 ───────────────────────────────────────────
function SnapshotHistory({ rows, onSave, saving }: { rows: DailySnapshot[]; onSave: () => void; saving: boolean }) {
  const p = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-500'
  const s = (v: number) => v > 0 ? '+' : ''
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
          <History size={11} /> 일별 잔고 이력
        </p>
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs disabled:opacity-50 transition-colors"
          title="오늘 잔고를 지금 저장합니다 (매일 15:40 자동 저장)">
          <RefreshCw size={11} className={saving ? 'animate-spin' : ''} />
          오늘 스냅샷 저장
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-sm text-gray-500">
          저장된 이력이 없습니다. 장 마감(15:40) 후 자동 저장됩니다.
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="text-left px-3 py-2.5 font-medium">날짜</th>
                  <th className="text-right px-3 py-2.5 font-medium">총 자산</th>
                  <th className="text-right px-3 py-2.5 font-medium">주문가능금액</th>
                  <th className="text-right px-3 py-2.5 font-medium hidden sm:table-cell">매입금액</th>
                  <th className="text-right px-3 py-2.5 font-medium">평가손익</th>
                  <th className="text-right px-3 py-2.5 font-medium">당일실현손익</th>
                  <th className="text-right px-3 py-2.5 font-medium hidden sm:table-cell">보유</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r, i) => (
                  <tr key={r.trade_date} className={`border-b border-gray-800/50 ${i === 0 ? 'bg-gray-800/30' : ''}`}>
                    <td className="px-3 py-2 font-medium text-gray-300">{r.trade_date}</td>
                    <td className="px-3 py-2 text-right font-semibold">{r.total_asset.toLocaleString()}원</td>
                    <td className="px-3 py-2 text-right text-gray-400">{r.available_cash.toLocaleString()}원</td>
                    <td className="px-3 py-2 text-right text-gray-500 hidden sm:table-cell">{r.total_buy_amount.toLocaleString()}원</td>
                    <td className={`px-3 py-2 text-right font-medium ${p(r.total_pnl)}`}>
                      {r.total_pnl === 0 ? '—' : `${s(r.total_pnl)}${r.total_pnl.toLocaleString()}원`}
                      {r.total_pnl_rate !== 0 && <span className="block text-[10px] opacity-70">{s(r.total_pnl_rate)}{r.total_pnl_rate.toFixed(2)}%</span>}
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${p(r.realized_pnl)}`}>
                      {r.realized_pnl === 0 ? '—' : `${s(r.realized_pnl)}${r.realized_pnl.toLocaleString()}원`}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500 hidden sm:table-cell">{r.holdings_count}종목</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

// ─── 메인 페이지 ─────────────────────────────────────────────
export default function Holdings() {
  const [holdings, setHoldings]     = useState<Holding[]>([])
  const [balance, setBalance]       = useState<Balance | null>(null)
  const [loading, setLoading]       = useState(false)
  const [balLoading, setBalLoading] = useState(false)
  const [syncing, setSyncing]       = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [snapshots, setSnapshots]   = useState<DailySnapshot[]>([])
  const [snapSaving, setSnapSaving] = useState(false)

  const loadSnapshots = useCallback(async () => {
    try { setSnapshots(Array.isArray(await getAccountSnapshots(90)) ? await getAccountSnapshots(90) : []) }
    catch { /* 조용히 */ }
  }, [])

  const loadBalance = useCallback(async () => {
    setBalLoading(true)
    try { setBalance(await getAccountBalance()) }
    catch { setBalance(null) }
    finally { setBalLoading(false) }
  }, [])

  const loadHoldings = useCallback(async () => {
    const data = await getHoldings()
    setHoldings(Array.isArray(data) ? data : [])
  }, [])

  useEffect(() => {
    loadBalance(); loadHoldings()
    getAccountSnapshots(90).then(d => setSnapshots(Array.isArray(d) ? d : [])).catch(() => {})
  }, [loadBalance, loadHoldings])

  const handleRefresh = async () => {
    setLoading(true)
    try {
      const [synced] = await Promise.all([refreshHoldings(), loadBalance()])
      setHoldings(Array.isArray(synced) ? synced : [])
    } finally { setLoading(false) }
  }

  const handleSync = async () => {
    setSyncing(true); setSyncResult(null)
    try {
      const result = await syncHoldingsWithKiwoom()
      setHoldings(Array.isArray(result.holdings) ? result.holdings : [])
      setSyncResult(result); await loadBalance()
    } finally { setSyncing(false) }
  }

  const handleToggleLongTerm = async (code: string) => {
    try {
      const updated = await toggleLongTerm(code)
      setHoldings(prev => prev.map(h => h.stock_code === code ? { ...h, is_long_term: updated.is_long_term } : h))
    } catch { /* 조용히 */ }
  }

  const handleToggleManual = async (code: string) => {
    try {
      const updated = await toggleManual(code)
      setHoldings(prev => prev.map(h => h.stock_code === code ? { ...h, is_manual: updated.is_manual } : h))
    } catch { /* 조용히 */ }
  }

  const loadAll = useCallback(async () => {
    await Promise.all([loadBalance(), loadHoldings(), loadSnapshots()])
  }, [loadBalance, loadHoldings, loadSnapshots])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(60, loadAll)

  const dbTotalEval   = holdings.reduce((s, h) => s + (h.current_price ?? h.avg_buy_price) * h.quantity, 0)
  const dbTotalInvest = holdings.reduce((s, h) => s + h.avg_buy_price * h.quantity, 0)
  const dbTotalPnl    = dbTotalEval - dbTotalInvest

  // 세 그룹으로 분류
  const longHoldings   = holdings.filter(h => h.is_long_term)
  const manualHoldings = holdings.filter(h => h.is_manual && !h.is_long_term)
  const autoHoldings   = holdings.filter(h => !h.is_manual && !h.is_long_term)

  return (
    <div className="space-y-5">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-bold">보유 종목 · 잔고</h1>
        <div className="flex items-center gap-2">
          <RefreshTimer
            secondsLeft={secondsLeft} intervalSec={60}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy || balLoading}
            onRefresh={timerRefresh} serverLabel="잔고 60초"
          />
          <button onClick={handleRefresh} disabled={loading || syncing}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs disabled:opacity-50 transition-colors">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            <span>잔고 갱신</span>
          </button>
          <button onClick={handleSync} disabled={loading || syncing}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-700 hover:bg-blue-600 rounded-lg text-xs disabled:opacity-50 transition-colors text-white"
            title="키움 실제 계좌와 비교해 미체결 종목을 DB에서 제거하고 수동 매수 종목을 감지합니다">
            <ShieldCheck size={12} className={syncing ? 'animate-pulse' : ''} />
            <span>{syncing ? '동기화 중…' : '실계좌 대조 동기화'}</span>
          </button>
        </div>
      </div>

      {/* 범례 */}
      <div className="flex items-center gap-3 text-[11px] text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-blue-900/50 border border-blue-700/40 text-blue-300"><Bot size={10}/>자동</span>
          자동매매 종목 — 손절·익절 자동 청산
        </span>
        <span className="text-gray-700">|</span>
        <span className="flex items-center gap-1">
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-violet-900/60 border border-violet-700/50 text-violet-300"><User size={10}/>수동</span>
          수동 매수 — 자동 청산 없음
        </span>
        <span className="text-gray-700">|</span>
        <span className="flex items-center gap-1">
          <span className="px-1.5 py-0.5 rounded-md bg-emerald-900/60 border border-emerald-700/50 text-emerald-300">🌱 장기</span>
          장기 보유 — 자동 청산 없음
        </span>
      </div>

      {/* 동기화 결과 배너 */}
      {syncResult && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 text-xs space-y-2">
          <div className="flex items-center gap-2 text-gray-300 font-medium">
            <ShieldCheck size={13} className="text-blue-400" />
            실계좌 대조 동기화 완료
            <button onClick={() => setSyncResult(null)} className="ml-auto text-gray-600 hover:text-gray-400 text-[10px]">✕ 닫기</button>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className={`rounded-lg p-2.5 text-center ${syncResult.removed.length > 0 ? 'bg-red-900/30 border border-red-800/40' : 'bg-gray-800/40'}`}>
              <div className={`text-lg font-bold ${syncResult.removed.length > 0 ? 'text-red-400' : 'text-gray-500'}`}>{syncResult.removed.length}</div>
              <div className="text-gray-500 mt-0.5">미체결 제거</div>
              {syncResult.removed.map(r => <div key={r.stock_code} className="text-red-400 text-[10px] mt-1">{r.stock_name || r.stock_code}</div>)}
            </div>
            <div className="bg-gray-800/40 rounded-lg p-2.5 text-center">
              <div className="text-lg font-bold text-emerald-400">{syncResult.updated.length}</div>
              <div className="text-gray-500 mt-0.5">수량·단가 갱신</div>
            </div>
            <div className={`rounded-lg p-2.5 text-center ${syncResult.added.length > 0 ? 'bg-emerald-900/30 border border-emerald-800/40' : 'bg-gray-800/40'}`}>
              <div className={`text-lg font-bold ${syncResult.added.length > 0 ? 'text-emerald-400' : 'text-gray-500'}`}>{syncResult.added.length}</div>
              <div className="text-gray-500 mt-0.5">신규 추가</div>
              {syncResult.added.map(a => (
                <div key={a.stock_code} className="text-emerald-400 text-[10px] mt-1 flex items-center justify-center gap-1">
                  {a.is_manual ? <User size={9} /> : <Bot size={9} />}
                  {a.stock_name || a.stock_code}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 잔고 섹션 */}
      <section>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Wallet size={11} /> 계좌 잔고
        </p>
        <BalanceSection bal={balance} loading={balLoading} />
      </section>

      {/* 보유 종목 섹션 */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <CircleDollarSign size={11} /> 보유 종목 ({holdings.length}개)
          </p>
          {!balance && holdings.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>평가 {dbTotalEval.toLocaleString()}원</span>
              <span className={dbTotalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {dbTotalPnl >= 0 ? '+' : ''}{dbTotalPnl.toLocaleString()}원
              </span>
            </div>
          )}
        </div>

        {holdings.length === 0 ? (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-10 text-center text-gray-500 text-sm">
            보유 종목이 없습니다.<br />
            <span className="text-xs text-gray-600 mt-1 block">「실계좌 대조 동기화」 버튼으로 키움 잔고를 불러오세요.</span>
          </div>
        ) : (
          <div className="space-y-6">
            <HoldingGroup
              label="수동 매수" icon={<User size={11} />} count={manualHoldings.length}
              holdings={manualHoldings} color="text-violet-400"
              onToggleLongTerm={handleToggleLongTerm} onToggleManual={handleToggleManual}
            />
            <HoldingGroup
              label="자동매매" icon={<Bot size={11} />} count={autoHoldings.length}
              holdings={autoHoldings} color="text-blue-400"
              onToggleLongTerm={handleToggleLongTerm} onToggleManual={handleToggleManual}
            />
            <HoldingGroup
              label="장기 보유" icon={<span>🌱</span>} count={longHoldings.length}
              holdings={longHoldings} color="text-emerald-500"
              onToggleLongTerm={handleToggleLongTerm} onToggleManual={handleToggleManual}
            />
          </div>
        )}
      </section>

      {/* 일별 잔고 이력 */}
      <SnapshotHistory rows={snapshots} onSave={async () => { setSnapSaving(true); try { await saveAccountSnapshotNow(); await loadSnapshots() } finally { setSnapSaving(false) } }} saving={snapSaving} />
    </div>
  )
}
