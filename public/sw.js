// Service worker: push notifications + runtime caching.
//
// Bump CACHE_VERSION to invalidate caches on deploy. (The hashed asset
// filenames mean stale JS/CSS is usually harmless — but bumping on schema or
// API contract changes is a fast way to flush stale shells on everyone's
// phones.)
const CACHE_VERSION = 'v4'
const ASSET_CACHE = `todo-xp-assets-${CACHE_VERSION}`
const HTML_CACHE = `todo-xp-html-${CACHE_VERSION}`
const API_CACHE = `todo-xp-api-${CACHE_VERSION}`

const EXPECTED_CACHES = new Set([ASSET_CACHE, HTML_CACHE, API_CACHE])

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(Promise.resolve())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith('todo-xp-') && !EXPECTED_CACHES.has(n))
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

function isAuthRequest(url) {
  return url.pathname.startsWith('/api/auth/') ||
    url.pathname.startsWith('/api/push/')
}

function isHashedAsset(url) {
  // Vite emits hashed files under /assets/<name>-<hash>.<ext>. Only those
  // are safe to cache-first forever — root-level files like /icon.svg,
  // /favicon.ico, /logo192.png change when we ship a new branding and
  // must not be pinned by the SW.
  return url.pathname.startsWith('/assets/')
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

async function networkFirstHtml(request) {
  const cache = await caches.open(HTML_CACHE)
  try {
    const fresh = await fetch(request)
    if (fresh.ok) cache.put(request, fresh.clone())
    return fresh
  } catch (err) {
    const cached = await cache.match(request)
    if (cached) return cached
    // Fall back to the root shell if we have one.
    const root = await cache.match('/today')
    if (root) return root
    throw err
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => cached)
  return cached || network
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return // let the network handle writes
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // skip cross-origin
  if (isAuthRequest(url)) return // never cache auth/push endpoints

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE))
    return
  }

  // Treat everything else as a navigation/HTML route.
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstHtml(request))
  }
})

self.addEventListener('push', (event) => {
  if (!event.data) return
  let data
  try {
    data = event.data.json()
  } catch {
    data = { title: 'Reminder', body: event.data.text() }
  }
  const { title, body, tag, taskInstanceId, url } = data
  const hasInstance = typeof taskInstanceId === 'string'
  event.waitUntil(
    self.registration.showNotification(title || 'Reminder', {
      body: body || '',
      icon: '/logo192.png',
      badge: '/logo192.png',
      tag,
      data: { taskInstanceId, url: url || '/today' },
      actions: hasInstance
        ? [
            { action: 'complete', title: '\u2713 Done' },
            { action: 'snooze', title: '\u23F0 1h' },
          ]
        : [],
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { action } = event
  const data = event.notification.data || {}
  const { taskInstanceId, url = '/today' } = data

  let target = url
  if (taskInstanceId && action === 'complete') {
    target = `/today?complete=${encodeURIComponent(taskInstanceId)}`
  } else if (taskInstanceId && action === 'snooze') {
    target = `/today?snooze=${encodeURIComponent(taskInstanceId)}`
  }

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      for (const client of clients) {
        const clientUrl = new URL(client.url)
        if (clientUrl.origin === self.location.origin) {
          await client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    })(),
  )
})
