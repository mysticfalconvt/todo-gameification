// Gates 7d / 30d / 90d window toggles on how long the user has actually
// had event history. A 30d chart with 3 days of data is just noise — wait
// until there's enough real data to render something meaningful. "All"
// and 7d always show; 30d / 90d unlock once history reaches that length.
import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDataAvailability } from '../server/functions/user'

export function useAvailableWindows(): {
  isLoading: boolean
  daysOfHistory: number
  allows: (days: number | 'all') => boolean
} {
  const query = useQuery({
    queryKey: ['data-availability'],
    queryFn: () => getDataAvailability(),
    // Cheap, but changes rarely — refresh occasionally to unlock new
    // windows once the user crosses a threshold.
    staleTime: 5 * 60_000,
  })
  const daysOfHistory = query.data?.daysOfHistory ?? 0
  // While we don't know yet, show everything — better than briefly hiding
  // options for a returning user on a slow network.
  const unknown = query.isLoading || !query.data

  // Stable across renders so callers can safely memoize on it (and depend on
  // it from an effect). Returning a fresh closure each render made every
  // derived array a new identity, which is why callers were reduced to
  // hand-rolled `deps: [ranges.join(',')]` keys to avoid re-running.
  const allows = useCallback(
    (days: number | 'all') => {
      // 7d and All always show. 7d is the sensible default even for a
      // brand-new account — an empty 7-day chart is fine. Longer windows
      // unlock only once there's meaningful history to fill them.
      if (days === 'all' || days === 7) return true
      if (unknown) return true
      return daysOfHistory >= days
    },
    [unknown, daysOfHistory],
  )

  return { isLoading: query.isLoading, daysOfHistory, allows }
}
