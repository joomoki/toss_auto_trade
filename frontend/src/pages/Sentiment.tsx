import { useEffect, useState, useCallback } from 'react'
import { getNews, getSentimentSummary, getSentimentByStock, triggerNewsCollect, analyzePendingNews } from '../api/client'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { RefreshCw, Newspaper, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useRefreshTimer } from '../hooks/useRefreshTimer'
import RefreshTimer from '../components/common/RefreshTimer'

// ── 뉴스 수집 프롬프트 템플릿 ───────────────────────────
type PromptType = 'domestic' | 'us' | 'deep'

const PROMPT_LABELS: Record<PromptType, string> = {
  domestic: '국내 종목',
  us:       '미국 주식/ETF',
  deep:     '심화 분석',
}

function buildPrompt(type: PromptType, stock: string, period: string): string {
  const s = stock || '[종목명/티커]'
  const p = period || '[기간]'

  if (type === 'domestic') return `${s}에 대한 최근 ${p} 뉴스를 수집해서 정리해줘.

[수집 우선순위]
1. DART/KIND 공시 — 실적, 유증, 대주주 변동, 주요 계약 등 사실 위주
2. 속보·시황 — 네이버/다음 금융, 한경·매경·이데일리·인포맥스
3. 증권사 리포트 — 한경 컨센서스 기준 목표주가·실적 추정치 변화

[정리 형식]
- 날짜 | 출처 | 핵심 내용(1줄) | 주가 영향(호재/악재/중립)
- 시간 역순 정렬
- 사실(공시·실적)과 의견(전망·리포트)을 구분해서 표기
- 마지막에 "현재 주가에 이미 반영된 이슈 / 앞으로 변수가 될 이슈" 요약

[제외]
- 단순 시황 반복 기사, 광고성·낚시성 제목 기사`

  if (type === 'us') return `${s}에 대한 최근 ${p} 뉴스를 수집해서 정리해줘.

[수집 우선순위]
1. SEC EDGAR 공시 (10-K/10-Q/8-K) + 기업 IR
2. 속보 — Reuters, CNBC, Yahoo Finance
3. ETF는 운용사(Schwab/Vanguard 등) 구성종목·배당 변경 공지
4. 배당주는 배당 이력·인상률 (단, 개인 기고는 의견으로 분류)

[정리 형식]
- 날짜 | 출처 | 핵심 내용(1줄) | 주가 영향(호재/악재/중립)
- 시간 역순 정렬
- 사실과 의견을 구분해서 표기
- 마지막에 "이미 반영된 이슈 / 앞으로 변수가 될 이슈" 요약

[제외]
- 단순 시황 반복 기사, 광고성·낚시성 제목 기사`

  // deep
  return `${s}를 분석해줘.

1. 최근 ${p} 핵심 뉴스·공시 수집
   - 날짜 | 출처 | 핵심 내용 | 주가 영향 형식
2. 실적·가이던스 변화 추적 (전 분기 대비)
3. 뉴스가 주가에 선반영됐는지 vs 아직 변수인지 구분
4. 동종업계/경쟁사 대비 이슈 비교
5. 종합 정리
   - 단기 모멘텀
   - 중장기 관점
   - 주의해야 할 리스크

[조건]
- 출처를 반드시 명시
- 사실(공시·실적)과 추정(전망·리포트)을 분리
- 광고성·반복성 기사는 제외`
}

const PERIOD_PRESETS = ['1주', '2주', '1개월', '3개월']

function NewsPromptPanel() {
  const [open,   setOpen]   = useState(false)
  const [type,   setType]   = useState<PromptType>('domestic')
  const [stock,  setStock]  = useState('')
  const [period, setPeriod] = useState('2주')
  const [copied, setCopied] = useState(false)

  const prompt = buildPrompt(type, stock, period)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* 토글 헤더 */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Newspaper size={14} className="text-blue-400" />
          <span className="text-sm font-semibold">뉴스 수집 프롬프트 생성</span>
          <span className="text-xs text-gray-500">AI(Claude/ChatGPT)에 붙여넣기용</span>
        </div>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-800">

          {/* 용도 설명 */}
          <div className="mt-3 bg-blue-950/30 border border-blue-800/30 rounded-xl p-3 space-y-2 text-[11px] leading-relaxed">
            <p className="text-blue-200 font-semibold text-xs">이 기능은 무엇인가요?</p>
            <p className="text-gray-400">
              시스템이 자동으로 수집하는 뉴스는 <span className="text-gray-200">네이버 금융 헤드라인 위주</span>라 깊이가 제한됩니다.
              특정 종목을 더 깊이 조사하고 싶을 때, <span className="text-gray-200">Claude·ChatGPT에 붙여넣을 수 있는 전문 프롬프트</span>를 자동으로 만들어 줍니다.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
              <div className="bg-gray-800/60 rounded-lg px-2.5 py-2">
                <p className="text-gray-300 font-medium mb-0.5">📰 국내 종목</p>
                <p className="text-gray-500">DART 공시·속보·증권사 리포트를 날짜·출처·영향도 형식으로 정리 요청</p>
              </div>
              <div className="bg-gray-800/60 rounded-lg px-2.5 py-2">
                <p className="text-gray-300 font-medium mb-0.5">🇺🇸 미국 주식/ETF</p>
                <p className="text-gray-500">SEC 공시·Reuters·CNBC 기반, ETF는 구성종목·배당 변경까지 포함</p>
              </div>
              <div className="bg-gray-800/60 rounded-lg px-2.5 py-2">
                <p className="text-gray-300 font-medium mb-0.5">🔬 심화 분석</p>
                <p className="text-gray-500">뉴스+실적+경쟁사 비교+단기·중장기 리스크까지 종합 분석 요청</p>
              </div>
            </div>
            <p className="text-gray-500">
              💡 <span className="text-gray-300">사용법:</span> 종목명 입력 → 기간 선택 → 복사 → Claude(claude.ai) 또는 ChatGPT에 붙여넣기.
              <span className="text-blue-300 ml-1">웹 검색이 켜진 모드</span>에서 사용하면 실시간 뉴스를 가져옵니다.
            </p>
          </div>

          {/* 프롬프트 유형 */}
          <div className="flex gap-1.5 flex-wrap">
            {(Object.keys(PROMPT_LABELS) as PromptType[]).map(t => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                  type === t
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                {PROMPT_LABELS[t]}
              </button>
            ))}
          </div>

          {/* 입력 필드 */}
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs text-gray-500 mb-1">종목명 / 티커</label>
              <input
                value={stock}
                onChange={e => setStock(e.target.value)}
                placeholder="예: 삼성전자, AAPL, QQQ"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">기간</label>
              <div className="flex gap-1">
                {PERIOD_PRESETS.map(pr => (
                  <button
                    key={pr}
                    onClick={() => setPeriod(pr)}
                    className={`px-2.5 py-1.5 text-xs rounded-lg transition-colors ${
                      period === pr
                        ? 'bg-blue-600/20 text-blue-400 border border-blue-600/40'
                        : 'bg-gray-800 text-gray-400 hover:text-white border border-transparent'
                    }`}
                  >
                    {pr}
                  </button>
                ))}
                <input
                  value={PERIOD_PRESETS.includes(period) ? '' : period}
                  onChange={e => setPeriod(e.target.value || '2주')}
                  placeholder="직접 입력"
                  className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-600"
                />
              </div>
            </div>
          </div>

          {/* 생성된 프롬프트 */}
          <div className="relative">
            <textarea
              readOnly
              value={prompt}
              rows={10}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2.5 text-xs text-gray-300 font-mono resize-none focus:outline-none leading-relaxed"
            />
            <button
              onClick={handleCopy}
              className={`absolute top-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                copied
                  ? 'bg-green-600/20 text-green-400 border border-green-600/30'
                  : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
              }`}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? '복사됨' : '복사'}
            </button>
          </div>

          <p className="text-[11px] text-gray-600">
            복사 후 Claude(claude.ai) 또는 ChatGPT에 붙여넣기 하세요. 웹 검색 기능이 활성화된 모드에서 사용하면 실시간 뉴스를 가져올 수 있습니다.
          </p>
        </div>
      )}
    </div>
  )
}

interface NewsItem {
  id: number
  title: string
  source: string
  stock_codes: string[]
  sentiment_score: number | null
  sentiment_label: string | null
  is_disclosure: boolean
  published_at: string | null
  collected_at: string
}

interface SentimentSummary {
  total: number
  positive: number
  negative: number
  neutral: number
  avg_score: number
  market_mood: string
  timeline: { time: string; positive: number; negative: number; neutral: number; total: number }[]
}

interface StockSentiment {
  stock_code: string
  stock_name?: string
  sentiment_score: number
  news_count: number
  label: string
}

const MOOD_STYLE: Record<string, { color: string; label: string }> = {
  BULLISH: { color: 'text-green-400', label: '긍정적 (BULLISH)' },
  BEARISH: { color: 'text-red-400', label: '부정적 (BEARISH)' },
  NEUTRAL: { color: 'text-gray-400', label: '중립적 (NEUTRAL)' },
}

const LABEL_COLOR: Record<string, string> = {
  POSITIVE: 'text-green-400',
  NEGATIVE: 'text-red-400',
  NEUTRAL: 'text-gray-500',
}

const LABEL_DOT: Record<string, string> = {
  POSITIVE: 'bg-green-400',
  NEGATIVE: 'bg-red-400',
  NEUTRAL: 'bg-gray-600',
}

const SOURCE_BADGE: Record<string, string> = {
  naver: 'bg-green-900 text-green-300',
  yonhap: 'bg-blue-900 text-blue-300',
  dart: 'bg-yellow-900 text-yellow-300',
  krx: 'bg-purple-900 text-purple-300',
}

function SentimentGauge({ score }: { score: number }) {
  const pct = ((score + 1) / 2) * 100
  const color = score > 0.1 ? '#34d399' : score < -0.1 ? '#f87171' : '#6b7280'
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-24 h-12 overflow-hidden">
        <div className="absolute bottom-0 left-0 w-full h-24 rounded-full border-4"
          style={{ borderColor: '#1f2937' }} />
        <div className="absolute bottom-0 left-0 w-full h-24 rounded-full border-4 transition-all"
          style={{
            borderColor: color,
            clipPath: `inset(${100 - pct}% 0 0 0)`,
          }} />
      </div>
      <div className="text-xl font-bold" style={{ color }}>
        {score >= 0 ? '+' : ''}{score.toFixed(3)}
      </div>
    </div>
  )
}

export default function Sentiment() {
  const [summary, setSummary] = useState<SentimentSummary | null>(null)
  const [stockSentiments, setStockSentiments] = useState<StockSentiment[]>([])
  const [news, setNews] = useState<NewsItem[]>([])
  const [hours, setHours] = useState(24)
  const [collecting, setCollecting] = useState(false)
  const [filterLabel, setFilterLabel] = useState<string>('')

  const reload = useCallback(async () => {
    const [sum, stocks, newsData] = await Promise.all([
      getSentimentSummary(hours),
      getSentimentByStock(hours),
      getNews({ hours, limit: 60 }),
    ])
    setSummary(sum)
    setStockSentiments(stocks.items ?? [])
    setNews(newsData.items ?? [])
  }, [hours])

  useEffect(() => { reload() }, [reload])

  const { secondsLeft, lastRefreshed, isRefreshing: timerBusy, refresh: timerRefresh } =
    useRefreshTimer(1800, reload)

  const handleCollect = async () => {
    setCollecting(true)
    try {
      await triggerNewsCollect()
      await analyzePendingNews()
      await reload()
    } finally {
      setCollecting(false)
    }
  }

  const filteredNews = filterLabel
    ? news.filter(n => n.sentiment_label === filterLabel)
    : news

  const mood = summary ? (MOOD_STYLE[summary.market_mood] ?? MOOD_STYLE.NEUTRAL) : null

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <NewsPromptPanel />

      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-bold sm:text-xl">시장 감성 분석</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1">
            {[6, 24, 72].map(h => (
              <button key={h} onClick={() => setHours(h)}
                className={`px-2 py-1 text-xs rounded ${hours === h ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                {h}h
              </button>
            ))}
          </div>
          <RefreshTimer
            secondsLeft={secondsLeft}
            intervalSec={1800}
            lastRefreshed={lastRefreshed}
            isRefreshing={timerBusy}
            onRefresh={timerRefresh}
            serverLabel="서버 30분"
          />
          <button onClick={handleCollect} disabled={collecting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-50">
            <RefreshCw size={12} className={collecting ? 'animate-spin' : ''} />
            {collecting ? '수집 중...' : '뉴스 수집'}
          </button>
        </div>
      </div>

      {/* ── 시장 무드 + 통계 ── */}
      {summary && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <div className="flex flex-col items-center">
              <SentimentGauge score={summary.avg_score} />
              <div className={`text-sm font-semibold mt-1 ${mood?.color}`}>{mood?.label}</div>
              <div className="text-xs text-gray-500 mt-0.5">시장 평균 감성</div>
            </div>
            <div className="flex-1 grid grid-cols-3 gap-4 w-full">
              <div className="bg-green-950/30 border border-green-900/50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-green-400">{summary.positive}</div>
                <div className="text-xs text-green-600 mt-0.5">긍정 뉴스</div>
              </div>
              <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-gray-400">{summary.neutral}</div>
                <div className="text-xs text-gray-600 mt-0.5">중립</div>
              </div>
              <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-red-400">{summary.negative}</div>
                <div className="text-xs text-red-600 mt-0.5">부정 뉴스</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 시간별 감성 분포 바 차트 ── */}
      {summary && summary.timeline.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-3">시간별 감성 분포</h2>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={summary.timeline} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 9 }}
                tickFormatter={v => v.slice(11, 16)} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#6b7280', fontSize: 9 }} />
              <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 11 }} />
              <Bar dataKey="positive" stackId="a" fill="#34d399" name="긍정" />
              <Bar dataKey="neutral" stackId="a" fill="#374151" name="중립" />
              <Bar dataKey="negative" stackId="a" fill="#f87171" name="부정" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── 종목별 감성 순위 ── */}
      {stockSentiments.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-3">종목별 감성 점수</h2>
          <div className="space-y-2">
            {stockSentiments.slice(0, 10).map(s => (
              <div key={s.stock_code} className="flex items-center gap-3">
                <div className="flex flex-col w-20 shrink-0">
                  <span className="text-xs font-medium text-gray-200 truncate">{s.stock_name || s.stock_code}</span>
                  <span className="text-[10px] text-gray-500">{s.stock_code}</span>
                </div>
                <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.abs(s.sentiment_score) * 100}%`,
                      background: s.sentiment_score > 0 ? '#34d399' : '#f87171',
                      marginLeft: s.sentiment_score < 0 ? 'auto' : undefined,
                    }} />
                </div>
                <span className={`text-xs font-medium w-12 text-right ${
                  s.sentiment_score >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {s.sentiment_score >= 0 ? '+' : ''}{s.sentiment_score.toFixed(3)}
                </span>
                <span className="text-[10px] text-gray-600 w-10 text-right shrink-0">
                  {s.news_count}건
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 뉴스 목록 ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">수집된 뉴스</h2>
          <div className="flex gap-1">
            {['', 'POSITIVE', 'NEGATIVE', 'NEUTRAL'].map(l => (
              <button key={l} onClick={() => setFilterLabel(l)}
                className={`px-2 py-0.5 text-[10px] rounded ${
                  filterLabel === l ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}>
                {l || '전체'}
              </button>
            ))}
          </div>
        </div>
        {filteredNews.length > 0 ? (
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {filteredNews.map(n => (
              <div key={n.id} className="px-3 py-2.5 rounded-lg bg-gray-800/40 border border-gray-800">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 shrink-0 w-1.5 h-1.5 rounded-full ${LABEL_DOT[n.sentiment_label ?? 'NEUTRAL'] ?? 'bg-gray-600'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      {n.is_disclosure && (
                        <span className="text-[9px] bg-yellow-900 text-yellow-300 px-1 py-0.5 rounded font-medium">
                          공시
                        </span>
                      )}
                      {n.source && (
                        <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${SOURCE_BADGE[n.source] ?? 'bg-gray-700 text-gray-400'}`}>
                          {n.source}
                        </span>
                      )}
                      {n.stock_codes.map(code => (
                        <span key={code} className="text-[9px] bg-gray-700 text-gray-400 px-1 py-0.5 rounded">{code}</span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-200 leading-snug line-clamp-2">{n.title}</p>
                    <div className="flex items-center gap-3 mt-1">
                      {n.sentiment_label && (
                        <span className={`text-[10px] font-medium ${LABEL_COLOR[n.sentiment_label]}`}>
                          {n.sentiment_score != null ? (n.sentiment_score >= 0 ? '+' : '') + n.sentiment_score.toFixed(3) : ''}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-600">
                        {n.collected_at ? new Date(n.collected_at).toLocaleString('ko-KR', {
                          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                        }) : ''}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-10 text-gray-600">
            <Newspaper size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-xs">수집된 뉴스 없음</p>
            <p className="text-[11px] text-gray-700 mt-1">상단 '뉴스 수집' 버튼을 눌러 수집하세요</p>
          </div>
        )}
      </div>
    </div>
  )
}
