export type PushSupportStatus = 'unsupported' | 'unknown' | 'enabled' | 'disabled'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export async function currentPushStatus(): Promise<PushSupportStatus> {
  if (!isPushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'disabled'
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return 'unknown'
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'enabled' : 'unknown'
}

export async function enablePushNotifications(): Promise<void> {
  if (!isPushSupported()) throw new Error('Push not supported in this browser')

  const registration =
    (await navigator.serviceWorker.getRegistration('/sw.js')) ??
    (await navigator.serviceWorker.register('/sw.js'))
  await navigator.serviceWorker.ready

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission not granted')
  }

  const vapidRes = await fetch('/api/push/vapid-public-key')
  if (!vapidRes.ok) throw new Error('Failed to fetch VAPID key')
  const { publicKey } = (await vapidRes.json()) as { publicKey: string }

  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    })
  }

  const json = subscription.toJSON() as {
    endpoint?: string
    keys?: { p256dh?: string; auth?: string }
  }
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Subscription missing keys')
  }

  const deviceLabel = navigator.platform || undefined

  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      deviceLabel,
    }),
  })
  if (!res.ok) throw new Error(`Subscribe failed: ${res.status}`)
}

export async function disablePushNotifications(): Promise<void> {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ endpoint }),
  })
}
