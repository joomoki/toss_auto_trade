import { useEffect, useState } from 'react'
import {
  getPortfolio, addPortfolioHolding, updatePortfolioHolding,
  deletePortfolioHolding, refreshPortfolioPrices, syncFromToss,
  getPortfolioTransactions, addPortfolioTransaction,
} from '../api/client'
import { TrendingUp, TrendingDown, Plus, RefreshCw, Pencil, Trash2, X, Download, List } from 'lucide-react'

// ── 타입 ────────────────────────────────────────────────
interface Holding {
  id: number
  stock_code: string
  stock_name: string | null
  quantity: number
  avg_buy_price: number
  current_price: number | null
  unrealized_pnl: number | null
  unrealized_pnl_pct: number | null
  buy_date: string | null
  memo: string | null
  source: string
}

interface Summary {
  total_invest: number
  total_eval: number
  total_pnl: number
  total_pnl_pct: number
  count: number
}

interface Transaction {
  id: number
  stock_code: string
  stock_name: string | null
  transaction_type: string
  quantity: number
  price: number
  amount: number
  commission: number
  transaction_date: string
  memo: string | null
}

// ── 헬퍼 ────────────────────────────────────────────────
const fmtKRW = (v: number) => v.toLocaleString() + '원'
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const today = () => new Date().toISOString().slice(0, 10)

// ── 추가/수정 모달 ───────────────────────────────────────
interface HoldingFormProps {
  initial?: Partial<Holding>
  onSave: (data: Record<string, unknown>) => void
  onClose: () => void
}

function HoldingForm({ initial, onSave, onClose }: HoldingFormProps) {
  const [form, setForm] = useState({
    stock_code: initial?.stock_code ?? '',
    stock_name: initial?.stock_name ?? '',
    quantity: initial?.quantity ?? '',
    avg_buy_price: initial?.avg_buy_price ?? '',
    buy_date: initial?.buy_date ?? today(),
    memo: initial?.memo ?? '',
  })

  const isEdit = !!initial?.id

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-gray-900 rounded-2xl border border-gray-700 p-5 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">{isEdit ? '종목 수정' : '종목 추가'}</h2>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">종목코드 *</label>
              <input
                value={form.stock_code}
                onChange={e => setForm(f => ({ ...f, stock_code: e.target.value }))}
                disabled={isEdit}
                placeholder="005930"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">종목명</label>
              <input
                value={form.stock_name}
                onChange={e => setForm(f => ({ ...f, stock_name: e.target.value }))}
                placeholder="삼성전자"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">수량 *</label>
              <input
                type="number" min="1"
                value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">평균단가 (원) *</label>
              <input
                type="number" min="1"
                value={form.avg_buy_price}
                onChange={e => setForm(f => ({ ...f, avg_buy_price: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">매수일</label>
            <input
              type="date" value={form.buy_date}
              onChange={e => setForm(f => ({ ...f, buy_date: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">메모</label>
            <input
              value={form.memo}
              onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}
              placeholder="선택 입력"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose}
            className="flex-1 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm">
            취소
          </button>
          <button
            onClick={() => onSave({
              stock_code: form.stock_code,
              stock_name: form.stock_name || null,
              quantity: Number(form.quantity),
              avg_buy_price: Number(form.avg_buy_price),
              buy_date: form.buy_date || null,
              memo: form.memo || null,
            })}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium">
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 거래 내역 모달 ──────────────────────────────────────
function TransactionModal({ stockCode, stockName, onClose }: {
  stockCode: string; stockName: string; onClose: () => void
}) {
  const [txs, setTxs] = useState<Transaction[]>([])
  const [form, setForm] = useState({
    transaction_type: 'BUY',
    quantity: '',
    price: '',
    commission: '0',
    transaction_date: today(),
    memo: '',
  })
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    getPortfolioTransactions(stockCode).then(setTxs)
  }, [stockCode])

  const handleAdd = async () => {
    await addPortfolioTransaction({
      stock_code: stockCode,
      stock_name: stockName,
      transaction_type: form.transaction_type,
      quantity: Number(form.quantity),
      price: Number(form.price),
      commission: Number(form.commission),
      transaction_date: form.transaction_date,
      memo: form.memo || null,
    })
    const updated = await getPortfolioTransactions(stockCode)
    setTxs(updated)
    setAdding(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-gray-900 rounded-2xl border border-gray-700 p-5 w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">{stockName || stockCode} 거래 내역</h2>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>

        {/* 거래 추가 폼 */}
        {adding ? (
          <div className="bg-gray-800 rounded-xl p-4 mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400 block mb-1">구분</label>
                <select value={form.transaction_type}
                  onChange={e => setForm(f => ({ ...f, transaction_type: e.target.value }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-2 text-sm">
                  <option value="BUY">매수</option>
                  <option value="SELL">매도</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">날짜</label>
                <input type="date" value={form.transaction_date}
                  onChange={e => setForm(f => ({ ...f, transaction_date: e.target.value }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">수량</label>
                <input type="number" value={form.quantity}
                  onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">가격 (원)</label>
                <input type="number" value={form.price}
                  onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-2 text-sm" />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setAdding(false)}
                className="flex-1 py-1.5 bg-gray-700 rounded-lg text-sm">취소</button>
              <button onClick={handleAdd}
                className="flex-1 py-1.5 bg-blue-600 rounded-lg text-sm font-medium">저장</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 mb-3">
            <Plus size={14} />거래 추가
          </button>
        )}

        {/* 거래 목록 */}
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-900">
              <tr className="text-gray-400 border-b border-gray-700">
                <th className="pb-2 text-left">날짜</th>
                <th className="pb-2 text-left">구분</th>
                <th className="pb-2 text-right">수량</th>
                <th className="pb-2 text-right">가격</th>
                <th className="pb-2 text-right">금액</th>
              </tr>
            </thead>
            <tbody>
              {txs.map(t => (
                <tr key={t.id} className="border-b border-gray-800">
                  <td className="py-2 text-gray-400">{t.transaction_date}</td>
                  <td className={`py-2 font-medium ${t.transaction_type === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                    {t.transaction_type === 'BUY' ? '매수' : '매도'}
                  </td>
                  <td className="py-2 text-right">{t.quantity.toLocaleString()}</td>
                  <td className="py-2 text-right">{t.price.toLocaleString()}</td>
                  <td className="py-2 text-right">{t.amount.toLocaleString()}</td>
                </tr>
              ))}
              {txs.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-gray-500">거래 내역 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── 보유 종목 카드 ──────────────────────────────────────
function HoldingCard({
  h, onEdit, onDelete, onShowTx
}: {
  h: Holding
  onEdit: (h: Holding) => void
  onDelete: (id: number) => void
  onShowTx: (h: Holding) => void
}) {
  const isProfit = (h.unrealized_pnl ?? 0) >= 0
  const pct = h.unrealized_pnl_pct ?? 0
  const invest = h.avg_buy_price * h.quantity
  const eval_ = (h.current_price ?? h.avg_buy_price) * h.quantity

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      {/* 헤더 */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{h.stock_name || h.stock_code}</span>
            {h.source === 'TOSS_SYNC' && (
              <span className="text-[10px] bg-blue-900 text-blue-300 px-1.5 py-0.5 rounded">토스</span>
            )}
          </div>
          <span className="text-xs text-gray-500">{h.stock_code}</span>
          {h.buy_date && <span className="text-xs text-gray-600 ml-2">{h.buy_date}</span>}
        </div>
        <div className={`flex items-center gap-1 font-bold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
          {isProfit ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {fmtPct(pct)}
        </div>
      </div>

      {/* 수치 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
        <span className="text-gray-400">수량</span>
        <span className="text-right">{h.quantity.toLocaleString()}주</span>
        <span className="text-gray-400">평균단가</span>
        <span className="text-right">{fmtKRW(h.avg_buy_price)}</span>
        <span className="text-gray-400">현재가</span>
        <span className="text-right">{h.current_price ? fmtKRW(h.current_price) : '-'}</span>
        <span className="text-gray-400">투자금액</span>
        <span className="text-right">{fmtKRW(invest)}</span>
        <span className="text-gray-400">평가금액</span>
        <span className="text-right">{fmtKRW(eval_)}</span>
        <span className="text-gray-400">평가손익</span>
        <span className={`text-right font-medium ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
          {h.unrealized_pnl != null
            ? `${h.unrealized_pnl >= 0 ? '+' : ''}${fmtKRW(Math.round(h.unrealized_pnl))}`
            : '-'}
        </span>
      </div>

      {h.memo && <p className="text-xs text-gray-500 mb-3 italic">"{h.memo}"</p>}

      {/* 액션 버튼 */}
      <div className="flex gap-1.5 border-t border-gray-800 pt-3">
        <button onClick={() => onShowTx(h)}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg">
          <List size={12} />거래
        </button>
        <button onClick={() => onEdit(h)}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg">
          <Pencil size={12} />수정
        </button>
        <button onClick={() => onDelete(h.id)}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs bg-red-950 hover:bg-red-900 text-red-400 rounded-lg">
          <Trash2 size={12} />삭제
        </button>
      </div>
    </div>
  )
}

// ── 알림 토스트 ─────────────────────────────────────────
interface Toast { msg: string; type: 'success' | 'error' | 'info' }

// ── 메인 페이지 ─────────────────────────────────────────
export default function Portfolio() {
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [modal, setModal] = useState<'add' | 'edit' | null>(null)
  const [editTarget, setEditTarget] = useState<Holding | null>(null)
  const [txTarget, setTxTarget] = useState<Holding | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)

  const showToast = (msg: string, type: Toast['type'] = 'info') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  const load = async () => {
    const data = await getPortfolio()
    setHoldings(data.holdings)
    setSummary(data.summary)
  }

  useEffect(() => { load() }, [])

  const handleAdd = async (data: Record<string, unknown>) => {
    await addPortfolioHolding(data)
    await load()
    setModal(null)
  }

  const handleEdit = async (data: Record<string, unknown>) => {
    if (!editTarget) return
    await updatePortfolioHolding(editTarget.id, data)
    await load()
    setModal(null)
    setEditTarget(null)
  }

  const handleDelete = async (id: number) => {
    if (!confirm('삭제하시겠습니까?')) return
    await deletePortfolioHolding(id)
    await load()
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const r = await refreshPortfolioPrices()
      await load()
      showToast(`시세 갱신 완료 (${r.updated}/${r.total})`, 'success')
    } catch {
      showToast('시세 갱신 실패 — 토스 API 연결을 확인하세요', 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const result = await syncFromToss()
      await load()
      showToast(result.message ?? `${result.synced}개 종목 동기화 완료`, 'success')
    } catch (e: unknown) {
      const err = e as { code?: string; response?: { status?: number; data?: { detail?: string } } }
      if (err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED') {
        showToast('백엔드 서버에 연결할 수 없습니다 — start.bat으로 서버를 시작하세요', 'error')
      } else if (err.response?.status === 502) {
        showToast(err.response.data?.detail ?? '토스증권 API 오류 — API 키를 확인하고 백엔드를 재시작하세요', 'error')
      } else {
        showToast(err.response?.data?.detail ?? '동기화 실패', 'error')
      }
    } finally {
      setSyncing(false)
    }
  }

  const isProfit = (summary?.total_pnl ?? 0) >= 0

  return (
    <div className="space-y-4">
      {/* 토스트 알림 */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl text-sm font-medium max-w-xs
          ${toast.type === 'success' ? 'bg-green-800 text-green-100 border border-green-600'
            : toast.type === 'error' ? 'bg-red-900 text-red-100 border border-red-700'
            : 'bg-gray-800 text-gray-100 border border-gray-600'}`}>
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      )}

      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-bold sm:text-xl">내 포트폴리오</h1>
          <p className="text-xs text-gray-500 mt-0.5">자동매매와 분리된 개인 보유 종목 관리</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-900 hover:bg-blue-800 text-blue-300 rounded-lg text-xs disabled:opacity-50">
            <Download size={13} className={syncing ? 'animate-pulse' : ''} />
            토스 동기화
          </button>
          <button onClick={handleRefresh} disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs disabled:opacity-50">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            시세 갱신
          </button>
          <button onClick={() => setModal('add')}
            className="flex items-center gap-1.5 px-3 py-2 bg-green-700 hover:bg-green-600 rounded-lg text-xs font-medium">
            <Plus size={13} />종목 추가
          </button>
        </div>
      </div>

      {/* 요약 카드 */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <p className="text-xs text-gray-400 mb-1">총 투자금액</p>
            <p className="text-lg font-bold">{fmtKRW(Math.round(summary.total_invest))}</p>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <p className="text-xs text-gray-400 mb-1">총 평가금액</p>
            <p className="text-lg font-bold">{fmtKRW(Math.round(summary.total_eval))}</p>
          </div>
          <div className={`bg-gray-900 rounded-xl border p-4 ${isProfit ? 'border-green-800' : 'border-red-800'}`}>
            <p className="text-xs text-gray-400 mb-1">총 평가손익</p>
            <p className={`text-lg font-bold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
              {summary.total_pnl >= 0 ? '+' : ''}{fmtKRW(Math.round(summary.total_pnl))}
            </p>
          </div>
          <div className={`bg-gray-900 rounded-xl border p-4 ${isProfit ? 'border-green-800' : 'border-red-800'}`}>
            <p className="text-xs text-gray-400 mb-1">수익률</p>
            <p className={`text-lg font-bold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
              {fmtPct(summary.total_pnl_pct)}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">{summary.count}종목</p>
          </div>
        </div>
      )}

      {/* 종목 카드 그리드 */}
      {holdings.length === 0 ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-10 text-center">
          <p className="text-gray-400 mb-3">보유 종목이 없습니다</p>
          <button onClick={() => setModal('add')}
            className="flex items-center gap-2 mx-auto px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm">
            <Plus size={14} />첫 종목 추가
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {holdings.map(h => (
            <HoldingCard
              key={h.id}
              h={h}
              onEdit={h => { setEditTarget(h); setModal('edit') }}
              onDelete={handleDelete}
              onShowTx={setTxTarget}
            />
          ))}
        </div>
      )}

      {/* 모달 */}
      {modal === 'add' && (
        <HoldingForm onSave={handleAdd} onClose={() => setModal(null)} />
      )}
      {modal === 'edit' && editTarget && (
        <HoldingForm initial={editTarget} onSave={handleEdit} onClose={() => { setModal(null); setEditTarget(null) }} />
      )}
      {txTarget && (
        <TransactionModal
          stockCode={txTarget.stock_code}
          stockName={txTarget.stock_name ?? txTarget.stock_code}
          onClose={() => setTxTarget(null)}
        />
      )}
    </div>
  )
}
