import { useCallback, useEffect, useState } from 'react'
import {
  Globe, TrendingUp, TrendingDown, Minus,
  RefreshCw, Play, AlertTriangle, CheckCircle,
  BarChart3, FlaskConical, Map, ScanSearch, ChevronDown, ChevronUp,
  BookOpen, ArrowRight, Cpu, Newspaper, ShieldCheck, Zap,
} from 'lucide-react'
import api from '../api/client'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

// ── 타입 ──────────────────────────────────────────────────────────────────────
interface MacroEvent {
  event_id:    string
  name:        string
  category:    string
  score:       number
  magnitude:   number
  confidence:  number
  persistence: number
  evidence:    string[]
  detected_at: string
}

interface Contribution {
  event_id:     string
  event_name:   string
  weight:       number
  event_score:  number
  contribution: number
}

interface SectorSignal {
  sector_id:     string
  sector_name:   string
  net_score:     number
  direction:     'long' | 'short' | 'neutral'
  contributions: Contribution[]
}

interface RunResult {
  run_at:  string
  mode:    string
  events:  number
  orders:  number
  log:     string[]
  sector_signals: { sector: string; name: string; score: number; dir: string }[]
  orders_placed:  { code: string; name: string; action: string; qty: number; price: number; reason: string }[]
}

interface ScreenedStock {
  stock_code:       string
  stock_name:       string
  screen_style:     string
  composite_score:  number | null
  model_score:      number | null
  news_score:       number | null
  dart_score:       number | null
  supply_score:     number | null
  market_score:     number | null
  final_signal:     string | null
  trigger_models:   string[]
  current_price:    number | null
  screened_at:      string | null
  macro_sector_name?: string
  macro_sector_score?: number
}

interface SectorRunResult {
  message:        string
  total_analyzed: number
  buy_signals:    number
  results:        ScreenedStock[]
}

interface BacktestResult {
  total_return_pct:      number
  annualized_return_pct: number
  max_drawdown_pct:      number
  sharpe_ratio:          number
  win_rate_pct:          number
  total_trades:          number
  benchmark_pct:         number
  excess_return_pct:     number
  equity_curve:          { date: string; equity: number; drawdown: number }[]
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
const CATEGORY_COLOR: Record<string, string> = {
  market: 'bg-blue-900/50 text-blue-300 border-blue-700',
  risk:   'bg-red-900/50 text-red-300 border-red-700',
  macro:  'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  policy: 'bg-purple-900/50 text-purple-300 border-purple-700',
}

const CATEGORY_LABEL: Record<string, string> = {
  market: '시장', risk: '리스크', macro: '거시', policy: '정책',
}

function ScoreBar({ value, max = 1 }: { value: number; max?: number }) {
  const pct = Math.min(100, (value / max) * 100)
  const color = value >= 0.7 ? 'bg-emerald-500' : value >= 0.4 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-mono text-gray-400 w-8 text-right">
        {(value * 100).toFixed(0)}
      </span>
    </div>
  )
}

function DirectionIcon({ dir }: { dir: string }) {
  if (dir === 'long')    return <TrendingUp size={14} className="text-emerald-400" />
  if (dir === 'short')   return <TrendingDown size={14} className="text-red-400" />
  return <Minus size={14} className="text-gray-500" />
}

// ── 작동 방식 설명 ──────────────────────────────────────────────────────────
function MacroHowItWorks() {
  const [open, setOpen] = useState(false)

  const steps = [
    {
      num: '1',
      color: 'bg-blue-600',
      icon: <Globe size={14} />,
      title: '글로벌 경제 지표 수집',
      sub: '30분마다 자동',
      desc: '원달러 환율, 국제 유가(WTI), 금 가격, 미국 10년 금리, 공포지수(VIX) 등을 자동으로 수집합니다.',
      items: ['📈 원달러 환율 — 수출기업 수익에 직결', '🛢 국제 유가 — 정유·에너지 섹터 영향', '💛 금 가격 — 안전자산 선호도 측정', '📉 VIX(공포지수) — 시장 불안감 수치', '🏦 미국 금리 — 성장주 vs 가치주 흐름'],
    },
    {
      num: '2',
      color: 'bg-purple-600',
      icon: <AlertTriangle size={14} />,
      title: '매크로 이벤트 감지',
      sub: '변화량 임계값 분석',
      desc: '수집한 지표가 기준치를 넘어 변동하면 "이벤트"로 인식합니다. 각 이벤트는 강도·지속성·신뢰도 3가지로 평가됩니다.',
      items: ['달러 급등 → 강도 0.8, 신뢰 0.9', '유가 급락 → 강도 0.6, 신뢰 0.7', '금리 상승 → 강도 0.5, 신뢰 0.8', '⚡ 이벤트가 없으면 전 섹터 관망 (매매 안 함)'],
    },
    {
      num: '3',
      color: 'bg-emerald-600',
      icon: <TrendingUp size={14} />,
      title: '수혜 섹터 자동 선정',
      sub: '이벤트 → 섹터 가중치 계산',
      desc: '각 이벤트가 어떤 업종에 유리한지 미리 설정된 규칙(이벤트-섹터 매핑 테이블)으로 계산합니다. 순점수 +0.20 이상인 섹터만 선정합니다.',
      items: ['달러 강세 → 반도체·자동차 수출 유리 ✅', '유가 상승 → 정유·에너지 섹터 유리 ✅', '금리 상승 → 바이오·성장주 불리 ❌', '🎯 최대 3개 섹터까지 선정'],
    },
    {
      num: '4',
      color: 'bg-yellow-600',
      icon: <Cpu size={14} />,
      title: 'AI 종목 스크리닝',
      sub: '하루 3회 (09:05 / 11:00 / 13:30)',
      desc: '선정된 섹터의 대표 종목들을 AI 모델 10개(M1~M10)로 분석합니다. 기술적 지표·뉴스 감성·공시·수급을 종합해 0~1점으로 채점합니다.',
      items: ['M1 이동평균 골든크로스', 'M2 RSI 과매도 반등', 'M3 MACD 상향 전환', 'M4 볼린저밴드 반등', 'M5~M10 거래량·캔들·추세 등', '📰 뉴스 감성 분석 15% 반영', '📋 DART 공시 분석 10% 반영'],
    },
    {
      num: '5',
      color: 'bg-red-600',
      icon: <Zap size={14} />,
      title: '자동 매수·매도 실행',
      sub: '5분 간격 체크',
      desc: '종합 점수가 매수 임계값(기본 0.60) 이상이면 자동으로 매수합니다. 손절·익절(전략 탭 설정값) 조건을 항상 감시하며, 일일 손실 한도 초과 시 킬스위치가 발동해 당일 매매를 완전 중단합니다. 당일 손절된 종목은 같은 날 재매수하지 않습니다.',
      items: ['종합점수 ≥ 매수 임계값(전략 탭) → 자동 매수', '손절 기준 이하 → 즉시 자동 매도 (전략 탭 설정)', '익절 기준 이상 → 수익 확정 자동 매도 (전략 탭 설정)', '🔒 당일 손절 종목 재매수 차단', '🚨 일일 손실 한도 초과 → 킬스위치 발동'],
    },
  ]

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BookOpen size={14} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-200">이 시스템은 어떻게 작동하나요?</span>
          <span className="text-xs text-gray-500">초보자도 쉽게 이해하는 작동 원리</span>
        </div>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {open && (
        <div className="border-t border-gray-800 px-4 py-5 space-y-6 text-xs">

          {/* 한 줄 요약 */}
          <div className="bg-blue-950/40 border border-blue-800/40 rounded-lg px-4 py-3">
            <p className="text-blue-200 leading-relaxed text-sm">
              <strong className="text-white">한 마디 요약:</strong> 세계 경제 흐름을 읽어 <strong className="text-yellow-300">지금 유리한 업종</strong>을 찾고,
              그 업종의 주식을 <strong className="text-emerald-300">AI로 자동 매수·매도</strong>하는 시스템입니다.
            </p>
          </div>

          {/* 5단계 플로우 */}
          <div>
            <p className="text-gray-400 font-semibold mb-3 text-xs uppercase tracking-wide">전체 흐름 (5단계)</p>
            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={step.num} className="flex gap-3">
                  {/* 번호 + 세로선 */}
                  <div className="flex flex-col items-center gap-1 shrink-0">
                    <div className={`w-6 h-6 rounded-full ${step.color} flex items-center justify-center text-white font-bold text-[11px]`}>
                      {step.num}
                    </div>
                    {i < steps.length - 1 && <div className="w-px flex-1 bg-gray-700 min-h-[16px]" />}
                  </div>

                  {/* 내용 */}
                  <div className="pb-4 flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`p-1 rounded ${step.color}/20 text-white`}>{step.icon}</span>
                      <span className="font-semibold text-gray-100 text-[13px]">{step.title}</span>
                      <span className="text-gray-500 text-[10px] bg-gray-800 rounded px-1.5 py-0.5">{step.sub}</span>
                    </div>
                    <p className="text-gray-400 leading-relaxed mb-2">{step.desc}</p>
                    <ul className="space-y-0.5">
                      {step.items.map((item, j) => (
                        <li key={j} className="text-gray-500 flex items-start gap-1.5">
                          <ArrowRight size={10} className="mt-0.5 shrink-0 text-gray-600" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 매크로 vs AI 자동매매 차이 */}
          <div>
            <p className="text-gray-400 font-semibold mb-2 text-xs uppercase tracking-wide">두 가지 매매 방식</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="bg-gray-800/60 rounded-lg p-3 border border-purple-800/30">
                <div className="flex items-center gap-1.5 mb-2">
                  <Globe size={12} className="text-purple-400" />
                  <span className="text-purple-300 font-semibold text-[12px]">매크로 파이프라인</span>
                  <span className="text-[10px] text-gray-500 bg-gray-700 rounded px-1">30분마다</span>
                </div>
                <p className="text-gray-400 leading-relaxed">글로벌 경제 이벤트 기반으로 섹터를 선정하고, 해당 섹터 대표 종목에 비중 조정 주문을 냅니다.</p>
                <p className="text-gray-500 mt-1.5">📍 매크로 탭 상단 <strong className="text-gray-300">▶ 실거래 실행</strong> 버튼</p>
              </div>
              <div className="bg-gray-800/60 rounded-lg p-3 border border-yellow-800/30">
                <div className="flex items-center gap-1.5 mb-2">
                  <Zap size={12} className="text-yellow-400" />
                  <span className="text-yellow-300 font-semibold text-[12px]">AI 자동매매 엔진</span>
                  <span className="text-[10px] text-gray-500 bg-gray-700 rounded px-1">5분마다</span>
                </div>
                <p className="text-gray-400 leading-relaxed">섹터 스크리닝 결과 + 워치리스트를 AI 10개 모델로 분석해 매수 조건이 되면 자동으로 주문합니다.</p>
                <p className="text-gray-500 mt-1.5">📍 <strong className="text-gray-300">전략 탭</strong> ▶시작 버튼으로 ON/OFF</p>
              </div>
            </div>
          </div>

          {/* 리스크 안내 */}
          <div className="bg-red-950/30 border border-red-800/30 rounded-lg px-4 py-3 flex gap-3">
            <ShieldCheck size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-red-300 font-semibold text-[12px]">꼭 알아두세요</p>
              <ul className="text-gray-400 space-y-0.5">
                <li>• 자동매매는 <strong className="text-white">수익을 보장하지 않습니다.</strong> 반드시 잃어도 되는 금액으로 시작하세요.</li>
                <li>• 처음엔 <strong className="text-white">PAPER 모드(모의)</strong>로 충분히 테스트한 뒤 실거래로 전환하세요.</li>
                <li>• <strong className="text-white">킬스위치</strong>와 <strong className="text-white">손절선</strong>을 반드시 설정해두세요 (전략 탭).</li>
                <li>• 두 시스템(매크로 + AI 자동매매)을 동시에 실거래로 켜면 주문이 충돌할 수 있습니다.</li>
              </ul>
            </div>
          </div>

          {/* 뉴스 읽기 안내 */}
          <div className="flex items-start gap-2 text-gray-500 bg-gray-800/40 rounded-lg px-3 py-2.5">
            <Newspaper size={12} className="mt-0.5 shrink-0 text-gray-600" />
            <p>더 자세한 이벤트-섹터 매핑 규칙은 <strong className="text-gray-300">이벤트-섹터 매핑 탭</strong>에서 확인할 수 있습니다.</p>
          </div>
        </div>
      )}
    </div>
  )
}

function NetScoreBadge({ score }: { score: number }) {
  const color = score >= 0.2
    ? 'bg-emerald-900/40 border-emerald-600 text-emerald-300'
    : score <= -0.2
      ? 'bg-red-900/40 border-red-600 text-red-300'
      : 'bg-gray-800 border-gray-600 text-gray-400'
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${color}`}>
      {score >= 0 ? '+' : ''}{(score * 100).toFixed(0)}
    </span>
  )
}

// ── 이벤트 카드 ──────────────────────────────────────────────────────────────
function EventCard({ ev }: { ev: MacroEvent }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`border rounded-xl overflow-hidden cursor-pointer ${CATEGORY_COLOR[ev.category] ?? 'bg-gray-800 border-gray-700 text-gray-300'}`}
      onClick={() => setOpen(v => !v)}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold">{ev.name}</span>
          <span className="text-[10px] opacity-70">{CATEGORY_LABEL[ev.category] ?? ev.category}</span>
        </div>
        <ScoreBar value={ev.score} />
        <div className="flex gap-3 mt-1.5 text-[10px] opacity-70">
          <span>강도 {(ev.magnitude * 100).toFixed(0)}</span>
          <span>신뢰 {(ev.confidence * 100).toFixed(0)}</span>
          <span>지속 {(ev.persistence * 100).toFixed(0)}</span>
        </div>
      </div>
      {open && ev.evidence.length > 0 && (
        <div className="border-t border-current/20 px-3 py-2 space-y-0.5">
          {ev.evidence.map((e, i) => (
            <p key={i} className="text-[10px] opacity-80">· {e}</p>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 섹터 히트맵 행 ────────────────────────────────────────────────────────────
function SectorRow({ sig, rank }: { sig: SectorSignal; rank: number }) {
  const [open, setOpen] = useState(false)
  const barPct = Math.min(100, Math.abs(sig.net_score) * 100)
  const barColor = sig.direction === 'long'
    ? 'bg-emerald-500'
    : sig.direction === 'short' ? 'bg-red-500' : 'bg-gray-600'

  return (
    <>
      <tr
        className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
        onClick={() => setOpen(v => !v)}
      >
        <td className="px-3 py-2.5 text-xs text-gray-500 w-6">{rank}</td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <DirectionIcon dir={sig.direction} />
            <span className="text-sm font-medium text-gray-200">{sig.sector_name}</span>
          </div>
        </td>
        <td className="px-3 py-2.5 w-32">
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${barColor}`}
              style={{ width: `${barPct}%` }}
            />
          </div>
        </td>
        <td className="px-3 py-2.5 text-right">
          <NetScoreBadge score={sig.net_score} />
        </td>
        <td className="px-3 py-2.5 text-xs text-gray-500 text-right">
          {sig.contributions.length}개 이벤트
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-900/50">
          <td colSpan={5} className="px-6 py-3">
            <div className="space-y-1">
              {sig.contributions
                .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
                .map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className={c.contribution >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {c.contribution >= 0 ? '▲' : '▼'}
                    </span>
                    <span className="text-gray-300 flex-1">{c.event_name}</span>
                    <span className="text-gray-500 font-mono">
                      {c.event_score.toFixed(2)} × {c.weight > 0 ? '+' : ''}{c.weight.toFixed(2)}
                      {' = '}
                      <span className={c.contribution >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {c.contribution > 0 ? '+' : ''}{c.contribution.toFixed(3)}
                      </span>
                    </span>
                  </div>
                ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── 스크리닝 결과 행 ──────────────────────────────────────────────────────────
function ScreenedRow({ s, rank }: { s: ScreenedStock; rank: number }) {
  const [open, setOpen] = useState(false)
  const score = s.composite_score ?? 0
  const scoreColor =
    score >= 0.7 ? 'text-emerald-400' :
    score >= 0.55 ? 'text-yellow-400' : 'text-gray-400'
  const priceStr = s.current_price ? s.current_price.toLocaleString() + '원' : '-'

  return (
    <>
      <tr
        className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
        onClick={() => setOpen(v => !v)}
      >
        <td className="px-3 py-2.5 text-xs text-gray-500 w-6">{rank}</td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${
              s.final_signal === 'BUY'  ? 'bg-emerald-900/60 text-emerald-400' :
              s.final_signal === 'SELL' ? 'bg-red-900/60 text-red-400' :
              'bg-gray-800 text-gray-500'
            }`}>{s.final_signal ?? '—'}</span>
            <div>
              <p className="text-sm font-medium text-gray-200 leading-tight">
                {s.stock_name && s.stock_name !== s.stock_code ? s.stock_name : '—'}
              </p>
              <p className="text-[10px] text-gray-500 font-mono leading-tight">{s.stock_code}</p>
            </div>
          </div>
          {s.macro_sector_name && (
            <p className="text-[10px] text-gray-600 mt-0.5 pl-12">{s.macro_sector_name}</p>
          )}
        </td>
        <td className="px-3 py-2.5 text-xs text-gray-400 text-right">{priceStr}</td>
        <td className="px-3 py-2.5 text-right">
          <span className={`text-sm font-bold font-mono ${scoreColor}`}>
            {(score * 100).toFixed(1)}
          </span>
        </td>
        <td className="px-3 py-2.5 text-right">
          {open
            ? <ChevronUp size={12} className="text-gray-500 ml-auto" />
            : <ChevronDown size={12} className="text-gray-500 ml-auto" />}
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-900/60">
          <td colSpan={5} className="px-6 py-3">
            <div className="grid grid-cols-5 gap-2 mb-2">
              {[
                { label: '모델',  v: s.model_score },
                { label: '뉴스',  v: s.news_score  },
                { label: 'DART', v: s.dart_score   },
                { label: '수급',  v: s.supply_score },
                { label: '시장',  v: s.market_score },
              ].map(({ label, v }) => (
                <div key={label} className="bg-gray-800 rounded-lg px-2 py-1.5 text-center">
                  <p className="text-[10px] text-gray-500">{label}</p>
                  <p className={`text-xs font-bold mt-0.5 ${
                    (v ?? 0) >= 0.6 ? 'text-emerald-400' :
                    (v ?? 0) >= 0.45 ? 'text-yellow-400' : 'text-red-400'
                  }`}>{v != null ? (v * 100).toFixed(0) : '-'}</p>
                </div>
              ))}
            </div>
            {s.trigger_models.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <span className="text-[10px] text-gray-500 mr-1">BUY 모델:</span>
                {s.trigger_models.map(m => (
                  <span key={m} className="text-[10px] bg-emerald-900/40 border border-emerald-800 text-emerald-400 rounded px-1.5 py-0.5">{m}</span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ── AI 섹터 스크리닝 패널 ──────────────────────────────────────────────────────
function SectorScreeningPanel() {
  const [running,    setRunning]    = useState(false)
  const [result,     setResult]     = useState<SectorRunResult | null>(null)
  const [latest,     setLatest]     = useState<{ screened_at: string | null; results: ScreenedStock[] } | null>(null)
  const [loadingLatest, setLoadingLatest] = useState(true)
  const [maxStocks,  setMaxStocks]  = useState(() => Number(localStorage.getItem('screen_max_stocks') ?? 80))
  const [minVol,     setMinVol]     = useState(() => Number(localStorage.getItem('screen_min_vol')    ?? 50))
  const [minCap,     setMinCap]     = useState(() => Number(localStorage.getItem('screen_min_cap')    ?? 1000))
  const [maxPrice,   setMaxPrice]   = useState(() => Number(localStorage.getItem('screen_max_price')  ?? 0))
  const [tab,        setTab]        = useState<'latest' | 'run'>('latest')
  const [priceSynced, setPriceSynced] = useState(false)

  const loadLatest = useCallback(async () => {
    setLoadingLatest(true)
    try {
      const r = await api.get('/screened/latest?style=full')
      setLatest(r.data)
    } catch { /* ignore */ }
    finally { setLoadingLatest(false) }
  }, [])

  useEffect(() => { loadLatest() }, [loadLatest])

  // 전략 탭의 단가 상한을 서버에서 자동 로드 (localStorage 미설정 시에만)
  useEffect(() => {
    if (priceSynced) return
    const stored = localStorage.getItem('screen_max_price')
    if (stored !== null) { setPriceSynced(true); return }
    api.get('/auto-trade/price-limit').then(r => {
      const v = r.data.max_stock_price ?? 0
      if (v > 0) {
        setMaxPrice(v)
        localStorage.setItem('screen_max_price', String(v))
      }
    }).catch(() => {}).finally(() => setPriceSynced(true))
  }, [priceSynced])

  const handleRun = async () => {
    setRunning(true); setResult(null)
    try {
      const r = await api.post(
        `/screened/sector-run?max_stocks=${maxStocks}&min_vol_won=${minVol * 1e8}&min_market_cap=${minCap * 1e8}&max_stock_price=${maxPrice}`
      )
      setResult(r.data)
      await loadLatest()
      setTab('latest')
    } catch (e) {
      console.error(e)
    } finally { setRunning(false) }
  }

  const displayList = tab === 'latest'
    ? (latest?.results ?? [])
    : (result?.results ?? [])

  const buyList = displayList.filter(s => s.final_signal === 'BUY')

  return (
    <div className="space-y-4">
      {/* 컨트롤 패널 */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <ScanSearch size={14} className="text-cyan-400" />
          매크로 섹터 기반 AI 스크리닝
          <span className="text-[10px] text-gray-500 font-normal">
            장중 09:05 · 11:00 · 13:30 자동 실행
          </span>
        </h3>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <label className="text-gray-400 block mb-1">최대 종목 수</label>
            <input
              type="number" min={10} max={200} step={10} value={maxStocks}
              onChange={e => { const v = Number(e.target.value); setMaxStocks(v); localStorage.setItem('screen_max_stocks', String(v)) }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
            />
          </div>
          <div>
            <label className="text-gray-400 block mb-1">
              종목 단가 상한 (원, 0=제한없음)
              <span className="ml-1 text-yellow-500">★</span>
            </label>
            <input
              type="number" min={0} step={10000} value={maxPrice}
              onChange={e => { const v = Number(e.target.value); setMaxPrice(v); localStorage.setItem('screen_max_price', String(v)) }}
              placeholder="예: 200000"
              className="w-full bg-gray-800 border border-yellow-700 rounded px-2 py-1.5 text-gray-200 placeholder-gray-600"
            />
            <p className="text-[10px] text-gray-600 mt-1">
              전략 탭 → 단가 상한 설정값이 자동 로드됩니다. 스케줄 자동 스크리닝에도 동일 적용.
            </p>
          </div>
          <div>
            <label className="text-gray-400 block mb-1">일평균 거래대금 (억원 이상)</label>
            <input
              type="number" min={10} step={10} value={minVol}
              onChange={e => { const v = Number(e.target.value); setMinVol(v); localStorage.setItem('screen_min_vol', String(v)) }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
            />
          </div>
          <div>
            <label className="text-gray-400 block mb-1">시가총액 (억원 이상)</label>
            <input
              type="number" min={100} step={100} value={minCap}
              onChange={e => { const v = Number(e.target.value); setMinCap(v); localStorage.setItem('screen_min_cap', String(v)) }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
            />
          </div>
        </div>
        {maxPrice > 0 && (
          <p className="text-xs text-yellow-400">
            ⚠ 단가 {maxPrice.toLocaleString()}원 이하 종목만 스크리닝합니다. 예수금에 맞게 설정하세요.
          </p>
        )}

        <button
          onClick={handleRun} disabled={running}
          className="w-full py-2.5 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-colors"
        >
          {running
            ? <><RefreshCw size={13} className="animate-spin" /> 스크리닝 실행 중… (수분 소요)</>
            : <><ScanSearch size={13} /> 코스피/코스닥 전종목 AI 스크리닝 즉시 실행</>}
        </button>

        {running && (
          <p className="text-xs text-gray-500 text-center">
            pykrx 전종목 조회 → 섹터 매핑 → M1-M10 모델 적용 중…
          </p>
        )}
      </div>

      {/* 결과 탭 */}
      <div className="flex gap-1 items-center border-b border-gray-800">
        <button
          onClick={() => setTab('latest')}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
            tab === 'latest'
              ? 'border-cyan-500 text-cyan-300'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          최근 스크리닝 결과
          {latest?.screened_at && (
            <span className="ml-1.5 text-[10px] text-gray-600">
              {new Date(latest.screened_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </button>
        {result && (
          <button
            onClick={() => setTab('run')}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === 'run'
                ? 'border-emerald-500 text-emerald-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            방금 실행 결과
            <span className="ml-1.5 text-[10px] bg-emerald-900/50 text-emerald-400 rounded px-1">
              {result.buy_signals}건 BUY
            </span>
          </button>
        )}
        <button
          onClick={loadLatest} disabled={loadingLatest}
          className="ml-auto p-1.5 text-gray-500 hover:text-gray-300"
        >
          <RefreshCw size={12} className={loadingLatest ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 요약 배너 */}
      {displayList.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 text-center">
            <p className="text-[10px] text-gray-500">분석 종목</p>
            <p className="text-xl font-bold text-gray-200 mt-0.5">{displayList.length}</p>
          </div>
          <div className="bg-gray-900 border border-emerald-800/40 rounded-xl px-3 py-2.5 text-center">
            <p className="text-[10px] text-gray-500">매수 신호</p>
            <p className="text-xl font-bold text-emerald-400 mt-0.5">{buyList.length}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 text-center">
            <p className="text-[10px] text-gray-500">평균 점수</p>
            <p className="text-xl font-bold text-yellow-400 mt-0.5">
              {displayList.length
                ? ((displayList.reduce((s, r) => s + (r.composite_score ?? 0), 0) / displayList.length) * 100).toFixed(1)
                : '-'}
            </p>
          </div>
        </div>
      )}

      {/* 결과 테이블 */}
      {loadingLatest && tab === 'latest' ? (
        <div className="text-center py-10 text-gray-500 text-sm">
          <RefreshCw size={16} className="animate-spin mx-auto mb-2" />
          최근 스크리닝 결과 로딩 중…
        </div>
      ) : displayList.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-10 text-center text-sm text-gray-500">
          <ScanSearch size={28} className="mx-auto mb-2 opacity-30" />
          {tab === 'latest'
            ? '아직 스크리닝 결과가 없습니다. 위 버튼으로 즉시 실행하세요.'
            : '실행 결과가 없습니다.'}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500">
                <th className="px-3 py-2.5 text-left w-6">#</th>
                <th className="px-3 py-2.5 text-left">종목</th>
                <th className="px-3 py-2.5 text-right">현재가</th>
                <th className="px-3 py-2.5 text-right">종합점수</th>
                <th className="px-3 py-2.5 w-6" />
              </tr>
            </thead>
            <tbody>
              {displayList.map((s, i) => (
                <ScreenedRow key={`${s.stock_code}-${i}`} s={s} rank={i + 1} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── 백테스트 패널 ─────────────────────────────────────────────────────────────
function BacktestPanel() {
  const [form, setForm] = useState({
    start_date: '2024-01-01', end_date: '2025-12-31',
    initial_capital: 10000000, hold_days: 5,
    stop_loss_pct: 5, take_profit_pct: 10,
  })
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState('')

  const handleRun = async () => {
    setRunning(true); setError(''); setResult(null)
    try {
      const r = await api.post('/macro/backtest', form)
      setResult(r.data)
    } catch (e: unknown) {
      setError('백테스트 실패 — 서버 로그 확인')
    } finally { setRunning(false) }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <FlaskConical size={14} className="text-purple-400" /> 백테스트
      </h3>

      <div className="grid grid-cols-2 gap-3 text-xs">
        {[
          { label: '시작일', key: 'start_date', type: 'date' },
          { label: '종료일', key: 'end_date', type: 'date' },
        ].map(({ label, key, type }) => (
          <div key={key}>
            <label className="text-gray-400 block mb-1">{label}</label>
            <input
              type={type} value={(form as Record<string, unknown>)[key] as string}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
            />
          </div>
        ))}
        {[
          { label: '초기 자본(원)', key: 'initial_capital', step: 1000000 },
          { label: '보유 기간(일)', key: 'hold_days', step: 1 },
          { label: '손절(%)', key: 'stop_loss_pct', step: 0.5 },
          { label: '익절(%)', key: 'take_profit_pct', step: 0.5 },
        ].map(({ label, key, step }) => (
          <div key={key}>
            <label className="text-gray-400 block mb-1">{label}</label>
            <input
              type="number" step={step}
              value={(form as Record<string, unknown>)[key] as number}
              onChange={e => setForm(f => ({ ...f, [key]: parseFloat(e.target.value) }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
            />
          </div>
        ))}
      </div>

      <button
        onClick={handleRun} disabled={running}
        className="w-full py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 rounded-lg text-xs font-bold flex items-center justify-center gap-2"
      >
        {running ? <><RefreshCw size={12} className="animate-spin" /> 실행 중…</> : '▶ 백테스트 실행'}
      </button>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              { label: '총 수익률', value: `${result.total_return_pct >= 0 ? '+' : ''}${result.total_return_pct.toFixed(2)}%`, color: result.total_return_pct >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { label: '연환산 수익률', value: `${result.annualized_return_pct >= 0 ? '+' : ''}${result.annualized_return_pct.toFixed(2)}%`, color: result.annualized_return_pct >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { label: 'MDD', value: `-${result.max_drawdown_pct.toFixed(2)}%`, color: 'text-red-400' },
              { label: '샤프 비율', value: result.sharpe_ratio.toFixed(2), color: result.sharpe_ratio >= 1 ? 'text-emerald-400' : 'text-gray-300' },
              { label: '승률', value: `${result.win_rate_pct.toFixed(1)}%`, color: result.win_rate_pct >= 50 ? 'text-emerald-400' : 'text-red-400' },
              { label: '총 거래수', value: `${result.total_trades}회`, color: 'text-gray-300' },
              { label: 'KOSPI', value: `${result.benchmark_pct >= 0 ? '+' : ''}${result.benchmark_pct.toFixed(2)}%`, color: 'text-gray-400' },
              { label: '초과 수익', value: `${result.excess_return_pct >= 0 ? '+' : ''}${result.excess_return_pct.toFixed(2)}%`, color: result.excess_return_pct >= 0 ? 'text-emerald-400' : 'text-red-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-800 rounded-lg px-3 py-2">
                <p className="text-gray-500 text-[10px]">{label}</p>
                <p className={`font-bold text-sm mt-0.5 ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────
export default function MacroRotation() {
  const [events,  setEvents]  = useState<MacroEvent[]>([])
  const [signals, setSignals] = useState<SectorSignal[]>([])
  const [loading, setLoading] = useState(false)
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [running,   setRunning]   = useState(false)
  const [tab, setTab] = useState<'heatmap' | 'screening' | 'backtest' | 'map'>('heatmap')
  const [mapData, setMapData] = useState<{
    events: Record<string, { name: string; category: string }>
    sectors: Record<string, { name: string; representative_stocks: { code: string; name: string }[] }>
    mappings: { event: string; sector: string; weight: number; rationale: string }[]
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/macro/status')
      setEvents(r.data.events ?? [])
      setSignals(r.data.sector_signals ?? [])
    } catch (e) {
      console.error(e)
    } finally { setLoading(false) }
  }, [])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(1800, load)

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (tab === 'map' && !mapData) {
      api.get('/macro/map').then(r => setMapData(r.data)).catch(() => {})
    }
  }, [tab, mapData])

  const handleRun = async () => {
    setRunning(true); setRunResult(null)
    try {
      const r = await api.post('/macro/run/sync', { mode: 'paper' })
      setRunResult(r.data)
      await load()
    } catch (e) {
      console.error(e)
    } finally { setRunning(false) }
  }

  const longSectors  = signals.filter(s => s.direction === 'long').length
  const shortSectors = signals.filter(s => s.direction === 'short').length

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Globe size={18} className="text-blue-400" />
            매크로 섹터 로테이션
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            거시 이벤트 감지 → 수혜 섹터 자동 선정 → 대표 종목 매매
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={1800}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy || loading}
            onRefresh={timerRefresh}
            serverLabel="30분 캐시"
          />
        </div>
      </div>

      {/* 요약 배너 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 text-center">
          <p className="text-xs text-gray-500">감지된 이벤트</p>
          <p className="text-2xl font-bold text-blue-400 mt-0.5">{events.length}</p>
        </div>
        <div className="bg-gray-900 border border-emerald-800/40 rounded-xl px-4 py-3 text-center">
          <p className="text-xs text-gray-500">오버웨이트 섹터</p>
          <p className="text-2xl font-bold text-emerald-400 mt-0.5">{longSectors}</p>
        </div>
        <div className="bg-gray-900 border border-red-800/40 rounded-xl px-4 py-3 text-center">
          <p className="text-xs text-gray-500">회피 섹터</p>
          <p className="text-2xl font-bold text-red-400 mt-0.5">{shortSectors}</p>
        </div>
      </div>

      {/* 작동 방식 설명 */}
      <MacroHowItWorks />

      {/* 이벤트 카드 */}
      {events.length > 0 && (
        <section>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <AlertTriangle size={11} /> 활성 매크로 이벤트
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {events.map(ev => <EventCard key={ev.event_id} ev={ev} />)}
          </div>
        </section>
      )}

      {events.length === 0 && !loading && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-8 text-center text-sm text-gray-500">
          <Globe size={28} className="mx-auto mb-2 opacity-30" />
          감지된 매크로 이벤트 없음 — 시장 관망 중
        </div>
      )}

      {/* 파이프라인 실행 (관찰 전용 — 실제 주문 없음) */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleRun} disabled={running}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-colors bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
        >
          {running
            ? <><RefreshCw size={14} className="animate-spin" /> 실행 중…</>
            : <><Play size={14} /> 섹터 스크리닝 실행</>}
        </button>
        <span className="text-xs text-gray-500 flex items-center gap-1">
          <AlertTriangle size={11} /> 관찰 전용 — 실제 주문 없음 (실매매는 AI 자동매매 엔진이 담당)
        </span>
      </div>

      {/* 실행 결과 */}
      {runResult && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <CheckCircle size={14} className="text-emerald-400" />
            파이프라인 실행 완료
            <span className="text-xs text-gray-500 font-normal">
              이벤트 {runResult.events}개 · 주문 {runResult.orders}건 · {runResult.mode.toUpperCase()}
            </span>
          </div>

          {runResult.orders_placed.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-gray-400 font-semibold">발주 내역</p>
              {runResult.orders_placed.map((o, i) => (
                <div key={i} className="flex items-center gap-3 text-xs bg-gray-800 rounded-lg px-3 py-2">
                  <span className={`font-bold ${o.action === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{o.action}</span>
                  <span className="text-gray-200">{o.name}</span>
                  <span className="text-gray-500">{o.code}</span>
                  <span className="ml-auto text-gray-300">{o.qty}주 @ {o.price.toLocaleString()}원</span>
                </div>
              ))}
            </div>
          )}

          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer hover:text-gray-300">파이프라인 로그 ({runResult.log.length}줄)</summary>
            <div className="mt-2 bg-gray-950 rounded-lg p-3 font-mono space-y-0.5 max-h-48 overflow-y-auto">
              {runResult.log.map((line, i) => (
                <p key={i} className={
                  line.includes('[LIVE') ? 'text-red-300' :
                  line.includes('[PAPER') ? 'text-emerald-300' :
                  line.includes('[경고') || line.includes('오류') ? 'text-yellow-300' :
                  'text-gray-500'
                }>{line}</p>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* 탭 */}
      <div className="flex gap-1 border-b border-gray-800">
        {([
          { id: 'heatmap',   label: '섹터 히트맵',     Icon: BarChart3 },
          { id: 'screening', label: 'AI 종목 스크리닝', Icon: ScanSearch },
          { id: 'backtest',  label: '백테스트',         Icon: FlaskConical },
          { id: 'map',       label: '이벤트-섹터 매핑',  Icon: Map },
        ] as const).map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === id
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon size={11} />{label}
          </button>
        ))}
      </div>

      {/* 섹터 히트맵 */}
      {tab === 'heatmap' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {signals.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-10">
              {loading ? '로딩 중…' : '신호 없음 — 관망'}
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="px-3 py-2.5 text-left w-6">#</th>
                  <th className="px-3 py-2.5 text-left">섹터</th>
                  <th className="px-3 py-2.5 text-left w-32">강도</th>
                  <th className="px-3 py-2.5 text-right">순점수</th>
                  <th className="px-3 py-2.5 text-right">기여 이벤트</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((sig, i) => (
                  <SectorRow key={sig.sector_id} sig={sig} rank={i + 1} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* AI 섹터 스크리닝 */}
      {tab === 'screening' && <SectorScreeningPanel />}

      {/* 백테스트 */}
      {tab === 'backtest' && <BacktestPanel />}

      {/* 매핑 테이블 */}
      {tab === 'map' && mapData && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
              <h3 className="text-xs font-semibold text-gray-300">이벤트 → 섹터 매핑 룰</h3>
              <p className="text-[11px] text-gray-500 mt-0.5">
                config/event_sector_map.yaml
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-500">
                    <th className="px-4 py-2.5 text-left">이벤트</th>
                    <th className="px-4 py-2.5 text-left">섹터</th>
                    <th className="px-4 py-2.5 text-center w-16">가중치</th>
                    <th className="px-4 py-2.5 text-left">근거</th>
                  </tr>
                </thead>
                <tbody>
                  {mapData.mappings.map((m, i) => (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                      <td className="px-4 py-2">
                        <span className="text-gray-300">
                          {mapData.events[m.event]?.name ?? m.event}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-400">
                        {mapData.sectors[m.sector]?.name ?? m.sector}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <span className={`font-bold ${m.weight >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {m.weight > 0 ? '+' : ''}{m.weight.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500">{m.rationale}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 섹터별 대표 종목 */}
          <div className="grid sm:grid-cols-2 gap-3">
            {Object.entries(mapData.sectors).map(([sid, sec]) => (
              <div key={sid} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
                <p className="text-xs font-semibold text-gray-300 mb-2">{sec.name}</p>
                <div className="flex flex-wrap gap-1">
                  {sec.representative_stocks.map(s => (
                    <span key={s.code} className="text-[10px] bg-gray-800 rounded px-2 py-0.5 text-gray-400">
                      {s.name} <span className="text-gray-600">{s.code}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
