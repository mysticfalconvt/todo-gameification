import { useCallback, useEffect, useRef, useState } from 'react'

export type FocusStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled'

export interface FocusSessionState {
  status: FocusStatus
  plannedMs: number
  accumulatedMs: number
  remainingMs: number
  wasInterrupted: boolean
}

interface WakeLockSentinelLike {
  release: () => Promise<void>
}

const TICK_MS = 200

export function useFocusSession(
  plannedMs: number,
  onComplete: () => void,
) {
  const [status, setStatus] = useState<FocusStatus>('idle')
  const [accumulatedMs, setAccumulatedMs] = useState(0)
  const [wasInterrupted, setWasInterrupted] = useState(false)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastTickRef = useRef<number | null>(null)
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const completedRef = useRef(false)

  const requestWakeLock = useCallback(async () => {
    try {
      const wl = (navigator as unknown as {
        wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
      }).wakeLock
      if (!wl) return
      wakeLockRef.current = await wl.request('screen')
    } catch {
      // Wake lock may be denied (no user gesture, page hidden, unsupported).
      // Ignore — it's a nice-to-have.
    }
  }, [])

  const releaseWakeLock = useCallback(async () => {
    const wl = wakeLockRef.current
    wakeLockRef.current = null
    if (wl) {
      try {
        await wl.release()
      } catch {
        // ignore
      }
    }
  }, [])

  const stopInterval = useCallback(() => {
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    lastTickRef.current = null
  }, [])

  const pause = useCallback(() => {
    setStatus((s) => {
      if (s !== 'running') return s
      setWasInterrupted(true)
      stopInterval()
      void releaseWakeLock()
      return 'paused'
    })
  }, [releaseWakeLock, stopInterval])

  const start = useCallback(() => {
    if (completedRef.current) return
    setStatus('running')
    lastTickRef.current = Date.now()
    void requestWakeLock()
    intervalRef.current = setInterval(() => {
      const now = Date.now()
      const last = lastTickRef.current ?? now
      const delta = now - last
      lastTickRef.current = now
      setAccumulatedMs((prev) => prev + delta)
    }, TICK_MS)
  }, [requestWakeLock])

  const resume = useCallback(() => {
    setStatus((s) => {
      if (s !== 'paused') return s
      lastTickRef.current = Date.now()
      void requestWakeLock()
      intervalRef.current = setInterval(() => {
        const now = Date.now()
        const last = lastTickRef.current ?? now
        const delta = now - last
        lastTickRef.current = now
        setAccumulatedMs((prev) => prev + delta)
      }, TICK_MS)
      return 'running'
    })
  }, [requestWakeLock])

  const cancel = useCallback(() => {
    stopInterval()
    void releaseWakeLock()
    setStatus('cancelled')
  }, [releaseWakeLock, stopInterval])

  // Visibility / focus listeners — pause on hide, resume on show.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) pause()
      else if (status === 'paused') resume()
    }
    const onWindowBlur = () => pause()
    const onWindowFocus = () => {
      if (status === 'paused' && !document.hidden) resume()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [pause, resume, status])

  // Completion check.
  useEffect(() => {
    if (status === 'running' && accumulatedMs >= plannedMs && !completedRef.current) {
      completedRef.current = true
      stopInterval()
      void releaseWakeLock()
      setStatus('done')
      onComplete()
    }
  }, [accumulatedMs, plannedMs, status, stopInterval, releaseWakeLock, onComplete])

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      stopInterval()
      void releaseWakeLock()
    }
  }, [stopInterval, releaseWakeLock])

  return {
    status,
    plannedMs,
    accumulatedMs,
    remainingMs: Math.max(0, plannedMs - accumulatedMs),
    wasInterrupted,
    start,
    pause,
    resume,
    cancel,
  }
}
