import { useState } from 'react'
import { CalendarDays, Briefcase, Zap } from 'lucide-react'
import DailyTrades from './DailyTrades'
import Holdings from './Holdings'
import AutoTradeHistory from './AutoTradeHistory'

const TABS = [
  { id: 'daily'   as const, label: '일별 현황',     Icon: CalendarDays },
  { id: 'auto'    as const, label: '자동매매 이력', Icon: Zap          },
  { id: 'holdings'as const, label: '보유 종목',     Icon: Briefcase    },
]

type Tab = 'daily' | 'auto' | 'holdings'

export default function HistoryPage() {
  const [tab, setTab] = useState<Tab>('daily')

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-gray-800 overflow-x-auto scrollbar-hide">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-colors ${
              tab === id
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon size={11} />{label}
          </button>
        ))}
      </div>
      {tab === 'daily'    && <DailyTrades      key="daily"    />}
      {tab === 'auto'     && <AutoTradeHistory key="auto"     />}
      {tab === 'holdings' && <Holdings         key="holdings" />}
    </div>
  )
}
