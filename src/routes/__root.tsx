/// <reference types="vite/client" />
import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
  useRouter,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClientProvider } from '@tanstack/react-query'
import { persistQueryClient } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { useEffect, type ReactNode } from 'react'

import { signOut, useSession } from '../lib/auth-client'
import { QUERY_PERSIST_KEY, getQueryClient } from '../lib/query'
import { updateTimezone } from '../server/functions/user'
import { ThemeToggle } from '../components/ThemeToggle'
import appCss from '../styles.css?url'

const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('todo-xp-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#4fb8b2' },
      { title: 'Todo Gameification' },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap',
      },
      { rel: 'stylesheet', href: appCss },
      { rel: 'manifest', href: '/manifest.json' },
      { rel: 'icon', href: '/favicon.ico' },
      { rel: 'apple-touch-icon', href: '/logo192.png' },
    ],
  }),
  shellComponent: RootShell,
})

function RootShell({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient()

  useEffect(() => {
    const persister = createSyncStoragePersister({
      storage: window.localStorage,
      key: QUERY_PERSIST_KEY,
    })
    const [unsubscribe] = persistQueryClient({
      queryClient,
      persister,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    })
    return unsubscribe
  }, [queryClient])

  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <div id="app">
            <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 backdrop-blur-lg">
              <nav className="page-wrap flex items-center gap-4 py-3 text-sm font-semibold">
                <Link to="/today" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                  Today
                </Link>
                <Link to="/tasks" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                  Tasks
                </Link>
                <div className="ml-auto flex items-center gap-3">
                  <ThemeToggle />
                  <SessionNav />
                </div>
              </nav>
            </header>
            {children}
          </div>
          <TanStackDevtools
            config={{ position: 'bottom-right' }}
            plugins={[
              { name: 'TanStack Router', render: <TanStackRouterDevtoolsPanel /> },
            ]}
          />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}

function SessionNav() {
  const { data, isPending } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (!data?.user) return
    const browserTz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const storedTz = (data.user as { timezone?: string }).timezone
    if (storedTz && storedTz === browserTz) return
    updateTimezone({ data: { timezone: browserTz } }).catch(() => {
      // Non-critical; user can retry or set in settings later.
    })
  }, [data?.user?.id])

  if (isPending) {
    return <span className="text-[var(--sea-ink-soft)]">…</span>
  }

  if (!data) {
    return (
      <Link to="/auth/login" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
        Log in
      </Link>
    )
  }

  async function onSignOut() {
    await signOut()
    await router.invalidate()
    router.navigate({ to: '/auth/login' })
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-[var(--sea-ink-soft)]">{data.user.name}</span>
      <button type="button" onClick={onSignOut} className="nav-link">
        Sign out
      </button>
    </div>
  )
}
