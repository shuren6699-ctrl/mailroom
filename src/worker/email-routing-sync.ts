export type EmailRoutingSyncStatus = {
  configured: boolean;
  state: "synced" | "not_configured" | "error";
  message: string;
};

export interface EmailRoutingSyncEnv {
  CF_EMAIL_ROUTING_API_TOKEN?: string;
  EMAIL_ROUTING_ZONE_ID?: string;
}

type RoutingRule = {
  id?: unknown;
  enabled?: unknown;
  matchers?: unknown;
  actions?: unknown;
};

type RoutingConfig = { url: string; token: string };

const WORKER_NAME = "mailroom";
const REQUEST_TIMEOUT_MS = 15_000;
const MESSAGES = {
  notConfigured: "尚未配置 Cloudflare Email Routing API Token，邮箱已保存但路由尚未同步。",
  synced: "Cloudflare 邮件路由已同步。",
  api: "Cloudflare 邮件路由同步失败，请检查 API Token 权限和 Zone ID 后重试。",
  conflict: "Cloudflare 已存在指向其他目标的同名路由规则，未创建邮箱。",
  network: "无法连接 Cloudflare 邮件路由服务，请稍后重试。",
  timeout: "Cloudflare 邮件路由同步超时，请稍后重试。",
  configuration: "Cloudflare 邮件路由同步配置无效，请检查 API Token 和 Zone ID。",
} as const;

function configuration(env: EmailRoutingSyncEnv): RoutingConfig | null {
  const token = env.CF_EMAIL_ROUTING_API_TOKEN?.trim();
  if (!token) return null;
  const zoneId = env.EMAIL_ROUTING_ZONE_ID?.trim();
  if (!zoneId || !/^[a-f\d]{32}$/i.test(zoneId) || !/^[A-Za-z\d._~-]{1,4096}$/.test(token)) {
    throw new Error("invalid email routing configuration");
  }
  return {
    url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`,
    token,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literalMatcher(rule: RoutingRule, address: string): boolean {
  if (!Array.isArray(rule.matchers)) return false;
  return rule.matchers.some((matcher) => object(matcher) && matcher.type === "literal" && matcher.field === "to" &&
    typeof matcher.value === "string" && matcher.value.trim().toLowerCase() === address);
}

function workerTarget(rule: RoutingRule): boolean {
  if (!Array.isArray(rule.actions)) return false;
  return rule.actions.some((action) => object(action) && action.type === "worker" && Array.isArray(action.value) &&
    action.value.some((value) => value === WORKER_NAME));
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return MESSAGES.timeout;
  if (error instanceof Error && error.message === "email-routing-api") return MESSAGES.api;
  return MESSAGES.network;
}

async function request(config: RoutingConfig, method: "GET" | "POST", body?: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("email-routing-api"); }
    if (!response.ok || !object(payload) || payload.success !== true) throw new Error("email-routing-api");
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure one exact address routes to this Worker's Email handler. */
export async function ensureEmailRoutingRule(
  env: EmailRoutingSyncEnv,
  address: string,
): Promise<EmailRoutingSyncStatus> {
  let config: RoutingConfig | null;
  try {
    config = configuration(env);
  } catch {
    return { configured: Boolean(env.CF_EMAIL_ROUTING_API_TOKEN?.trim()), state: "error", message: MESSAGES.configuration };
  }
  if (!config) return { configured: false, state: "not_configured", message: MESSAGES.notConfigured };

  const normalizedAddress = address.trim().toLowerCase();
  try {
    const result = await request(config, "GET");
    if (!Array.isArray(result)) throw new Error("email-routing-api");
    const matching = result.filter((rule): rule is RoutingRule => object(rule) && literalMatcher(rule as RoutingRule, normalizedAddress));
    const owned = matching.find((rule) => workerTarget(rule));
    if (owned) return { configured: true, state: "synced", message: MESSAGES.synced };
    if (matching.length > 0) return { configured: true, state: "error", message: MESSAGES.conflict };

    await request(config, "POST", {
      name: normalizedAddress,
      enabled: true,
      source: "api",
      matchers: [{ type: "literal", field: "to", value: normalizedAddress }],
      actions: [{ type: "worker", value: [WORKER_NAME] }],
    });
    return { configured: true, state: "synced", message: MESSAGES.synced };
  } catch (error) {
    return { configured: true, state: "error", message: messageFor(error) };
  }
}
