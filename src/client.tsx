// Custom client entry — overrides @tanstack/react-start's default one
// (the plugin resolves `src/client` and only falls back to its own bundled
// entry when this file is absent). Behaviourally identical to the default:
// startTransition + hydrateRoot(document) + StrictMode. The only addition is
// the onRecoverableError hook.
//
// Why: React 19 reports hydration mismatches (minified error #418 / #423 /
// #425) through onRecoverableError, and when no handler is supplied it falls
// through to reportError -> window.onerror, which is how Bugsink was seeing
// them. That path loses errorInfo.componentStack, so the report only ever
// pointed at react-dom internals and never named the offending component.
// Capturing it here means the next occurrence identifies itself.
//
// The extra tags exist to test the leading hypothesis for the #418 reports:
// that something outside the app is rewriting document text before hydration.
// We hydrate the whole `document` (including <head>, where <title> is a text
// node), so browser auto-translate and text-munging extensions both land as
// text mismatches. Chrome's translator stamps `translated-ltr`/`translated-rtl`
// on <html>; Microsoft's stamps `_msttexthash`. If the reports correlate with
// those, it's not our markup.
import { StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import * as Sentry from '@sentry/react'

import { initSentryBrowser } from './lib/sentry'

// StartClient resolves the router (and thus getRouter's own init call)
// asynchronously via hydrateStart(), so init here too — otherwise a mismatch
// on the first pass could fire before the SDK exists. Guarded internally.
initSentryBrowser()

function documentMutationTags(): Record<string, string> {
  const html = document.documentElement
  const translated =
    html.classList.contains('translated-ltr') ||
    html.classList.contains('translated-rtl') ||
    html.hasAttribute('_msttexthash')
  return {
    hydration: 'recoverable',
    path: window.location.pathname,
    html_lang: html.lang || 'unset',
    translated: String(translated),
  }
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    {
      onRecoverableError: (error, errorInfo) => {
        Sentry.captureException(error, {
          tags: documentMutationTags(),
          extra: { componentStack: errorInfo.componentStack },
        })
      },
    },
  )
})
