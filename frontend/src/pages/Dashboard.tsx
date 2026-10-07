import { useEffect, useState, useCallback } from 'react'
import {
  getDashboardSummary, getPnlChart,
  getHoldings, getAutoTradeToday,
  getAccountBalance, reconcileOrders,
  getMarketStatus, syncHoldingsWithKiwoom,
  getStrategy, updateStrategy,
  getPerformanceSplit,
  getPendingBuys,
} from '../api/client'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'
import PnLChart from '../components/charts/PnLChart'
import HoldingTable, { type Holding, type PendingBuy } from '../components/tables/HoldingTable'
import { useWebSocketMessage } from '../hooks/useWebSocket'
import { useTradeStore } from '../store/tradeStore'
import {
  Landmark, RefreshCw, TrendingUp, TrendingDown,
  Wallet, Activity, BarChart2, Clock, ShieldCheck,
  Brain, Newspaper, Building2, Globe, Users,
  ArrowRightCircle, TrendingDown as TrendingDownIcon,
  CheckCircle2, XCircle, ChevronDown, ChevronUp, Zap,
  ShoppingCart, BadgeDollarSign, AlertTriangle, Repeat2,
  Sprout, CalendarDays, Filter, RefreshCcw,
  Pencil, Check,
} from 'lucide-react'

// ── 자동매매 로직 안내 컴포넌트 ──────────────────────────────────

function AutoTradeGuide() {
  const [open, setOpen] = useState(false)

  const scoreFactors = [
    { icon: Brain,         label: 'AI 모델 신호',    pct: 35, color: 'text-violet-400', bar: 'bg-violet-500',
      desc: 'EMA크로스·볼린저밴드·거래량폭발·LightGBM 4개 모델이 과거 주가 패턴으로 상승 확률을 계산합니다.' },
    { icon: Users,         label: '외국인·기관 수급', pct: 25, color: 'text-blue-400',   bar: 'bg-blue-500',
      desc: '최근 5일 외국인·기관 순매수 강도를 분석합니다. 수급 점수가 75점 이상이면 스마트 홀딩 모드로 전환됩니다.' },
    { icon: Globe,         label: '시장 상황',        pct: 15, color: 'text-cyan-400',   bar: 'bg-cyan-500',
      desc: '코스피 등락률(-3%~+3%)·시간대·요일을 종합해 지금 살 만한 환경인지 판단합니다.' },
    { icon: Newspaper,     label: '뉴스 감성',        pct: 15, color: 'text-amber-400',  bar: 'bg-amber-500',
      desc: '최근 24시간 뉴스를 AI가 분석해 긍정/부정 점수를 매깁니다. 악재 뉴스가 감지되면 매수를 차단합니다.' },
    { icon: Building2,     label: 'DART 공시',        pct: 10, color: 'text-emerald-400',bar: 'bg-emerald-500',
      desc: '금감원 공시(실적·분기보고서 등)를 분석해 호재·악재를 반영합니다.' },
  ]

  const buyConditions = [
    { ok: true,  text: '종합 점수 ≥ 60점 (전략 설정에서 변경 가능)' },
    { ok: true,  text: '보유 종목이 최대 한도(기본 10종목) 미만' },
    { ok: true,  text: '악재 뉴스 없음 — 뉴스 감성 점수 40점 초과' },
    { ok: true,  text: '09:30 이후, 14:00 이전 — 장초반·마감 전 매수 차단' },
    { ok: true,  text: '가용 예수금으로 1주 이상 살 수 있음' },
    { ok: true,  text: '프리장 STRONG_BUY 종목 — 종합 점수 최대 +8pt 부스트' },
    { ok: false, text: '오늘 손절한 종목 — 당일 재매수 금지' },
    { ok: false, text: '오늘 익절한 종목 — 재매수 임계값 +10점 가산' },
    { ok: false, text: '손실 -2% 이하 보유 중 종목 — 추가매수(물타기) 차단' },
    { ok: false, text: '샹들리에 하향 돌파 종목 — 하락 추세로 매수 차단' },
  ]

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800">
      {/* 헤더 — 항상 보임 */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Brain size={15} className="text-violet-400" />
          <h2 className="text-sm font-semibold text-gray-100">자동매매 작동 원리</h2>
          <span className="text-[10px] text-gray-500 ml-1">— 초보자 가이드</span>
        </div>
        {open
          ? <ChevronUp size={15} className="text-gray-500" />
          : <ChevronDown size={15} className="text-gray-500" />
        }
      </button>

      {open && (
        <div className="px-4 pb-5 space-y-6">

          {/* ── 1. 하루 운영 스케줄 ─────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              ① 하루 자동 운영 스케줄 (평일 기준)
            </h3>
            <div className="space-y-2 mb-4">
              {[
                { time: '08:10',       label: '프리장 거래량 스캔',    sub: '워치리스트 + 섹터스크리닝 상위 종목 시간외 거래량 분석 (pykrx 20일 평균 대비 비교)', tc: 'text-amber-300',   bc: 'border-amber-800 bg-amber-900/10'    },
                { time: '08:25',       label: '텔레그램 매수 후보 알림',sub: 'STRONG_BUY · BUY 신호 종목 사전 발송 — 정규장 시작 전 준비',                          tc: 'text-blue-300',    bc: 'border-blue-800 bg-blue-900/10'      },
                { time: '09:10',       label: '장기 전략 매수',         sub: '재무 스크리닝(ROE·부채비율·PER) 통과 종목 동일비중 매수 — 시장 모드 무관 실행',         tc: 'text-emerald-300', bc: 'border-emerald-800 bg-emerald-900/10' },
                { time: '09:30~15:30', label: '정규장 자동매매 (10분마다)', sub: '손절·익절 체크 → 후보 수집 → AI 점수 → 매수 / 프리장 STRONG_BUY 종목 점수 부스트',  tc: 'text-violet-300',  bc: 'border-violet-800 bg-violet-900/10'  },
                { time: '15:45',       label: '상승 종목 자동 분석',    sub: '당일 3%↑ 종목의 뉴스·거래량·수급 원인 분석 후 DB 저장 → AI 학습 데이터 누적',          tc: 'text-gray-400',    bc: 'border-gray-700 bg-gray-800/30'      },
              ].map(item => (
                <div key={item.time} className={`flex items-start gap-3 border ${item.bc} rounded-lg px-3 py-2.5`}>
                  <span className={`text-[10px] font-bold tabular-nums shrink-0 w-[80px] pt-0.5 ${item.tc}`}>{item.time}</span>
                  <div>
                    <p className={`text-xs font-semibold ${item.tc}`}>{item.label}</p>
                    <p className="text-[10px] text-gray-500 leading-snug mt-0.5">{item.sub}</p>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-[10px] text-gray-500 mb-2">▸ 정규장 10분 사이클 실행 순서</p>
            <div className="flex flex-wrap items-center gap-1">
              {[
                { icon: ShieldCheck,      label: '손절·익절 체크',  sub: '보유 종목 전수 감시',         color: 'border-red-800    bg-red-900/20    text-red-300'    },
                { icon: ArrowRightCircle, label: '후보 종목 수집',  sub: '섹터스크리닝 + 워치리스트', color: 'border-violet-800 bg-violet-900/20 text-violet-300' },
                { icon: Brain,            label: 'AI 점수 계산',    sub: '5가지 요소 종합 0~100점',   color: 'border-blue-800   bg-blue-900/20   text-blue-300'   },
                { icon: ShoppingCart,     label: '매수 실행',       sub: '점수 상위 종목 자동 주문',   color: 'border-emerald-800 bg-emerald-900/20 text-emerald-300' },
              ].map((step, i, arr) => (
                <div key={step.label} className="flex items-center gap-1">
                  <div className={`border ${step.color} rounded-lg px-3 py-2 min-w-[110px]`}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <step.icon size={12} />
                      <span className="text-xs font-semibold">{step.label}</span>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-tight">{step.sub}</p>
                  </div>
                  {i < arr.length - 1 && (
                    <ArrowRightCircle size={14} className="text-gray-700 shrink-0" />
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              📌 09:00~09:30은 장초반 허수호가 구간이라 신규 매수가 차단됩니다. 14:00 이후도 오버나이트 리스크로 차단됩니다.
            </p>
          </div>

          {/* ── 2. 장기 투자 전략 ────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Sprout size={12} className="text-emerald-400" />
              ② 장기 투자 전략 — 분기 재무 스크리닝
            </h3>

            <div className="mb-4 p-3 bg-emerald-900/10 border border-emerald-800/30 rounded-lg">
              <p className="text-[11px] text-gray-300 leading-relaxed">
                단기 AI 매매(10분 사이클)와 <strong className="text-emerald-300">독립적으로</strong> 운영됩니다.
                매 분기마다 ROE·부채비율·매출성장률 등 재무지표로 우량주를 선별해 <strong className="text-emerald-300">동일비중으로 매수</strong>하고,
                분기 리밸런싱 때 성과 하위 종목을 교체합니다.
                손절·익절 없이 분기 단위로만 운영하며, <strong className="text-emerald-300">하락장에서도 매수를 허용</strong>합니다 (우량주 저가 매수 기회).
              </p>
            </div>

            <p className="text-[10px] text-gray-500 mb-2">▸ 단기 전략과의 주요 차이점</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
              {[
                { icon: CalendarDays, color: 'text-emerald-400', title: '운영 주기',
                  short: '10분마다 실행', long: '분기(3·6·9·12월)마다 스크리닝 → 매수·리밸런싱' },
                { icon: ShieldCheck,  color: 'text-blue-400',    title: '시장 모드',
                  short: '경계·수비 시 매수 차단', long: '모드 무관 매수 허용 (하락장 저가 매수)' },
                { icon: TrendingDown, color: 'text-red-400',     title: '매도 조건',
                  short: '손절(-3%) · 익절(+5%)', long: '손절·익절 없음 — 분기 리밸런싱으로 교체' },
                { icon: BarChart2,    color: 'text-violet-400',  title: '화면번호',
                  short: '1000~1049번대', long: '2000~2049번대 (단기와 완전 분리)' },
              ].map(item => (
                <div key={item.title} className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <item.icon size={12} className={item.color} />
                    <span className={`text-[11px] font-semibold ${item.color}`}>{item.title}</span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-start gap-1.5">
                      <span className="text-[9px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded shrink-0 mt-0.5">단기</span>
                      <span className="text-[10px] text-gray-400">{item.short}</span>
                    </div>
                    <div className="flex items-start gap-1.5">
                      <span className="text-[9px] bg-emerald-900/60 text-emerald-300 px-1.5 py-0.5 rounded shrink-0 mt-0.5">장기</span>
                      <span className="text-[10px] text-gray-300">{item.long}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-[10px] text-gray-500 mb-2 flex items-center gap-1">
              <Filter size={10} className="text-gray-500" />
              ▸ 종목 선별 기준 (pykrx + DART 재무 데이터)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
              {[
                { label: 'ROE',       value: '≥ 10%',    desc: '자기자본이익률',  color: 'text-emerald-300', bar: 'bg-emerald-600', pct: 70 },
                { label: '부채비율',  value: '≤ 200%',   desc: '재무 안정성',     color: 'text-blue-300',    bar: 'bg-blue-600',    pct: 55 },
                { label: '매출성장률',value: '≥ 0%',     desc: '전년 대비 성장',  color: 'text-cyan-300',    bar: 'bg-cyan-600',    pct: 40 },
                { label: 'PER',       value: '3 ~ 25배', desc: '적정 밸류에이션',color: 'text-violet-300',  bar: 'bg-violet-600',  pct: 60 },
                { label: 'PBR',       value: '≥ 0.3배',  desc: '순자산 대비 가격',color: 'text-amber-300',   bar: 'bg-amber-600',   pct: 35 },
                { label: '시가총액',  value: '≥ 5,000억',desc: '대형·중형주 한정',color: 'text-rose-300',    bar: 'bg-rose-600',    pct: 50 },
              ].map(f => (
                <div key={f.label} className="bg-gray-800/40 rounded-lg p-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-gray-400">{f.label}</span>
                    <span className={`text-[10px] font-bold tabular-nums ${f.color}`}>{f.value}</span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-1 mb-1">
                    <div className={`h-1 rounded-full ${f.bar}`} style={{ width: `${f.pct}%` }} />
                  </div>
                  <p className="text-[9px] text-gray-600">{f.desc}</p>
                </div>
              ))}
            </div>

            <p className="text-[10px] text-gray-500 mb-2">▸ 장기 전략 자동 스케줄</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
              {[
                { time: '09:10', label: '스크리닝 + 매수', desc: '재무 스크리닝 후 미보유 종목 동일비중 매수 (매일 실행, 분기 변경 시만 신규 편입)', color: 'border-emerald-800 bg-emerald-900/10 text-emerald-300' },
                { time: '09:30', label: '분기 리밸런싱',   desc: '3·6·9·12월 15일 — 성과 하위 종목 매도 후 신규 종목으로 교체',                   color: 'border-blue-800 bg-blue-900/10 text-blue-300' },
                { time: '15:40', label: '계좌 스냅샷',     desc: '일별 포트폴리오 가치·수익률 DB 기록',                                            color: 'border-violet-800 bg-violet-900/10 text-violet-300' },
              ].map(item => (
                <div key={item.time} className={`border ${item.color} rounded-lg p-2`}>
                  <div className={`text-[10px] font-mono font-bold ${item.color.split(' ')[2]}`}>{item.time}</div>
                  <div className="text-[11px] font-semibold text-gray-200 mt-0.5">{item.label}</div>
                  <div className="text-[9px] text-gray-500 mt-0.5 leading-tight">{item.desc}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1 mb-3">
              {[
                { icon: Filter,       label: '재무 스크리닝',  sub: 'ROE·부채비율·PER 필터', color: 'border-emerald-800 bg-emerald-900/20 text-emerald-300' },
                { icon: ShoppingCart, label: '동일비중 매수',  sub: '예산 ÷ 종목 수 균등 배분', color: 'border-blue-800 bg-blue-900/20 text-blue-300' },
                { icon: RefreshCcw,   label: '분기 리밸런싱',  sub: '성과 하위 종목 매도 → 신규 편입', color: 'border-violet-800 bg-violet-900/20 text-violet-300' },
              ].map((step, i, arr) => (
                <div key={step.label} className="flex items-center gap-1">
                  <div className={`border ${step.color} rounded-lg px-3 py-2 min-w-[120px]`}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <step.icon size={12} />
                      <span className="text-xs font-semibold">{step.label}</span>
                    </div>
                    <p className="text-[9px] text-gray-500 leading-tight">{step.sub}</p>
                  </div>
                  {i < arr.length - 1 && <ArrowRightCircle size={14} className="text-gray-700 shrink-0" />}
                </div>
              ))}
            </div>

            <div className="p-3 bg-gray-800/60 rounded-lg">
              <p className="text-[11px] text-gray-400">
                💡 보유 종목 화면에서 <strong className="text-emerald-300">🌱 장기</strong> 배지로 표시됩니다.
                장기 종목은 단기 엔진의 손절·익절에서 완전히 제외됩니다.
                텔레그램 포트폴리오 현황은 장기·단기 섹션을 분리해서 발송됩니다.
              </p>
            </div>
          </div>

          {/* ── 3. AI 점수 구성 ───────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              ③ AI 종합 점수 구성 — 5가지 요소를 합산 (0~100점)
            </h3>
            <div className="space-y-2.5">
              {scoreFactors.map(f => (
                <div key={f.label}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <f.icon size={13} className={f.color} />
                      <span className="text-xs font-medium text-gray-200">{f.label}</span>
                    </div>
                    <span className={`text-xs font-bold tabular-nums ${f.color}`}>{f.pct}%</span>
                  </div>
                  <div className="w-full bg-gray-800 rounded-full h-1.5 mb-1">
                    <div className={`h-1.5 rounded-full ${f.bar}`} style={{ width: `${f.pct * 2.86}%` }} />
                  </div>
                  <p className="text-[10px] text-gray-500 leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 p-3 bg-gray-800/60 rounded-lg space-y-2">
              <p className="text-[11px] text-gray-400">
                💡 <strong className="text-gray-200">예시:</strong> 종합 점수 75점 →
                AI모델 80점(×35%) + 수급 70점(×25%) + 시장 60점(×15%) + 뉴스 80점(×15%) + 공시 70점(×10%)
                <br />점수가 기준값(기본 <strong className="text-violet-300">60점</strong>) 이상이면 매수를 시도합니다.
              </p>
              <p className="text-[11px] text-amber-400/80 border-t border-gray-700 pt-2">
                ⚡ 프리장(08:10) 거래량 폭발 종목은 종합 점수에 <strong className="text-amber-300">최대 +8pt</strong> 우선 부스트가 추가됩니다.
                거래량이 20일 평균 대비 높을수록 부스트 크기가 커집니다.
              </p>
            </div>
          </div>

          {/* ── 4. 매수 조건 ──────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              ④ 단기 전략 — 매수 조건 (모두 통과해야 매수)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {buyConditions.map((c, i) => (
                <div key={i} className={`flex items-start gap-2 p-2.5 rounded-lg ${c.ok ? 'bg-emerald-900/10 border border-emerald-900/30' : 'bg-red-900/10 border border-red-900/30'}`}>
                  {c.ok
                    ? <CheckCircle2 size={13} className="text-emerald-400 mt-0.5 shrink-0" />
                    : <XCircle      size={13} className="text-red-400     mt-0.5 shrink-0" />
                  }
                  <span className="text-[11px] text-gray-300 leading-relaxed">{c.text}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              📌 오늘 매매 내역의 "스킵 이유" 컬럼에서 어떤 조건에 막혔는지 확인할 수 있습니다.
            </p>
          </div>

          {/* ── 5. 매도 조건 ──────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              ⑤ 단기 전략 — 자동 매도 조건 (10분마다 보유 종목 전수 체크)
            </h3>

            {/* 일반 매도 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              {[
                { icon: TrendingDownIcon, color: 'text-red-400',     label: '손절',     desc: '평균 매수가 대비 -3% 하락 시 즉시 전량 매도 (수급 점수와 무관하게 항상 적용)' },
                { icon: TrendingUp,       color: 'text-emerald-400', label: '일반 익절', desc: '수급 점수 < 75점일 때 +5% 상승 시 전량 매도 (전략 설정에서 변경 가능)' },
                { icon: Zap,              color: 'text-yellow-400',  label: '동적 익절', desc: '수급 ≥ 65점 + 시장 강세이면 익절 기준을 7.5%로 상향해 더 보유합니다.' },
              ].map(s => (
                <div key={s.label} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <s.icon size={13} className={s.color} />
                    <span className={`text-xs font-bold ${s.color}`}>{s.label}</span>
                  </div>
                  <p className="text-[11px] text-gray-400 leading-relaxed">{s.desc}</p>
                </div>
              ))}
            </div>

            {/* 스마트 홀딩 */}
            <div className="p-3 bg-blue-900/10 border border-blue-800/40 rounded-lg mb-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Users size={12} className="text-blue-400" />
                <span className="text-xs font-bold text-blue-400">스마트 홀딩 모드 (수급 점수 ≥ 75점)</span>
              </div>
              <p className="text-[11px] text-gray-400 mb-2">
                외국인·기관이 강하게 매수 중인 종목은 고정 익절(+5%) 없이 아래 3가지 신호가 올 때만 청산합니다.
                수급이 강한 동안 추세를 더 타기 위한 전략입니다.
              </p>
              <div className="space-y-1.5">
                {[
                  { label: '① 샹들리에 청산', desc: '최근 20봉 최고가 − 3×ATR14 아래로 현재가가 내려왔을 때 (추세 이탈 확인)' },
                  { label: '② 거래량 급감 청산', desc: '오늘 예상 거래량이 5일 평균의 40% 미만일 때 (수익 구간에서만, 11시 이후)' },
                  { label: '③ 수급 이탈 청산', desc: '수급 점수가 55점 아래로 내려왔을 때 (외국인·기관이 빠져나가는 신호)' },
                ].map(item => (
                  <div key={item.label} className="flex items-start gap-2">
                    <span className="text-[10px] font-semibold text-blue-300 shrink-0 mt-0.5">{item.label}</span>
                    <span className="text-[10px] text-gray-500 leading-snug">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-3 bg-gray-800/60 rounded-lg">
              <p className="text-[11px] text-gray-400">
                💡 손절·익절 기준은 <strong className="text-gray-200">전략 탭 → 손절/익절 설정</strong>에서 변경할 수 있습니다.
                손절된 종목은 당일 재매수하지 않습니다. 장기 보유(🌱) 종목은 이 로직에서 완전히 제외됩니다.
              </p>
            </div>
          </div>

          {/* ── 6. 안전장치 ───────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              ⑥ 안전장치
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { icon: ShieldCheck,    color: 'text-blue-400',   title: '킬스위치',        desc: '웹 화면에서 언제든지 자동매매를 즉시 중단할 수 있습니다.' },
                { icon: AlertTriangle,  color: 'text-red-400',    title: '일일 손실 한도',  desc: '하루 실현 손실이 설정 한도를 초과하면 킬스위치가 자동으로 켜지고 텔레그램으로 알림이 옵니다.' },
                { icon: Repeat2,        color: 'text-amber-400',  title: '무한 재시도 방지', desc: 'API 오류로 거절된 매수 종목은 당일 다시 시도하지 않습니다. 텔레그램 /buy로 수동 주문 가능합니다.' },
                { icon: BadgeDollarSign,color: 'text-emerald-400',title: '모의·실전 분리',  desc: '전략 설정에서 모의매매(실제 주문 없음)와 실전매매를 언제든 전환할 수 있습니다.' },
              ].map(s => (
                <div key={s.title} className="flex items-start gap-2.5 p-3 bg-gray-800/40 border border-gray-700 rounded-lg">
                  <s.icon size={16} className={`${s.color} mt-0.5 shrink-0`} />
                  <div>
                    <p className="text-xs font-semibold text-gray-200 mb-0.5">{s.title}</p>
                    <p className="text-[11px] text-gray-400 leading-relaxed">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── 7. 자주 묻는 것 ───────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              ⑦ 자주 묻는 것
            </h3>
            <div className="space-y-2">
              {[
                { q: '프리장 스캔이란 무엇인가요?',
                  a: '매일 08:10에 워치리스트 + 섹터스크리닝 상위 종목의 시간외(프리마켓) 거래량을 분석합니다. pykrx로 구한 20일 평균 거래량 대비 급증 종목에 STRONG_BUY / BUY 신호를 부여하고, 08:25에 텔레그램으로 알려줍니다. 해당 종목은 정규장 자동매매에서 점수 부스트(최대 +8pt)를 받아 우선 매수 후보가 됩니다.' },
                { q: '왜 점수가 높은데 안 사나요?',
                  a: '주요 원인: ① 09:30 이전이거나 14:00 이후 ② 예수금 부족 ③ 최대 보유 종목 초과 ④ 악재 뉴스 감지 ⑤ 당일 손절 종목 ⑥ 샹들리에 하향 돌파. 오늘 매매 내역의 "스킵 이유" 컬럼을 확인하세요.' },
                { q: '"스마트 홀딩"이란 무엇인가요?',
                  a: '수급 점수(외국인·기관 순매수)가 75점 이상이면 고정 익절(+5%)을 건너뛰고, 샹들리에 이탈·거래량 급감·수급 이탈 3가지 신호 중 하나가 발생할 때만 청산합니다. 강한 수급이 있는 종목은 추세를 더 탑니다.' },
                { q: '"PENDING"과 "FILLED"는 다른가요?',
                  a: 'PENDING = 주문 접수(체결 대기), FILLED = 체결 완료입니다. 시장가 주문이라 보통 수초 내 FILLED로 바뀝니다.' },
                { q: '모의매매는 실제 돈이 나가나요?',
                  a: '아니요. 전략 탭에서 "모의매매" 모드일 때는 실제 주문을 보내지 않고 기록만 합니다.' },
                { q: '장기 전략은 언제 매수하나요?',
                  a: '매일 09:10에 재무 스크리닝을 실행하고 미보유 통과 종목을 동일비중으로 매수합니다. 분기가 바뀌는 달(3·6·9·12월)에만 신규 종목이 편입됩니다. 하락장(경계·수비·전면수비 모드)에도 정상 매수합니다.' },
                { q: '장기 보유 종목에도 손절이 적용되나요?',
                  a: '아니요. 장기 전략 종목(🌱 배지)은 단기 엔진의 손절·익절·스마트홀딩 로직에서 완전히 제외됩니다. 분기 리밸런싱 때 성과 하위 종목만 교체됩니다.' },
              ].map((item, i) => (
                <div key={i} className="border border-gray-800 rounded-lg overflow-hidden">
                  <div className="flex items-start gap-2 p-3">
                    <span className="text-[10px] font-bold text-blue-400 mt-0.5 shrink-0">Q</span>
                    <span className="text-[11px] font-medium text-gray-200">{item.q}</span>
                  </div>
                  <div className="flex items-start gap-2 px-3 pb-3 border-t border-gray-800">
                    <span className="text-[10px] font-bold text-emerald-400 mt-0.5 shrink-0">A</span>
                    <span className="text-[11px] text-gray-400 leading-relaxed">{item.a}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────

const RANGES = ['7d', '30d', '90d', 'all'] as const
type Range = typeof RANGES[number]

function isMarketOpen(): boolean {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
  const day = kst.getDay()
  if (day === 0 || day === 6) return false
  const t = kst.getHours() * 100 + kst.getMinutes()
  return t >= 900 && t <= 1530
}

function fmt(v: number, sign = true): string {
  const prefix = sign ? (v >= 0 ? '+' : '') : ''
  if (Math.abs(v) >= 100_000_000) return `${prefix}${(v / 100_000_000).toFixed(2)}억원`
  if (Math.abs(v) >= 10_000)      return `${prefix}${(v / 10_000).toFixed(0)}만원`
  return `${prefix}${v.toLocaleString()}원`
}

interface Balance {
  cash: number; available_cash: number; total_asset: number
  total_buy_amount: number; total_pnl: number; total_pnl_rate: number
  account_name: string; synced_at?: string; holdings?: Holding[]
  kiwoom_available?: boolean
}
interface Summary {
  today_pnl: number; cumulative_pnl: number; win_rate: number
  holdings_count: number; today_trade_count: number
  account_no?: string; account_name?: string
}
interface TradeLog {
  id: number; stock_code: string; stock_name: string
  action: string; quantity: number; order_price: number
  filled_price: number | null; filled_amount: number | null
  composite_score: number | null; realized_pnl: number | null
  trigger_models: string[]; status: string; error_msg: string | null
  created_at: string | null; filled_at: string | null
}
interface TodayTrade {
  buy_count: number; sell_count: number
  filled_buy_count: number; filled_sell_count: number
  total_buy_amount: number; total_sell_amount: number
  logs: TradeLog[]
}
interface MarketStatus {
  kospi: number; kospi_change_pct: number
  kosdaq: number; kosdaq_change_pct: number
  mode: string; mode_kr: string; mode_desc: string; available: boolean
}

type ActionFilter = 'ALL' | 'BUY' | 'SELL'
type StatusFilter = 'SUCCESS' | 'CANCELLED' | 'ALL'

interface PerfRealized {
  total_pnl: number; trade_count: number; win_count: number; loss_count: number
  win_rate: number; avg_win: number; avg_loss: number
  cumulative_chart: { date: string; pnl: number }[]
}
interface PerfHolding {
  stock_code: string; stock_name: string; quantity: number
  avg_buy_price: number; current_price: number
  unrealized_pnl: number; unrealized_pnl_pct: number
}
interface PerfUnrealized {
  total_value: number; total_unrealized_pnl: number; holdings: PerfHolding[]
}

export default function Dashboard() {
  const [summary, setSummary]       = useState<Summary | null>(null)
  const [chartData, setChartData]   = useState<unknown[]>([])
  const [range, setRange]           = useState<Range>('30d')
  const [holdings, setHoldings]     = useState<Holding[]>([])
  const [pendingBuys, setPendingBuys] = useState<PendingBuy[]>([])
  const [todayTrade, setTodayTrade] = useState<TodayTrade | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [actionFilter, setActionFilter] = useState<ActionFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('SUCCESS')
  const [reconciling, setReconciling] = useState(false)
  const [reconcileResult, setReconcileResult] = useState<{ cancelled?: unknown[]; filled?: unknown[]; message: string } | null>(null)
  const [syncing, setSyncing]         = useState(false)
  const [syncMsg, setSyncMsg]         = useState<string | null>(null)

  const [perfSplit, setPerfSplit] = useState<{
    long_term:  { realized: PerfRealized; unrealized: PerfUnrealized }
    short_term: { realized: PerfRealized; unrealized: PerfUnrealized }
  } | null>(null)
  const [perfTab, setPerfTab] = useState<'short' | 'long'>('short')

  const [balance, setBalance]             = useState<Balance | null>(null)
  const [balanceErr, setBalanceErr]       = useState<string | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [totalDeposited, setTotalDeposited] = useState(0)
  const [depositedEditing, setDepositedEditing] = useState(false)
  const [depositedInput, setDepositedInput]     = useState('')
  const [depositedSaving, setDepositedSaving]   = useState(false)
  const [marketStatus, setMarketStatus]   = useState<MarketStatus | null>(null)
  const [marketUpdatedAt, setMarketUpdatedAt] = useState<Date | null>(null)
  const [marketSecsLeft, setMarketSecsLeft]   = useState(30)

  const [marketOpen, setMarketOpen] = useState(() => isMarketOpen())
  const { addSignal } = useTradeStore()

  const MARKET_POLL_SEC = 30

  useEffect(() => {
    const id = setInterval(() => setMarketOpen(isMarketOpen()), 60_000)
    return () => clearInterval(id)
  }, [])

  // 시장 지수 전용 30초 자동 갱신 + 카운트다운
  const loadMarketStatusOnly = useCallback(async () => {
    try {
      const ms = await getMarketStatus()
      if (ms) {
        setMarketStatus(ms)
        setMarketUpdatedAt(new Date())
        setMarketSecsLeft(MARKET_POLL_SEC)
      }
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    const pollId = setInterval(loadMarketStatusOnly, MARKET_POLL_SEC * 1000)
    const tickId = setInterval(() => setMarketSecsLeft(s => Math.max(0, s - 1)), 1000)
    return () => { clearInterval(pollId); clearInterval(tickId) }
  }, [loadMarketStatusOnly])

  const loadBalance = useCallback(async () => {
    setBalanceLoading(true)
    setBalanceErr(null)
    try {
      // 잔고 조회 + 계좌 현행화 + 미체결 동시 실행
      const [bal, syncResult, pb] = await Promise.all([
        getAccountBalance(),
        syncHoldingsWithKiwoom().catch(() => null),
        getPendingBuys().catch(() => []),
      ])
      setBalance(bal)
      if (Array.isArray(pb)) setPendingBuys(pb)
      // 현행화 결과 우선, 없으면 잔고 API의 holdings 사용
      if (syncResult && Array.isArray(syncResult.holdings)) {
        setHoldings(syncResult.holdings)
      } else if (Array.isArray(bal.holdings) && bal.holdings.length > 0) {
        setHoldings(bal.holdings)
      }
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e instanceof Error ? e.message : '잔고 조회 실패')
      setBalanceErr(msg)
    } finally {
      setBalanceLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    const [s, c, h, t, ms, ps, pb] = await Promise.all([
      getDashboardSummary().catch(() => null),
      getPnlChart(range).catch(() => null),
      getHoldings().catch(() => []),
      getAutoTradeToday().catch(() => null),
      getMarketStatus().catch(() => null),
      getPerformanceSplit().catch(() => null),
      getPendingBuys().catch(() => []),
    ])
    if (s  != null) setSummary(s)
    if (c  != null) setChartData(c)
    if (Array.isArray(h) && h.length > 0) setHoldings(h)
    setTodayTrade(t)
    if (ms != null) {
      setMarketStatus(ms)
      setMarketUpdatedAt(new Date())
      setMarketSecsLeft(MARKET_POLL_SEC)
    }
    if (ps != null) setPerfSplit(ps)
    if (Array.isArray(pb)) setPendingBuys(pb)
  }, [range])

  const loadDeposited = useCallback(async () => {
    try {
      const s = await getStrategy()
      setTotalDeposited(s.total_deposited || 0)
    } catch { /* silent */ }
  }, [])

  const saveDeposited = async () => {
    const val = parseFloat(depositedInput.replace(/,/g, ''))
    if (isNaN(val) || val < 0) return
    setDepositedSaving(true)
    try {
      await updateStrategy({ total_deposited: val })
      setTotalDeposited(val)
      setDepositedEditing(false)
    } finally {
      setDepositedSaving(false)
    }
  }

  useEffect(() => { load(); loadBalance(); loadDeposited() }, [load, loadBalance, loadDeposited])

  useWebSocketMessage('signal', (data) => {
    addSignal(data as Parameters<typeof addSignal>[0])
  })

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([load(), loadBalance()])
    setRefreshing(false)
  }, [load, loadBalance])

  const handleReconcile = useCallback(async () => {
    setReconciling(true)
    setReconcileResult(null)
    try {
      const res = await reconcileOrders()
      setReconcileResult(res)
      await load()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '알 수 없는 오류'
      setReconcileResult({ cancelled: [], filled: [], message: `오류: ${msg}` })
    } finally {
      setReconciling(false)
    }
  }, [load])

  const { secondsLeft, lastRefreshed, isRefreshing: timerRefreshing, refresh: timerRefresh } =
    useRefreshTimer(60, handleRefresh)

  const pnlColor = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-300'

  // 시장 모드별 스타일
  const modeStyle = (mode: string) => {
    switch (mode) {
      case 'DEFENSIVE':    return { bg: 'bg-red-900/30 border-red-700',    text: 'text-red-300',    icon: '🛑', label: '전면수비' }
      case 'CONSERVATIVE': return { bg: 'bg-orange-900/30 border-orange-700', text: 'text-orange-300', icon: '🛡', label: '수비' }
      case 'CAUTIOUS':     return { bg: 'bg-yellow-900/30 border-yellow-700', text: 'text-yellow-300', icon: '⚠️', label: '경계' }
      default:             return { bg: 'bg-emerald-900/20 border-emerald-800', text: 'text-emerald-400', icon: '✅', label: '정상' }
    }
  }

  return (
    <div className="space-y-4">

      {/* ── 시장 상태 배너 (비정상 모드일 때 강조) ─────── */}
      {marketStatus && (
        <div className={`flex items-center justify-between px-4 py-2.5 rounded-xl border text-xs ${modeStyle(marketStatus.mode).bg}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span>{modeStyle(marketStatus.mode).icon}</span>
            <span className={`font-bold ${modeStyle(marketStatus.mode).text}`}>
              [{modeStyle(marketStatus.mode).label} 모드]
            </span>
            {marketStatus.available ? (
              <>
                <span className="text-gray-400">코스피</span>
                <span className={`font-semibold tabular-nums ${marketStatus.kospi_change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {marketStatus.kospi.toLocaleString('ko-KR')}
                  <span className="ml-1">({marketStatus.kospi_change_pct >= 0 ? '+' : ''}{marketStatus.kospi_change_pct.toFixed(2)}%)</span>
                </span>
                <span className="text-gray-600 hidden sm:inline">│</span>
                <span className="text-gray-400 hidden sm:inline">코스닥</span>
                <span className={`font-semibold tabular-nums hidden sm:inline ${marketStatus.kosdaq_change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {marketStatus.kosdaq.toLocaleString('ko-KR')}
                  <span className="ml-1">({marketStatus.kosdaq_change_pct >= 0 ? '+' : ''}{marketStatus.kosdaq_change_pct.toFixed(2)}%)</span>
                </span>
                <span className="text-gray-500 hidden md:inline">—</span>
                <span className={`hidden md:inline ${modeStyle(marketStatus.mode).text}`}>{marketStatus.mode_desc}</span>
              </>
            ) : (
              <span className="text-gray-500">장 마감 (지수 조회 불가)</span>
            )}
          </div>
          {/* 연동 주기 표시 */}
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              marketStatus.available ? 'bg-emerald-500 animate-pulse' : 'bg-gray-600'
            }`} />
            <span className="text-gray-500 text-[10px] tabular-nums hidden sm:inline">
              {marketStatus.available
                ? marketSecsLeft > 0
                  ? `${marketSecsLeft}s`
                  : '갱신중'
                : '장외'}
            </span>
            {marketUpdatedAt && (
              <span className="text-gray-600 text-[10px] hidden md:inline">
                {marketUpdatedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 헤더 ───────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-bold shrink-0">대시보드</h1>

            {balanceLoading ? (
              <div className="h-7 w-64 bg-gray-800 rounded-lg animate-pulse" />
            ) : balanceErr ? (
              <button onClick={loadBalance}
                className="flex items-center gap-1.5 bg-gray-800 px-3 py-1.5 rounded-lg text-xs text-red-400 hover:bg-gray-700 transition-colors"
                title={balanceErr}
              >
                <Landmark size={11} />
                <span>잔고 조회 실패 — 재시도</span>
                <RefreshCw size={10} className="ml-0.5" />
              </button>
            ) : balance ? (
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs flex-wrap ${
                balance.kiwoom_available === false ? 'bg-gray-800/60' : 'bg-gray-800'
              }`}>
                <Landmark size={11} className={balance.kiwoom_available === false ? 'text-gray-500 shrink-0' : 'text-blue-400 shrink-0'} />
                {balance.account_name && (
                  <span className="text-gray-400 hidden lg:inline">{balance.account_name}</span>
                )}
                <span className="text-gray-500">예수금</span>
                <span className="font-semibold">{balance.cash.toLocaleString('ko-KR')}원</span>
                <span className="text-gray-700 hidden sm:inline">│</span>
                <span className="text-gray-500 hidden sm:inline">총 자산</span>
                <span className="font-semibold hidden sm:inline">{balance.total_asset.toLocaleString('ko-KR')}원</span>
                <span className="text-gray-700">│</span>
                <span className="text-gray-500">손익</span>
                <span className={`font-semibold ${pnlColor(balance.total_pnl)}`}>
                  {balance.total_pnl >= 0 ? '+' : ''}{balance.total_pnl.toLocaleString('ko-KR')}원
                </span>
                <span className={`hidden sm:inline ${pnlColor(balance.total_pnl_rate)}`}>
                  ({balance.total_pnl_rate >= 0 ? '+' : ''}{balance.total_pnl_rate.toFixed(2)}%)
                </span>
                {balance.kiwoom_available === false && (
                  <span className="text-[9px] bg-yellow-900/50 text-yellow-400 border border-yellow-700/40 px-1.5 py-0.5 rounded ml-1">
                    원장 점검중 (18:00~08:00)
                  </span>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-3 mt-1">
            <div className="flex items-center gap-1 text-xs">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${marketOpen ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
              <span className={marketOpen ? 'text-green-400' : 'text-gray-500'}>
                {marketOpen ? '개장중' : '폐장'}
              </span>
            </div>
            {balance?.synced_at && (
              <span className="text-[10px] text-gray-600">
                {balance.kiwoom_available === false ? '캐시 기준 ' : '잔고 동기화 '}
                {new Date(balance.synced_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={60}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerRefreshing || refreshing}
            onRefresh={timerRefresh}
            serverLabel="잔고 60초"
          />
        </div>
      </div>

      {/* ── KPI 카드 (잔고 API 기반) ───────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* 평가 손익 */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-2">
            {balance && balance.total_pnl >= 0
              ? <TrendingUp size={12} className="text-emerald-400" />
              : <TrendingDown size={12} className="text-red-400" />}
            평가 손익
          </div>
          {balance ? (
            <>
              <div className={`text-xl font-bold ${pnlColor(balance.total_pnl)}`}>
                {balance.total_pnl >= 0 ? '+' : ''}{balance.total_pnl.toLocaleString('ko-KR')}원
              </div>
              <div className={`text-xs mt-1 ${pnlColor(balance.total_pnl_rate)}`}>
                {balance.total_pnl_rate >= 0 ? '+' : ''}{balance.total_pnl_rate.toFixed(2)}%
              </div>
            </>
          ) : (
            <div className="text-xl font-bold text-gray-600 animate-pulse">---</div>
          )}
        </div>

        {/* 총 자산 + 입금 기준 손익 */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-2">
            <Wallet size={12} className="text-blue-400" />
            총 자산 (현금+주식)
          </div>
          {balance ? (
            <>
              <div className="text-xl font-bold text-white">
                {fmt(balance.total_asset, false)}
              </div>
              {/* 총 입금액 입력 */}
              <div className="mt-2 pt-2 border-t border-gray-800 space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] text-gray-500">총 입금액</span>
                  {depositedEditing ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={depositedInput}
                        onChange={e => setDepositedInput(e.target.value.replace(/[^0-9]/g, ''))}
                        onKeyDown={e => { if (e.key === 'Enter') saveDeposited(); if (e.key === 'Escape') setDepositedEditing(false) }}
                        className="w-24 text-xs bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-white text-right"
                        placeholder="0"
                        autoFocus
                      />
                      <span className="text-[10px] text-gray-400">원</span>
                      <button
                        onClick={saveDeposited}
                        disabled={depositedSaving}
                        className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        onClick={() => setDepositedEditing(false)}
                        className="text-gray-500 hover:text-gray-300"
                      >
                        <XCircle size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-gray-300">
                        {totalDeposited > 0 ? totalDeposited.toLocaleString('ko-KR') + '원' : '미설정'}
                      </span>
                      <button
                        onClick={() => { setDepositedInput(String(totalDeposited)); setDepositedEditing(true) }}
                        className="text-gray-500 hover:text-gray-300"
                        title="입금액 수정"
                      >
                        <Pencil size={10} />
                      </button>
                    </div>
                  )}
                </div>
                {/* 실손익 계산 */}
                {totalDeposited > 0 && !depositedEditing && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500">실손익</span>
                    <span className={`text-[10px] font-semibold ${pnlColor(balance.total_asset - totalDeposited)}`}>
                      {(balance.total_asset - totalDeposited) >= 0 ? '+' : ''}
                      {(balance.total_asset - totalDeposited).toLocaleString('ko-KR')}원
                      {' '}({(balance.total_asset - totalDeposited) >= 0 ? '+' : ''}
                      {totalDeposited > 0
                        ? (((balance.total_asset - totalDeposited) / totalDeposited) * 100).toFixed(2)
                        : '0.00'}%)
                    </span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-xl font-bold text-gray-600 animate-pulse">---</div>
          )}
        </div>

        {/* 오늘 매매 */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-2">
            <Activity size={12} className="text-yellow-400" />
            오늘 매매
          </div>
          {todayTrade != null ? (
            <>
              <div className="text-xl font-bold text-white">
                {(todayTrade.filled_buy_count ?? 0) + (todayTrade.filled_sell_count ?? 0)}건
              </div>
              <div className="text-xs mt-1 text-gray-500">
                체결 매수 {todayTrade.filled_buy_count ?? 0} · 매도 {todayTrade.filled_sell_count ?? 0}
              </div>
              <div className="text-[10px] mt-0.5 text-gray-600">
                전체 시도 {(todayTrade.buy_count ?? 0) + (todayTrade.sell_count ?? 0)}건
              </div>
            </>
          ) : (
            <div className="text-xl font-bold text-gray-600">0건</div>
          )}
        </div>

        {/* 보유 종목 + 승률 */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-2">
            <BarChart2 size={12} className="text-purple-400" />
            보유 / 승률
          </div>
          <div className="text-xl font-bold text-white">
            {holdings.length}종목
          </div>
          <div className="text-xs mt-1 text-gray-500">
            승률 {summary?.win_rate?.toFixed(1) ?? '0.0'}%
          </div>
        </div>
      </div>

      {/* ── 포트폴리오 구성 (장기 / 단기 / 예수금) ──────── */}
      {(() => {
        const ltHoldings  = holdings.filter(h => h.is_long_term)
        const stHoldings  = holdings.filter(h => !h.is_long_term && !h.is_manual)
        const ltValue  = ltHoldings.reduce((s, h) => s + (h.current_price ?? h.avg_buy_price) * h.quantity, 0)
        const stValue  = stHoldings.reduce((s, h) => s + (h.current_price ?? h.avg_buy_price) * h.quantity, 0)
        const ltPnl    = ltHoldings.reduce((s, h) => s + (h.unrealized_pnl ?? 0), 0)
        const stPnl    = stHoldings.reduce((s, h) => s + (h.unrealized_pnl ?? 0), 0)
        const cash     = balance?.cash ?? 0
        const total    = ltValue + stValue + cash || 1
        const ltPct    = (ltValue / total) * 100
        const stPct    = (stValue / total) * 100
        const cashPct  = (cash   / total) * 100
        const targetLtPct = 30

        return (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Sprout size={13} className="text-emerald-400" />
                <h2 className="text-sm font-semibold">포트폴리오 구성</h2>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                <span>장기 목표</span>
                <span className="text-emerald-400 font-semibold">{targetLtPct}%</span>
                <span className="text-gray-600">|</span>
                <span>현재</span>
                <span className={`font-semibold ${ltPct >= targetLtPct * 0.8 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {ltPct.toFixed(1)}%
                </span>
              </div>
            </div>

            {/* 비중 바 */}
            <div className="flex h-2 rounded-full overflow-hidden gap-px mb-3">
              <div className="bg-emerald-600 transition-all duration-500" style={{ width: `${ltPct}%` }} title={`장기 ${ltPct.toFixed(1)}%`} />
              <div className="bg-blue-600 transition-all duration-500" style={{ width: `${stPct}%` }} title={`단기 ${stPct.toFixed(1)}%`} />
              <div className="bg-gray-700 transition-all duration-500" style={{ width: `${cashPct}%` }} title={`예수금 ${cashPct.toFixed(1)}%`} />
            </div>

            {/* 목표선 */}
            <div className="relative h-0 -mt-3 mb-3" style={{ pointerEvents: 'none' }}>
              <div
                className="absolute top-0 w-px h-2 bg-emerald-400/60"
                style={{ left: `${targetLtPct}%` }}
                title={`목표 ${targetLtPct}%`}
              />
            </div>

            {/* 3개 항목 */}
            <div className="grid grid-cols-3 gap-2">
              {/* 장기 */}
              <div className="bg-emerald-900/20 border border-emerald-800/40 rounded-lg p-3">
                <div className="flex items-center gap-1 mb-1.5">
                  <Sprout size={11} className="text-emerald-400" />
                  <span className="text-[10px] text-emerald-400 font-semibold">장기 보유</span>
                  <span className="ml-auto text-[10px] text-gray-500">{ltHoldings.length}종목</span>
                </div>
                <div className="text-sm font-bold text-white tabular-nums">{fmt(ltValue, false)}</div>
                <div className={`text-[10px] mt-0.5 tabular-nums ${ltPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {ltPnl >= 0 ? '+' : ''}{ltPnl.toLocaleString()}원
                </div>
                <div className="text-[10px] text-gray-500 mt-1">{ltPct.toFixed(1)}% 비중</div>
              </div>

              {/* 단기 */}
              <div className="bg-blue-900/20 border border-blue-800/40 rounded-lg p-3">
                <div className="flex items-center gap-1 mb-1.5">
                  <Zap size={11} className="text-blue-400" />
                  <span className="text-[10px] text-blue-400 font-semibold">단기 보유</span>
                  <span className="ml-auto text-[10px] text-gray-500">{stHoldings.length}종목</span>
                </div>
                <div className="text-sm font-bold text-white tabular-nums">{fmt(stValue, false)}</div>
                <div className={`text-[10px] mt-0.5 tabular-nums ${stPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {stPnl >= 0 ? '+' : ''}{stPnl.toLocaleString()}원
                </div>
                <div className="text-[10px] text-gray-500 mt-1">{stPct.toFixed(1)}% 비중</div>
              </div>

              {/* 예수금 */}
              <div className="bg-gray-800/60 border border-gray-700/40 rounded-lg p-3">
                <div className="flex items-center gap-1 mb-1.5">
                  <Wallet size={11} className="text-gray-400" />
                  <span className="text-[10px] text-gray-400 font-semibold">예수금</span>
                </div>
                <div className="text-sm font-bold text-white tabular-nums">{fmt(cash, false)}</div>
                <div className="text-[10px] text-gray-600 mt-0.5">
                  단기 가용 {balance ? fmt(Math.max(0, cash - Math.max(0, total * (targetLtPct / 100) - ltValue)), false) : '-'}
                </div>
                <div className="text-[10px] text-gray-500 mt-1">{cashPct.toFixed(1)}% 비중</div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── 장기 / 단기 실적 ─────────────────────────── */}
      {perfSplit && (() => {
        const d = perfTab === 'long' ? perfSplit.long_term : perfSplit.short_term
        const { realized: r, unrealized: u } = d
        const totalPnl = r.total_pnl + u.total_unrealized_pnl
        const isLong   = perfTab === 'long'

        return (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            {/* 탭 헤더 */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5">
                {([['short', '⚡ 단기', 'text-blue-400'], ['long', '🌱 장기', 'text-emerald-400']] as const).map(([tab, label, color]) => (
                  <button
                    key={tab}
                    onClick={() => setPerfTab(tab)}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                      perfTab === tab
                        ? `bg-gray-700 ${color}`
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">종합 손익</span>
                <span className={`font-bold tabular-nums ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {totalPnl >= 0 ? '+' : ''}{totalPnl.toLocaleString()}원
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 실현 손익 */}
              <div>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">실현 손익 (매도 완료)</p>
                <div className={`rounded-xl border p-4 ${isLong ? 'border-emerald-800/40 bg-emerald-900/10' : 'border-blue-800/40 bg-blue-900/10'}`}>
                  <div className={`text-2xl font-bold tabular-nums mb-1 ${r.total_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.total_pnl >= 0 ? '+' : ''}{r.total_pnl.toLocaleString()}원
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    {[
                      { label: '거래 수', value: `${r.trade_count}건` },
                      { label: '승률',    value: `${r.win_rate.toFixed(1)}%`, color: r.win_rate >= 50 ? 'text-emerald-400' : 'text-red-400' },
                      { label: '승/패',   value: `${r.win_count}/${r.loss_count}` },
                    ].map(item => (
                      <div key={item.label} className="text-center">
                        <div className={`text-sm font-bold ${(item as {color?: string}).color ?? 'text-white'}`}>{item.value}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">{item.label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-gray-700/50">
                    <div className="text-center">
                      <div className="text-sm font-bold text-emerald-400 tabular-nums">
                        {r.avg_win > 0 ? '+' : ''}{r.avg_win.toLocaleString()}원
                      </div>
                      <div className="text-[10px] text-gray-500">평균 수익</div>
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-bold text-red-400 tabular-nums">
                        {r.avg_loss.toLocaleString()}원
                      </div>
                      <div className="text-[10px] text-gray-500">평균 손실</div>
                    </div>
                  </div>

                  {/* 미니 누적 PnL 바 차트 */}
                  {r.cumulative_chart.length > 1 && (() => {
                    const vals = r.cumulative_chart.map(p => p.pnl)
                    const min  = Math.min(0, ...vals)
                    const max  = Math.max(0, ...vals)
                    const range_ = max - min || 1
                    const last = vals[vals.length - 1]
                    return (
                      <div className="mt-3">
                        <div className="flex items-end gap-px h-10">
                          {r.cumulative_chart.slice(-30).map((p, i) => {
                            const h_ = Math.abs(p.pnl - min) / range_ * 40
                            return (
                              <div
                                key={i}
                                title={`${p.date}: ${p.pnl >= 0 ? '+' : ''}${p.pnl.toLocaleString()}원`}
                                className={`flex-1 rounded-sm min-h-[1px] ${p.pnl >= 0 ? 'bg-emerald-500/60' : 'bg-red-500/60'}`}
                                style={{ height: `${Math.max(2, h_)}px`, alignSelf: 'flex-end' }}
                              />
                            )
                          })}
                        </div>
                        <div className="flex justify-between mt-0.5">
                          <span className="text-[9px] text-gray-600">{r.cumulative_chart[Math.max(0, r.cumulative_chart.length - 30)]?.date}</span>
                          <span className={`text-[9px] font-semibold ${last >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            누적 {last >= 0 ? '+' : ''}{last.toLocaleString()}원
                          </span>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>

              {/* 현재 보유 평가 손익 */}
              <div>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
                  보유 중 평가 손익 ({u.holdings.length}종목)
                </p>
                <div className={`rounded-xl border p-4 ${isLong ? 'border-emerald-800/40 bg-emerald-900/10' : 'border-blue-800/40 bg-blue-900/10'}`}>
                  <div className={`text-2xl font-bold tabular-nums mb-1 ${u.total_unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {u.total_unrealized_pnl >= 0 ? '+' : ''}{u.total_unrealized_pnl.toLocaleString()}원
                  </div>
                  <div className="text-xs text-gray-500 mb-3">평가금액 {u.total_value.toLocaleString()}원</div>

                  {u.holdings.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-4">보유 종목 없음</p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {u.holdings.map(h => (
                        <div key={h.stock_code} className="flex items-center justify-between">
                          <div className="min-w-0">
                            <span className="text-xs font-medium text-gray-200 truncate block">{h.stock_name}</span>
                            <span className="text-[10px] text-gray-500">{h.quantity}주 · 평균 {h.avg_buy_price.toLocaleString()}원</span>
                          </div>
                          <div className="text-right shrink-0 ml-2">
                            <div className={`text-xs font-bold tabular-nums ${h.unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {h.unrealized_pnl >= 0 ? '+' : ''}{h.unrealized_pnl.toLocaleString()}원
                            </div>
                            <div className={`text-[10px] tabular-nums ${h.unrealized_pnl_pct >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                              {h.unrealized_pnl_pct >= 0 ? '+' : ''}{h.unrealized_pnl_pct.toFixed(2)}%
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── 오늘 자동매매 + 보유 종목 ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">

        {/* 오늘 자동매매 */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-blue-400" />
            <h2 className="text-sm font-semibold">오늘 자동매매</h2>
          </div>
          {todayTrade ? (
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-emerald-900/30 rounded-lg p-3">
                <div className="text-xs text-gray-400 mb-1">매수</div>
                <div className="text-2xl font-bold text-emerald-400">
                  {todayTrade.filled_buy_count ?? 0}
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {todayTrade.total_buy_amount > 0 ? fmt(todayTrade.total_buy_amount, false) : '금액 미집계'}
                </div>
                <div className="text-[10px] text-gray-600 mt-0.5">
                  시도 {todayTrade.buy_count ?? 0}건
                </div>
              </div>
              <div className="bg-red-900/30 rounded-lg p-3">
                <div className="text-xs text-gray-400 mb-1">매도</div>
                <div className="text-2xl font-bold text-red-400">
                  {todayTrade.filled_sell_count ?? 0}
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {todayTrade.total_sell_amount > 0 ? fmt(todayTrade.total_sell_amount, false) : '금액 미집계'}
                </div>
                <div className="text-[10px] text-gray-600 mt-0.5">
                  시도 {todayTrade.sell_count ?? 0}건
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-6">데이터 없음</p>
          )}
        </div>

        {/* 보유 종목 */}
        <div className="lg:col-span-3 bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">보유 종목</h2>
              {pendingBuys.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full
                                 bg-amber-900/60 border border-amber-600/50 text-amber-300">
                  <Clock size={9} />
                  매수 진행중 {pendingBuys.length}건
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(summary?.account_no || summary?.account_name) && (
                <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-gray-800 px-2.5 py-1 rounded-lg">
                  <Wallet size={11} className="text-blue-400" />
                  <span className="font-mono tracking-wide">
                    {summary.account_no
                      ? summary.account_no.replace(/(\d{4})(\d{2})(\d{4})/, '$1-$2-$3')
                      : summary.account_name}
                  </span>
                </div>
              )}
              <div className="flex flex-col items-end gap-0.5">
                <button
                  onClick={async () => {
                    setSyncing(true)
                    setSyncMsg(null)
                    try {
                      const r = await syncHoldingsWithKiwoom()
                      setHoldings(Array.isArray(r.holdings) ? r.holdings : [])
                      const parts = []
                      if (r.removed?.length) parts.push(`삭제 ${r.removed.length}건`)
                      if (r.added?.length)   parts.push(`추가 ${r.added.length}건`)
                      if (r.updated?.length) parts.push(`갱신 ${r.updated.length}건`)
                      setSyncMsg(parts.length ? `계좌 동기화 완료 — ${parts.join(' / ')}` : '계좌와 일치합니다')
                    } catch (e: any) {
                      setSyncMsg(`동기화 실패: ${e?.response?.data?.detail || e?.message || '오류'}`)
                    } finally {
                      setSyncing(false)
                    }
                  }}
                  disabled={syncing || timerRefreshing}
                  className="flex items-center gap-1 text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white px-2.5 py-1 rounded-lg transition-colors"
                >
                  <RefreshCw size={11} className={(syncing || timerRefreshing) ? 'animate-spin' : ''} />
                  {(syncing || timerRefreshing) ? '동기화 중…' : '계좌 현행화'}
                </button>
                <span className="text-[9px] text-gray-600">
                  자동 60초 · 마지막 {lastRefreshed.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            </div>
          </div>
          {syncMsg && (
            <div className={`mb-2 px-3 py-1.5 rounded-lg text-xs flex items-center justify-between
              ${syncMsg.startsWith('동기화 실패') ? 'bg-red-900/40 text-red-300' : 'bg-blue-900/40 text-blue-300'}`}>
              <span>{syncMsg}</span>
              <button onClick={() => setSyncMsg(null)} className="ml-2 text-gray-500 hover:text-gray-300">✕</button>
            </div>
          )}
          <HoldingTable holdings={holdings} pendingBuys={pendingBuys} />
        </div>
      </div>

      {/* ── 오늘 매매 내역 ────────────────────────────── */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        {/* 헤더 + 필터 */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Activity size={14} className="text-blue-400 shrink-0" />
          <h2 className="text-sm font-semibold shrink-0">오늘 매매 내역</h2>

          {/* 구분 필터 */}
          <div className="flex rounded-lg overflow-hidden border border-gray-700/60 ml-1">
            {([['ALL','전체'],['BUY','매수'],['SELL','매도']] as [ActionFilter, string][]).map(([v, label]) => (
              <button key={v} onClick={() => setActionFilter(v)}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  actionFilter === v
                    ? v === 'BUY' ? 'bg-emerald-700 text-white' : v === 'SELL' ? 'bg-red-700 text-white' : 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* 상태 필터 */}
          <div className="flex rounded-lg overflow-hidden border border-gray-700/60">
            {([['SUCCESS','성공'],['CANCELLED','취소'],['ALL','전체']] as [StatusFilter, string][]).map(([v, label]) => (
              <button key={v} onClick={() => setStatusFilter(v)}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  statusFilter === v
                    ? v === 'CANCELLED' ? 'bg-gray-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* 건수 */}
          {(() => {
            const allLogs = todayTrade?.logs ?? []
            const filtered = allLogs.filter(l => {
              if (actionFilter !== 'ALL' && l.action !== actionFilter) return false
              if (statusFilter === 'SUCCESS') return l.status !== 'CANCELLED'
              if (statusFilter === 'CANCELLED') return l.status === 'CANCELLED'
              return true
            })
            return (
              <span className="text-xs text-gray-500">
                {filtered.length}/{allLogs.length}건
              </span>
            )
          })()}

          {/* 정합성 검사 버튼 */}
          <button
            onClick={handleReconcile}
            disabled={reconciling}
            className="ml-auto flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg bg-indigo-900/60 border border-indigo-700/50 text-indigo-300 hover:bg-indigo-800/60 transition-colors disabled:opacity-50"
          >
            <ShieldCheck size={12} className={reconciling ? 'animate-spin' : ''} />
            {reconciling ? '검사중...' : '정합성 검사'}
          </button>
        </div>

        {/* 정합성 검사 결과 배너 */}
        {reconcileResult && (() => {
          const cancelled = reconcileResult.cancelled ?? []
          const filled = reconcileResult.filled ?? []
          const hasIssue = cancelled.length > 0
          return (
            <div className={`mb-3 rounded-lg px-3 py-2 text-xs flex items-start gap-2 ${
              hasIssue
                ? 'bg-orange-900/30 border border-orange-700/40 text-orange-300'
                : 'bg-emerald-900/30 border border-emerald-700/40 text-emerald-300'
            }`}>
              <ShieldCheck size={13} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold mb-0.5">{reconcileResult.message}</div>
                {cancelled.length > 0 && (
                  <div className="text-[11px] opacity-80">
                    미체결 취소: {(cancelled as Array<{stock_name?: string; stock_code?: string}>).map(c => c.stock_name || c.stock_code).join(', ')}
                  </div>
                )}
                {filled.length > 0 && (
                  <div className="text-[11px] opacity-80">
                    체결 확정: {(filled as Array<{stock_name?: string; stock_code?: string}>).map(c => c.stock_name || c.stock_code).join(', ')}
                  </div>
                )}
              </div>
              <button onClick={() => setReconcileResult(null)} className="ml-auto text-gray-500 hover:text-gray-300">✕</button>
            </div>
          )
        })()}

        {/* 체결 요약 바 */}
        {todayTrade && (todayTrade.logs ?? []).length > 0 && (() => {
          const allLogs = todayTrade.logs ?? []
          const isSuccess = (s: string) => s === 'FILLED' || s === 'MOCK' || s === 'PENDING'
          const filledBuys  = allLogs.filter(l => l.action === 'BUY'  && isSuccess(l.status))
          const filledSells = allLogs.filter(l => l.action === 'SELL' && isSuccess(l.status))
          const totalBuyAmt  = filledBuys.reduce((s, l)  => s + (l.filled_amount ?? l.quantity * (l.filled_price ?? l.order_price)), 0)
          const totalSellAmt = filledSells.reduce((s, l) => s + (l.filled_amount ?? l.quantity * (l.filled_price ?? l.order_price)), 0)
          const realizedPnl  = filledSells.reduce((s, l) => s + (l.realized_pnl ?? 0), 0)
          const pnlPositive  = realizedPnl > 0
          const pnlNegative  = realizedPnl < 0
          return (
            <div className="flex flex-wrap gap-2 mb-3">
              <div className="flex items-center gap-2 bg-emerald-900/20 border border-emerald-800/40 rounded-lg px-3 py-2 min-w-0">
                <TrendingUp size={12} className="text-emerald-400 shrink-0" />
                <div>
                  <div className="text-[10px] text-gray-500">체결 매수금액</div>
                  <div className="text-sm font-bold text-emerald-400 tabular-nums">
                    {totalBuyAmt > 0 ? fmt(totalBuyAmt, false) : '-'}
                  </div>
                  <div className="text-[10px] text-gray-600">{filledBuys.length}건 체결</div>
                </div>
              </div>
              <div className="flex items-center gap-2 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2 min-w-0">
                <TrendingDown size={12} className="text-red-400 shrink-0" />
                <div>
                  <div className="text-[10px] text-gray-500">체결 매도금액</div>
                  <div className="text-sm font-bold text-red-400 tabular-nums">
                    {totalSellAmt > 0 ? fmt(totalSellAmt, false) : '-'}
                  </div>
                  <div className="text-[10px] text-gray-600">{filledSells.length}건 체결</div>
                </div>
              </div>
              <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border min-w-0 ${
                pnlPositive ? 'bg-emerald-900/20 border-emerald-800/40' :
                pnlNegative ? 'bg-red-900/20 border-red-800/40' :
                'bg-gray-800/40 border-gray-700/40'
              }`}>
                <BarChart2 size={12} className={pnlPositive ? 'text-emerald-400 shrink-0' : pnlNegative ? 'text-red-400 shrink-0' : 'text-gray-400 shrink-0'} />
                <div>
                  <div className="text-[10px] text-gray-500">실현손익 (체결확정)</div>
                  <div className={`text-sm font-bold tabular-nums ${pnlPositive ? 'text-emerald-400' : pnlNegative ? 'text-red-400' : 'text-gray-300'}`}>
                    {filledSells.length === 0 ? '-' : `${realizedPnl >= 0 ? '+' : ''}${Math.round(realizedPnl).toLocaleString()}원`}
                  </div>
                  <div className="text-[10px] text-gray-600">접수·체결·모의 기준</div>
                </div>
              </div>
            </div>
          )
        })()}

        {/* 테이블 */}
        {!todayTrade || (todayTrade.logs ?? []).length === 0 ? (
          <p className="text-sm text-gray-600 text-center py-6">오늘 자동매매 내역이 없습니다</p>
        ) : (() => {
          const statusMap: Record<string, { label: string; cls: string }> = {
            FILLED:    { label: '체결완료', cls: 'bg-emerald-900/60 text-emerald-400' },
            MOCK:      { label: '모의',     cls: 'bg-blue-900/60 text-blue-400' },
            PENDING:   { label: '접수완료', cls: 'bg-yellow-900/60 text-yellow-300' },
            CANCELLED: { label: '취소',     cls: 'bg-gray-800 text-gray-500' },
          }
          const filteredLogs = (todayTrade.logs ?? []).filter(l => {
            if (actionFilter !== 'ALL' && l.action !== actionFilter) return false
            if (statusFilter === 'SUCCESS') return l.status !== 'CANCELLED'
            if (statusFilter === 'CANCELLED') return l.status === 'CANCELLED'
            return true
          })

          if (filteredLogs.length === 0) {
            return <p className="text-sm text-gray-600 text-center py-6">필터 조건에 맞는 내역이 없습니다</p>
          }

          return (
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full text-xs min-w-[640px]">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left pb-2 pr-3 font-medium">시간</th>
                    <th className="text-left pb-2 pr-3 font-medium">종목</th>
                    <th className="text-left pb-2 pr-3 font-medium">구분</th>
                    <th className="text-left pb-2 pr-3 font-medium">상태</th>
                    <th className="text-right pb-2 pr-3 font-medium">수량×단가</th>
                    <th className="text-right pb-2 pr-3 font-medium">점수</th>
                    <th className="text-right pb-2 pr-3 font-medium">실현손익</th>
                    <th className="text-left pb-2 font-medium">사유/메시지</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/60">
                  {filteredLogs.map(log => {
                    const timeStr = log.created_at
                      ? new Date(log.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      : '-'
                    const isBuy = log.action === 'BUY'
                    const st = statusMap[log.status] ?? { label: log.status, cls: 'bg-gray-800 text-gray-400' }
                    const price = log.filled_price ?? log.order_price
                    const reasonText = log.error_msg
                      ? `⚠ ${log.error_msg}`
                      : (log.trigger_models ?? []).join(', ')
                    return (
                      <tr key={log.id} className="hover:bg-gray-800/40 transition-colors">
                        <td className="py-2 pr-3 text-gray-500 tabular-nums">{timeStr}</td>
                        <td className="py-2 pr-3">
                          <span className="font-medium text-gray-200">{log.stock_name || log.stock_code}</span>
                          <span className="text-gray-600 ml-1">{log.stock_code}</span>
                        </td>
                        <td className="py-2 pr-3">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${isBuy ? 'bg-emerald-900/60 text-emerald-400' : 'bg-red-900/60 text-red-400'}`}>
                            {isBuy ? '매수' : '매도'}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.cls}`}>{st.label}</span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-gray-300">
                          {log.quantity}주 × {price.toLocaleString()}원
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-gray-400">
                          {log.composite_score != null ? (log.composite_score * 100).toFixed(0) + '점' : '-'}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {log.realized_pnl != null
                            ? <span className={log.realized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {log.realized_pnl >= 0 ? '+' : ''}{Math.round(log.realized_pnl).toLocaleString()}원
                              </span>
                            : <span className="text-gray-600">-</span>}
                        </td>
                        <td className="py-2 text-gray-500 max-w-[180px] truncate" title={reasonText}>
                          {reasonText || '-'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        })()}
      </div>

      {/* ── 누적 손익 차트 ─────────────────────────────── */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">누적 손익</h2>
            <p className="text-[10px] text-gray-600 mt-0.5">자동매매 실현손익 기준 (DB 집계)</p>
          </div>
          <div className="flex gap-1">
            {RANGES.map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-2 py-1 text-xs rounded ${range === r ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <PnLChart data={chartData as Parameters<typeof PnLChart>[0]['data']} />
      </div>

      {/* ── 키움 API 연동 스케줄 ──────────────────────────── */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={14} className="text-blue-400" />
          <h2 className="text-sm font-semibold">키움 API 연동 스케줄</h2>
          <span className="text-[10px] text-gray-600 ml-auto">평일 기준 (KST)</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
          {([
            { time: '06:00~',        label: '서버 기동',           desc: '로그인 · 데이터 초기화',    border: 'border-gray-700',    text: 'text-gray-400',    bg: 'bg-gray-800/40' },
            { time: '08:00~',        label: '계좌 조회 가능',       desc: '잔고 · 평가현황 API 시작',  border: 'border-blue-800',    text: 'text-blue-300',    bg: 'bg-blue-900/20' },
            { time: '08:30~08:40',   label: '장전 시간외 주문',     desc: '장전 주문 가능 구간',              border: 'border-yellow-800',  text: 'text-yellow-300',  bg: 'bg-yellow-900/20' },
            { time: '08:40',         label: '모닝 리포트',          desc: '텔레그램 매수 후보 발송',          border: 'border-orange-800',  text: 'text-orange-300',  bg: 'bg-orange-900/20' },
            { time: '09:00~15:30',   label: '정규장 자동매매',      desc: '5분마다 매수 · 매도 주문 실행',     border: 'border-emerald-700', text: 'text-emerald-300', bg: 'bg-emerald-900/20' },
            { time: '09:05/11:00/13:30', label: '섹터 스크리닝',    desc: 'AI 전종목 분석 · BUY 후보 선정',   border: 'border-cyan-800',    text: 'text-cyan-300',    bg: 'bg-cyan-900/20' },
            { time: '10:00~15:00',   label: '정시 현황 리포트',     desc: '매 정시 텔레그램 진행현황 발송',    border: 'border-green-900',   text: 'text-green-400',   bg: 'bg-green-900/10' },
            { time: '15:30',         label: '장 마감',              desc: '신규 매수 중단 · 잔여 주문 정리',   border: 'border-red-800',     text: 'text-red-400',     bg: 'bg-red-900/20' },
            { time: '15:35',         label: '결산 리포트',          desc: '텔레그램 결산 · 종가 DB 갱신',      border: 'border-purple-800',  text: 'text-purple-300',  bg: 'bg-purple-900/20' },
            { time: '16:00~18:00',   label: '시간외 단일가',        desc: '계좌 조회 유지 (주문 불가)',        border: 'border-blue-900',    text: 'text-blue-400',    bg: 'bg-blue-900/10' },
            { time: '18:00~',        label: '원장 점검',            desc: '캐시 스냅샷 표시 (API 일시 중단)',  border: 'border-gray-800',    text: 'text-gray-500',    bg: 'bg-gray-800/20' },
          ] as { time: string; label: string; desc: string; border: string; text: string; bg: string }[]).map(({ time, label, desc, border, text, bg }) => (
            <div key={time} className={`border ${border} ${bg} rounded-lg p-2.5`}>
              <div className={`text-[11px] font-mono font-bold ${text}`}>{time}</div>
              <div className="text-xs font-medium text-gray-200 mt-0.5">{label}</div>
              <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 자동매매 로직 안내 ──────────────────────────── */}
      <AutoTradeGuide />

    </div>
  )
}
