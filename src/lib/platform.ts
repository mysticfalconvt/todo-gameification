// Detect iOS Safari running *not* in standalone (home-screen-installed)
// mode. iOS only delivers Web Push to PWAs that have been added to the
// home screen — so for Pocket Mode (which depends on push to wake the
// user), we need to nudge non-installed iOS users to install first.
export function isIosNonStandalone(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false
  }
  const ua = navigator.userAgent
  const isIos = /iPad|iPhone|iPod/.test(ua)
  if (!isIos) return false
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  return !standalone
}
