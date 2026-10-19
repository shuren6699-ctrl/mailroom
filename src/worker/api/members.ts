import { Hono } from "hono";
import { z } from "zod";
import type { ApiVariables } from "./context.ts";
import { normalizeMemberEmail } from "../inbox/permissions.ts";

type MemberRow = { email: string; role: "admin" | "member"; enabled: number; created_at: string };
const fields = {
  mailbox_ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(1000),
  enabled: z.boolean(),
};
const createInput = z.object({
  email: z.string().trim().email().max(254),
  mailbox_ids: fields.mailbox_ids,
  enabled: fields.enabled.optional(),
}).strict();
const updateInput = z.object(fields).strict();

export const membersApi = new Hono<{ Bindings: Env; Variables: ApiVariables }>();
membersApi.use("*", async (c, next) => {
  const principal = c.get("principal");
  if (!principal?.enabled || principal.role !== "admin") return c.json({ error: "仅管理员可以管理成员" }, 403);
  await next();
});

membersApi.get("/", async (c) => {
  const [members, mailboxes, grants] = await Promise.all([
    c.env.DB.prepare("SELECT email, role, enabled, created_at FROM members ORDER BY role, email").all<MemberRow>(),
    c.env.DB.prepare("SELECT id, address FROM mailboxes ORDER BY address").all<{ id: number; address: string }>(),
    c.env.DB.prepare("SELECT member_email, mailbox_id FROM member_mailboxes ORDER BY mailbox_id")
      .all<{ member_email: string; mailbox_id: number }>(),
  ]);
  return c.json({
    members: members.results.map((member) => ({
      ...member, enabled: member.enabled === 1,
      mailbox_ids: member.role === "admin" ? mailboxes.results.map((box) => box.id)
        : grants.results.filter((grant) => grant.member_email === member.email).map((grant) => grant.mailbox_id),
    })),
    mailboxes: mailboxes.results,
  });
});

async function validMailboxes(db: D1Database, ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  const unique = [...new Set(ids)];
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM mailboxes WHERE id IN (${unique.map(() => "?").join(",")})`)
    .bind(...unique).first<{ count: number }>();
  return Number(row?.count) === unique.length;
}

membersApi.post("/", async (c) => {
  const parsed = createInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "请输入有效邮箱，并选择需要分配的收件箱" }, 400);
  const email = normalizeMemberEmail(parsed.data.email);
  const ids = [...new Set(parsed.data.mailbox_ids)];
  if (!await validMailboxes(c.env.DB, ids)) return c.json({ error: "选择的收件箱不存在，请刷新后重试" }, 400);
  if (await c.env.DB.prepare("SELECT email FROM members WHERE email = ?").bind(email).first()) {
    return c.json({ error: "该成员已存在，请编辑现有成员" }, 409);
  }
  const enabled = parsed.data.enabled ?? true;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO members (email, role, enabled) VALUES (?, 'member', ?)").bind(email, enabled ? 1 : 0),
      ...ids.map((id) => c.env.DB.prepare("INSERT INTO member_mailboxes (member_email, mailbox_id) VALUES (?, ?)").bind(email, id)),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return c.json({ error: "该成员已存在" }, 409);
    throw error;
  }
  const member = await c.env.DB.prepare("SELECT created_at FROM members WHERE email = ?").bind(email).first<{ created_at: string }>();
  return c.json({ email, role: "member", enabled, mailbox_ids: ids, created_at: member!.created_at }, 201);
});

membersApi.put("/:email", async (c) => {
  const email = normalizeMemberEmail(c.req.param("email"));
  const parsed = updateInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "成员配置无效" }, 400);
  const member = await c.env.DB.prepare("SELECT email, role, enabled, created_at FROM members WHERE email = ?")
    .bind(email).first<MemberRow>();
  if (!member) return c.json({ error: "成员不存在" }, 404);
  if (member.role === "admin") return c.json({ error: "管理员固定拥有全部权限，不能停用或修改" }, 403);
  const ids = [...new Set(parsed.data.mailbox_ids)];
  if (!await validMailboxes(c.env.DB, ids)) return c.json({ error: "选择的收件箱不存在，请刷新后重试" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE email = ?")
      .bind(parsed.data.enabled ? 1 : 0, email),
    c.env.DB.prepare("DELETE FROM member_mailboxes WHERE member_email = ?").bind(email),
    ...ids.map((id) => c.env.DB.prepare("INSERT INTO member_mailboxes (member_email, mailbox_id) VALUES (?, ?)").bind(email, id)),
  ]);
  return c.json({ ...member, enabled: parsed.data.enabled, mailbox_ids: ids });
});
