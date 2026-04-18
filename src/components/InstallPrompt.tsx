import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'todo-xp-install-dismissed'

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setDismissed(localStorage.getItem(DISMISS_KEY) === '1')

    const onBefore = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setDeferred(null)
      localStorage.setItem(DISMISS_KEY, '1')
    }
    window.addEventListener('beforeinstallprompt', onBefore)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBefore)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!deferred || dismissed) return null

  async function install() {
    if (!deferred) return
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    setDeferred(null)
    if (outcome === 'dismissed') {
      localStorage.setItem(DISMISS_KEY, '1')
      setDismissed(true)
    }
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
    setDeferred(null)
  }

  return (
    <div className="island-shell mx-4 mb-4 flex items-center justify-between gap-3 rounded-xl p-3 text-sm">
      <span className="text-[var(--sea-ink-soft)]">
        Install Todo XP for offline access and a cleaner launch icon.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]"
        >
          Later
        </button>
        <button
          type="button"
          onClick={install}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 text-xs font-semibold text-[var(--lagoon-deep)]"
        >
          Install
        </button>
      </div>
    </div>
  )
}
