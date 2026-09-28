// Service worker: iba push notifikácie. Offline cache zatiaľ netreba.
self.addEventListener('push', e => {
  const d = e.data?.json() ?? {}
  e.waitUntil(self.registration.showNotification(d.title || 'Ďatelinka', { body: d.body, icon: 'icon-192.png', badge: 'icon-192.png' }))
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(clients.matchAll({ type: 'window' }).then(w => w[0] ? w[0].focus() : clients.openWindow('./')))
})
