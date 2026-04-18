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
  component: () => <Outlet />,
})
