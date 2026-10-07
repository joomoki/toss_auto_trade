import { create } from 'zustand'

interface WsState {
  status: 'disconnected' | 'connecting' | 'connected'
  lastMessage: Record<string, unknown> | null
  connect: () => void
  disconnect: () => void
}

let ws: WebSocket | null = null

export const useWsStore = create<WsState>((set) => ({
  status: 'disconnected',
  lastMessage: null,

  connect: () => {
    if (ws && ws.readyState === WebSocket.OPEN) return
    set({ status: 'connecting' })
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => set({ status: 'connected' })
    ws.onclose = () => {
      set({ status: 'disconnected' })
      setTimeout(() => useWsStore.getState().connect(), 3000)
    }
    ws.onerror = () => set({ status: 'disconnected' })
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        set({ lastMessage: msg })
      } catch {}
    }

    const keepAlive = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send('ping')
      else clearInterval(keepAlive)
    }, 30000)
  },

  disconnect: () => {
    ws?.close()
    ws = null
    set({ status: 'disconnected' })
  },
}))
