import type { AccessSyncStatus } from "../shared/access-sync.ts";

interface AccessSyncEnv {
  DB: D1Database;
  CF_ACCESS_API_TOKEN?: string;
  ACCESS_SYNC_ACCOUNT_ID?: string;
  ACCESS_SYNC_POLICY_ID?: string;
}

interface SyncState {
  revision: number;
  synced_revision: number;
  lease_token: string | null;
  lease_until: number | null;
  last_synced_at: string | null;
  last_error: string | null;
}

const OWNER_EMAIL = "shuren6699@gmail.com";
const POLICY_NAME = "mailroom-team";
const REQUEST_TIMEOUT_MS = 15_000;
// Longer than the complete bounded network work (3 attempts x 2 x 15 seconds).
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;

const MESSAGES = {
  configuration: "Cloudflare 白名单同步配置无效，请检查服务器配置后重试。",
  policy: "目标策略必须是仅供当前应用使用的 mailroom-team 邮箱允许规则，且安全约束必须完整保留；请检查后重试。",
  policy_shape: "Cloudflare 返回的目标策略格式无效，已停止同步；请检查后重试。",
  policy_identity: "目标策略的名称、ID 或允许操作不匹配，已停止同步；请检查后重试。",
  policy_attachment_metadata: "目标策略的应用关联数量缺失或格式无效，已停止同步；请检查后重试。",
  policy_attachment_count: "目标策略并非仅供一个应用使用，已停止同步以保护其他应用；请检查后重试。",
  policy_fields: "目标策略包含当前同步程序不支持的字段，已停止同步以保留安全约束；请检查后重试。",
  policy_rules: "目标策略的邮箱包含规则格式不受支持，已停止同步；请检查后重试。",
  policy_constraints: "目标策略的 Require 或 Exclude 规则格式无效，已停止同步；请检查后重试。",
  policy_emails_changed: "Cloudflare 返回的邮箱白名单与已保存成员不一致，尚未确认同步；请重试。",
  policy_constraints_changed: "Cloudflare 返回的安全约束与原策略不一致，尚未确认同步；请检查后重试。",
  owner: "管理员账户配置异常，已停止白名单同步以保护管理员访问；请修复后重试。",
  member: "成员邮箱配置无效，已停止白名单同步；请检查后重试。",
  api: "Cloudflare 白名单同步失败，请检查 API Token 权限和目标策略后重试。",
  timeout: "Cloudflare 白名单同步超时，成员配置已保存，请重试。",
  network: "无法连接 Cloudflare，成员配置已保存，请重试。",
  storage: "暂时无法读取白名单同步状态，请重试。",
} as const;

type Failure = keyof typeof MESSAGES;
class SyncError extends Error {
  code: Failure;
  constructor(code: Failure) { super(MESSAGES[code]); this.code = code; }
}
class LeaseLost extends Error {}

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuration(env: AccessSyncEnv): { url: string; token: string } | null {
  const token = env.CF_ACCESS_API_TOKEN;
  if (!token?.trim()) return null;
  // Targets are server configuration only. Neither a URL nor a path fragment is accepted.
  if (!/^[a-f\d]{32}$/i.test(env.ACCESS_SYNC_ACCOUNT_ID ?? "") ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(env.ACCESS_SYNC_POLICY_ID ?? "") ||
      !/^[A-Za-z\d._~-]{1,4096}$/.test(token)) throw new SyncError("configuration");
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${env.ACCESS_SYNC_ACCOUNT_ID}/access/policies/${env.ACCESS_SYNC_POLICY_ID}`,
    token,
  };
}

function timestamp(value: string | null): string | null {
  return value && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

function pending(lastSyncedAt: string | null): AccessSyncStatus {
  return { configured: true, state: "pending", message: "成员配置已保存，Cloudflare 白名单等待同步；可稍后重试。", last_synced_at: lastSyncedAt };
}

async function readState(db: D1Database): Promise<SyncState> {
  const state = await db.prepare("SELECT revision, synced_revision, lease_token, lease_until, last_synced_at, last_error FROM access_sync_state WHERE id = 1").first<SyncState>();
  if (!state) throw new SyncError("storage");
  return state;
}

export async function getAccessSyncStatus(env: AccessSyncEnv): Promise<AccessSyncStatus> {
  try {
    if (!configuration(env)) return { configured: false, state: "not_configured", message: "尚未配置 Cloudflare API Token，成员配置已保存，白名单尚未同步。", last_synced_at: null };
  } catch {
    return { configured: false, state: "error", message: MESSAGES.configuration, last_synced_at: null };
  }
  try {
    const state = await readState(env.DB);
    const lastSyncedAt = timestamp(state.last_synced_at);
    if (state.lease_token && Number(state.lease_until) > Date.now()) return pending(lastSyncedAt);
    if (state.last_error) {
      // Even a stored error is untrusted. Never echo exception or upstream text.
      const message = Object.values(MESSAGES).find((value) => value === state.last_error) ?? MESSAGES.api;
      return { configured: true, state: "error", message, last_synced_at: lastSyncedAt };
    }
    if (!lastSyncedAt || state.synced_revision !== state.revision) return pending(lastSyncedAt);
    return { configured: true, state: "synced", message: "Cloudflare 白名单已同步。", last_synced_at: lastSyncedAt };
  } catch {
    return { configured: true, state: "error", message: MESSAGES.storage, last_synced_at: null };
  }
}

/** Include in the SAME D1 batch as a membership change so revision and members are atomic. */
export function accessSyncRevisionStatement(db: D1Database): D1PreparedStatement {
  return db.prepare("UPDATE access_sync_state SET revision = revision + 1, last_error = NULL WHERE id = 1");
}

function email(value: unknown): string {
  if (typeof value !== "string") throw new SyncError("member");
  const canonical = value.trim().toLowerCase();
  if (canonical.length > 254 || !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(canonical)) throw new SyncError("member");
  return canonical;
}

async function snapshot(db: D1Database, token: string): Promise<{ revision: number; emails: string[] }> {
  // One SQL statement gives both the revision and the member list one consistent snapshot.
  const { results } = await db.prepare(`SELECT s.revision, s.lease_token, s.lease_until, m.email, m.role
    FROM access_sync_state s LEFT JOIN members m ON m.enabled = 1 WHERE s.id = 1 ORDER BY m.email`)
    .all<{ revision: number; lease_token: string | null; lease_until: number | null; email: string | null; role: string | null }>();
  if (!results.length) throw new SyncError("storage");
  if (results[0].lease_token !== token || Number(results[0].lease_until) <= Date.now()) throw new LeaseLost();
  const admins = results.filter((row) => row.role === "admin");
  if (admins.length !== 1 || email(admins[0].email) !== OWNER_EMAIL) throw new SyncError("owner");
  return { revision: results[0].revision, emails: [...new Set([OWNER_EMAIL, ...results.map((row) => email(row.email))])].sort() };
}

// Writable fields from the reusable policy update API. Response-only metadata is excluded.
// https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/update/
const SAFETY_FIELDS = [
  "require", "exclude", "session_duration", "approval_groups", "approval_required", "connection_rules",
  "isolation_required", "mfa_config", "purpose_justification_prompt", "purpose_justification_required",
] as const;
const POLICY_FIELDS = new Set<string>(["name", "decision", "include", ...SAFETY_FIELDS]);
const RESPONSE_FIELDS = new Set(["id", "account_id", "app_count", "created_at", "updated_at", "reusable"]);

type PolicyPhase = "get" | "put";
function rejectPolicy(reason: Failure, phase: PolicyPhase, details: JsonObject = {}): never {
  // Only static classifications, bounded field names and counts belong in diagnostics.
  console.warn("Cloudflare Access policy validation rejected", { phase, reason, ...details });
  throw new SyncError(reason);
}

function policyEmails(value: unknown, env: AccessSyncEnv, phase: PolicyPhase): { policy: JsonObject; emails: string[] } {
  if (!object(value)) rejectPolicy("policy_shape", phase);
  if (value.name !== POLICY_NAME || value.decision !== "allow" ||
      (value.id !== undefined && value.id !== env.ACCESS_SYNC_POLICY_ID) ||
      (value.account_id !== undefined && value.account_id !== env.ACCESS_SYNC_ACCOUNT_ID)) rejectPolicy("policy_identity", phase);
  if (typeof value.app_count !== "number" || !Number.isFinite(value.app_count)) rejectPolicy("policy_attachment_metadata", phase);
  if (value.app_count !== 1) rejectPolicy("policy_attachment_count", phase, { app_count: value.app_count });
  const unexpectedFields = Object.keys(value).filter((key) => !POLICY_FIELDS.has(key) && !RESPONSE_FIELDS.has(key));
  if (unexpectedFields.length) rejectPolicy("policy_fields", phase, {
    unexpected_field_count: unexpectedFields.length,
    unexpected_fields: unexpectedFields.filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) &&
      !key.includes(env.CF_ACCESS_API_TOKEN ?? "")).slice(0, 16),
  });
  if (!Array.isArray(value.include) || value.include.length === 0) rejectPolicy("policy_rules", phase);
  if ((value.require !== undefined && !Array.isArray(value.require)) ||
      (value.exclude !== undefined && !Array.isArray(value.exclude))) rejectPolicy("policy_constraints", phase, {
    invalid_fields: ["require", "exclude"].filter((key) => value[key] !== undefined && !Array.isArray(value[key])),
  });
  const emails = value.include.map((rule: unknown) => {
    if (!object(rule) || Object.keys(rule).length !== 1 || !object(rule.email) || Object.keys(rule.email).length !== 1) rejectPolicy("policy_rules", phase);
    try { return email(rule.email.email); } catch { return rejectPolicy("policy_rules", phase); }
  });
  return { policy: value, emails: [...new Set(emails)].sort() };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function request(config: { url: string; token: string }, method: "GET" | "PUT", body?: JsonObject): Promise<unknown> {
  const startedAt = Date.now();
  let waitingFor: "response_headers" | "response_body" | undefined = "response_headers";
  let status: number | undefined;
  const diagnostic = (phase: "request_start" | "response_headers" | "response_body" | "request_failed", reason?: Failure) => {
    // Never include request URLs, credentials, headers, response bodies or exception text.
    console.info("Cloudflare Access sync request", {
      method, phase, elapsed_ms: Math.max(0, Date.now() - startedAt),
      ...(status === undefined ? {} : { status }),
      ...(phase === "request_failed" && waitingFor ? { waiting_for: waitingFor } : {}),
      ...(reason ? { reason } : {}),
    });
  };
  diagnostic("request_start");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new SyncError("timeout")); }, REQUEST_TIMEOUT_MS);
  });
  const operation = async () => {
    const response = await fetch(config.url, {
      // workerd accepts manual/follow only. Reject 3xx below without forwarding credentials.
      method, redirect: "manual", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) status = response.status;
    waitingFor = undefined;
    diagnostic("response_headers");
    if (!response.ok) throw new SyncError("api");
    let payload: unknown;
    waitingFor = "response_body";
    try { payload = await response.json(); } catch { throw new SyncError("api"); }
    waitingFor = undefined;
    diagnostic("response_body");
    if (!object(payload) || payload.success !== true || !object(payload.result)) throw new SyncError("api");
    return payload.result;
  };
  try { return await Promise.race([operation(), timeout]); }
  catch (error) {
    const failure = controller.signal.aborted ? new SyncError("timeout")
      : error instanceof SyncError ? error : new SyncError("network");
    diagnostic("request_failed", failure.code);
    throw failure;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function renewLease(db: D1Database, token: string): Promise<void> {
  const now = Date.now();
  const result = await db.prepare("UPDATE access_sync_state SET lease_until = ? WHERE id = 1 AND lease_token = ? AND lease_until > ?")
    .bind(now + LEASE_MS, token, now).run();
  if (result.meta.changes !== 1) throw new LeaseLost();
}

export async function synchronizeAccessPolicy(env: AccessSyncEnv): Promise<AccessSyncStatus> {
  let config: ReturnType<typeof configuration>;
  try { config = configuration(env); } catch { return getAccessSyncStatus(env); }
  if (!config) return getAccessSyncStatus(env);
  const token = crypto.randomUUID();
  let acquired = false;
  let lostLease = false;
  try {
    const now = Date.now();
    const lock = await env.DB.prepare(`UPDATE access_sync_state SET lease_token = ?, lease_until = ?, last_error = NULL
      WHERE id = 1 AND (lease_token IS NULL OR lease_until IS NULL OR lease_until <= ?)`)
      .bind(token, now + LEASE_MS, now).run();
    if (lock.meta.changes !== 1) return pending((await getAccessSyncStatus(env)).last_synced_at);
    acquired = true;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const desired = await snapshot(env.DB, token);
      await renewLease(env.DB, token);
      const current = policyEmails(await request(config, "GET"), env, "get").policy;
      await renewLease(env.DB, token);
      if ((await readState(env.DB)).revision !== desired.revision) continue;
      const body: JsonObject = { name: POLICY_NAME, decision: "allow", include: desired.emails.map((address) => ({ email: { email: address } })) };
      for (const key of SAFETY_FIELDS) if (Object.hasOwn(current, key)) body[key] = current[key];
      const updated = policyEmails(await request(config, "PUT", body), env, "put");
      if (stableJson(updated.emails) !== stableJson(desired.emails)) rejectPolicy("policy_emails_changed", "put");
      const changedSafetyFields = SAFETY_FIELDS.filter((key) => stableJson(body[key]) !== stableJson(updated.policy[key]));
      if (changedSafetyFields.length) rejectPolicy("policy_constraints_changed", "put", { changed_fields: changedSafetyFields });
      const mark = await env.DB.prepare(`UPDATE access_sync_state SET synced_revision = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = NULL
        WHERE id = 1 AND revision = ? AND lease_token = ? AND lease_until > ?`)
        .bind(desired.revision, desired.revision, token, Date.now()).run();
      if (mark.meta.changes === 1) break;
      await renewLease(env.DB, token);
    }
  } catch (error) {
    if (error instanceof LeaseLost) lostLease = true;
    else if (acquired) {
      const message = error instanceof SyncError ? MESSAGES[error.code] : MESSAGES.storage;
      try {
        await env.DB.prepare("UPDATE access_sync_state SET last_error = ? WHERE id = 1 AND lease_token = ?")
          .bind(message, token).run();
      } catch { return { configured: true, state: "error", message: MESSAGES.storage, last_synced_at: null }; }
    } else return { configured: true, state: "error", message: MESSAGES.storage, last_synced_at: null };
  } finally {
    if (acquired) {
      // A timed out/old isolate may only release its own lease, never a successor's.
      try { await env.DB.prepare("UPDATE access_sync_state SET lease_token = NULL, lease_until = NULL WHERE id = 1 AND lease_token = ?").bind(token).run(); }
      catch { /* The lease expires; all user-facing errors remain sanitized. */ }
    }
  }
  const status = await getAccessSyncStatus(env);
  return lostLease ? pending(status.last_synced_at) : status;
}
