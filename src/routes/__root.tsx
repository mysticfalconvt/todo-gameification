/// <reference types="vite/client" />
import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClientProvider } from '@tanstack/react-query'
import { persistQueryClient } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { useEffect, type ReactNode } from 'react'
import { Toaster } from 'sonner'

import { useSession } from '../lib/auth-client'
import { QUERY_PERSIST_KEY, getQueryClient } from '../lib/query'
import { registerServiceWorker } from '../lib/sw-register'
import { updateTimezone } from '../server/functions/user'
import { InstallPrompt } from '../components/InstallPrompt'
import { OfflineIndicator } from '../components/OfflineIndicator'
import '../styles.css'

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
      { rel: 'manifest', href: '/manifest.json?v=2' },
      { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg?v=2' },
      { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico?v=2' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png?v=2' },
    ],
  }),
  shellComponent: RootShell,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <main className="page-wrap px-4 py-16 text-center">
      <p className="island-kicker mb-2">404</p>
      <h1 className="display-title mb-4 text-4xl font-bold text-[var(--sea-ink)]">
        Page not found
      </h1>
      <p className="mb-6 text-[var(--sea-ink-soft)]">
        The URL didn't match anything we have.
      </p>
      <Link
        to="/today"
        className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
      >
        Back to Today
      </Link>
    </main>
  )
}

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

  useEffect(() => {
    registerServiceWorker()
  }, [])

  return (
    <html lang="en" suppressHydrationWarning>
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
                <Link to="/history" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                  History
                </Link>
                <Link to="/stats" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                  Stats
                </Link>
                <div className="ml-auto flex items-center gap-3">
                  <OfflineIndicator />
                  <SessionNav />
                </div>
              </nav>
            </header>
            <InstallPrompt />
            {children}
          </div>
          <Toaster position="bottom-right" richColors closeButton />
          {import.meta.env.DEV ? (
            <TanStackDevtools
              config={{ position: 'bottom-right' }}
              plugins={[
                { name: 'TanStack Router', render: <TanStackRouterDevtoolsPanel /> },
              ]}
            />
          ) : null}
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}

function SessionNav() {
  const { data, isPending } = useSession()

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

  return (
    <Link
      to="/settings"
      className="nav-link"
      activeProps={{ className: 'nav-link is-active' }}
    >
      {data.user.name}
    </Link>
  )
}
