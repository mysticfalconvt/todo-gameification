/// <reference types="vite/client" />
import * as Sentry from '@sentry/react'

// Browser-side Bugsink (Sentry-compatible) error tracking.
//
// The DSN is a public value — it identifies the project, not a secret — so we
// bake it into the client bundle from VITE_SENTRY_DSN at build time. Leaving
// the var blank fully disables the SDK: no init, no network, no global
// handlers. Config is deliberately minimal per Bugsink's SDK recommendation —
// no performance tracing (tracesSampleRate: 0) and no extra integrations
// (the array merges with Sentry's defaults, so global error/rejection
// handlers still install).
//
// Safe to call from both server and client code paths: the `document` guard
// makes it a no-op during SSR so the Node process never loads the browser SDK.
export function initSentryBrowser(): void {
  if (typeof document === 'undefined') return
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return
  Sentry.init({
    dsn,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
    integrations: [],
  })
}
