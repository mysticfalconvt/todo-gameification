import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { initSentryBrowser } from './lib/sentry'

export function getRouter() {
  // Runs once at client startup, before the first render. No-op during SSR
  // and when VITE_SENTRY_DSN is unset. Called here (rather than a bare
  // side-effect import) so it survives the package's `sideEffects: false`
  // tree-shaking.
  initSentryBrowser()

  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
