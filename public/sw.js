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
