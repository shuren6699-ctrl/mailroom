import type { BrowserPushSubscription } from "../shared/types";
import { localizeErrorMessage } from "./ui-messages";

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export interface BrowserPushState {
  supported: boolean;
  permission: BrowserNotificationPermission;
  subscribed: boolean;
}

export class BrowserPushError extends Error {
  readonly code: "permission-denied" | "subscription-failed" | "unsupported";

  constructor(
    code: BrowserPushError["code"],
    message: string,
  ) {
    super(localizeErrorMessage(message));
    this.code = code;
  }
}

const PUSH_OWNER_KEY = "mailroom.push-owner";
let reconciledPushIdentity: string | null = null;
let pushIdentityQueue: Promise<void> = Promise.resolve();

/** Rotate endpoints across accounts, including subscriptions created before ownership tracking. */
export function reconcileBrowserPushIdentity(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const operation = pushIdentityQueue.catch(() => {}).then(async () => {
    let recordedOwner: string | null = null;
    let storageAvailable = false;
    try {
      recordedOwner = localStorage.getItem(PUSH_OWNER_KEY)?.trim().toLowerCase() ?? null;
      storageAvailable = true;
    } catch { /* Private browsing may deny local storage. */ }
    if (reconciledPushIdentity === normalized && (!storageAvailable || recordedOwner === normalized)) return;

    if (supportsBrowserPush()) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (registration) {
        // Install the recipient-checking worker before accepting an existing endpoint.
        await registration.update();
        await waitForUpdatedWorker(registration);
        const sameOwner = storageAvailable && recordedOwner === normalized &&
          (reconciledPushIdentity === null || reconciledPushIdentity === normalized);
        if (!sameOwner) {
          for (const notification of await registration.getNotifications()) notification.close();
          await unsubscribeCurrentBrowser();
        }
      }
    }
    try { localStorage.setItem(PUSH_OWNER_KEY, normalized); } catch { /* Keep the in-memory identity. */ }
    reconciledPushIdentity = normalized;
  });
  pushIdentityQueue = operation;
  return operation;
}

async function waitForUpdatedWorker(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting;
  if (!worker || worker.state === "activated") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("通知安全更新尚未完成，请重试。")), 10_000);
    const onStateChange = () => {
      if (worker.state === "activated") finish();
      else if (worker.state === "redundant") finish(new Error("通知安全更新失败，请重试。"));
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      worker.removeEventListener("statechange", onStateChange);
      if (error) reject(error);
      else resolve();
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

export async function getBrowserPushState(): Promise<BrowserPushState> {
  if (!supportsBrowserPush()) {
    return { supported: false, permission: "unsupported", subscribed: false };
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: Boolean(subscription),
    };
  } catch {
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: false,
    };
  }
}

export async function createBrowserPushSubscription(
  vapidPublicKey: string,
): Promise<BrowserPushSubscription> {
  if (!supportsBrowserPush()) {
    throw new BrowserPushError("unsupported", "This browser does not support push notifications.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new BrowserPushError(
      "permission-denied",
      "Notifications are blocked in this browser.",
    );
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const applicationServerKey = base64urlToUint8Array(vapidPublicKey);
    let subscription = await registration.pushManager.getSubscription();

    if (
      subscription &&
      !sameApplicationServerKey(subscription.options.applicationServerKey, applicationServerKey)
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }

    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    const value = subscription.toJSON();
    if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
      throw new Error("The browser returned an incomplete Push Subscription");
    }
    return {
      endpoint: value.endpoint,
      expirationTime: value.expirationTime ?? null,
      keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
    };
  } catch (error) {
    if (error instanceof BrowserPushError) throw error;
    throw new BrowserPushError(
      "subscription-failed",
      error instanceof Error ? error.message : "Could not subscribe this browser.",
    );
  }
}

export async function unsubscribeCurrentBrowser(): Promise<void> {
  if (!supportsBrowserPush()) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription && !(await subscription.unsubscribe())) {
    throw new BrowserPushError("subscription-failed", "无法清除上一个账号的浏览器通知订阅，请重试。");
  }
}

function supportsBrowserPush(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function base64urlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sameApplicationServerKey(
  current: ArrayBuffer | null,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  if (!current) return false;
  const actual = new Uint8Array(current);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}
