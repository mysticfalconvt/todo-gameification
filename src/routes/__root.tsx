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

import { useQuery } from '@tanstack/react-query'
import { useSession } from '../lib/auth-client'
import { QUERY_PERSIST_KEY, getQueryClient } from '../lib/query'
import { registerServiceWorker } from '../lib/sw-register'
import { updateTimezone } from '../server/functions/user'
import { listIncomingFn } from '../server/functions/social'
import { getIsAdminFn } from '../server/functions/admin'
import { InstallPrompt } from '../components/InstallPrompt'
import { OfflineIndicator } from '../components/OfflineIndicator'
import '../styles.css'

const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('todo-xp-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`

// Umami analytics: inject the tracking script only when both env vars are
// set. head() runs server-side for SSR, so `process.env` is available and
// the resulting <script> tag is serialized into the initial HTML. Leaving
// either env var blank fully opts out — no script, no extra request.
function umamiScriptTag():
  | { src: string; defer: true; 'data-website-id': string }
  | null {
  const src = process.env.UMAMI_SCRIPT_URL?.trim()
  const id = process.env.UMAMI_WEBSITE_ID?.trim()
  if (!src || !id) return null
  return { src, defer: true, 'data-website-id': id }
}

export const Route = createRootRoute({
  head: () => {
    const umami = umamiScriptTag()
    return {
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
      scripts: umami ? [umami] : undefined,
    }
  },
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
          <div id="app" className="pb-20 md:pb-0">
            <AppNav />
            <InstallPrompt />
            {children}
            <MobileTabBar />
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

// Split navs by session state. Logged-out users get a minimal marketing
// nav (brand + log in / sign up); logged-in users get the full app nav.
// While Better Auth's session is pending we show the marketing variant
// so a refresh on a public page doesn't flash the full app nav to
// strangers. Admin + friends links are always gated on a resolved
// session so cached query data can't leak them past sign-out.
function AppNav() {
  const { data: session, isPending } = useSession()
  const loggedIn = Boolean(session?.user)

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 backdrop-blur-lg">
      <nav className="page-wrap flex items-center gap-4 py-3 text-sm font-semibold">
        {loggedIn ? (
          <>
            {/* Logged-in mobile: brand on top bar, primary links live in
                the bottom tab bar below. On md+ screens we still show
                the full row inline so desktop users don't lose one-hop
                navigation. */}
            <Link
              to="/today"
              className="text-[var(--sea-ink)] no-underline md:hidden"
            >
              Todo&nbsp;XP
            </Link>
            <div className="hidden items-center gap-4 md:flex">
              <Link to="/today" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                Today
              </Link>
              <Link to="/tasks" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                Tasks
              </Link>
              <Link to="/stats" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                Stats
              </Link>
              <Link to="/garden" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
                Garden
              </Link>
              <FriendsNavLink />
              <AdminNavLink />
            </div>
          </>
        ) : (
          <Link to="/" className="text-[var(--sea-ink)] no-underline">
            Todo&nbsp;XP
          </Link>
        )}
        <div className="ml-auto flex items-center gap-3">
          {loggedIn ? <OfflineIndicator /> : null}
          {isPending ? null : loggedIn ? <SessionNav /> : <GuestNav />}
        </div>
      </nav>
    </header>
  )
}

function GuestNav() {
  return (
    <div className="flex items-center gap-2">
      <Link
        to="/auth/login"
        className="nav-link"
        activeProps={{ className: 'nav-link is-active' }}
      >
        Log in
      </Link>
      <Link
        to="/auth/signup"
        className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 text-xs font-semibold text-[var(--lagoon-deep)] no-underline"
      >
        Sign up
      </Link>
    </div>
  )
}

function FriendsNavLink() {
  const pending = useQuery({
    queryKey: ['friends', 'incoming'],
    queryFn: () => listIncomingFn(),
    // Re-fetch occasionally so the badge catches requests that arrived on
    // another device while this tab was idle.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  })
  const count = pending.data?.length ?? 0
  return (
    <Link
      to="/friends"
      className="nav-link relative"
      activeProps={{ className: 'nav-link is-active relative' }}
    >
      <span>Friends</span>
      {count > 0 ? (
        <span
          aria-label={`${count} pending friend ${count === 1 ? 'request' : 'requests'}`}
          className="ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--btn-primary-bg)] px-1 text-[10px] font-bold leading-none text-[var(--btn-primary-fg)]"
        >
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </Link>
  )
}

function AdminNavLink() {
  const admin = useQuery({
    queryKey: ['is-admin'],
    queryFn: () => getIsAdminFn(),
    staleTime: 5 * 60_000,
  })
  if (!admin.data?.isAdmin) return null
  return (
    <Link
      to="/admin"
      className="nav-link"
      activeProps={{ className: 'nav-link is-active' }}
    >
      Admin
    </Link>
  )
}

// Phone-first bottom tab bar. Visible only on < md viewports so
// desktop users keep their existing single-row top nav. Hidden
// entirely when logged out; the marketing pages don't need it.
function MobileTabBar() {
  const { data: session, isPending } = useSession()
  const loggedIn = Boolean(session?.user)
  const admin = useQuery({
    queryKey: ['is-admin'],
    queryFn: () => getIsAdminFn(),
    enabled: loggedIn,
    staleTime: 5 * 60_000,
  })
  const pending = useQuery({
    queryKey: ['friends', 'incoming'],
    queryFn: () => listIncomingFn(),
    enabled: loggedIn,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  if (isPending || !loggedIn) return null
  const friendCount = pending.data?.length ?? 0
  const isAdmin = admin.data?.isAdmin === true

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--line)] bg-[var(--header-bg)] backdrop-blur-lg md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Primary"
    >
      <div className="flex items-stretch">
        <TabLink to="/today" icon="☀️" label="Today" />
        <TabLink to="/tasks" icon="✅" label="Tasks" />
        <TabLink to="/garden" icon="🪴" label="Garden" />
        <TabLink to="/stats" icon="📊" label="Stats" />
        <TabLink to="/friends" icon="👥" label="Friends" badge={friendCount} />
        {isAdmin ? <TabLink to="/admin" icon="🛠" label="Admin" /> : null}
      </div>
    </nav>
  )
}

function TabLink({
  to,
  icon,
  label,
  badge,
}: {
  to: string
  icon: string
  label: string
  badge?: number
}) {
  return (
    <Link
      to={to}
      className="relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold text-[var(--sea-ink-soft)] no-underline"
      activeProps={{
        className:
          'relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold text-[var(--lagoon-deep)] no-underline',
      }}
    >
      <span className="text-xl leading-none" aria-hidden>
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {badge && badge > 0 ? (
        <span
          aria-label={`${badge} pending`}
          className="absolute right-3 top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--btn-primary-bg)] px-1 text-[10px] font-bold leading-none text-[var(--btn-primary-fg)]"
        >
          {badge > 9 ? '9+' : badge}
        </span>
      ) : null}
    </Link>
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
