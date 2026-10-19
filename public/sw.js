self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  event.waitUntil(showAuthorizedNotification(payload));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openAuthorizedConversation(event.notification.data));
});

async function authorizedNotificationData(data) {
  if (!data || typeof data.recipientEmail !== "string" ||
      !Number.isSafeInteger(data.threadId) || data.threadId <= 0) return null;
  const recipientEmail = data.recipientEmail.trim().toLowerCase();
  if (!recipientEmail) return null;

  try {
    const identity = await readAuthorizedJson("/api/me");
    if (!isRecipient(identity, recipientEmail)) return null;
    // The endpoint resolves current mailbox grants instead of trusting payload scope.
    const { thread } = await readAuthorizedJson(`/api/threads/${data.threadId}`);
    if (thread?.id !== data.threadId || !Number.isSafeInteger(thread.mailbox_id)) return null;
    // A shared browser can change identity while the thread request is in flight.
    const current = await readAuthorizedJson("/api/me");
    if (!isRecipient(current, recipientEmail) ||
        (current.role !== "admin" && !current.mailbox_ids?.includes(thread.mailbox_id))) return null;
    return { data: { url: `/inbox/${data.threadId}`, threadId: data.threadId, recipientEmail }, thread };
  } catch {
    // Login redirects, unavailable authentication and offline delivery must stay silent.
    return null;
  }
}

function isRecipient(identity, recipientEmail) {
  return identity?.enabled === true && typeof identity.email === "string" &&
    identity.email.trim().toLowerCase() === recipientEmail;
}

async function readAuthorizedJson(path) {
  const url = new URL(path, self.location.origin);
  const response = await fetch(url.href, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (!response.ok || response.redirected ||
      !response.headers.get("content-type")?.includes("application/json") ||
      (response.url && response.url !== url.href)) throw new Error("Authorization unavailable");
  return response.json();
}

async function showAuthorizedNotification(payload) {
  const authorized = await authorizedNotificationData(payload?.data);
  if (!authorized) return;
  const { data, thread } = authorized;
  const sender = String(thread.last_from || thread.last_from_address || "未知发件人").trim().replace(/\s+/g, " ").slice(0, 80);
  const subject = String(thread.subject || "").trim().replace(/\s+/g, " ").slice(0, 160);
  await self.registration.showNotification(`来自 ${sender} 的新邮件`, {
    body: subject || "（无主题）",
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    renotify: Boolean(payload.tag),
    data,
  });
}

async function openAuthorizedConversation(notificationData) {
  const authorized = await authorizedNotificationData(notificationData);
  if (!authorized) return;
  const targetUrl = new URL(authorized.data.url, self.location.origin).href;
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windowClients.find((client) => new URL(client.url).origin === self.location.origin);
  if (existing) {
    if ("navigate" in existing && existing.url !== targetUrl) await existing.navigate(targetUrl);
    if ("focus" in existing) return existing.focus();
  }
  return self.clients.openWindow(targetUrl);
}
