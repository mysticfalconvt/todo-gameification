import { useEffect, useState } from 'react'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { getCurrentSession } from '../server/session'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async () => {
    const session = await getCurrentSession()
    if (!session) {
      throw redirect({ to: '/auth/login' })
    }
    return { session }
  },
  component: AuthenticatedShell,
})

// Authenticated pages read from a client-persisted React Query cache
// (localStorage + in-memory singleton) that the server can't see. Rather
// than whack-a-mole every component's SSR/CSR drift, gate the subtree on a
// client mount flag so the first render matches between server and client
// (both render nothing) and the app takes over after hydration.
function AuthenticatedShell() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <Outlet />
}
