import React, { useState, useEffect, useCallback } from 'react'
import api from '../api/client'
import { getTelegramLogs, runTelegramCommand, getTelegramCommandLogs, getTelegramInbox } from '../api/client'
import {
  MessageSquare, Send, Settings, Clock, Bell, BellOff,
  CheckCircle2, XCircle, RefreshCw, Zap, TrendingUp,
  BarChart2, Moon, Sun, Activity, History, Terminal,
  ShoppingCart, ArrowDownCircle, Layers, Inbox, Copy, Check,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

interface TgStatus {
  configured: boolean
  bot_token_masked: string
  chat_id: string
}

interface TgSettings {
  status_interval: number
  notify_buy: boolean
  notify_sell: boolean
  notify_error: boolean
  notify_kill_switch: boolean
  notify_morning: boolean
  notify_hourly: boolean
  notify_close: boolean
  notify_screening: boolean
  notify_from: string
  notify_to: string
  notify_business_only: boolean
}

// ── Helpers ───────────────────────────────────────────────────────

function Badge({ ok }: { ok: boolean }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={12} />연결됨</span>
    : <span className="inline-flex items-center gap-1 text-xs text-red-400"><XCircle size={12} />미연결</span>
}

function SectionCard({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-200 mb-4">
        <Icon size={15} className="text-blue-400" />{title}
      </h3>
      {children}
    </div>
  )
}

// ── Connection Status ─────────────────────────────────────────────

function ConnectionPanel({ status, onRefresh }: { status: TgStatus | null; onRefresh: () => void }) {
  const [token, setToken] = useState('')
  const [chat, setChat]   = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]       = useState('')

  const save = async () => {
    setSaving(true)
    try {
      const r = await api.post('/telegram/config', { bot_token: token, chat_id: chat })
      setMsg(r.data.message)
      onRefresh()
      setToken('')
      setChat('')
    } catch (e: any) {
      setMsg(e?.response?.data?.detail ?? '저장 실패')
    } finally {
      setSaving(false)
      setTimeout(() => setMsg(''), 4000)
    }
  }

  const test = async () => {
    try {
      const r = await api.post('/telegram/test')
      setMsg(r.data.message)
    } catch (e: any) {
      setMsg(e?.response?.data?.detail ?? '전송 실패')
    } finally {
      setTimeout(() => setMsg(''), 4000)
    }
  }

  return (
    <SectionCard title="봇 연결 설정" icon={Settings}>
      {status && (
        <div className="flex items-center gap-4 mb-4 p-3 bg-gray-800 rounded-lg text-xs text-gray-400">
          <Badge ok={status.configured} />
          {status.configured && (
            <>
              <span className="font-mono">{status.bot_token_masked}</span>
              <span className="text-gray-500">Chat: {status.chat_id}</span>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">봇 토큰 (새로 입력 시 교체)</label>
          <input
            type="password"
            placeholder="123456:ABCdef…"
            value={token}
            onChange={e => setToken(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Chat ID</label>
          <input
            type="text"
            placeholder="-100xxxxxxxxxx"
            value={chat}
            onChange={e => setChat(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || (!token && !chat)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs rounded transition-colors"
        >
          {saving ? '저장 중…' : '저장'}
        </button>
        <button
          onClick={test}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition-colors"
        >
          테스트 메시지 전송
        </button>
        <button onClick={onRefresh} className="ml-auto text-gray-500 hover:text-gray-300">
          <RefreshCw size={13} />
        </button>
      </div>

      {msg && <p className="mt-2 text-xs text-green-400">{msg}</p>}
    </SectionCard>
  )
}

// ── Manual Send ───────────────────────────────────────────────────

interface SendBtn {
  label: string
  endpoint: string
  icon: React.ElementType
  desc: string
  color: string
}

const SEND_BUTTONS: SendBtn[] = [
  { label: '포트폴리오 현황', endpoint: '/telegram/send/status',    icon: Activity,    desc: '현재 보유 종목 + 손익 현황', color: 'blue' },
  { label: '모닝 리포트',     endpoint: '/telegram/send/morning',   icon: Sun,         desc: '장 시작 전 매수 후보 분석',   color: 'yellow' },
  { label: '진행현황 리포트', endpoint: '/telegram/send/hourly',    icon: TrendingUp,  desc: '장 중 거래 진행 상황',         color: 'green' },
  { label: '결산 리포트',     endpoint: '/telegram/send/close',     icon: Moon,        desc: '장 마감 후 오늘 결과 요약',    color: 'purple' },
  { label: '섹터 스크리닝',   endpoint: '/telegram/send/screening', icon: BarChart2,   desc: 'AI 전종목 스크리닝 결과',      color: 'cyan' },
]

const COLOR_MAP: Record<string, string> = {
  blue:   'bg-blue-600 hover:bg-blue-700',
  yellow: 'bg-yellow-600 hover:bg-yellow-700',
  green:  'bg-green-600 hover:bg-green-700',
  purple: 'bg-purple-600 hover:bg-purple-700',
  cyan:   'bg-cyan-600 hover:bg-cyan-700',
}

function ManualSendPanel({ configured }: { configured: boolean }) {
  const [loading, setLoading] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})

  const send = async (btn: SendBtn) => {
    if (!configured) return
    setLoading(btn.endpoint)
    try {
      const r = await api.post(btn.endpoint)
      setResults(prev => ({ ...prev, [btn.endpoint]: r.data.message }))
    } catch (e: any) {
      setResults(prev => ({ ...prev, [btn.endpoint]: e?.response?.data?.detail ?? '전송 실패' }))
    } finally {
      setLoading(null)
      setTimeout(() => setResults(prev => { const n = { ...prev }; delete n[btn.endpoint]; return n }), 5000)
    }
  }

  return (
    <SectionCard title="수동 전송" icon={Send}>
      {!configured && (
        <p className="text-xs text-red-400 mb-3">봇 연결 설정을 먼저 완료하세요.</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {SEND_BUTTONS.map(btn => {
          const Icon = btn.icon
          const busy = loading === btn.endpoint
          const result = results[btn.endpoint]
          return (
            <button
              key={btn.endpoint}
              onClick={() => send(btn)}
              disabled={busy || !configured}
              className={`flex items-start gap-3 p-3 rounded-lg text-left transition-colors disabled:opacity-40 ${COLOR_MAP[btn.color]} text-white`}
            >
              <Icon size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-medium">{busy ? '전송 중…' : btn.label}</div>
                <div className="text-[10px] opacity-75 mt-0.5">
                  {result ?? btn.desc}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </SectionCard>
  )
}

// ── Interval Config ───────────────────────────────────────────────

function IntervalPanel({ settings, onSave }: { settings: TgSettings | null; onSave: (s: TgSettings) => void }) {
  const [interval, setInterval] = useState(0)
  const [enabled, setEnabled]   = useState(false)

  useEffect(() => {
    if (settings) {
      setInterval(settings.status_interval)
      setEnabled(settings.status_interval > 0)
    }
  }, [settings])

  const handleToggle = (v: boolean) => {
    setEnabled(v)
    if (!v) setInterval(0)
    else if (interval === 0) setInterval(30)
  }

  const handleSave = () => {
    if (!settings) return
    onSave({ ...settings, status_interval: enabled ? interval : 0 })
  }

  return (
    <SectionCard title="주기 현황 리포트" icon={Clock}>
      <p className="text-xs text-gray-500 mb-4">
        설정한 주기마다 보유 종목 + 손익 현황을 텔레그램으로 자동 발송합니다.
      </p>

      <div className="flex items-center gap-4 mb-4">
        <button
          onClick={() => handleToggle(!enabled)}
          className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
        <span className="text-xs text-gray-300">{enabled ? '활성' : '비활성'}</span>
      </div>

      {enabled && (
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 whitespace-nowrap">발송 주기</label>
            <input
              type="number"
              min={5}
              max={1440}
              value={interval}
              onChange={e => setInterval(Math.max(5, Number(e.target.value)))}
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-blue-500"
            />
            <span className="text-xs text-gray-500">분</span>
          </div>
          <div className="flex gap-2">
            {[10, 30, 60, 120].map(m => (
              <button
                key={m}
                onClick={() => setInterval(m)}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${interval === m ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
              >
                {m >= 60 ? `${m/60}시간` : `${m}분`}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={handleSave}
        className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors"
      >
        저장
      </button>

      {enabled && interval > 0 && (
        <p className="mt-2 text-xs text-blue-400">
          매 {interval < 60 ? `${interval}분` : `${Math.floor(interval/60)}시간${interval%60 > 0 ? ` ${interval%60}분` : ''}`}마다 현황 발송
        </p>
      )}
    </SectionCard>
  )
}

// ── Notification Toggles ─────────────────────────────────────────

interface ToggleDef {
  key: keyof TgSettings
  label: string
  desc: string
  icon: React.ElementType
}

const TOGGLES: ToggleDef[] = [
  { key: 'notify_buy',          label: '매수 알림',       desc: '매수 체결 시',              icon: Zap       },
  { key: 'notify_sell',         label: '매도 알림',       desc: '매도 체결 시',              icon: TrendingUp },
  { key: 'notify_error',        label: '오류 알림',       desc: '엔진 오류 발생 시',          icon: XCircle   },
  { key: 'notify_kill_switch',  label: '킬스위치 알림',   desc: '자동매매 ON/OFF 시',         icon: Zap       },
  { key: 'notify_morning',      label: '모닝 리포트',     desc: '평일 08:40 자동 발송',       icon: Sun       },
  { key: 'notify_hourly',       label: '시간별 현황',     desc: '평일 10~15시 매시 정각',     icon: Clock     },
  { key: 'notify_close',        label: '결산 리포트',     desc: '평일 15:35 자동 발송',       icon: Moon      },
  { key: 'notify_screening',    label: '섹터 스크리닝',   desc: '09:05 / 11:00 / 13:30',     icon: BarChart2 },
]

function NotificationToggles({ settings, onSave }: { settings: TgSettings | null; onSave: (s: TgSettings) => void }) {
  const [local, setLocal] = useState<TgSettings | null>(null)

  useEffect(() => { if (settings) setLocal({ ...settings }) }, [settings])

  if (!local) return null

  const toggle = (key: keyof TgSettings) => {
    const next = { ...local, [key]: !local[key] }
    setLocal(next)
    onSave(next)
  }

  return (
    <SectionCard title="알림 종류 설정" icon={Bell}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {TOGGLES.map(({ key, label, desc, icon: Icon }) => {
          const on = !!local[key]
          return (
            <button
              key={key}
              onClick={() => toggle(key)}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                on
                  ? 'border-blue-700 bg-blue-950/40'
                  : 'border-gray-800 bg-gray-800/30 opacity-60'
              }`}
            >
              <div className={`p-1.5 rounded ${on ? 'bg-blue-600/30' : 'bg-gray-700'}`}>
                {on ? <Bell size={12} className="text-blue-400" /> : <BellOff size={12} className="text-gray-500" />}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-gray-200">{label}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{desc}</div>
              </div>
              <Icon size={13} className={`ml-auto shrink-0 ${on ? 'text-blue-400' : 'text-gray-600'}`} />
            </button>
          )
        })}
      </div>
    </SectionCard>
  )
}

// ── Notify Window Panel ───────────────────────────────────────────

function NotifyWindowPanel({ settings, onSave }: { settings: TgSettings | null; onSave: (s: TgSettings) => void }) {
  const [from, setFrom]             = useState('00:00')
  const [to, setTo]                 = useState('23:59')
  const [bizOnly, setBizOnly]       = useState(false)

  useEffect(() => {
    if (settings) {
      setFrom(settings.notify_from || '00:00')
      setTo(settings.notify_to || '23:59')
      setBizOnly(settings.notify_business_only ?? false)
    }
  }, [settings])

  const handleSave = () => {
    if (!settings) return
    onSave({ ...settings, notify_from: from, notify_to: to, notify_business_only: bizOnly })
  }

  const isDefault = from === '00:00' && to === '23:59' && !bizOnly

  return (
    <SectionCard title="발송 시간 설정" icon={Clock}>
      <p className="text-xs text-gray-500 mb-4">
        지정한 시간 창 내에서만 텔레그램 알림을 발송합니다. 기본값(00:00~23:59)은 제한 없음입니다.
      </p>

      <div className="flex flex-wrap items-end gap-4 mb-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">발송 시작 (From)</label>
          <input
            type="time"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
          />
        </div>
        <span className="text-gray-500 text-xs pb-2">~</span>
        <div>
          <label className="block text-xs text-gray-500 mb-1">발송 종료 (To)</label>
          <input
            type="time"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => setBizOnly(!bizOnly)}
          className={`relative w-10 h-5 rounded-full transition-colors ${bizOnly ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${bizOnly ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
        <span className="text-xs text-gray-300">영업일(평일)만 발송</span>
        {bizOnly && <span className="text-xs text-blue-400">주말 발송 차단됨</span>}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors"
        >
          저장
        </button>
        {isDefault
          ? <span className="text-xs text-gray-600">제한 없음 (기본값)</span>
          : <span className="text-xs text-blue-400">{from} ~ {to}{bizOnly ? ' · 영업일만' : ''}</span>
        }
      </div>
    </SectionCard>
  )
}

// ── Scheduled Overview ────────────────────────────────────────────

const SCHEDULE = [
  { time: '08:40',         label: '모닝 리포트',       desc: '매수 후보 종목 분석 전송',       color: 'text-yellow-400' },
  { time: '09:05',         label: '섹터 스크리닝',      desc: '장 시작 직후 AI 전종목 스크리닝', color: 'text-blue-400'   },
  { time: '10:00~15:00',   label: '시간별 현황',        desc: '매 정시 보유 종목 진행 상황',     color: 'text-green-400'  },
  { time: '11:00',         label: '섹터 스크리닝',      desc: '오전 AI 전종목 스크리닝',         color: 'text-blue-400'   },
  { time: '13:30',         label: '섹터 스크리닝',      desc: '오후 AI 전종목 스크리닝',         color: 'text-blue-400'   },
  { time: '15:35',         label: '결산 리포트',        desc: '오늘 거래 결과 최종 요약',         color: 'text-purple-400' },
]

function ScheduleOverview() {
  return (
    <SectionCard title="자동 발송 스케줄 (평일)" icon={Clock}>
      <div className="space-y-2">
        {SCHEDULE.map(({ time, label, desc, color }) => (
          <div key={`${time}-${label}`} className="flex items-center gap-3 text-xs">
            <span className={`font-mono w-24 shrink-0 ${color}`}>{time}</span>
            <span className="font-medium text-gray-300 w-28 shrink-0">{label}</span>
            <span className="text-gray-500">{desc}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] text-gray-600">* 장 외 시간(야간/주말)에는 스케줄 알림이 발송되지 않습니다.</p>
    </SectionCard>
  )
}

// ── Command Panel ─────────────────────────────────────────────────

const CMD_EXAMPLES = [
  { cmd: '/buy [종목] [수량]',    desc: '시장가 매수',     icon: ShoppingCart, color: 'text-emerald-400' },
  { cmd: '/sell [종목] [수량]',   desc: '시장가 매도',     icon: TrendingUp,   color: 'text-red-400'     },
  { cmd: '/sellall [종목]',       desc: '전량 시장가 매도', icon: Layers,       color: 'text-orange-400'  },
  { cmd: '/holdings',             desc: '보유 종목 조회',   icon: ArrowDownCircle, color: 'text-blue-400' },
  { cmd: '/status',               desc: '포트폴리오 현황',  icon: Activity,     color: 'text-purple-400'  },
  { cmd: '/help',                 desc: '도움말',           icon: Terminal,     color: 'text-gray-400'    },
]

const CMD_RESULT_COLOR: Record<string, string> = {
  success:  'bg-emerald-900/30 border-emerald-700/40 text-emerald-300',
  error:    'bg-red-900/30 border-red-700/40 text-red-300',
  rejected: 'bg-yellow-900/30 border-yellow-700/40 text-yellow-300',
  unknown:  'bg-gray-800 border-gray-700 text-gray-400',
}

interface CmdLog {
  id: number; received_at: string; source: string
  user_name: string | null; raw_text: string
  command_type: string; stock_code: string | null; stock_name: string | null
  quantity: number | null; result: string; result_msg: string
}

function CommandPanel({ configured }: { configured: boolean }) {
  const [input, setInput]         = useState('')
  const [running, setRunning]     = useState(false)
  const [lastResult, setLastResult] = useState<{ result: string; result_msg: string } | null>(null)
  const [logs, setLogs]           = useState<CmdLog[]>([])
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [days, setDays]           = useState(7)
  const [expanded, setExpanded]   = useState<number | null>(null)

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true)
    try { setLogs(await getTelegramCommandLogs({ days })) } catch {}
    finally { setLoadingLogs(false) }
  }, [days])

  useEffect(() => { loadLogs() }, [loadLogs])

  const run = async (text: string) => {
    if (!text.trim()) return
    setRunning(true)
    setLastResult(null)
    try {
      const res = await runTelegramCommand(text.trim())
      setLastResult(res)
      await loadLogs()
    } catch (e: any) {
      setLastResult({ result: 'error', result_msg: e?.response?.data?.detail ?? '실행 실패' })
    } finally {
      setRunning(false)
    }
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }) + ' ' +
      d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  const CMD_TYPE_LABEL: Record<string, string> = {
    buy: '매수', sell: '매도', sellall: '전량매도',
    holdings: '보유조회', status: '현황', help: '도움말', unknown: '알수없음',
  }
  const CMD_TYPE_COLOR: Record<string, string> = {
    buy: 'bg-emerald-900/50 text-emerald-300', sell: 'bg-red-900/50 text-red-300',
    sellall: 'bg-orange-900/50 text-orange-300', holdings: 'bg-blue-900/50 text-blue-300',
    status: 'bg-purple-900/50 text-purple-300', help: 'bg-gray-800 text-gray-400',
    unknown: 'bg-gray-800 text-gray-500',
  }
  const SRC_BADGE: Record<string, string> = {
    web: 'bg-indigo-900/50 text-indigo-300',
    telegram: 'bg-cyan-900/50 text-cyan-300',
  }

  return (
    <div className="space-y-4">
      {/* 명령어 레퍼런스 */}
      <SectionCard title="지원 명령어" icon={Terminal}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
          {CMD_EXAMPLES.map(({ cmd, desc, icon: Icon, color }) => (
            <button
              key={cmd}
              onClick={() => setInput(cmd.split(' [')[0] + ' ')}
              className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-800/50 border border-gray-700/50 hover:border-gray-600 transition-colors text-left group"
            >
              <Icon size={14} className={`shrink-0 ${color}`} />
              <div>
                <div className="text-xs font-mono text-gray-200 group-hover:text-white">{cmd}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{desc}</div>
              </div>
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-gray-500 bg-gray-800/40 rounded-lg p-3">
          <div>
            <p className="text-gray-400 font-medium mb-1">📌 입력 예시</p>
            <p className="font-mono">/buy 삼성전자 5</p>
            <p className="font-mono">/buy 005930 3</p>
            <p className="font-mono">/sell 카카오 2</p>
            <p className="font-mono">/sellall 미래에셋</p>
          </div>
          <div>
            <p className="text-gray-400 font-medium mb-1">⚠️ 유의사항</p>
            <p>• 실전 모드에서는 즉시 키움 실계좌 주문이 접수됩니다</p>
            <p>• 종목명이 모호하면 코드(6자리 숫자)로 입력하세요</p>
            <p>• 웹 실행과 텔레그램 명령 모두 이력에 기록됩니다</p>
          </div>
        </div>
      </SectionCard>

      {/* 명령어 입력 */}
      <SectionCard title="명령어 실행 (웹)" icon={Send}>
        {!configured && (
          <p className="text-xs text-yellow-400 mb-3">⚠️ 텔레그램 미연결 상태: 웹 실행은 가능하지만 텔레그램 회신은 없습니다.</p>
        )}
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !running && run(input)}
            placeholder="/buy 삼성전자 5"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => run(input)}
            disabled={running || !input.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Send size={13} />
            {running ? '실행 중…' : '실행'}
          </button>
        </div>

        {lastResult && (
          <div className={`p-3 rounded-lg border text-xs ${CMD_RESULT_COLOR[lastResult.result] ?? CMD_RESULT_COLOR.unknown}`}>
            <pre className="whitespace-pre-wrap font-sans leading-relaxed">
              {lastResult.result_msg?.replace(/<[^>]+>/g, '')}
            </pre>
          </div>
        )}
      </SectionCard>

      {/* 명령어 실행 이력 */}
      <SectionCard title="명령어 이력" icon={History}>
        <div className="flex flex-wrap gap-2 mb-3 items-center">
          {[1, 3, 7, 30].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${days === d ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {d === 1 ? '오늘' : `${d}일`}
            </button>
          ))}
          <button onClick={loadLogs} disabled={loadingLogs} className="ml-auto text-gray-500 hover:text-white disabled:opacity-40">
            <RefreshCw size={13} className={loadingLogs ? 'animate-spin' : ''} />
          </button>
        </div>

        {logs.length === 0 ? (
          <p className="text-xs text-gray-600 py-4 text-center">명령어 이력이 없습니다.</p>
        ) : (
          <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1">
            {logs.map(l => (
              <div key={l.id} className="bg-gray-800/50 border border-gray-800 rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/80 transition-colors"
                >
                  {/* 출처 뱃지 */}
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium shrink-0 ${SRC_BADGE[l.source] ?? 'bg-gray-800 text-gray-400'}`}>
                    {l.source === 'telegram' ? '📱TG' : '🖥️WEB'}
                  </span>
                  {/* 명령 유형 */}
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${CMD_TYPE_COLOR[l.command_type] ?? 'bg-gray-800 text-gray-400'}`}>
                    {CMD_TYPE_LABEL[l.command_type] ?? l.command_type}
                  </span>
                  {/* 종목 */}
                  {l.stock_name && (
                    <span className="text-xs text-gray-300 shrink-0">{l.stock_name}</span>
                  )}
                  {l.quantity && (
                    <span className="text-xs text-gray-500 shrink-0">{l.quantity}주</span>
                  )}
                  {/* 원본 */}
                  <span className="text-[10px] text-gray-500 font-mono flex-1 truncate min-w-0">{l.raw_text}</span>
                  <span className="text-[10px] text-gray-600 shrink-0">{fmtTime(l.received_at)}</span>
                  {l.result === 'success'
                    ? <CheckCircle2 size={11} className="text-green-500 shrink-0" />
                    : <XCircle size={11} className="text-red-400 shrink-0" />}
                </button>
                {expanded === l.id && (
                  <div className="px-3 pb-3 border-t border-gray-700/50">
                    <pre className="mt-2 text-[10px] text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">
                      {l.result_msg?.replace(/<[^>]+>/g, '')}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[10px] text-gray-600 text-right">{logs.length}건</p>
      </SectionCard>
    </div>
  )
}

// ── Send Log Panel ────────────────────────────────────────────────

const MSG_TYPE_LABEL: Record<string, string> = {
  buy: '매수', sell: '매도', kill_switch: '킬스위치', error: '오류',
  report: '리포트', portfolio: '포트폴리오', hourly: '시간별', close: '결산',
  screening: '스크리닝', macro: '매크로', test: '테스트', general: '일반',
}
const MSG_TYPE_COLOR: Record<string, string> = {
  buy:        'bg-blue-900/40 text-blue-300',
  sell:       'bg-red-900/40 text-red-300',
  kill_switch:'bg-red-900/60 text-red-200',
  error:      'bg-orange-900/40 text-orange-300',
  report:     'bg-yellow-900/40 text-yellow-300',
  portfolio:  'bg-green-900/40 text-green-300',
  hourly:     'bg-cyan-900/40 text-cyan-300',
  close:      'bg-purple-900/40 text-purple-300',
  screening:  'bg-indigo-900/40 text-indigo-300',
  macro:      'bg-teal-900/40 text-teal-300',
  test:       'bg-gray-800 text-gray-400',
  general:    'bg-gray-800 text-gray-400',
}

interface TgLog {
  id: number; msg_type: string; stock_code: string | null; stock_name: string | null
  message: string; is_success: boolean; sent_at: string
}

function SendLogPanel() {
  const [logs, setLogs]       = useState<TgLog[]>([])
  const [days, setDays]       = useState(7)
  const [filter, setFilter]   = useState('')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getTelegramLogs({ days, msg_type: filter || undefined })
      setLogs(data)
    } catch {}
    finally { setLoading(false) }
  }, [days, filter])

  useEffect(() => { load() }, [load])

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }) + ' ' +
      d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  return (
    <SectionCard title="전송 내역" icon={History}>
      <div className="flex flex-wrap gap-2 mb-3">
        {[1, 3, 7, 30].map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${days === d ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
            {d === 1 ? '오늘' : `${d}일`}
          </button>
        ))}
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="ml-auto bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-300 focus:outline-none"
        >
          <option value="">전체 유형</option>
          {Object.entries(MSG_TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <button onClick={load} disabled={loading} className="text-gray-500 hover:text-white disabled:opacity-40">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {logs.length === 0 ? (
        <p className="text-xs text-gray-600 py-4 text-center">전송 내역이 없습니다.</p>
      ) : (
        <div className="space-y-1 max-h-[480px] overflow-y-auto pr-1">
          {logs.map(l => (
            <div key={l.id}
              className="bg-gray-800/50 border border-gray-800 rounded-lg overflow-hidden">
              <button
                onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/80 transition-colors"
              >
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${MSG_TYPE_COLOR[l.msg_type] ?? 'bg-gray-800 text-gray-400'}`}>
                  {MSG_TYPE_LABEL[l.msg_type] ?? l.msg_type}
                </span>
                {l.stock_name && (
                  <span className="text-xs text-gray-300 shrink-0">{l.stock_name}</span>
                )}
                <span className="text-[10px] text-gray-500 truncate flex-1 min-w-0">
                  {l.message?.replace(/<[^>]+>/g, '').slice(0, 60)}
                </span>
                <span className="text-[10px] text-gray-600 shrink-0">{fmtTime(l.sent_at)}</span>
                {l.is_success
                  ? <CheckCircle2 size={11} className="text-green-500 shrink-0" />
                  : <XCircle size={11} className="text-red-500 shrink-0" />}
              </button>
              {expanded === l.id && (
                <div className="px-3 pb-3 border-t border-gray-700/50">
                  <pre className="mt-2 text-[10px] text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">
                    {l.message?.replace(/<[^>]+>/g, '')}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] text-gray-600 text-right">{logs.length}건</p>
    </SectionCard>
  )
}

// ── Inbox Panel (내 메시지) ───────────────────────────────────────

interface InboxMsg {
  id: number
  tg_msg_id: number | null
  received_at: string | null
  from_user: string | null
  text: string
  is_command: string
}

function InboxPanel() {
  const [msgs, setMsgs]       = useState<InboxMsg[]>([])
  const [loading, setLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getTelegramInbox(200)
      // 오래된 순 → 화면은 아래가 최신 (카카오톡 스타일)
      setMsgs([...data].reverse())
    } catch {}
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const copy = async (msg: InboxMsg) => {
    await navigator.clipboard.writeText(msg.text)
    setCopiedId(msg.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const fmt = (iso: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <SectionCard title="내 메시지 수신함" icon={Inbox}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">텔레그램에서 보낸 메시지를 여기서 복사하세요</p>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          새로고침
        </button>
      </div>

      {msgs.length === 0 ? (
        <p className="text-center text-xs text-gray-600 py-10">
          텔레그램 앱에서 봇으로 메시지를 보내면 여기 표시됩니다
        </p>
      ) : (
        <div className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1">
          {msgs.map(m => (
            <div key={m.id} className="flex justify-end">
              <div className="group relative max-w-[80%]">
                {/* 말풍선 */}
                <div
                  className={`rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                    m.is_command === 'Y'
                      ? 'bg-gray-700 text-gray-300'
                      : 'bg-blue-600 text-white'
                  }`}
                >
                  {m.text}
                </div>
                {/* 시각 + 복사 버튼 */}
                <div className="flex items-center justify-end gap-2 mt-0.5">
                  <span className="text-[10px] text-gray-600">{fmt(m.received_at)}</span>
                  <button
                    onClick={() => copy(m)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-gray-300"
                    title="클립보드 복사"
                  >
                    {copiedId === m.id
                      ? <Check size={12} className="text-green-400" />
                      : <Copy size={12} />
                    }
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] text-gray-600 text-right">{msgs.length}건</p>
    </SectionCard>
  )
}

// ── Main Page ─────────────────────────────────────────────────────

type TabId = 'settings' | 'command' | 'logs' | 'inbox'

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'settings', label: '설정 & 알림', icon: Settings  },
  { id: 'command',  label: '명령어',       icon: Terminal  },
  { id: 'logs',     label: '전송 내역',    icon: History   },
  { id: 'inbox',    label: '내 메시지',    icon: Inbox     },
]

export default function TelegramPage() {
  const [activeTab, setActiveTab] = useState<TabId>('settings')
  const [status,   setStatus]   = useState<TgStatus | null>(null)
  const [tgSettings, setTgSettings] = useState<TgSettings | null>(null)
  const [savingMsg, setSavingMsg]   = useState('')

  const fetchStatus = useCallback(async () => {
    try {
      const r = await api.get('/telegram/status')
      setStatus(r.data)
    } catch {}
  }, [])

  const fetchSettings = useCallback(async () => {
    try {
      const r = await api.get('/telegram/settings')
      setTgSettings(r.data)
    } catch {}
  }, [])

  useEffect(() => {
    fetchStatus()
    fetchSettings()
  }, [fetchStatus, fetchSettings])

  const saveSettings = async (next: TgSettings) => {
    try {
      await api.post('/telegram/settings', next)
      setTgSettings(next)
      setSavingMsg('저장됨')
    } catch {
      setSavingMsg('저장 실패')
    } finally {
      setTimeout(() => setSavingMsg(''), 2500)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold text-gray-100">
          <MessageSquare size={17} className="text-blue-400" />
          텔레그램 알림
        </h2>
        {savingMsg && <span className="text-xs text-green-400">{savingMsg}</span>}
      </div>

      {/* 탭 */}
      <div className="flex border-b border-gray-800">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'settings' && (
        <>
          <ConnectionPanel status={status} onRefresh={fetchStatus} />
          <ManualSendPanel configured={!!status?.configured} />
          <IntervalPanel       settings={tgSettings} onSave={saveSettings} />
          <NotifyWindowPanel   settings={tgSettings} onSave={saveSettings} />
          <NotificationToggles settings={tgSettings} onSave={saveSettings} />
          <ScheduleOverview />
        </>
      )}

      {activeTab === 'command' && (
        <CommandPanel configured={!!status?.configured} />
      )}

      {activeTab === 'logs' && (
        <SendLogPanel />
      )}

      {activeTab === 'inbox' && (
        <InboxPanel />
      )}
    </div>
  )
}
