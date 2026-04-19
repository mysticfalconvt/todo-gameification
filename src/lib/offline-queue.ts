// Simple offline mutation queue.
//
// When the browser is offline, instance-level actions (complete / skip /
// snooze) are stashed in IndexedDB and the UI updates optimistically. When
// `online` fires, the queue drains FIFO against the real server functions.
//
// Scope: safe, idempotent-ish instance mutations only. Create / update /
// delete on tasks themselves stay online-only for now because getting their
// failure modes wrong (orphan instances, stale ids) is worse than just
// requiring a connection for those actions.
import { get as idbGet, set as idbSet } from 'idb-keyval'
import {
  completeInstance,
  skipInstance,
  snoozeInstance,
} from '../server/functions/tasks'

const QUEUE_KEY = 'todo-xp-offline-queue-v1'

export type QueueInput =
  | { type: 'complete'; instanceId: string }
  | { type: 'skip'; instanceId: string }
  | { type: 'snooze'; instanceId: string; hours: number }

export type QueuedOp = QueueInput & { id: string; queuedAt: number }

async function readQueue(): Promise<QueuedOp[]> {
  const raw = await idbGet(QUEUE_KEY)
  return Array.isArray(raw) ? (raw as QueuedOp[]) : []
}

async function writeQueue(ops: QueuedOp[]): Promise<void> {
  await idbSet(QUEUE_KEY, ops)
}

const listeners = new Set<(len: number) => void>()

async function notifyChange(): Promise<void> {
  const len = (await readQueue()).length
  for (const l of listeners) l(len)
}

export function onQueueChange(listener: (len: number) => void): () => void {
  listeners.add(listener)
  // Fire once with current length so subscribers render correct initial UI.
  readQueue()
    .then((q) => listener(q.length))
    .catch(() => {})
  return () => {
    listeners.delete(listener)
  }
}

export async function queuedLength(): Promise<number> {
  return (await readQueue()).length
}

function makeId(): string {
  // A plain sortable ID is enough; we don't need crypto-strength uniqueness.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}

async function enqueue(op: QueueInput): Promise<void> {
  const queue = await readQueue()
  queue.push({ ...op, id: makeId(), queuedAt: Date.now() })
  await writeQueue(queue)
  await notifyChange()
}

async function runOp(op: QueuedOp): Promise<void> {
  switch (op.type) {
    case 'complete':
      await completeInstance({ data: { instanceId: op.instanceId } })
      return
    case 'skip':
      await skipInstance({ data: { instanceId: op.instanceId } })
      return
    case 'snooze':
      await snoozeInstance({
        data: { instanceId: op.instanceId, hours: op.hours },
      })
      return
  }
}

/** True iff the error looks like a network failure (vs a real server error). */
function isNetworkError(err: unknown): boolean {
  if (!isOnline()) return true
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) {
    return true
  }
  return false
}

/**
 * Execute an operation now if we're online; otherwise queue it.
 * Callers should assume the op will eventually run and apply optimistic UI.
 * Rejections only fire for server-side failures (validation / not-found),
 * not for offline-ness.
 */
export async function runOrQueue(op: QueueInput): Promise<void> {
  if (!isOnline()) {
    await enqueue(op)
    return
  }
  try {
    await runOp({ ...op, id: 'inline', queuedAt: Date.now() })
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueue(op)
      return
    }
    throw err
  }
}

/**
 * Drain the queue in FIFO order. Ops that fail with a non-network error are
 * dropped (the resource likely changed shape server-side — e.g. the instance
 * was deleted); their errors are collected and reported back to the caller.
 */
export async function drainQueue(): Promise<{
  succeeded: number
  dropped: Array<{ op: QueuedOp; error: string }>
}> {
  let queue = await readQueue()
  const dropped: Array<{ op: QueuedOp; error: string }> = []
  let succeeded = 0
  while (queue.length > 0) {
    if (!isOnline()) break
    const [head, ...rest] = queue
    try {
      await runOp(head)
      succeeded += 1
      queue = rest
      await writeQueue(queue)
      await notifyChange()
    } catch (err) {
      if (isNetworkError(err)) {
        break
      }
      dropped.push({
        op: head,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      queue = rest
      await writeQueue(queue)
      await notifyChange()
    }
  }
  return { succeeded, dropped }
}
