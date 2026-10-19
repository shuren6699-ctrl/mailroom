export interface Principal {
  email: string;
  role: "admin" | "member";
  enabled: boolean;
  mailboxIds: number[];
}

export class PermissionError extends Error {
  status = 403 as const;
  constructor(message = "你没有此收件箱的使用权限") {
    super(message);
    this.name = "PermissionError";
  }
}

export function normalizeMemberEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Always resolve current grants; never trust mailbox ids from a client or an old token. */
export async function loadPrincipal(db: D1Database, email: string): Promise<Principal> {
  const normalized = normalizeMemberEmail(email);
  const member = await db.prepare("SELECT role, enabled FROM members WHERE email = ?")
    .bind(normalized).first<{ role: Principal["role"]; enabled: number }>();
  const principal: Principal = {
    email: normalized, role: member?.role ?? "member", enabled: member?.enabled === 1, mailboxIds: [],
  };
  if (!principal.enabled) return principal;
  const { results } = principal.role === "admin"
    ? await db.prepare("SELECT id AS mailbox_id FROM mailboxes ORDER BY id").all<{ mailbox_id: number }>()
    : await db.prepare("SELECT mailbox_id FROM member_mailboxes WHERE member_email = ? ORDER BY mailbox_id")
      .bind(normalized).all<{ mailbox_id: number }>();
  principal.mailboxIds = results.map((row) => Number(row.mailbox_id));
  return principal;
}

export function canUseMailbox(principal: Principal, mailboxId: number): boolean {
  return principal.enabled && Number.isSafeInteger(mailboxId) && mailboxId > 0 &&
    (principal.role === "admin" || principal.mailboxIds.includes(mailboxId));
}

/** Callers supply a source-code column name; the only interpolated values are safe integers. */
export function mailboxScope(principal: Principal, column: string): string {
  if (!/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?$/.test(column)) throw new Error("Invalid scope column");
  if (!principal.enabled) return "0=1";
  if (principal.role === "admin") return "1=1";
  const ids = principal.mailboxIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  return ids.length ? `${column} IN (${ids.join(",")})` : "0=1";
}

export function requireMailbox(principal: Principal, mailboxId: number): void {
  if (!canUseMailbox(principal, mailboxId)) throw new PermissionError();
}

export async function requireThread(db: D1Database, principal: Principal, threadId: number): Promise<void> {
  const thread = await db.prepare("SELECT mailbox_id FROM threads WHERE id = ?")
    .bind(threadId).first<{ mailbox_id: number }>();
  if (!thread) throw new PermissionError("会话不存在或你没有访问权限");
  requireMailbox(principal, Number(thread.mailbox_id));
}
