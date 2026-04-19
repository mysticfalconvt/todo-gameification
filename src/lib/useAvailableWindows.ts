// Gates 7d / 30d / 90d window toggles on how long the user has actually
// had event history. A 30d chart with 3 days of data is just noise — wait
// until there's enough real data to render something meaningful. "All"
// and 7d always show; 30d / 90d unlock once history reaches that length.
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
  return {
    isLoading: query.isLoading,
    daysOfHistory,
    allows: (days) => {
      // 7d and All always show. 7d is the sensible default even for a
      // brand-new account — an empty 7-day chart is fine. Longer windows
      // unlock only once there's meaningful history to fill them.
      if (days === 'all' || days === 7) return true
      // While we don't know yet, show everything — better than briefly
      // hiding options for a returning user on a slow network.
      if (query.isLoading || !query.data) return true
      return daysOfHistory >= days
    },
  }
}
