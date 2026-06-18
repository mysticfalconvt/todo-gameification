import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { getEffectiveMemberStatus } from '../services/membership'
import {
  generateHouseholdAnalysis,
  generateWeeklyAnalysis,
  getWeeklySummary,
  type WeeklySummary,
} from '../services/weeklySummary'

type Blurb = { analysis: string; generatedAt: string } | null

export type WeeklySummaryResponse =
  | { gated: true }
  | {
      gated: false
      summary: WeeklySummary
      analysis: Blurb
      householdAnalysis: Blurb
    }

// Members-only. Free users get { gated: true } and the page shows an
// upsell. Both blurbs are read-through cached for the week; the household
// one is null for users with no household.
export const getWeeklySummaryFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<WeeklySummaryResponse> => {
    const member = await getEffectiveMemberStatus(context.userId)
    if (!member.isMember) return { gated: true }
    const summary = await getWeeklySummary(context.userId)
    const [analysis, householdAnalysis] = await Promise.all([
      generateWeeklyAnalysis(context.userId, summary),
      generateHouseholdAnalysis(context.userId, summary),
    ])
    return { gated: false, summary, analysis, householdAnalysis }
  })

// Force a fresh personal LLM analysis for the current week (the
// "Regenerate now" button). Returns null when the LLM isn't configured.
export const regenerateWeeklyAnalysisFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Blurb> => {
    const member = await getEffectiveMemberStatus(context.userId)
    if (!member.isMember) throw new Error('Members only.')
    const summary = await getWeeklySummary(context.userId)
    return generateWeeklyAnalysis(context.userId, summary, { force: true })
  })

// Force a fresh household recap for the current week. Returns null when
// there's no household or the LLM isn't configured.
export const regenerateHouseholdAnalysisFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Blurb> => {
    const member = await getEffectiveMemberStatus(context.userId)
    if (!member.isMember) throw new Error('Members only.')
    const summary = await getWeeklySummary(context.userId)
    return generateHouseholdAnalysis(context.userId, summary, { force: true })
  })
