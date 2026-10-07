import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Dashboard    from './pages/Dashboard'
import AutoTrade    from './pages/AutoTrade'
import Supply       from './pages/Supply'
import InfoPage     from './pages/InfoPage'
import HistoryPage  from './pages/HistoryPage'
import Strategy     from './pages/Strategy'
import Backtest     from './pages/Backtest'
import AnalysisPage    from './pages/AnalysisPage'
import MacroRotation   from './pages/MacroRotation'
import TelegramPage    from './pages/Telegram'
import LogPage         from './pages/LogPage'
import TrValidator     from './pages/TrValidator'
import StockAnalysisPage from './pages/StockAnalysisPage'
import RisingStockPage from './pages/RisingStockPage'
import { useWsStore } from './store/wsStore'
import SystemHealth from './components/common/SystemHealth'
import {
  LayoutDashboard, Zap, TrendingUp, Newspaper,
  History as HistoryIcon, Settings, FlaskConical,
  BrainCircuit, Wifi, WifiOff, Globe, MessageSquare, ScrollText,
  Sun, Moon, Database, BarChart2, Flame,
} from 'lucide-react'

type Theme = 'dark' | 'light'

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('theme') as Theme) ?? 'dark'
  )
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    localStorage.setItem('theme', theme)
  }, [theme])
  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark')
  return [theme, toggle]
}

const NAV_ITEMS = [
  { to: '/',           label: '홈',      Icon: LayoutDashboard },
  { to: '/trade',      label: '자동매매', Icon: Zap             },
  { to: '/market',     label: '시장',    Icon: TrendingUp       },
  { to: '/macro',      label: '매크로',  Icon: Globe            },
  { to: '/info',       label: '정보',    Icon: Newspaper        },
  { to: '/history',    label: '내역',    Icon: HistoryIcon      },
  { to: '/stock-analysis', label: '종목분석', Icon: BarChart2   },
  { to: '/rising',         label: '상승분석', Icon: Flame        },
  { to: '/strategy',   label: '전략',    Icon: Settings         },
  { to: '/backtest',   label: '백테스트', Icon: FlaskConical    },
  { to: '/ai',         label: 'AI분석',  Icon: BrainCircuit     },
  { to: '/telegram',   label: '텔레그램', Icon: MessageSquare   },
  { to: '/log',        label: '로그',    Icon: ScrollText       },
  { to: '/account',   label: 'TR검증',  Icon: Database         },
]

function TopNav({ theme, onThemeToggle }: { theme: Theme; onThemeToggle: () => void }) {
  const wsStatus = useWsStore(s => s.status)
  return (
    <header className="hidden sm:flex bg-gray-900 border-b border-gray-800 px-4 py-2 items-center gap-3 sticky top-0 z-50">
      <span className="text-sm font-bold text-blue-400 whitespace-nowrap">키움 AI 매매</span>
      <nav className="flex gap-0.5 flex-1 overflow-x-auto scrollbar-hide">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                isActive ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`
            }
          >
            <Icon size={13} />{label}
          </NavLink>
        ))}
      </nav>
      <div className="flex items-center gap-2 shrink-0">
        <SystemHealth />
        {wsStatus === 'connected'
          ? <Wifi size={13} className="text-green-400" />
          : <WifiOff size={13} className="text-gray-600" />}
        <button
          onClick={onThemeToggle}
          className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
        </button>
      </div>
    </header>
  )
}

function BottomNav() {
  const location = useLocation()
  return (
    <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-gray-900 border-t border-gray-800 flex overflow-x-auto">
      {NAV_ITEMS.map(({ to, label, Icon }) => {
        const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
        return (
          <NavLink key={to} to={to} end={to === '/'}
            className="flex-none flex flex-col items-center justify-center py-2 px-3 gap-0.5 min-w-[4rem]"
          >
            <Icon size={18} className={isActive ? 'text-blue-400' : 'text-gray-500'} />
            <span className={`text-[9px] whitespace-nowrap ${isActive ? 'text-blue-400' : 'text-gray-500'}`}>
              {label}
            </span>
          </NavLink>
        )
      })}
    </nav>
  )
}

export default function App() {
  const connect = useWsStore(s => s.connect)
  const [theme, toggleTheme] = useTheme()
  useEffect(() => { connect() }, [connect])

  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-gray-950">
        <TopNav theme={theme} onThemeToggle={toggleTheme} />
        {/* 모바일 테마 토글 — 우상단 고정 */}
        <button
          onClick={toggleTheme}
          className="sm:hidden fixed top-2 right-2 z-50 p-2 rounded-full bg-gray-800 text-gray-300 shadow-lg"
          title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <main className="flex-1 px-3 py-4 sm:px-6 sm:py-6 pb-20 sm:pb-6 max-w-7xl mx-auto w-full">
          <Routes>
            <Route path="/"         element={<Dashboard    />} />
            <Route path="/trade"    element={<AutoTrade    />} />
            <Route path="/market"   element={<Supply       />} />
            <Route path="/info"     element={<InfoPage     />} />
            <Route path="/history"  element={<HistoryPage  />} />
            <Route path="/stock-analysis" element={<StockAnalysisPage />} />
            <Route path="/rising"         element={<RisingStockPage  />} />
            <Route path="/strategy" element={<Strategy     />} />
            <Route path="/backtest" element={<Backtest     />} />
            <Route path="/macro"     element={<MacroRotation />} />
            <Route path="/ai"        element={<AnalysisPage  />} />
            <Route path="/telegram"  element={<TelegramPage  />} />
            <Route path="/log"       element={<LogPage       />} />
            <Route path="/account"   element={<TrValidator   />} />
          </Routes>
        </main>
        <BottomNav />
      </div>
    </BrowserRouter>
  )
}
