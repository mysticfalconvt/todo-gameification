import { QueryClient } from '@tanstack/react-query'

export const QUERY_PERSIST_KEY = 'todo-xp-query-cache-v1'

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 1000 * 60 * 60 * 24,
      },
    },
  })
}

let browserClient: QueryClient | undefined

export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient()
  if (!browserClient) browserClient = makeQueryClient()
  return browserClient
}
