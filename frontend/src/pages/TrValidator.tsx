import { useState, useCallback } from 'react'
import { getTrSpecs, validateAllTrs, validateTr, getTrFields } from '../api/client'
import { Play, RefreshCw, ChevronDown, ChevronRight, CheckCircle, XCircle, HelpCircle, AlertTriangle, Info } from 'lucide-react'

interface TrSpec {
  tr_id: string
  desc: string
  status: 'confirmed' | 'unverified' | 'probe'
  body_extra: Record<string, string>
}

interface FieldRow {
  field: string
  type: string
  sample: string
}

interface ArrayInfo {
  key: string
  parent: string
  count: number
}

interface TrResult {
  tr_id: string
  desc: string
  status: string
  ok: boolean
  return_code: number | null
  return_msg: string | null
  top_level_keys: string[]
  arrays_found: ArrayInfo[]
  fields: FieldRow[]
  raw: Record<string, unknown> | null
  elapsed_ms: number
  error: string | null
  body_sent?: Record<string, string>
}

const STATUS_COLOR: Record<string, string> = {
  confirmed:  'bg-blue-900/40 text-blue-300 border-blue-700/50',
  unverified: 'bg-yellow-900/40 text-yellow-300 border-yellow-700/50',
  probe:      'bg-gray-800 text-gray-400 border-gray-700',
}
const STATUS_LABEL: Record<string, string> = {
  confirmed: '확인됨', unverified: '미확인', probe: '탐색',
}

function ResultIcon({ ok, error }: { ok: boolean; error: string | null }) {
  if (error)  return <XCircle size={16} className="text-red-400 shrink-0" />
  if (ok)     return <CheckCircle size={16} className="text-green-400 shrink-0" />
  return <AlertTriangle size={16} className="text-yellow-400 shrink-0" />
}

function FieldTable({ fields }: { fields: FieldRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-700 text-gray-500">
            <th className="px-2 py-1.5 text-left font-medium w-64">필드명</th>
            <th className="px-2 py-1.5 text-left font-medium w-20">타입</th>
            <th className="px-2 py-1.5 text-left font-medium">샘플값</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {fields.map((f, i) => (
            <tr key={i} className={f.field.includes('[0]') ? 'bg-indigo-950/20' : ''}>
              <td className="px-2 py-1 font-mono text-blue-300">{f.field}</td>
              <td className="px-2 py-1 text-gray-500">{f.type}</td>
              <td className="px-2 py-1 text-gray-300 truncate max-w-xs">{f.sample}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ResultRow({ result }: { result: TrResult }) {
  const [open, setOpen] = useState(false)
  const [loadingFields, setLoadingFields] = useState(false)
  const [fields, setFields] = useState<FieldRow[] | null>(null)

  const loadFields = async () => {
    if (fields) { setOpen(o => !o); return }
    setLoadingFields(true)
    try {
      const d = await getTrFields(result.tr_id)
      setFields(d.fields ?? [])
      setOpen(true)
    } finally {
      setLoadingFields(false)
    }
  }

  const isOk     = result.ok && !result.error
  const hasError = !!result.error

  return (
    <div className={`border rounded-lg overflow-hidden ${
      isOk ? 'border-green-800/50' : hasError ? 'border-red-800/50' : 'border-gray-800'
    }`}>
      {/* 헤더 */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/30 transition-colors"
        onClick={loadFields}
        disabled={loadingFields}
      >
        <ResultIcon ok={isOk} error={result.error} />

        <span className="font-mono text-sm font-semibold text-white w-20 shrink-0">
          {result.tr_id}
        </span>

        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border shrink-0 ${STATUS_COLOR[result.status] ?? STATUS_COLOR.probe}`}>
          {STATUS_LABEL[result.status] ?? result.status}
        </span>

        <span className="text-xs text-gray-400 flex-1 truncate">{result.desc}</span>

        {result.ok && (
          <span className="text-[10px] text-gray-500 shrink-0">{result.elapsed_ms}ms</span>
        )}

        {result.ok && result.arrays_found.length > 0 && (
          <span className="text-[10px] bg-indigo-900/50 text-indigo-300 px-1.5 py-0.5 rounded shrink-0">
            배열 {result.arrays_found.length}개
          </span>
        )}

        {result.return_code != null && result.return_code !== 0 && (
          <span className="text-[10px] text-yellow-400 shrink-0">
            code={result.return_code}
          </span>
        )}

        {loadingFields
          ? <RefreshCw size={12} className="animate-spin text-gray-500 shrink-0" />
          : open
            ? <ChevronDown size={12} className="text-gray-500 shrink-0" />
            : <ChevronRight size={12} className="text-gray-500 shrink-0" />
        }
      </button>

      {/* 상세 */}
      {open && (
        <div className="border-t border-gray-800 bg-gray-950/50">
          {/* 요청 파라미터 */}
          {result.body_sent && (
            <div className="px-4 py-2 border-b border-gray-800/50">
              <span className="text-[10px] text-gray-500 font-medium">요청 body: </span>
              <span className="text-[10px] font-mono text-gray-400">
                {JSON.stringify(result.body_sent)}
              </span>
            </div>
          )}

          {/* 오류 */}
          {result.error && (
            <div className="px-4 py-3">
              <p className="text-xs text-red-400 font-mono">{result.error}</p>
            </div>
          )}

          {/* return_msg */}
          {result.return_msg && (
            <div className="px-4 py-2 border-b border-gray-800/50">
              <span className="text-[10px] text-gray-500">return_msg: </span>
              <span className="text-xs text-yellow-300">{result.return_msg}</span>
            </div>
          )}

          {/* 배열 목록 */}
          {result.arrays_found.length > 0 && (
            <div className="px-4 py-2 border-b border-gray-800/50">
              <p className="text-[10px] text-gray-500 mb-1.5 font-medium">응답 배열 키</p>
              <div className="flex flex-wrap gap-1.5">
                {result.arrays_found.map((a, i) => (
                  <span key={i} className="text-[10px] font-mono bg-indigo-900/40 text-indigo-300 px-2 py-0.5 rounded">
                    {a.key} ({a.count}개)
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 최상위 키 */}
          {result.top_level_keys.length > 0 && (
            <div className="px-4 py-2 border-b border-gray-800/50">
              <p className="text-[10px] text-gray-500 mb-1.5 font-medium">최상위 필드</p>
              <div className="flex flex-wrap gap-1">
                {result.top_level_keys.map(k => (
                  <span key={k} className="text-[10px] font-mono bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded">
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 필드 상세 */}
          {fields && fields.length > 0 && (
            <div className="px-4 py-2">
              <p className="text-[10px] text-gray-500 mb-1.5 font-medium">
                전체 필드 ({fields.length}개) — 파란색: 배열 내부
              </p>
              <FieldTable fields={fields} />
            </div>
          )}

          {fields && fields.length === 0 && !result.error && (
            <div className="px-4 py-3 text-xs text-gray-500">파싱 가능한 필드 없음 (빈 응답)</div>
          )}
        </div>
      )}
    </div>
  )
}

function ExplainCard() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-gray-900 border border-blue-900/50 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-800/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <Info size={14} className="text-blue-400 shrink-0" />
        <span className="text-sm font-medium text-blue-300">TR 코드 검증이란?</span>
        <span className="text-xs text-gray-500 ml-1">— 이 화면의 목적과 사용 방법</span>
        {open
          ? <ChevronDown size={13} className="text-gray-500 ml-auto" />
          : <ChevronRight size={13} className="text-gray-500 ml-auto" />
        }
      </button>

      {open && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4 text-xs text-gray-300">

          {/* TR이란 */}
          <div>
            <p className="font-semibold text-white mb-1">TR(Transaction Request)이란?</p>
            <p className="text-gray-400 leading-relaxed">
              키움증권 REST API에서 모든 데이터 조회·주문은 고유한 <span className="font-mono text-blue-300">api-id</span> 코드로 구분됩니다.
              이 코드를 <strong className="text-white">TR 코드</strong>라고 합니다.
              예를 들어 <span className="font-mono text-blue-300">kt00004</span>는 계좌평가현황(예수금·평가금액),
              <span className="font-mono text-blue-300"> kt00005</span>는 체결잔고(보유종목 목록),
              <span className="font-mono text-blue-300"> ka10001</span>은 주식 현재가 조회입니다.
            </p>
          </div>

          {/* 왜 검증이 필요한가 */}
          <div>
            <p className="font-semibold text-white mb-1">왜 검증이 필요한가요?</p>
            <p className="text-gray-400 leading-relaxed">
              키움 공식 문서는 일부 TR의 파라미터·응답 필드를 완전히 문서화하지 않습니다.
              특히 <span className="text-yellow-400">미확인</span> TR들은 "존재한다고 알려졌지만 실제로 호출했을 때
              어떤 필드를 돌려주는지" 직접 테스트해야 알 수 있습니다.
              검증하지 않고 수집 모듈을 만들면 필드명 불일치로 파싱 오류가 발생합니다.
            </p>
          </div>

          {/* 3가지 상태 */}
          <div>
            <p className="font-semibold text-white mb-2">TR 상태 구분</p>
            <div className="space-y-2">
              {[
                {
                  color: 'bg-blue-900/40 text-blue-300 border-blue-700/50',
                  label: '확인됨',
                  desc: '이미 코드에서 사용 중이며 응답 구조가 검증된 TR. (kt00004 잔고, kt00005 체결잔고, ka10076 체결내역)',
                },
                {
                  color: 'bg-yellow-900/40 text-yellow-300 border-yellow-700/50',
                  label: '미확인',
                  desc: '키움 문서나 커뮤니티에서 "있다"고 알려졌지만 실제 응답 필드를 아직 확인하지 못한 TR. (kt00001 예수금, ka10072 실현손익 등)',
                },
                {
                  color: 'bg-gray-800 text-gray-400 border-gray-700',
                  label: '탐색',
                  desc: '번호 패턴으로 추정한 TR. 실제로 존재하지 않거나 권한이 없을 수 있음. 검증 실패 시 해당 TR은 미지원으로 처리.',
                },
              ].map(s => (
                <div key={s.label} className="flex items-start gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${s.color}`}>
                    {s.label}
                  </span>
                  <span className="text-gray-400">{s.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 검증 후 활용 */}
          <div>
            <p className="font-semibold text-white mb-1">검증 결과 활용</p>
            <ol className="text-gray-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>성공한 TR의 <span className="text-blue-300">응답 필드명</span>을 확인 (클릭 → 필드 테이블 펼쳐짐)</li>
              <li>배열 키가 있으면 반복 데이터(체결내역·보유종목 등)가 존재한다는 의미</li>
              <li>필드명 확인 후 <code className="bg-gray-800 px-1 rounded">account_collector.py</code>에 파서 구현</li>
              <li>실패한 TR은 미지원 또는 파라미터 수정 필요로 판단</li>
            </ol>
          </div>

          {/* 주의사항 */}
          <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 text-yellow-400/80">
            <p className="font-medium mb-0.5">⚠ 주의</p>
            <p>전체 검증 실행은 TR당 0.8초 간격으로 순차 호출합니다 (Rate Limit 보호).
            13개 TR 기준 약 11초 소요됩니다.
            <strong className="text-yellow-300"> 장 시간 중 실행 시 실제 계좌 데이터를 조회</strong>하므로
            테스트용 계좌에서만 사용하거나 16:00 이후 실행을 권장합니다.</p>
          </div>

        </div>
      )}
    </div>
  )
}

export default function TrValidator() {
  const [specs, setSpecs]       = useState<TrSpec[]>([])
  const [results, setResults]   = useState<TrResult[]>([])
  const [running, setRunning]   = useState(false)
  const [loaded, setLoaded]     = useState(false)
  const [summary, setSummary]   = useState<Record<string, unknown> | null>(null)
  const [filter, setFilter]     = useState<'all' | 'ok' | 'fail'>('all')

  const loadSpecs = useCallback(async () => {
    const d = await getTrSpecs()
    setSpecs(d.specs ?? [])
    setLoaded(true)
  }, [])

  const runAll = useCallback(async () => {
    setRunning(true)
    setResults([])
    setSummary(null)
    try {
      const d = await validateAllTrs()
      setResults(d.results ?? [])
      setSummary(d.summary ?? null)
    } finally {
      setRunning(false)
    }
  }, [])

  const runSingle = useCallback(async (trId: string) => {
    const d = await validateTr(trId)
    setResults(prev => {
      const next = prev.filter(r => r.tr_id !== trId)
      return [...next, d].sort((a, b) => {
        const si = TR_SPEC_ORDER.indexOf(a.tr_id)
        const sj = TR_SPEC_ORDER.indexOf(b.tr_id)
        return (si === -1 ? 999 : si) - (sj === -1 ? 999 : sj)
      })
    })
  }, [])

  const TR_SPEC_ORDER = specs.map(s => s.tr_id)

  const filtered = results.filter(r => {
    if (filter === 'ok')   return r.ok && !r.error
    if (filter === 'fail') return !!r.error || !r.ok
    return true
  })

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div>
          <h1 className="text-lg font-bold">키움 TR 코드 검증</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            미확인 TR 실제 호출 → 응답 필드명 파악 → 수집 모듈 구현에 활용
          </p>
        </div>
        <div className="flex gap-2 sm:ml-auto">
          {!loaded && (
            <button
              onClick={loadSpecs}
              className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors"
            >
              <HelpCircle size={13} />TR 목록 보기
            </button>
          )}
          <button
            onClick={runAll}
            disabled={running}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded-lg transition-colors font-medium"
          >
            {running
              ? <><RefreshCw size={13} className="animate-spin" />검증 중…</>
              : <><Play size={13} />전체 검증 실행</>
            }
          </button>
        </div>
      </div>

      {/* 설명 카드 */}
      <ExplainCard />

      {/* 범례 */}
      <div className="flex flex-wrap gap-3 text-xs">
        {[
          { color: 'bg-blue-900/40 text-blue-300 border border-blue-700/50',    label: '확인됨 (기존 코드)' },
          { color: 'bg-yellow-900/40 text-yellow-300 border border-yellow-700/50', label: '미확인 (사용자 제공)' },
          { color: 'bg-gray-800 text-gray-400 border border-gray-700',           label: '탐색 (추정 TR)' },
        ].map(b => (
          <span key={b.label} className={`px-2 py-0.5 rounded ${b.color}`}>{b.label}</span>
        ))}
      </div>

      {/* 결과 요약 */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: '전체', value: String(summary.total), color: 'text-white' },
            { label: '성공', value: String(summary.ok),    color: 'text-green-400' },
            { label: '실패', value: String(summary.failed), color: 'text-red-400' },
            { label: '계좌번호', value: String(summary.account_no), color: 'text-blue-400' },
          ].map(k => (
            <div key={k.label} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
              <div className="text-[10px] text-gray-500">{k.label}</div>
              <div className={`text-sm font-semibold mt-0.5 ${k.color}`}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* TR 스펙 목록 (호출 전) */}
      {loaded && results.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <p className="text-xs text-gray-400">검증할 TR 목록 ({specs.length}개) — "전체 검증 실행"을 눌러 시작</p>
          </div>
          <div className="divide-y divide-gray-800">
            {specs.map(s => (
              <div key={s.tr_id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="font-mono text-sm text-white w-20 shrink-0">{s.tr_id}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${STATUS_COLOR[s.status]}`}>
                  {STATUS_LABEL[s.status]}
                </span>
                <span className="text-xs text-gray-400 flex-1">{s.desc}</span>
                <button
                  onClick={() => runSingle(s.tr_id)}
                  className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
                >
                  단건 실행
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 검증 결과 */}
      {results.length > 0 && (
        <div className="space-y-2">
          {/* 필터 */}
          <div className="flex gap-1">
            {(['all', 'ok', 'fail'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  filter === f ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
              >
                {f === 'all' ? `전체 (${results.length})` : f === 'ok' ? `성공 (${results.filter(r=>r.ok && !r.error).length})` : `실패 (${results.filter(r=>r.error||!r.ok).length})`}
              </button>
            ))}
          </div>

          {filtered.map(r => (
            <ResultRow key={r.tr_id} result={r} />
          ))}
        </div>
      )}

      {/* 로딩 중 안내 */}
      {running && (
        <div className="text-center py-8">
          <RefreshCw size={24} className="animate-spin text-blue-400 mx-auto mb-3" />
          <p className="text-sm text-gray-400">TR 순차 호출 중… (Rate limit 보호: TR당 0.8초 간격)</p>
          <p className="text-xs text-gray-600 mt-1">총 {TR_SPECS_COUNT}개 TR × 0.8s ≒ 약 {Math.ceil(TR_SPECS_COUNT * 0.8)}초 소요</p>
        </div>
      )}
    </div>
  )
}

const TR_SPECS_COUNT = 13
