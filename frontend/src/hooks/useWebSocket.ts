import { useEffect } from 'react'
import { useWsStore } from '../store/wsStore'

export function useWebSocketMessage(
  type: string,
  handler: (data: unknown) => void,
) {
  const lastMessage = useWsStore((s) => s.lastMessage)

  useEffect(() => {
    if (lastMessage && lastMessage.type === type) {
      handler(lastMessage.data)
    }
  }, [lastMessage])
}
