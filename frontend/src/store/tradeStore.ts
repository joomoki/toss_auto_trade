import { create } from 'zustand'

export interface Signal {
  id: number
  stock_code: string
  stock_name: string
  signal_type: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  price_at_signal: number
  created_at: string
}

interface TradeState {
  todaySignals: Signal[]
  addSignal: (s: Signal) => void
  setSignals: (signals: Signal[]) => void
}

export const useTradeStore = create<TradeState>((set) => ({
  todaySignals: [],
  addSignal: (s) => set((state) => ({ todaySignals: [s, ...state.todaySignals] })),
  setSignals: (signals) => set({ todaySignals: signals }),
}))
