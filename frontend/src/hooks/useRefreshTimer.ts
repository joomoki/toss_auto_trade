import { useCallback, useEffect, useRef, useState } from 'react'

export interface RefreshTimerState {
  secondsLeft: number
  lastRefreshed: Date
  isRefreshing: boolean
  refresh: () => Promise<void>
}

/**
 * 현재 유닉스 시각 기준으로 다음 경계까지 남은 초를 반환.
 * 예) 1800 간격이면 :00/:30 경계 기준, 60 간격이면 매 분 :00 기준.
 */
function secUntilNext(intervalSec: number): number {
  const nowSec = Math.floor(Date.now() / 1000)
  const rem = intervalSec - (nowSec % intervalSec)
  return rem === 0 ? intervalSec : rem
}

/**
 * intervalSec > 0 → 벽시계 정렬 카운트다운 + 자동 갱신
 *   - 다른 탭 갔다 돌아와도 실제 경과 시간에 맞게 복원됨
 *   - 30분 간격 → 1:00, 1:30, 2:00 ... 기준으로 리셋
 * intervalSec = 0 → 수동 갱신 전용 (카운트다운 없음)
 */
export function useRefreshTimer(
  intervalSec: number,
  loadFn: () => Promise<void>,
): RefreshTimerState {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    intervalSec > 0 ? secUntilNext(intervalSec) : 0
  )
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date())
  const [isRefreshing, setIsRefreshing] = useState(false)

  // stale-closure 방지: 항상 최신 loadFn 참조
  const loadRef = useRef(loadFn)
  loadRef.current = loadFn

  // 수동 갱신 버튼용
  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await loadRef.current()
      setLastRefreshed(new Date())
    } finally {
      setIsRefreshing(false)
      if (intervalSec > 0) setSecondsLeft(secUntilNext(intervalSec))
    }
  }, [intervalSec])

  useEffect(() => {
    if (intervalSec <= 0) return

    // 탭 진입(마운트) 시 벽시계 기준으로 남은 시간 초기화
    setSecondsLeft(secUntilNext(intervalSec))

    const id = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          // 자동 갱신 트리거 (비동기)
          setIsRefreshing(true)
          loadRef.current()
            .then(() => setLastRefreshed(new Date()))
            .finally(() => {
              setIsRefreshing(false)
              // 갱신 완료 후 다음 경계까지 재동기
              setSecondsLeft(secUntilNext(intervalSec))
            })
          // 갱신 중에도 다음 경계부터 카운트다운 즉시 재개
          return secUntilNext(intervalSec)
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(id)
  }, [intervalSec])

  return { secondsLeft, lastRefreshed, isRefreshing, refresh }
}
