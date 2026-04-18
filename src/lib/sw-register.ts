// Registers the service worker on every page load (independent of push
// notifications). Call once from the root on client mount.
//
// The same `/sw.js` also handles push + notificationclick; if the user later
// enables notifications, that flow reuses this registration.
export async function registerServiceWorker(): Promise<void> {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch (err) {
    console.warn('Service worker registration failed:', err)
  }
}
