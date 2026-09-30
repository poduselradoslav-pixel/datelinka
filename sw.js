// Service worker: push notifikácie + vždy čerstvá verzia platformy (bez offline cache).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(clients.claim()))
// súbory platformy vždy overíme na serveri (inak ich prehliadač drží v cache až 10 min)
self.addEventListener('fetch', e => {
  if (e.request.method != 'GET' || new URL(e.request.url).origin != location.origin) return
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).catch(() => fetch(e.request)))
})
self.addEventListener('push', e => {
  const d = e.data?.json() ?? {}
  e.waitUntil(self.registration.showNotification(d.title || 'Ďatelinka', { body: d.body, icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag }))
})
// ťuknutie na push otvorí priamo to, čoho sa týka (tag = n<id upozornenia>)
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const id = (e.notification.tag || '').replace(/^n/, '')
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(w => {
    if (w[0]) { if (id) w[0].postMessage({ note: id }); return w[0].focus() }
    return clients.openWindow('./' + (id ? '#n' + id : ''))
  }))
})
