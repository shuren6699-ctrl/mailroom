import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { createMember, fetchMembers, syncMembersAccess, updateMember, type Member, type MembersResponse } from "../api";
import type { AccessSyncStatus } from "../../shared/access-sync";
import { localizeErrorMessage } from "../ui-messages";
import { workerDashboardUrl } from "../cloudflare-dashboard";
import { DashLink } from "./DashLink";
import { SettingsBlock, SettingsHeader, SettingsPage, SettingsPanel } from "./SettingsNavigation";

interface EditorState {
  email: string;
  enabled: boolean;
  mailbox_ids: number[];
}

export function MembersSettings(props: {
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenInboxes: () => void;
}) {
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["members"],
    queryFn: fetchMembers,
    refetchInterval: (query) => query.state.data?.access_sync?.state === "pending" ? 3_000 : 30_000,
  });
  const [adding, setAdding] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [email, setEmail] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ create: boolean; enabled: boolean; hasSyncStatus: boolean } | null>(null);

  const updateSyncStatus = (access_sync: AccessSyncStatus) => {
    queryClient.setQueryData<MembersResponse>(["members"], (current) => current ? { ...current, access_sync } : current);
  };

  const sync = useMutation({
    mutationFn: syncMembersAccess,
    onMutate: () => setSaved(null),
    onSuccess: async (status) => {
      updateSyncStatus(status);
      await queryClient.invalidateQueries({ queryKey: ["members"] });
    },
  });

  const save = useMutation({
    mutationFn: (input: EditorState & { create: boolean }) => input.create
      ? createMember({ email: input.email, enabled: input.enabled, mailbox_ids: input.mailbox_ids })
      : updateMember(input.email, { enabled: input.enabled, mailbox_ids: input.mailbox_ids }),
    onSuccess: async (member, input) => {
      if (member.access_sync) updateSyncStatus(member.access_sync);
      await queryClient.invalidateQueries({ queryKey: ["members"] });
      setAdding(false);
      setEditor(null);
      setEmail("");
      setSaved({ create: input.create, enabled: input.enabled, hasSyncStatus: Boolean(member.access_sync) });
    },
  });

  const beginAdd = () => {
    save.reset();
    sync.reset();
    setSaved(null);
    setValidationError(null);
    setEmail("");
    setAdding(true);
    setEditor({ email: "", enabled: true, mailbox_ids: [] });
  };

  const beginEdit = (member: Member) => {
    save.reset();
    sync.reset();
    setSaved(null);
    setValidationError(null);
    setAdding(false);
    setEditor({ email: member.email, enabled: member.enabled, mailbox_ids: [...member.mailbox_ids] });
  };

  const submit = () => {
    if (!editor || save.isPending) return;
    const normalizedEmail = (adding ? email : editor.email).trim().toLowerCase();
    if (adding && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254)) {
      setValidationError("请输入有效的邮箱地址。");
      return;
    }
    if (adding && members.data?.members.some((member) => member.email.toLowerCase() === normalizedEmail)) {
      setValidationError("此邮箱已是成员，请在下方编辑其权限。");
      return;
    }
    setValidationError(null);
    save.mutate({ ...editor, email: normalizedEmail, create: adding });
  };

  const editorForm = editor && (
    <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="space-y-4">
      <fieldset disabled={save.isPending} className="min-w-0 space-y-4 disabled:opacity-60">
        {adding && <div>
          <label htmlFor="member-email" className="text-[13px] font-medium">登录邮箱</label>
          <Input id="member-email" type="email" required maxLength={254} autoComplete="off" placeholder="name@example.com" value={email}
            onChange={(event) => { setEmail(event.target.value); setValidationError(null); save.reset(); }}
            aria-invalid={Boolean(validationError) || undefined} aria-describedby="member-email-help" className="mt-2 max-w-md" />
          <p id="member-email-help" className="mt-1.5 text-xs text-muted-foreground">使用成员通过 Access 邮箱验证码登录时的邮箱地址。</p>
        </div>}
        <div className="flex items-start justify-between gap-4">
          <div>
            <label htmlFor="member-enabled" className="text-[13px] font-medium">启用成员</label>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">停用后立即阻止访问 Mailroom，并自动同步登录白名单。</p>
          </div>
          <Switch id="member-enabled" checked={editor.enabled} onCheckedChange={(enabled) => setEditor({ ...editor, enabled })} />
        </div>
        <MailboxPermissions mailboxes={members.data?.mailboxes ?? []} selected={editor.mailbox_ids}
          onChange={(mailbox_ids) => setEditor({ ...editor, mailbox_ids })} />
      </fieldset>
      {(validationError || save.isError) && <p role="alert" className="text-xs leading-5 text-destructive">{validationError ?? (save.error instanceof Error ? localizeErrorMessage(save.error.message) : "无法保存成员，请重试。")}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "正在保存…" : adding ? "添加成员" : "保存"}</Button>
        <Button type="button" variant="outline" size="sm" disabled={save.isPending} onClick={() => { setAdding(false); setEditor(null); setValidationError(null); save.reset(); }}>取消</Button>
      </div>
    </form>
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader active="members" onBack={props.onBack} onOpenGeneral={props.onOpenGeneral} onOpenInboxes={props.onOpenInboxes} onOpenMembers={() => undefined} />
      <SettingsPage>
        <SettingsBlock id="members-heading" title="成员与权限"
          description="为每位成员分配可访问的收件箱。成员可查看、回复和归档其中的邮件，也可请求 AI 草稿。"
          action={<Button size="sm" variant="outline" onClick={beginAdd} disabled={Boolean(editor) || members.isLoading || members.isError}><Users className="h-4 w-4" />添加成员</Button>}>
          {members.data && !members.isError && <AccessSyncPanel status={members.data.access_sync} busy={sync.isPending || save.isPending}
            error={sync.error} onSync={() => sync.mutate()} />}
          <p className="mb-4 text-xs leading-5 text-muted-foreground">新成员默认没有收件箱权限。未勾选任何收件箱时，该成员无法查看或发送邮件。</p>

          {saved && <p role="status" className="mb-4 text-[13px] leading-6 text-muted-foreground">{memberSavedMessage(saved, saved.hasSyncStatus ? members.data?.access_sync : undefined)}</p>}
          {members.isLoading ? <SettingsPanel><p className="p-5 text-sm text-muted-foreground" role="status">正在加载成员…</p></SettingsPanel>
            : members.isError ? <SettingsPanel><div className="p-5 text-sm" role="alert"><p>无法加载成员与权限。</p><Button variant="outline" size="sm" className="mt-3" onClick={() => members.refetch()}>重试</Button></div></SettingsPanel>
            : <div className="space-y-3">
              {adding && <SettingsPanel><div className="p-4 sm:p-5"><h3 className="mb-4 text-sm font-medium">添加成员</h3>{editorForm}</div></SettingsPanel>}
              {members.data?.members.map((member) => {
                const isAdmin = member.role === "admin";
                const editing = !adding && editor?.email === member.email;
                return <SettingsPanel key={member.email}>
                  <div className="flex items-start gap-3 p-4 sm:p-5">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">{isAdmin ? <ShieldCheck className="h-4 w-4" /> : <Users className="h-4 w-4" />}</span>
                    <div className="min-w-0 flex-1">
                      <p className="break-all text-[13.5px] font-medium">{member.email}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{isAdmin ? "唯一管理员" : "成员"}</Badge>
                        {!isAdmin && <span className={`text-xs ${member.enabled ? "text-muted-foreground" : "text-destructive"}`}>{member.enabled ? "已启用" : "已停用"}</span>}
                      </div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">{isAdmin ? "拥有全部收件箱的管理权限，管理员不可修改或停用。" : mailboxSummary(member, members.data?.mailboxes ?? [])}</p>
                    </div>
                    {!isAdmin && !editing && <Button variant="outline" size="sm" disabled={Boolean(editor)} onClick={() => beginEdit(member)}>编辑</Button>}
                  </div>
                  {editing && <div className="border-t px-4 py-4 sm:px-5">{editorForm}</div>}
                </SettingsPanel>;
              })}
            </div>}
        </SettingsBlock>
      </SettingsPage>
    </div>
  );
}

function AccessSyncPanel(props: {
  status: AccessSyncStatus | undefined;
  busy: boolean;
  error: Error | null;
  onSync: () => void;
}) {
  const { status } = props;
  const pending = status?.state === "pending";
  const needsSetup = status !== undefined && !status.configured;
  const failed = status?.state === "error" || props.error !== null;
  const label = failed ? "同步失败"
    : status?.state === "synced" ? "已同步"
    : pending ? "待同步"
      : needsSetup ? "尚未连接" : "状态暂不可用";
  const syncedAt = status?.last_synced_at ? new Date(status.last_synced_at) : null;
  const hasSyncedTime = syncedAt !== null && !Number.isNaN(syncedAt.getTime());

  return <section aria-labelledby="access-sync-heading" className="mb-4 overflow-hidden rounded-xl border bg-background">
    <div className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="access-sync-heading" className="text-[13.5px] font-medium">团队登录白名单</h3>
            <Badge variant={failed ? "destructive" : "secondary"}>{label}</Badge>
          </div>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            团队登录白名单以本页已启用成员为准；Cloudflare 账户成员规则仍由 Cloudflare 管理。
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={props.onSync}
          disabled={!status?.configured || props.busy}>
          {props.busy ? "正在同步…" : failed || props.error ? "重试同步" : "立即同步"}
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        添加或启用成员后会自动同步。停用会立即阻止访问 Mailroom，随后同步登录规则。成员使用同一网址和邮箱验证码登录。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        首次同步也会移除现有白名单中未列为已启用成员的邮箱。
      </p>
      <p role={failed ? "alert" : "status"} className={`text-[13px] leading-6 ${failed ? "text-destructive" : "text-muted-foreground"}`}>
        {props.error ? "本次同步请求未完成，可重试同步。" : status?.message ? localizeErrorMessage(status.message) : "无法确认登录白名单状态，请刷新成员列表后重试。"}
      </p>
      {hasSyncedTime && <p className="text-xs text-muted-foreground">最近同步：<time dateTime={status!.last_synced_at!}>{syncedAt.toLocaleString("zh-CN", { hour12: false })}</time></p>}
      {needsSetup && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-[13px] leading-6 text-amber-950 dark:border-amber-800 dark:bg-amber-950/25 dark:text-amber-100">
        <p>首次连接需管理员在 Worker 密钥中配置 <code className="font-mono text-xs">CF_ACCESS_API_TOKEN</code>（账号级 Access: Apps and Policies 编辑权限）。令牌不要发到聊天或代码仓库。</p>
        <p className="mt-2">配置后回到此页刷新，再点击“立即同步”。<span className="ml-2"><DashLink href={workerDashboardUrl("settings")}>打开 Worker 设置</DashLink></span></p>
      </div>}
      {props.error && <p role="alert" className="text-xs leading-5 text-destructive">同步请求未完成：{localizeErrorMessage(props.error.message)} 成员配置仍已保存在 Mailroom，请重试同步。</p>}
    </div>
  </section>;
}

function memberSavedMessage(saved: { create: boolean; enabled: boolean }, status: AccessSyncStatus | undefined): string {
  const prefix = saved.create
    ? saved.enabled ? "成员已添加。" : "成员已添加，当前已停用。"
    : saved.enabled ? "成员权限已保存。" : "成员已停用，Mailroom 访问权限已立即撤销。";
  if (!status) return `${prefix}尚未确认登录白名单同步结果，请刷新后检查上方状态。`;
  if (!status.configured || status.state === "not_configured") return `${prefix}请先连接 Cloudflare，登录白名单尚未同步。`;
  if (status.state === "error") return `${prefix}登录白名单同步失败，成员配置已保留，请点击“重试同步”。`;
  if (status.state === "pending") return `${prefix}登录白名单尚未同步完成，可点击“立即同步”重试。`;
  return `${prefix}团队登录白名单已同步。`;
}

function MailboxPermissions(props: {
  mailboxes: MembersResponse["mailboxes"];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  return <fieldset className="min-w-0">
    <legend className="text-[13px] font-medium">可访问的收件箱</legend>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">仅勾选需要授予权限的收件箱。</p>
    <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border">
      {props.mailboxes.length === 0 ? <p className="p-3 text-xs text-muted-foreground">尚无收件箱，请先在收件箱设置中添加。</p> : props.mailboxes.map((mailbox) => <label key={mailbox.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-3 text-[13px] last:border-0 hover:bg-muted/40">
        <Checkbox checked={props.selected.includes(mailbox.id)} onCheckedChange={(checked) => props.onChange(checked === true ? [...props.selected, mailbox.id] : props.selected.filter((id) => id !== mailbox.id))} />
        <span className="min-w-0 break-all">{mailbox.address}</span>
      </label>)}
    </div>
  </fieldset>;
}

function mailboxSummary(member: Member, mailboxes: MembersResponse["mailboxes"]): string {
  const addresses = mailboxes.filter((mailbox) => member.mailbox_ids.includes(mailbox.id)).map((mailbox) => mailbox.address);
  return addresses.length ? `可访问：${addresses.join("、")}` : "尚未分配收件箱";
}
