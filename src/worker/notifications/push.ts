import { buildPushHTTPRequest } from "@pushforge/builder";
import type { BrowserPushSubscription } from "../../shared/types";

interface StoredPushSubscription {
  member_email: string;
  endpoint: string;
  expiration_time: number | null;
  p256dh: string;
  auth: string;
}

export interface NewEmailNotificationInput {
  threadId: number;
  senderName: string | null;
  senderAddress: string;
  subject: string;
}

export interface NewEmailNotificationPayload {
  title: string;
  body: string;
  tag: string;
  data: { url: string };
}

export function buildNewEmailNotification(
  input: NewEmailNotificationInput,
): NewEmailNotificationPayload {
  const sender = (input.senderName?.trim() || input.senderAddress.trim() || "未知发件人")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const subject = input.subject.trim().replace(/\s+/g, " ").slice(0, 160);

  return {
    title: `来自 ${sender} 的新邮件`,
    body: subject || "（无主题）",
    tag: `conversation-${input.threadId}`,
    data: { url: `/inbox/${input.threadId}` },
  };
}

export function validatePushSubscription(
  value: unknown,
): value is BrowserPushSubscription {
  if (!value || typeof value !== "object") return false;
  const subscription = value as Partial<BrowserPushSubscription>;
  if (
    typeof subscription.endpoint !== "string" ||
    subscription.endpoint.length > 2048 ||
    !subscription.keys ||
    typeof subscription.keys.p256dh !== "string" ||
    typeof subscription.keys.auth !== "string" ||
    subscription.keys.p256dh.length < 40 ||
    subscription.keys.p256dh.length > 256 ||
    subscription.keys.auth.length < 8 ||
    subscription.keys.auth.length > 128 ||
    (subscription.expirationTime !== null &&
      subscription.expirationTime !== undefined &&
      (!Number.isSafeInteger(subscription.expirationTime) || subscription.expirationTime < 0))
  ) {
    return false;
  }

  try {
    const endpoint = new URL(subscription.endpoint);
    return endpoint.protocol === "https:" && !endpoint.username && !endpoint.password;
  } catch {
    return false;
  }
}

export async function notifyNewEmail(
  env: Env,
  input: NewEmailNotificationInput,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return;
  const privateJWK = env.VAPID_PRIVATE_JWK;
  const adminContact = env.VAPID_SUBJECT;

  const settings = await env.DB.prepare(
    "SELECT browser_notifications_enabled FROM global_settings WHERE id = 1",
  ).first<{ browser_notifications_enabled: number }>();
  if (!settings?.browser_notifications_enabled) return;

  const { results } = await env.DB.prepare(
    `SELECT p.endpoint, p.expiration_time, p.p256dh, p.auth, member.email AS member_email
     FROM push_subscriptions p
     JOIN members member ON member.email = p.member_email
     JOIN threads thread ON thread.id = ?
     WHERE member.enabled = 1
       AND (member.role = 'admin' OR EXISTS (
         SELECT 1 FROM member_mailboxes grant_access
         WHERE grant_access.member_email = member.email
           AND grant_access.mailbox_id = thread.mailbox_id
       ))
     ORDER BY p.id`,
  ).bind(input.threadId).all<StoredPushSubscription>();
  if (results.length === 0) return;

  const payload = buildNewEmailNotification(input);
  const deadEndpoints: string[] = [];

  await Promise.all(
    results.map(async (subscription) => {
      try {
        const pushSubscription = {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        };
        const request = await buildPushHTTPRequest({
          privateJWK,
          subscription: pushSubscription,
          message: {
            payload: {
              // Legacy workers may still display these without recipient checks.
              // Fetch private sender/subject only after authorization in the current worker.
              title: "新邮件",
              body: "打开收件箱查看新邮件。",
              tag: payload.tag,
              data: { url: payload.data.url, threadId: input.threadId, recipientEmail: subscription.member_email },
            },
            adminContact,
            options: {
              ttl: 60 * 60,
              urgency: "normal",
              topic: `conversation-${input.threadId}`,
            },
          },
        });
        const response = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
        if (response.ok) return;
        if (response.status === 404 || response.status === 410) {
          deadEndpoints.push(subscription.endpoint);
          return;
        }
        console.error("Browser notification delivery failed", {
          statusCode: response.status,
          endpointOrigin: endpointOrigin(subscription.endpoint),
        });
      } catch (error) {
        console.error("Browser notification delivery failed", {
          statusCode: 0,
          endpointOrigin: endpointOrigin(subscription.endpoint),
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }),
  );

  if (deadEndpoints.length > 0) {
    await Promise.all(
      deadEndpoints.map((endpoint) =>
        env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run(),
      ),
    );
  }
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "invalid";
  }
}
