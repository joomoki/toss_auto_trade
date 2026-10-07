import { useState } from 'react'
import { BrainCircuit, Zap } from 'lucide-react'
import Models from './Models'
import AISignalAnalysis from './AISignalAnalysis'

const TABS = [
  { id: 'signal'   as const, label: 'AI 시그널',   Icon: Zap         },
  { id: 'models'   as const, label: 'AI 모델 관리', Icon: BrainCircuit },
]

export default function AnalysisPage() {
  const [tab, setTab] = useState<'signal' | 'models'>('signal')

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-gray-800">
        {TABS.map(({ id, label, Icon }) => (
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
      {tab === 'signal' && <AISignalAnalysis key="signal" />}
      {tab === 'models' && <Models           key="models" />}
    </div>
  )
}
