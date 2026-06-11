import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { getMemberStatus } from '../services/membership'
import {
  generateWeeklyAnalysis,
  getWeeklySummary,
  type WeeklySummary,
} from '../services/weeklySummary'

export type WeeklySummaryResponse =
  | { gated: true }
  | {
      gated: false
      summary: WeeklySummary
      analysis: { analysis: string; generatedAt: string } | null
    }

// Members-only. Free users get { gated: true } and the page shows an
// upsell. The analysis is read-through cached for the week.
export const getWeeklySummaryFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<WeeklySummaryResponse> => {
    const member = await getMemberStatus(context.userId)
    if (!member.isMember) return { gated: true }
    const summary = await getWeeklySummary(context.userId)
    const analysis = await generateWeeklyAnalysis(context.userId, summary)
    return { gated: false, summary, analysis }
  })

// Force a fresh LLM analysis for the current week (the "Regenerate now"
// button). Returns null when the LLM isn't configured / produced nothing.
export const regenerateWeeklyAnalysisFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(
    async ({
      context,
    }): Promise<{ analysis: string; generatedAt: string } | null> => {
      const member = await getMemberStatus(context.userId)
      if (!member.isMember) throw new Error('Members only.')
      const summary = await getWeeklySummary(context.userId)
      return generateWeeklyAnalysis(context.userId, summary, { force: true })
    },
  )
