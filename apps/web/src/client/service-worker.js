self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const notification = event.data.json();
  event.waitUntil(self.registration.showNotification(notification.title, {
    tag: notification.tag,
    icon: "/icon-192.png",
    data: { url: notification.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data.url, self.location.origin);
  if (destination.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((client) => new URL(client.url).origin === destination.origin);
    if (client) {
      await client.navigate(destination.href);
      await client.focus();
    } else {
      await self.clients.openWindow(destination.href);
    }
  })());
});
