import { useEffect, useState } from 'react'
import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getCurrentSession } from '../server/session'
import { getMyHouseholdFn } from '../server/functions/households'

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
  // KioskRedirect must live INSIDE the mount gate. It does a
  // useQuery for the household role; firing that during SSR pipes a
  // request-less call into the server-functions handler and crashes
  // with "Cannot read properties of undefined (reading 'method')".
  if (!mounted) return null
  return (
    <>
      <KioskRedirect />
      <Outlet />
    </>
  )
}

// Kiosk accounts have no personal task list, no Today, no Settings —
// the whole app collapses to /household. This hook fires once the
// household role lands and pushes the kiosk back to /household from
// anywhere else.
function KioskRedirect() {
  const navigate = useNavigate()
  const location = useLocation()
  const query = useQuery({
    queryKey: ['my-household'],
    queryFn: () => getMyHouseholdFn(),
  })
  const role = query.data?.role
  useEffect(() => {
    if (role !== 'kiosk') return
    // Allow /household and its sub-routes (per-member stats, etc.);
    // also allow /settings so kiosks can reach the lockout view's
    // sign-out button. Bounce everywhere else. /auth/* is outside the
    // authenticated tree so we don't see it here.
    if (location.pathname.startsWith('/household')) return
    if (location.pathname.startsWith('/settings')) return
    navigate({ to: '/household', replace: true })
  }, [role, location.pathname, navigate])
  return null
}
