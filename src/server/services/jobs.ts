// Read-only pg-boss monitoring for the admin view. Pulls per-queue
// counts from the boss API and recent failures directly from the
// pgboss schema — v12's public API doesn't expose failure details.
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { getBoss } from '../boss'

export interface JobQueueRow {
  name: string
  queuedCount: number
  activeCount: number
  deferredCount: number
  totalCount: number
  failedLast24h: number
  completedLast24h: number
  lastFailureAt: string | null
  lastFailureMessage: string | null
}

export interface JobFailureRow {
  name: string
  startedOn: string | null
  completedOn: string | null
  retryCount: number
  errorMessage: string
}

export interface JobStats {
  generatedAt: string
  queues: JobQueueRow[]
  recentFailures: JobFailureRow[]
}

export async function loadJobStats(): Promise<JobStats> {
  const boss = await getBoss()
  const queues = await boss.getQueues()

  // pgboss stores everything in the `pgboss` schema. Counts are cheap —
  // `state` is indexed. Last-24h aggregates use `completed_on`.
  const statRows = await db.execute<{
    name: string
    failed_24h: string
    completed_24h: string
    last_failure_at: Date | null
    last_failure_message: string | null
  }>(sql`
    with recent as (
      select
        name,
        state,
        completed_on,
        output
      from pgboss.job
      where completed_on > now() - interval '24 hours'
    ),
    agg as (
      select
        name,
        count(*) filter (where state = 'failed') as failed_24h,
        count(*) filter (where state = 'completed') as completed_24h
      from recent
      group by name
    ),
    last_fail as (
      select distinct on (name)
        name,
        completed_on as last_failure_at,
        coalesce(output->>'message', output::text) as last_failure_message
      from pgboss.job
      where state = 'failed'
      order by name, completed_on desc
    )
    select
      coalesce(agg.name, last_fail.name) as name,
      coalesce(agg.failed_24h, 0) as failed_24h,
      coalesce(agg.completed_24h, 0) as completed_24h,
      last_fail.last_failure_at,
      last_fail.last_failure_message
    from agg
    full outer join last_fail using (name)
  `)

  type StatRow = {
    name: string
    failed_24h: string | number
    completed_24h: string | number
    last_failure_at: Date | string | null
    last_failure_message: string | null
  }
  const rawRows = Array.isArray(statRows)
    ? (statRows as unknown as StatRow[])
    : (((statRows as unknown as { rows?: StatRow[] }).rows ??
        []) as StatRow[])
  const statByName = new Map<string, StatRow>(
    rawRows.map((r) => [r.name, r]),
  )

  const rows: JobQueueRow[] = queues.map((q) => {
    const s = statByName.get(q.name)
    return {
      name: q.name,
      queuedCount: q.queuedCount ?? 0,
      activeCount: q.activeCount ?? 0,
      deferredCount: q.deferredCount ?? 0,
      totalCount: q.totalCount ?? 0,
      failedLast24h: s ? Number(s.failed_24h) : 0,
      completedLast24h: s ? Number(s.completed_24h) : 0,
      lastFailureAt: s?.last_failure_at
        ? new Date(s.last_failure_at).toISOString()
        : null,
      lastFailureMessage: s?.last_failure_message ?? null,
    }
  })

  const failureRows = await db.execute<{
    name: string
    started_on: Date | null
    completed_on: Date | null
    retry_count: number
    output: unknown
  }>(sql`
    select name, started_on, completed_on, retry_count, output
    from pgboss.job
    where state = 'failed'
    order by completed_on desc nulls last
    limit 20
  `)
  type FailRow = {
    name: string
    started_on: Date | string | null
    completed_on: Date | string | null
    retry_count: number
    output: unknown
  }
  const failureArr = Array.isArray(failureRows)
    ? (failureRows as unknown as FailRow[])
    : (((failureRows as unknown as { rows?: FailRow[] }).rows ??
        []) as FailRow[])
  const recentFailures: JobFailureRow[] = failureArr.map((f) => ({
    name: f.name,
    startedOn: f.started_on ? new Date(f.started_on).toISOString() : null,
    completedOn: f.completed_on
      ? new Date(f.completed_on).toISOString()
      : null,
    retryCount: Number(f.retry_count ?? 0),
    errorMessage: extractError(f.output),
  }))

  return {
    generatedAt: new Date().toISOString(),
    queues: rows.sort((a, b) => a.name.localeCompare(b.name)),
    recentFailures,
  }
}

function extractError(output: unknown): string {
  if (!output) return ''
  if (typeof output === 'string') return output.slice(0, 400)
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>
    const msg =
      typeof o['message'] === 'string'
        ? o['message']
        : JSON.stringify(o).slice(0, 400)
    return String(msg).slice(0, 400)
  }
  return String(output).slice(0, 400)
}
