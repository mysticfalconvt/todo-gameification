import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  drainQueue,
  isOnline,
  onQueueChange,
} from '../lib/offline-queue'

/**
 * Small pill near the nav showing offline state + queued mutation count.
 * Also owns the global `online` event listener that drains the queue.
 */
export function OfflineIndicator() {
  const qc = useQueryClient()
  const [online, setOnline] = useState<boolean>(() => isOnline())
  const [queued, setQueued] = useState(0)

  useEffect(() => {
    function onOnline() {
      setOnline(true)
      drain()
    }
    function onOffline() {
      setOnline(false)
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    const unsubscribe = onQueueChange(setQueued)

    async function drain() {
      const result = await drainQueue()
      if (result.succeeded > 0) {
        toast.success(
          `Synced ${result.succeeded} pending ${result.succeeded === 1 ? 'action' : 'actions'}.`,
        )
        qc.invalidateQueries({ queryKey: ['today'] })
        qc.invalidateQueries({ queryKey: ['someday'] })
        qc.invalidateQueries({ queryKey: ['progression'] })
        qc.invalidateQueries({ queryKey: ['recent-activity'] })
      }
      for (const failed of result.dropped) {
        toast.error(
          `Couldn't sync a ${failed.op.type}: ${failed.error}`,
        )
      }
    }

    // If we loaded while online and there's a pre-existing queue (e.g. from a
    // previous session that closed offline), try to drain once.
    if (isOnline()) drain()

    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      unsubscribe()
    }
  }, [qc])

  if (online && queued === 0) return null
  if (!online) {
    return (
      <span className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--sea-ink-soft)]">
        Offline{queued > 0 ? ` · ${queued} queued` : ''}
      </span>
    )
  }
  return (
    <span className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--sea-ink-soft)]">
      Syncing · {queued}
    </span>
  )
}
