import { useState } from 'react'
import {
  Brain, RefreshCw, Newspaper,
  CheckCircle, XCircle,
} from 'lucide-react'

// ── 타입 ─────────────────────────────────────────────────
export interface ModelScore {
  model_id: string
  score: number
  signal: 'BUY' | 'NEUTRAL' | 'SELL'
}

export interface NewsSentiment {
  positive_ratio: number
  neutral_ratio: number
  negative_ratio: number
  composite_score: number     // -1 ~ +1
  article_count: number
  latest_headline?: string
}

export interface StockAnalysis {
  stock_code: string
  stock_name: string
  is_holding: boolean
  model_scores: ModelScore[]        // M1 ~ M10
  ensemble_score: number            // 0 ~ 1
  ensemble_signal: 'BUY' | 'NEUTRAL' | 'SELL'
  vote_buy: number
  vote_total: number
  score_variance: number            // 모델 간 표준편차
  news: NewsSentiment
}

export interface TradeAttribution {
  stock_code: string
  stock_name: string
  action: 'ENTERED' | 'SKIPPED'
  trigger_models: string[]
  skip_reason?: 'SCORE_LOW' | 'RISK_LIMIT' | 'CASH_LIMIT' | 'ALREADY_HELD' | 'CONFLICTING_SIGNALS'
  dissenting_models?: string[]
  entry_price?: number
  entry_time?: string
  score_at_decision: number
  news_score_at_decision: number
}

export interface AIAnalysisData {
  analyzed_at: string
  stocks: StockAnalysis[]
  attributions: TradeAttribution[]
}

// ── 샘플 데이터 ───────────────────────────────────────────
// TODO: 아래 const를 useEffect + API 호출로 교체
//   const [data, setData] = useState<AIAnalysisData | null>(null)
//   useEffect(() => { getAISignalAnalysis().then(setData) }, [])
export const SAMPLE_DATA: AIAnalysisData = {
  analyzed_at: '2026-06-26T14:32:00+09:00',
  stocks: [
    {
      stock_code: '373220', stock_name: 'LG에너지솔루션', is_holding: false,
      model_scores: [
        { model_id: 'M1',  score: 0.76, signal: 'BUY' },
        { model_id: 'M2',  score: 0.82, signal: 'BUY' },
        { model_id: 'M3',  score: 0.79, signal: 'BUY' },
        { model_id: 'M4',  score: 0.65, signal: 'BUY' },
        { model_id: 'M5',  score: 0.81, signal: 'BUY' },
        { model_id: 'M6',  score: 0.73, signal: 'BUY' },
        { model_id: 'M7',  score: 0.68, signal: 'BUY' },
        { model_id: 'M8',  score: 0.77, signal: 'BUY' },
        { model_id: 'M9',  score: 0.71, signal: 'BUY' },
        { model_id: 'M10', score: 0.80, signal: 'BUY' },
      ],
      ensemble_score: 0.77, ensemble_signal: 'BUY', vote_buy: 10, vote_total: 10, score_variance: 0.05,
      news: { positive_ratio: 0.62, neutral_ratio: 0.27, negative_ratio: 0.11, composite_score: 0.43, article_count: 9, latest_headline: 'LG에너지솔루션, 북미 대규모 배터리 공급 계약 신규 수주' },
    },
    {
      stock_code: '035720', stock_name: '카카오', is_holding: true,
      model_scores: [
        { model_id: 'M1',  score: 0.81, signal: 'BUY'     },
        { model_id: 'M2',  score: 0.74, signal: 'BUY'     },
        { model_id: 'M3',  score: 0.55, signal: 'NEUTRAL' },
        { model_id: 'M4',  score: 0.68, signal: 'BUY'     },
        { model_id: 'M5',  score: 0.72, signal: 'BUY'     },
        { model_id: 'M6',  score: 0.61, signal: 'BUY'     },
        { model_id: 'M7',  score: 0.45, signal: 'NEUTRAL' },
        { model_id: 'M8',  score: 0.77, signal: 'BUY'     },
        { model_id: 'M9',  score: 0.63, signal: 'BUY'     },
        { model_id: 'M10', score: 0.58, signal: 'NEUTRAL' },
      ],
      ensemble_score: 0.71, ensemble_signal: 'BUY', vote_buy: 7, vote_total: 10, score_variance: 0.11,
      news: { positive_ratio: 0.58, neutral_ratio: 0.31, negative_ratio: 0.11, composite_score: 0.38, article_count: 12, latest_headline: '카카오, AI 서비스 월간 사용자 역대 최고치 달성' },
    },
    {
      stock_code: '068270', stock_name: '셀트리온', is_holding: true,
      model_scores: [
        { model_id: 'M1',  score: 0.43, signal: 'NEUTRAL' },
        { model_id: 'M2',  score: 0.68, signal: 'BUY'     },
        { model_id: 'M3',  score: 0.72, signal: 'BUY'     },
        { model_id: 'M4',  score: 0.64, signal: 'BUY'     },
        { model_id: 'M5',  score: 0.55, signal: 'NEUTRAL' },
        { model_id: 'M6',  score: 0.70, signal: 'BUY'     },
        { model_id: 'M7',  score: 0.62, signal: 'BUY'     },
        { model_id: 'M8',  score: 0.38, signal: 'SELL'    },
        { model_id: 'M9',  score: 0.77, signal: 'BUY'     },
        { model_id: 'M10', score: 0.58, signal: 'NEUTRAL' },
      ],
      ensemble_score: 0.64, ensemble_signal: 'BUY', vote_buy: 6, vote_total: 10, score_variance: 0.13,
      news: { positive_ratio: 0.44, neutral_ratio: 0.35, negative_ratio: 0.21, composite_score: 0.21, article_count: 8, latest_headline: '셀트리온, 유럽 바이오시밀러 시장 점유율 지속 확대' },
    },
    {
      stock_code: '272210', stock_name: '한화시스템', is_holding: true,
      model_scores: [
        { model_id: 'M1',  score: 0.62, signal: 'BUY'     },
        { model_id: 'M2',  score: 0.51, signal: 'NEUTRAL' },
        { model_id: 'M3',  score: 0.48, signal: 'NEUTRAL' },
        { model_id: 'M4',  score: 0.55, signal: 'NEUTRAL' },
        { model_id: 'M5',  score: 0.67, signal: 'BUY'     },
        { model_id: 'M6',  score: 0.44, signal: 'NEUTRAL' },
        { model_id: 'M7',  score: 0.71, signal: 'BUY'     },
        { model_id: 'M8',  score: 0.52, signal: 'NEUTRAL' },
        { model_id: 'M9',  score: 0.43, signal: 'NEUTRAL' },
        { model_id: 'M10', score: 0.57, signal: 'NEUTRAL' },
      ],
      ensemble_score: 0.57, ensemble_signal: 'NEUTRAL', vote_buy: 3, vote_total: 10, score_variance: 0.09,
      news: { positive_ratio: 0.51, neutral_ratio: 0.28, negative_ratio: 0.21, composite_score: 0.27, article_count: 6, latest_headline: '한화시스템, 방산 수출 신규 계약 체결 확인' },
    },
    {
      stock_code: '005930', stock_name: '삼성전자', is_holding: false,
      model_scores: [
        { model_id: 'M1',  score: 0.51, signal: 'NEUTRAL' },
        { model_id: 'M2',  score: 0.38, signal: 'SELL'    },
        { model_id: 'M3',  score: 0.49, signal: 'NEUTRAL' },
        { model_id: 'M4',  score: 0.52, signal: 'NEUTRAL' },
        { model_id: 'M5',  score: 0.35, signal: 'SELL'    },
        { model_id: 'M6',  score: 0.48, signal: 'NEUTRAL' },
        { model_id: 'M7',  score: 0.44, signal: 'NEUTRAL' },
        { model_id: 'M8',  score: 0.53, signal: 'NEUTRAL' },
        { model_id: 'M9',  score: 0.42, signal: 'NEUTRAL' },
        { model_id: 'M10', score: 0.46, signal: 'NEUTRAL' },
      ],
      ensemble_score: 0.46, ensemble_signal: 'NEUTRAL', vote_buy: 0, vote_total: 10, score_variance: 0.06,
      news: { positive_ratio: 0.33, neutral_ratio: 0.38, negative_ratio: 0.29, composite_score: -0.04, article_count: 22, latest_headline: '삼성전자 3분기 가이던스, 시장 기대치 하회 전망' },
    },
    {
      stock_code: '000660', stock_name: 'SK하이닉스', is_holding: false,
      model_scores: [
        { model_id: 'M1',  score: 0.34, signal: 'SELL' },
        { model_id: 'M2',  score: 0.28, signal: 'SELL' },
        { model_id: 'M3',  score: 0.41, signal: 'NEUTRAL' },
        { model_id: 'M4',  score: 0.22, signal: 'SELL' },
        { model_id: 'M5',  score: 0.31, signal: 'SELL' },
        { model_id: 'M6',  score: 0.38, signal: 'SELL' },
        { model_id: 'M7',  score: 0.27, signal: 'SELL' },
        { model_id: 'M8',  score: 0.35, signal: 'SELL' },
        { model_id: 'M9',  score: 0.29, signal: 'SELL' },
        { model_id: 'M10', score: 0.33, signal: 'SELL' },
      ],
      ensemble_score: 0.32, ensemble_signal: 'SELL', vote_buy: 0, vote_total: 10, score_variance: 0.05,
      news: { positive_ratio: 0.24, neutral_ratio: 0.34, negative_ratio: 0.42, composite_score: -0.23, article_count: 15, latest_headline: 'SK하이닉스 HBM 수요 둔화·공급 과잉 우려 지속 확산' },
    },
  ],
  attributions: [
    {
      stock_code: '373220', stock_name: 'LG에너지솔루션', action: 'ENTERED',
      trigger_models: ['M1','M2','M3','M5','M8'],
      entry_price: 384500, entry_time: '14:02:33',
      score_at_decision: 0.77, news_score_at_decision: 0.43,
    },
    {
      stock_code: '035720', stock_name: '카카오', action: 'ENTERED',
      trigger_models: ['M1','M2','M4','M5','M8'],
      entry_price: 33150, entry_time: '10:15:08',
      score_at_decision: 0.71, news_score_at_decision: 0.38,
    },
    {
      stock_code: '068270', stock_name: '셀트리온', action: 'SKIPPED',
      trigger_models: ['M2','M3','M4','M6','M7','M9'],
      skip_reason: 'ALREADY_HELD',
      score_at_decision: 0.64, news_score_at_decision: 0.21,
    },
    {
      stock_code: '272210', stock_name: '한화시스템', action: 'SKIPPED',
      trigger_models: ['M1','M5','M7'],
      skip_reason: 'CONFLICTING_SIGNALS',
      dissenting_models: ['M3','M4','M6','M9'],
      score_at_decision: 0.57, news_score_at_decision: 0.27,
    },
    {
      stock_code: '005930', stock_name: '삼성전자', action: 'SKIPPED',
      trigger_models: [],
      skip_reason: 'SCORE_LOW',
      dissenting_models: ['M2','M5'],
      score_at_decision: 0.46, news_score_at_decision: -0.04,
    },
    {
      stock_code: '000660', stock_name: 'SK하이닉스', action: 'SKIPPED',
      trigger_models: [],
      skip_reason: 'SCORE_LOW',
      dissenting_models: ['M1','M2','M4','M5','M6','M7','M8','M9','M10'],
      score_at_decision: 0.32, news_score_at_decision: -0.23,
    },
  ],
}

// ── 유틸 ─────────────────────────────────────────────────
const MODEL_IDS = ['M1','M2','M3','M4','M5','M6','M7','M8','M9','M10']

const MODEL_SHORT: Record<string, string> = {
  M1: '이평크로스', M2: 'RSI반등', M3: 'MACD전환',
  M4: '볼린저밴드', M5: '거래량돌파', M6: '스토캐스틱',
  M7: 'ADX추세', M8: '캔들패턴', M9: '지지선', M10: '앙상블',
}

const SKIP_LABEL: Record<string, string> = {
  SCORE_LOW:            '점수 미달',
  RISK_LIMIT:           '리스크 한도',
  CASH_LIMIT:           '매수여력 부족',
  ALREADY_HELD:         '이미 보유중',
  CONFLICTING_SIGNALS:  '시그널 충돌',
}

const SKIP_COLOR: Record<string, string> = {
  SCORE_LOW:           'text-yellow-400',
  RISK_LIMIT:          'text-orange-400',
  CASH_LIMIT:          'text-orange-400',
  ALREADY_HELD:        'text-blue-400',
  CONFLICTING_SIGNALS: 'text-red-400',
}

function cellStyle(score: number): React.CSSProperties {
  if (score >= 0.75) return { background: 'rgba(5,150,105,0.85)',   color: '#ecfdf5' }
  if (score >= 0.65) return { background: 'rgba(16,185,129,0.55)',  color: '#d1fae5' }
  if (score >= 0.55) return { background: 'rgba(52,211,153,0.28)',  color: '#6ee7b7' }
  if (score >= 0.45) return { background: 'rgba(75,85,99,0.28)',    color: '#9ca3af' }
  if (score >= 0.35) return { background: 'rgba(248,113,113,0.30)', color: '#fca5a5' }
  if (score >= 0.25) return { background: 'rgba(239,68,68,0.55)',   color: '#fecaca' }
  return                    { background: 'rgba(185,28,28,0.80)',   color: '#fff1f2' }
}

function sigBadgeCls(sig: 'BUY' | 'NEUTRAL' | 'SELL') {
  if (sig === 'BUY')  return 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50'
  if (sig === 'SELL') return 'bg-red-900/60 text-red-300 border-red-700/50'
  return 'bg-gray-700/60 text-gray-400 border-gray-600/50'
}
function sigLabel(sig: 'BUY' | 'NEUTRAL' | 'SELL') {
  return sig === 'BUY' ? '매수' : sig === 'SELL' ? '매도' : '중립'
}
function pnlCls(v: number) {
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
}
function varianceInfo(v: number) {
  if (v < 0.07) return { label: '낮음', cls: 'text-emerald-400' }
  if (v < 0.12) return { label: '보통', cls: 'text-yellow-400'  }
  return               { label: '높음', cls: 'text-red-400'     }
}

// ── 섹션 1: 모델 점수 매트릭스 ───────────────────────────
function ModelMatrix({ stocks, selected, onSelect }: {
  stocks: StockAnalysis[]
  selected: string | null
  onSelect: (code: string | null) => void
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex items-start justify-between mb-3 gap-4">
        <div>
          <h2 className="text-sm font-semibold">모델별 점수 매트릭스</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">
            행 클릭 → 하단 섹션 필터 · 다시 클릭하면 해제
          </p>
        </div>
        {/* 범례 */}
        <div className="hidden md:flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {[
            { score: 0.80, label: '강매수' },
            { score: 0.65, label: '매수'   },
            { score: 0.50, label: '중립'   },
            { score: 0.35, label: '매도'   },
            { score: 0.20, label: '강매도' },
          ].map(({ score, label }) => (
            <div key={label} className="flex items-center gap-1 text-[10px] text-gray-500">
              <div className="w-3.5 h-3.5 rounded" style={cellStyle(score)} />
              {label}
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-separate border-spacing-0">
          <thead>
            <tr className="text-gray-500">
              <th className="py-2 px-3 text-left font-medium sticky left-0 bg-gray-900 z-10 w-32">
                종목
              </th>
              {MODEL_IDS.map(m => (
                <th key={m} className="py-2 px-1 text-center font-medium w-11">
                  <div className="font-mono text-gray-400">{m}</div>
                  <div className="text-[8px] text-gray-600 hidden xl:block whitespace-nowrap">
                    {MODEL_SHORT[m]}
                  </div>
                </th>
              ))}
              <th className="py-2 px-3 text-center font-medium w-24 text-gray-400">앙상블</th>
              <th className="py-2 px-3 text-center font-medium w-14 text-gray-400">투표</th>
            </tr>
          </thead>
          <tbody>
            {stocks.map(stock => {
              const isSel = selected === stock.stock_code
              return (
                <tr
                  key={stock.stock_code}
                  className={`cursor-pointer transition-colors ${
                    isSel ? 'bg-blue-950/40 outline outline-1 outline-blue-700/40' : 'hover:bg-gray-800/30'
                  }`}
                  onClick={() => onSelect(isSel ? null : stock.stock_code)}
                >
                  {/* 종목명 */}
                  <td className="py-2 px-3 sticky left-0 z-10 bg-inherit border-t border-gray-800/50">
                    <div className="font-semibold text-white text-[11px] flex items-center gap-1 flex-wrap">
                      {stock.stock_name}
                      {stock.is_holding && (
                        <span className="text-[8px] bg-blue-900/50 text-blue-300 px-1 py-0.5 rounded font-normal">보유</span>
                      )}
                    </div>
                    <div className="text-[9px] text-gray-600 font-mono">{stock.stock_code}</div>
                  </td>

                  {/* 모델 셀 */}
                  {stock.model_scores.map(ms => (
                    <td key={ms.model_id} className="py-1 px-0.5 border-t border-gray-800/50">
                      <div
                        className="rounded text-[11px] font-mono font-bold text-center py-1.5 mx-0.5"
                        style={cellStyle(ms.score)}
                      >
                        {ms.score.toFixed(2)}
                      </div>
                    </td>
                  ))}

                  {/* 앙상블 */}
                  <td className="py-1 px-2 text-center border-t border-gray-800/50">
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-semibold ${sigBadgeCls(stock.ensemble_signal)}`}>
                      {stock.ensemble_score.toFixed(2)}
                      <span>{sigLabel(stock.ensemble_signal)}</span>
                    </span>
                  </td>

                  {/* 투표 */}
                  <td className="py-1 px-2 text-center border-t border-gray-800/50">
                    <div className={`text-xs font-bold ${
                      stock.vote_buy >= 7 ? 'text-emerald-400'
                      : stock.vote_buy >= 4 ? 'text-yellow-400'
                      : 'text-red-400'
                    }`}>
                      {stock.vote_buy}/{stock.vote_total}
                    </div>
                    <div className="mt-0.5 h-1 rounded-full bg-gray-700 overflow-hidden w-10 mx-auto">
                      <div
                        className={`h-full rounded-full ${
                          stock.vote_buy >= 7 ? 'bg-emerald-500'
                          : stock.vote_buy >= 4 ? 'bg-yellow-500'
                          : 'bg-red-500'
                        }`}
                        style={{ width: `${(stock.vote_buy / stock.vote_total) * 100}%` }}
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 섹션 2: 앙상블 결정 카드 ─────────────────────────────
function EnsembleCards({ stocks, selected, onSelect }: {
  stocks: StockAnalysis[]
  selected: string | null
  onSelect: (code: string | null) => void
}) {
  const sorted = [...stocks].sort((a, b) => b.ensemble_score - a.ensemble_score)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">앙상블 결정 · 동의율</h2>
        <p className="text-[10px] text-gray-500">분산 높으면 신호 불안정 — 진입 주의</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {sorted.map(stock => {
          const isSel = selected === stock.stock_code
          const vi = varianceInfo(stock.score_variance)
          const isBuy  = stock.ensemble_signal === 'BUY'
          const isSell = stock.ensemble_signal === 'SELL'
          const barCls = isBuy ? 'bg-emerald-500' : isSell ? 'bg-red-500' : 'bg-gray-500'
          const scoreCls = isBuy ? 'text-emerald-400' : isSell ? 'text-red-400' : 'text-gray-300'

          return (
            <div
              key={stock.stock_code}
              onClick={() => onSelect(isSel ? null : stock.stock_code)}
              className={`bg-gray-900 rounded-xl border p-3 cursor-pointer transition-all ${
                isSel
                  ? 'border-blue-500 shadow-lg shadow-blue-900/20'
                  : 'border-gray-800 hover:border-gray-600'
              }`}
            >
              {/* 상단: 종목 + 신호 배지 */}
              <div className="flex items-start justify-between mb-2 gap-1">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold text-white leading-tight truncate">{stock.stock_name}</div>
                  <div className="text-[9px] text-gray-600 font-mono">{stock.stock_code}</div>
                </div>
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${sigBadgeCls(stock.ensemble_signal)}`}>
                  {sigLabel(stock.ensemble_signal)}
                </span>
              </div>

              {/* 점수 */}
              <div className={`text-2xl font-bold tabular-nums mb-1 ${scoreCls}`}>
                {stock.ensemble_score.toFixed(2)}
              </div>

              {/* 점수 바 (0.5 = 중립 기준) */}
              <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden mb-2.5">
                <div
                  className={`h-full rounded-full transition-all ${barCls}`}
                  style={{ width: `${stock.ensemble_score * 100}%` }}
                />
              </div>

              {/* 투표 수 */}
              <div className="text-[10px] text-gray-400 mb-1.5">
                <span className={`font-bold ${scoreCls}`}>{stock.vote_buy}</span>
                <span className="text-gray-600">/{stock.vote_total}</span>
                <span className="ml-1">모델 매수 동의</span>
              </div>

              {/* 분산 */}
              <div className="flex items-center gap-1 text-[9px]">
                <span className="text-gray-600">분산</span>
                <span className={`font-semibold ${vi.cls}`}>{vi.label}</span>
                <span className="text-gray-700 tabular-nums">({stock.score_variance.toFixed(2)})</span>
              </div>

              {stock.is_holding && (
                <div className="mt-2 text-[9px] text-blue-400 bg-blue-900/30 rounded px-1.5 py-0.5 text-center">
                  현재 보유중
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 섹션 3: 뉴스 감성 ────────────────────────────────────
function NewsSentimentSection({ stocks, selected }: {
  stocks: StockAnalysis[]
  selected: string | null
}) {
  const list = selected ? stocks.filter(s => s.stock_code === selected) : [...stocks].sort((a, b) => b.news.composite_score - a.news.composite_score)

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-4">
        <Newspaper size={13} className="text-blue-400" />
        <div>
          <h2 className="text-sm font-semibold">뉴스 감성</h2>
          <p className="text-[9px] text-gray-600">KR-FinBert-SC</p>
        </div>
      </div>

      <div className="space-y-4">
        {list.map(stock => {
          const { positive_ratio, neutral_ratio, composite_score, article_count, latest_headline } = stock.news
          const posPct = Math.round(positive_ratio * 100)
          const neuPct = Math.round(neutral_ratio * 100)
          const negPct = 100 - posPct - neuPct

          return (
            <div key={stock.stock_code}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-white">{stock.stock_name}</span>
                  {stock.is_holding && <span className="text-[9px] text-blue-400">★</span>}
                  <span className="text-[9px] text-gray-600">{article_count}건</span>
                </div>
                <span className={`text-xs font-bold tabular-nums ${pnlCls(composite_score)}`}>
                  {composite_score >= 0 ? '+' : ''}{composite_score.toFixed(2)}
                </span>
              </div>

              {/* 감성 바 */}
              <div className="flex h-2 rounded-full overflow-hidden">
                <div className="bg-emerald-500/70" style={{ width: `${posPct}%` }} title={`긍정 ${posPct}%`} />
                <div className="bg-gray-600/60" style={{ width: `${neuPct}%` }} title={`중립 ${neuPct}%`} />
                <div className="bg-red-500/70" style={{ width: `${negPct}%` }} title={`부정 ${negPct}%`} />
              </div>
              <div className="flex justify-between text-[9px] mt-0.5">
                <span className="text-emerald-600">긍 {posPct}%</span>
                <span className="text-gray-600">중 {neuPct}%</span>
                <span className="text-red-600">부 {negPct}%</span>
              </div>

              {latest_headline && (
                <p className="text-[9px] text-gray-500 mt-1 truncate" title={latest_headline}>
                  ▸ {latest_headline}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 섹션 4: 매매 Attribution ──────────────────────────────
function TradeAttributionSection({ attributions, selected }: {
  attributions: TradeAttribution[]
  selected: string | null
}) {
  const [tab, setTab] = useState<'entered' | 'skipped'>('entered')

  const entered = attributions.filter(a => a.action === 'ENTERED')
  const skipped = attributions.filter(a => a.action === 'SKIPPED')
  const list = (tab === 'entered' ? entered : skipped)
    .filter(a => !selected || a.stock_code === selected)

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <h2 className="text-sm font-semibold mb-3">매매 결정 근거</h2>

      {/* 탭 */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setTab('entered')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
            tab === 'entered'
              ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50'
              : 'bg-gray-800 text-gray-400 hover:text-white'
          }`}
        >
          <CheckCircle size={11} />
          진입 ({entered.length})
        </button>
        <button
          onClick={() => setTab('skipped')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
            tab === 'skipped'
              ? 'bg-red-900/40 text-red-300 border border-red-700/40'
              : 'bg-gray-800 text-gray-400 hover:text-white'
          }`}
        >
          <XCircle size={11} />
          미진입 ({skipped.length})
        </button>
      </div>

      <div className="space-y-2">
        {list.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-6">
            {selected ? '선택한 종목 없음' : '내역 없음'}
          </p>
        )}

        {list.map(a => (
          <div
            key={a.stock_code}
            className={`rounded-xl border p-3 ${
              a.action === 'ENTERED'
                ? 'border-emerald-800/40 bg-emerald-950/20'
                : 'border-gray-800/60 bg-gray-800/10'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              {/* 왼쪽: 종목명 + 사유 */}
              <div className="flex items-start gap-2 min-w-0">
                {a.action === 'ENTERED'
                  ? <CheckCircle size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                  : <XCircle    size={13} className="text-red-400     shrink-0 mt-0.5" />
                }
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold text-white">{a.stock_name}</span>
                    {a.action === 'SKIPPED' && a.skip_reason && (
                      <span className={`text-[10px] font-medium ${SKIP_COLOR[a.skip_reason] ?? 'text-gray-400'}`}>
                        — {SKIP_LABEL[a.skip_reason]}
                      </span>
                    )}
                  </div>

                  {/* 트리거 모델 */}
                  {a.trigger_models.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                      <span className="text-[9px] text-gray-600 shrink-0">
                        {a.action === 'ENTERED' ? '트리거' : '동의'}
                      </span>
                      {a.trigger_models.map(m => (
                        <span key={m} className="text-[9px] font-mono bg-emerald-900/40 text-emerald-300 px-1.5 py-0.5 rounded">
                          {m}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* 반대 모델 */}
                  {a.dissenting_models && a.dissenting_models.length > 0 && (
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-[9px] text-gray-600 shrink-0">반대</span>
                      {a.dissenting_models.map(m => (
                        <span key={m} className="text-[9px] font-mono bg-red-900/40 text-red-300 px-1.5 py-0.5 rounded">
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 오른쪽: 가격 + 점수 */}
              <div className="text-right shrink-0">
                {a.entry_price && (
                  <div className="text-xs font-semibold text-white">
                    {a.entry_price.toLocaleString()}원
                  </div>
                )}
                {a.entry_time && (
                  <div className="text-[10px] text-gray-500">{a.entry_time}</div>
                )}
                <div className="text-[9px] text-gray-600 mt-0.5 tabular-nums">
                  점수 {a.score_at_decision.toFixed(2)}
                  {' · '}
                  뉴스 {a.news_score_at_decision >= 0 ? '+' : ''}{a.news_score_at_decision.toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 메인 컴포넌트 ─────────────────────────────────────────
export default function AISignalAnalysis() {
  // TODO: SAMPLE_DATA → API 연동 교체 포인트
  //   const [data, setData] = useState<AIAnalysisData | null>(null)
  //   const [loading, setLoading] = useState(true)
  //   useEffect(() => {
  //     getAISignalAnalysis().then(d => { setData(d); setLoading(false) })
  //   }, [])
  const [data] = useState<AIAnalysisData>(SAMPLE_DATA)
  const [selected, setSelected] = useState<string | null>(null)

  const analyzedAt = new Date(data.analyzed_at).toLocaleString('ko-KR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const selectedName = selected
    ? data.stocks.find(s => s.stock_code === selected)?.stock_name
    : null

  return (
    <div className="space-y-4">

      {/* 헤더 */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-bold flex items-center gap-2">
            <Brain size={16} className="text-purple-400" />
            AI 시그널 분석
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-gray-500">마지막 분석 {analyzedAt}</span>
            {selectedName && (
              <button
                onClick={() => setSelected(null)}
                className="text-[10px] text-blue-400 hover:text-blue-300"
              >
                ✕ {selectedName} 필터 해제
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedName && (
            <span className="text-[10px] bg-blue-900/40 text-blue-300 border border-blue-700/40 px-2.5 py-1 rounded-lg">
              {selectedName} 선택됨
            </span>
          )}
          <span className="text-[10px] text-amber-400 bg-amber-900/30 border border-amber-700/40 px-2 py-1 rounded-lg">
            샘플 데이터
          </span>
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">
            <RefreshCw size={12} />재분석
          </button>
        </div>
      </div>

      {/* Section 1: 매트릭스 */}
      <ModelMatrix stocks={data.stocks} selected={selected} onSelect={setSelected} />

      {/* Section 2: 앙상블 카드 */}
      <EnsembleCards stocks={data.stocks} selected={selected} onSelect={setSelected} />

      {/* Section 3 + 4: 뉴스 감성 + Attribution (1:2 비율) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <NewsSentimentSection stocks={data.stocks} selected={selected} />
        <div className="lg:col-span-2">
          <TradeAttributionSection attributions={data.attributions} selected={selected} />
        </div>
      </div>

    </div>
  )
}
