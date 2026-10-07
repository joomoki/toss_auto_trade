import { useEffect, useState, useCallback } from 'react'
import api from '../../api/client'
import { RefreshCw, CheckCircle, AlertTriangle, XCircle } from 'lucide-react'

interface ServiceStatus {
  status: 'ok' | 'degraded' | 'error'
  label:  string
  msg?:   string
  count?:  number
  kospi?:  number
}

interface HealthData {
  overall:    'ok' | 'degraded' | 'error'
  services:   Record<string, ServiceStatus>
  checked_at: string
}

const STATUS_COLOR = {
  ok:       'bg-emerald-500',
  degraded: 'bg-yellow-500',
  error:    'bg-red-500',
}

const STATUS_TEXT = {
  ok:       'text-emerald-400',
  degraded: 'text-yellow-400',
  error:    'text-red-400',
}

const OVERALL_ICON = {
  ok:       <CheckCircle  size={12} className="text-emerald-400" />,
  degraded: <AlertTriangle size={12} className="text-yellow-400" />,
  error:    <XCircle      size={12} className="text-red-400"     />,
}

const ORDER: string[] = [
  'database', 'kiwoom', 'yfinance', 'macro_data', 'pykrx', 'news', 'dart', 'telegram',
]

export default function SystemHealth() {
  const [data,    setData]    = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(false)
  const [open,    setOpen]    = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/system/health')
      setData(r.data)
    } catch {
      // 서버 다운 등은 무시
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 120_000) // 2분마다 갱신
    return () => clearInterval(t)
  }, [load])

  if (!data) return null

  const services = ORDER
    .map(k => ({ key: k, ...data.services[k] }))
    .filter(s => s.status !== undefined)

  return (
    <div className="relative">
      {/* 요약 칩 (항상 표시) */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors hover:bg-gray-800 ${STATUS_TEXT[data.overall]}`}
        title="시스템 상태 보기"
      >
        {loading
          ? <RefreshCw size={11} className="animate-spin text-gray-500" />
          : OVERALL_ICON[data.overall]
        }
        <span className="hidden sm:inline">
          {data.overall === 'ok' ? '정상' : data.overall === 'degraded' ? '일부 이상' : '오류'}
        </span>
        {/* 이상 서비스 수 뱃지 */}
        {data.overall !== 'ok' && (
          <span className={`text-[10px] rounded-full px-1 ${
            data.overall === 'error' ? 'bg-red-900/60 text-red-300' : 'bg-yellow-900/60 text-yellow-300'
          }`}>
            {services.filter(s => s.status !== 'ok').length}
          </span>
        )}
      </button>

      {/* 드롭다운 상세 패널 */}
      {open && (
        <>
          {/* 오버레이 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-50 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
              <span className="text-xs font-semibold text-gray-300">시스템 연동 상태</span>
              <button
                onClick={load}
                disabled={loading}
                className="text-gray-500 hover:text-gray-300"
              >
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="py-1">
              {services.map(svc => (
                <div
                  key={svc.key}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-800/50 transition-colors"
                >
                  {/* 상태 점 */}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLOR[svc.status]}`} />
                  {/* 라벨 */}
                  <span className="text-xs text-gray-300 w-20 shrink-0">{svc.label}</span>
                  {/* 상세 */}
                  <span className={`text-[11px] flex-1 truncate ${
                    svc.status === 'ok' ? 'text-gray-500' :
                    svc.status === 'degraded' ? 'text-yellow-400' : 'text-red-400'
                  }`}>
                    {svc.status === 'ok' && svc.kospi
                      ? `KOSPI ${svc.kospi.toLocaleString()}`
                      : svc.msg ?? (svc.status === 'ok' ? '정상' : svc.status)}
                  </span>
                </div>
              ))}
            </div>
            <div className="px-3 py-2 border-t border-gray-800">
              <p className="text-[10px] text-gray-600">
                갱신: {data.checked_at
                  ? new Date(data.checked_at).toLocaleTimeString('ko-KR')
                  : '-'}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
