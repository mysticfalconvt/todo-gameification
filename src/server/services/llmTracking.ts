// Aggregate queries over `llm_call_log` for the admin dashboard. Writes
// now live in `src/server/llm/client.ts` — every call to `callLlmChat`
// records a row with the full context (user, messages, response, usage)
// so operators can debug individual calls here.
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { llmCallLog } from '../db/schema'

export type LlmCallKind = 'score' | 'categorize' | 'coach'

export type LlmMetricsWindow = '1m' | '30m' | '1h' | '24h'

export const LLM_WINDOW_MS: Record<LlmMetricsWindow, number> = {
  '1m': 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
}

export interface LlmMetricCell {
  count: number
  successCount: number
  avgMs: number
  p95Ms: number
}

export interface LlmMetricRow {
  kind: string
  windows: Record<LlmMetricsWindow, LlmMetricCell>
}

export interface LlmMetrics {
  generatedAt: string
  // Rows include every observed kind in the last 24h, plus synthetic
  // rows for the three expected kinds so the UI can render a stable
  // shape even when one kind hasn't been called recently.
  rows: LlmMetricRow[]
  // Aggregate across all kinds.
  overall: LlmMetricRow
  // Recent failures (last 50) to help diagnose spikes.
  recentFailures: Array<{
    kind: string
    startedAt: string
    durationMs: number
    errorMessage: string | null
  }>
}

const DEFAULT_KINDS: LlmCallKind[] = ['score', 'categorize', 'coach']

export async function loadLlmMetrics(): Promise<LlmMetrics> {
  const now = new Date()
  const since24h = new Date(now.getTime() - LLM_WINDOW_MS['24h'])

  // One pull of the raw rows from the last 24h, then all windows +
  // per-kind breakdowns are computed in-process. Volume is tiny.
  const rows = await db
    .select({
      kind: llmCallLog.kind,
      startedAt: llmCallLog.startedAt,
      durationMs: llmCallLog.durationMs,
      success: llmCallLog.success,
    })
    .from(llmCallLog)
    .where(
      and(gte(llmCallLog.startedAt, since24h), isNotNull(llmCallLog.startedAt)),
    )

  const kindsSeen = new Set<string>(rows.map((r) => r.kind))
  for (const k of DEFAULT_KINDS) kindsSeen.add(k)

  const perKind: LlmMetricRow[] = Array.from(kindsSeen)
    .sort()
    .map((kind) => ({
      kind,
      windows: computeWindows(
        rows.filter((r) => r.kind === kind),
        now,
      ),
    }))

  const overall: LlmMetricRow = {
    kind: 'all',
    windows: computeWindows(rows, now),
  }

  const failures = await db
    .select({
      kind: llmCallLog.kind,
      startedAt: llmCallLog.startedAt,
      durationMs: llmCallLog.durationMs,
      errorMessage: llmCallLog.errorMessage,
    })
    .from(llmCallLog)
    .where(
      and(
        eq(llmCallLog.success, false),
        gte(llmCallLog.startedAt, since24h),
      ),
    )
    .orderBy(sql`${llmCallLog.startedAt} desc`)
    .limit(50)

  return {
    generatedAt: now.toISOString(),
    rows: perKind,
    overall,
    recentFailures: failures.map((f) => ({
      kind: f.kind,
      startedAt: f.startedAt.toISOString(),
      durationMs: f.durationMs,
      errorMessage: f.errorMessage,
    })),
  }
}

function computeWindows(
  rows: Array<{ startedAt: Date; durationMs: number; success: boolean }>,
  now: Date,
): Record<LlmMetricsWindow, LlmMetricCell> {
  const out: Record<LlmMetricsWindow, LlmMetricCell> = {
    '1m': emptyCell(),
    '30m': emptyCell(),
    '1h': emptyCell(),
    '24h': emptyCell(),
  }
  const nowMs = now.getTime()
  const bucketsByWindow: Record<LlmMetricsWindow, number[]> = {
    '1m': [],
    '30m': [],
    '1h': [],
    '24h': [],
  }
  const successByWindow: Record<LlmMetricsWindow, number> = {
    '1m': 0,
    '30m': 0,
    '1h': 0,
    '24h': 0,
  }
  for (const r of rows) {
    const age = nowMs - r.startedAt.getTime()
    for (const w of Object.keys(LLM_WINDOW_MS) as LlmMetricsWindow[]) {
      if (age <= LLM_WINDOW_MS[w]) {
        bucketsByWindow[w].push(r.durationMs)
        if (r.success) successByWindow[w] += 1
      }
    }
  }
  for (const w of Object.keys(LLM_WINDOW_MS) as LlmMetricsWindow[]) {
    const durations = bucketsByWindow[w]
    out[w] = {
      count: durations.length,
      successCount: successByWindow[w],
      avgMs:
        durations.length === 0
          ? 0
          : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p95Ms: percentile(durations, 95),
    }
  }
  return out
}

function emptyCell(): LlmMetricCell {
  return { count: 0, successCount: 0, avgMs: 0, p95Ms: 0 }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[idx]
}
