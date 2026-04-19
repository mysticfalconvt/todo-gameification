import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import {
  getLeaderboard,
  type LeaderboardMetric,
  type LeaderboardScope,
  type LeaderboardWindow,
} from '../services/leaderboard'

const SCOPES: LeaderboardScope[] = ['friends', 'global']
const METRICS: LeaderboardMetric[] = ['xp', 'streak', 'showed-up']
const WINDOWS: LeaderboardWindow[] = [7, 30, 90, 'all']

export const getLeaderboardFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      scope: string
      metric: string
      days: number | string
    }) => {
      if (!SCOPES.includes(data.scope as LeaderboardScope)) {
        throw new Error('invalid scope')
      }
      if (!METRICS.includes(data.metric as LeaderboardMetric)) {
        throw new Error('invalid metric')
      }
      const days: LeaderboardWindow =
        data.days === 'all'
          ? 'all'
          : (Number(data.days) as 7 | 30 | 90)
      if (!WINDOWS.includes(days)) {
        throw new Error('invalid window')
      }
      return {
        scope: data.scope as LeaderboardScope,
        metric: data.metric as LeaderboardMetric,
        days,
      }
    },
  )
  .handler(async ({ data, context }) =>
    getLeaderboard(context.userId, data),
  )
