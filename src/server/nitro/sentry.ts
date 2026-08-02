// Nitro startup plugin: initialize Bugsink (Sentry-compatible) error tracking
// for the server, then forward every unhandled request error to it.
//
// It reads the same VITE_SENTRY_DSN the browser SDK uses (the DSN is a public
// identifier, not a secret) but from process.env at runtime, so the value can
// change without a rebuild. A blank/missing DSN fully disables capture — this
// plugin returns before installing anything. Config mirrors the browser side:
// no performance tracing, no extra integrations (Sentry's default Node
// integrations still install the uncaught-exception / unhandled-rejection
// handlers). See src/lib/sentry.ts for the client half.
import type { NitroApp } from 'nitro/types'
import * as Sentry from '@sentry/node'

export default function sentryPlugin(nitroApp: NitroApp): void {
  const dsn = process.env.VITE_SENTRY_DSN?.trim()
  if (!dsn) return

  Sentry.init({
    dsn,
    release: process.env.VITE_SENTRY_RELEASE,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
    integrations: [],
  })

  // Fires for errors thrown out of request handlers (server functions, API
  // routes, SSR) that Nitro turns into a 5xx. Uncaught exceptions and
  // unhandled rejections are already covered by Sentry's default integrations.
  nitroApp.hooks?.hook('error', (error) => {
    Sentry.captureException(error)
  })
}
