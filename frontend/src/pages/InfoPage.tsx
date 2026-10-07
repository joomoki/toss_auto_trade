import { useState } from 'react'
import { Newspaper, FileText } from 'lucide-react'
import Sentiment from './Sentiment'
import Dart from './Dart'

const TABS = [
  { id: 'news' as const, label: '뉴스 감성', Icon: Newspaper },
  { id: 'dart' as const, label: 'DART 공시', Icon: FileText  },
]

export default function InfoPage() {
  const [tab, setTab] = useState<'news' | 'dart'>('news')

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
      {tab === 'news' && <Sentiment key="sentiment" />}
      {tab === 'dart' && <Dart      key="dart"      />}
    </div>
  )
}
