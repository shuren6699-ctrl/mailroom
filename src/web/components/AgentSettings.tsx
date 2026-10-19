import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Label, Mailbox, Playbook } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  activateDomain,
  createDomain,
  createLabel,
  createMailbox,
  createPlaybook,
  deleteLabel,
  deleteMailbox,
  deletePlaybook,
  fetchDomains,
  fetchLabels,
  fetchPlaybooks,
  updateLabel,
  updateMailbox,
  updatePlaybook,
} from "../api";
import {
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  TagIcon,
  TrashIcon,
} from "./Icons";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";
import { localizeErrorMessage } from "../ui-messages";

interface PlaybookEditorState {
  id?: number;
  name: string;
  whenToUse: string;
  instructions: string;
  exampleReply: string;
  enabled: boolean;
}

interface LabelEditorState {
  id?: number;
  name: string;
  condition: string;
}

interface InboxSetupState {
  address: string;
  localPart: string;
  domainName: string;
}

const CLOUDFLARE_EMAIL_ROUTING_URL =
  "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Frouting";
const CLOUDFLARE_EMAIL_SENDING_URL =
  "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Fsending";

const EMPTY_PLAYBOOK: PlaybookEditorState = {
  name: "",
  whenToUse: "",
  instructions: "",
  exampleReply: "",
  enabled: true,
};

const EMPTY_LABEL: LabelEditorState = {
  name: "",
  condition: "",
};

export function AgentSettings(props: {
  mailboxes: Mailbox[];
  mailboxId: number | null;
  onSelectMailbox: (id: number) => void;
  onMailboxDeleted: (nextMailboxId: number | null) => void;
  onOpenGeneral: () => void;
  onOpenMembers: () => void;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [baseInstructions, setBaseInstructions] = useState("");
  const [editor, setEditor] = useState<PlaybookEditorState | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<number | null>(null);
  const [labelEditor, setLabelEditor] = useState<LabelEditorState | null>(null);
  const [labelDeleteConfirmation, setLabelDeleteConfirmation] = useState<number | null>(null);
  const [mailboxEditorOpen, setMailboxEditorOpen] = useState(false);
  const [mailboxAddress, setMailboxAddress] = useState("");
  const [mailboxValidationError, setMailboxValidationError] = useState<string | null>(null);
  const [inboxSetup, setInboxSetup] = useState<InboxSetupState | null>(null);
  const [routingConfirmed, setRoutingConfirmed] = useState(false);
  const [sendingConfirmed, setSendingConfirmed] = useState(false);
  const [routingAddress, setRoutingAddress] = useState<string | null>(null);
  const [deleteInboxOpen, setDeleteInboxOpen] = useState(false);
  const [deleteInboxConfirmation, setDeleteInboxConfirmation] = useState("");

  const selectedMailboxId = props.mailboxId;
  const mailbox = props.mailboxes.find((item) => item.id === selectedMailboxId) ?? null;

  useEffect(() => {
    setBaseInstructions(mailbox?.agent_instructions ?? "");
    setDeleteConfirmation(null);
    setLabelDeleteConfirmation(null);
    setDeleteInboxOpen(false);
    setDeleteInboxConfirmation("");
  }, [mailbox]);

  const playbooks = useQuery({
    queryKey: ["playbooks", selectedMailboxId],
    queryFn: () => fetchPlaybooks(selectedMailboxId!),
    enabled: selectedMailboxId !== null,
  });

  const labels = useQuery({
    queryKey: ["labels", selectedMailboxId],
    queryFn: () => fetchLabels(selectedMailboxId!),
    enabled: selectedMailboxId !== null,
  });

  const domains = useQuery({
    queryKey: ["domains"],
    queryFn: fetchDomains,
  });

  const addMailbox = useMutation({
    mutationFn: (input: { localPart: string; domainId: number }) =>
      createMailbox({ local_part: input.localPart, domain_id: input.domainId }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      setMailboxEditorOpen(false);
      setMailboxAddress("");
      setInboxSetup(null);
      setRoutingAddress(created.address);
      props.onSelectMailbox(created.id);
    },
  });

  const configureAndAddMailbox = useMutation({
    mutationFn: async (setup: InboxSetupState) => {
      let domain = await createDomain({ name: setup.domainName });
      if (domain.status !== "active") domain = await activateDomain(domain.id);
      return createMailbox({ local_part: setup.localPart, domain_id: domain.id });
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      setMailboxEditorOpen(false);
      setMailboxAddress("");
      setInboxSetup(null);
      props.onSelectMailbox(created.id);
    },
  });

  const saveInstructions = useMutation({
    mutationFn: () =>
      updateMailbox(selectedMailboxId!, { agent_instructions: baseInstructions.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
  });

  const toggleDrafting = useMutation({
    mutationFn: (enabled: boolean) =>
      updateMailbox(selectedMailboxId!, { agent_mode: enabled ? "draft" : "off" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
      ]);
    },
  });

  const savePlaybook = useMutation({
    mutationFn: async (input: PlaybookEditorState) => {
      const payload = {
        mailbox_id: selectedMailboxId!,
        name: input.name.trim(),
        when_to_use: input.whenToUse.trim(),
        instructions: input.instructions.trim(),
        example_reply: input.exampleReply.trim() || null,
        enabled: input.enabled,
      };
      return input.id ? updatePlaybook(input.id, payload) : createPlaybook(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playbooks", selectedMailboxId] });
      setEditor(null);
    },
  });

  const togglePlaybook = useMutation({
    mutationFn: (playbook: Playbook) =>
      updatePlaybook(playbook.id, { enabled: !playbook.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["playbooks", selectedMailboxId] }),
  });

  const removePlaybook = useMutation({
    mutationFn: (id: number) => deletePlaybook(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playbooks", selectedMailboxId] });
      setDeleteConfirmation(null);
    },
  });

  const saveLabel = useMutation({
    mutationFn: async (input: LabelEditorState) => {
      const payload = {
        mailbox_id: selectedMailboxId!,
        name: input.name.trim(),
        condition: input.condition.trim(),
      };
      return input.id ? updateLabel(input.id, payload) : createLabel(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      setLabelEditor(null);
    },
  });

  const removeLabel = useMutation({
    mutationFn: (id: number) => deleteLabel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      setLabelDeleteConfirmation(null);
    },
  });

  const openLabelEditor = (label?: Label) => {
    setLabelEditor(
      label
        ? { id: label.id, name: label.name, condition: label.condition }
        : { ...EMPTY_LABEL },
    );
  };

  const removeMailbox = useMutation({
    mutationFn: (input: { id: number; address: string }) =>
      deleteMailbox(input.id, deleteInboxConfirmation),
    onSuccess: async (_, deleted) => {
      const remainingMailboxes = props.mailboxes.filter((item) => item.id !== deleted.id);
      queryClient.setQueryData<Mailbox[]>(["mailboxes"], remainingMailboxes);
      queryClient.removeQueries({ queryKey: ["playbooks", deleted.id] });
      queryClient.removeQueries({ queryKey: ["threads"] });
      queryClient.removeQueries({ queryKey: ["thread"] });
      setDeleteInboxOpen(false);
      setDeleteInboxConfirmation("");
      props.onMailboxDeleted(remainingMailboxes[0]?.id ?? null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
        queryClient.invalidateQueries({ queryKey: ["domains"] }),
      ]);
    },
  });

  const instructionsDirty =
    baseInstructions.trim() !== (mailbox?.agent_instructions ?? "").trim();

  const openEditor = (playbook?: Playbook) => {
    setEditor(
      playbook
        ? {
            id: playbook.id,
            name: playbook.name,
            whenToUse: playbook.when_to_use,
            instructions: playbook.instructions,
            exampleReply: playbook.example_reply ?? "",
            enabled: Boolean(playbook.enabled),
          }
        : { ...EMPTY_PLAYBOOK },
    );
  };

  const openMailboxEditor = () => {
    addMailbox.reset();
    configureAndAddMailbox.reset();
    setMailboxAddress("");
    setMailboxValidationError(null);
    setInboxSetup(null);
    setRoutingConfirmed(false);
    setSendingConfirmed(false);
    setMailboxEditorOpen(true);
  };

  const prepareInbox = () => {
    const parsed = parseInboxAddress(mailboxAddress);
    if (!parsed) {
      setMailboxValidationError("请输入有效的邮箱地址");
      return;
    }
    setMailboxValidationError(null);
    addMailbox.reset();
    configureAndAddMailbox.reset();

    const domain = domains.data?.find((item) => item.name === parsed.domainName);
    if (domain?.status === "active") {
      addMailbox.mutate({ localPart: parsed.localPart, domainId: domain.id });
      return;
    }
    setRoutingConfirmed(false);
    setSendingConfirmed(false);
    setInboxSetup(parsed);
  };

  const setupStepsRemaining = Number(!routingConfirmed) + Number(!sendingConfirmed);

  const activePlaybookCount = playbooks.data?.filter((item) => item.enabled).length ?? 0;

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="inboxes"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenMembers={props.onOpenMembers}
        onOpenInboxes={() => undefined}
      />

      <SettingsPage>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <MailboxSelect
              mailboxes={props.mailboxes}
              selectedMailboxId={selectedMailboxId}
              onSelect={props.onSelectMailbox}
            />
          </div>
          <Button variant="outline" className="h-9 self-start sm:self-auto" onClick={openMailboxEditor}>
            <PlusIcon className="h-4 w-4" />
            添加收件箱
          </Button>
        </div>

        {mailbox ? (
          <>
            {!mailbox.has_received && (
              <SettingsBlock
                id="email-routing-heading"
                title="邮件路由"
                description="尚未收到邮件。请确认 Email Routing 已将此地址的邮件发送到 Mailroom，然后发送一封测试邮件。"
              >
                <Button
                  variant="link"
                  className="h-auto p-0 underline decoration-muted-foreground/50 hover:decoration-current"
                  onClick={() => setRoutingAddress(mailbox.address)}
                >
                  查看设置步骤
                </Button>
              </SettingsBlock>
            )}

            <SettingsBlock id="agent-drafting-heading" title="AI 草稿">
              <SettingsPanel>
                <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="agent-drafting"
                      className="text-[13.5px] font-medium text-foreground"
                    >
                      为新邮件生成回复草稿
                    </label>
                    <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
                      为客户的新邮件生成回复草稿。所有草稿均需你确认后才会发送。
                    </p>
                    {toggleDrafting.isError && (
                      <p className="mt-2 text-xs text-destructive" role="alert">
                        无法更新 AI 草稿设置，请重试。
                      </p>
                    )}
                  </div>
                  <Switch
                    id="agent-drafting"
                    checked={
                      toggleDrafting.isPending
                        ? toggleDrafting.variables
                        : mailbox.agent_mode !== "off"
                    }
                    onCheckedChange={(checked) => toggleDrafting.mutate(checked)}
                    disabled={toggleDrafting.isPending}
                    aria-describedby="agent-drafting-description"
                    className="mt-0.5"
                  />
                  <span id="agent-drafting-description" className="sr-only">
                    启用后，AI 会生成回复草稿，需经你审核后才能发送。
                  </span>
                </div>
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock
              id="base-instructions-heading"
              title="基础指令"
              description="适用于此收件箱所有 AI 草稿的产品背景和回复要求。"
            >
              <SettingsPanel className="transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
                <Textarea
                  value={baseInstructions}
                  onChange={(event) => setBaseInstructions(event.target.value)}
                  rows={4}
                  aria-labelledby="base-instructions-heading"
                  placeholder="描述产品、AI 助手的角色、语气、通用规则和签名…"
                  className="max-h-[60dvh] min-h-32 resize-y rounded-none border-0 bg-transparent px-4 py-3.5 text-sm leading-6 shadow-none focus-visible:ring-0 sm:px-5 md:text-sm"
                />
                <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-2.5 sm:px-5">
                  <p className="min-w-0 text-xs text-muted-foreground" aria-live="polite">
                    {saveInstructions.isError ? (
                      <span className="text-destructive">无法保存指令，请重试。</span>
                    ) : instructionsDirty ? (
                      "有未保存的更改"
                    ) : saveInstructions.isSuccess ? (
                      "所有更改已保存"
                    ) : null}
                  </p>
                  <Button
                    size="sm"
                    onClick={() => saveInstructions.mutate()}
                    disabled={saveInstructions.isPending || !instructionsDirty}
                  >
                    {saveInstructions.isPending ? "正在保存…" : "保存指令"}
                  </Button>
                </div>
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock
              id="labels-heading"
              title="标签"
              description="新会话会自动添加所有匹配条件的标签。现有会话中的回复不会添加标签。"
              action={
                <Button variant="outline" size="sm" onClick={() => openLabelEditor()}>
                  <PlusIcon className="h-3.5 w-3.5" />
                  新建标签
                </Button>
              }
            >
              <SettingsPanel>
                {labels.isLoading && <ListSkeleton />}
                {labels.isError && <ListMessage tone="error">无法加载标签。</ListMessage>}
                {labels.data?.length === 0 && (
                  <ListMessage icon={<TagIcon className="h-4 w-4" />}>暂无标签</ListMessage>
                )}
                {labels.data && labels.data.length > 0 && (
                  <ul className="divide-y">
                    {labels.data.map((label) => (
                      <LabelRow
                        key={label.id}
                        label={label}
                        deleting={removeLabel.isPending && labelDeleteConfirmation === label.id}
                        confirmDelete={labelDeleteConfirmation === label.id}
                        onEdit={() => openLabelEditor(label)}
                        onRequestDelete={() => setLabelDeleteConfirmation(label.id)}
                        onCancelDelete={() => setLabelDeleteConfirmation(null)}
                        onDelete={() => removeLabel.mutate(label.id)}
                      />
                    ))}
                  </ul>
                )}
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock
              id="playbooks-heading"
              title="回复指南"
              description={
                playbooks.data?.length
                  ? `已启用 ${activePlaybookCount} 项，共 ${playbooks.data.length} 项。匹配的回复指南会与基础指令结合使用。`
                  : "针对特定客服场景的回复要求，会在会话匹配时与基础指令结合使用。"
              }
              action={
                <Button variant="outline" size="sm" onClick={() => openEditor()}>
                  <PlusIcon className="h-3.5 w-3.5" />
                  新建回复指南
                </Button>
              }
            >
              <SettingsPanel>
                {playbooks.isLoading && <ListSkeleton />}
                {playbooks.isError && <ListMessage tone="error">无法加载回复指南。</ListMessage>}
                {playbooks.data?.length === 0 && (
                  <ListMessage icon={<SparklesIcon className="h-4 w-4" />}>暂无回复指南</ListMessage>
                )}
                {playbooks.data && playbooks.data.length > 0 && (
                  <ul className="divide-y">
                    {playbooks.data.map((playbook) => (
                      <PlaybookRow
                        key={playbook.id}
                        playbook={playbook}
                        toggling={togglePlaybook.isPending}
                        deleting={removePlaybook.isPending && deleteConfirmation === playbook.id}
                        confirmDelete={deleteConfirmation === playbook.id}
                        onToggle={() => togglePlaybook.mutate(playbook)}
                        onEdit={() => openEditor(playbook)}
                        onRequestDelete={() => setDeleteConfirmation(playbook.id)}
                        onCancelDelete={() => setDeleteConfirmation(null)}
                        onDelete={() => removePlaybook.mutate(playbook.id)}
                      />
                    ))}
                  </ul>
                )}
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock id="danger-zone-heading" title="危险操作">
              <SettingsPanel className="border-destructive/25">
                <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium text-foreground">删除收件箱</p>
                    <p className="mt-1 break-words text-[13px] leading-5 text-muted-foreground">
                      永久删除 {mailbox.address} 及其所有会话。
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    className="self-start sm:self-auto"
                    onClick={() => {
                      removeMailbox.reset();
                      setDeleteInboxConfirmation("");
                      setDeleteInboxOpen(true);
                    }}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    删除收件箱
                  </Button>
                </div>
              </SettingsPanel>
            </SettingsBlock>
          </>
        ) : (
          <SettingsPanel>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <SparklesIcon className="h-[18px] w-[18px]" />
              </span>
              <p className="mt-3 text-[13px] font-medium text-foreground">暂无可配置的收件箱</p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                请先添加收件箱，再配置 AI 助手。
              </p>
              <Button className="mt-4" onClick={openMailboxEditor}>
                <PlusIcon className="h-4 w-4" />
                添加收件箱
              </Button>
            </div>
          </SettingsPanel>
        )}
      </SettingsPage>

      {editor && (
        <PlaybookEditor
          state={editor}
          saving={savePlaybook.isPending}
          error={savePlaybook.isError}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSave={() => savePlaybook.mutate(editor)}
        />
      )}

      {labelEditor && (
        <LabelEditor
          state={labelEditor}
          saving={saveLabel.isPending}
          error={saveLabel.isError}
          errorMessage={
            saveLabel.error instanceof Error ? localizeErrorMessage(saveLabel.error.message) : null
          }
          onChange={setLabelEditor}
          onClose={() => setLabelEditor(null)}
          onSave={() => saveLabel.mutate(labelEditor)}
        />
      )}

      <Dialog
        open={mailboxEditorOpen}
        onOpenChange={(open) => {
          if (addMailbox.isPending || configureAndAddMailbox.isPending) return;
          setMailboxEditorOpen(open);
          if (!open) {
            addMailbox.reset();
            configureAndAddMailbox.reset();
            setMailboxValidationError(null);
            setInboxSetup(null);
            setRoutingConfirmed(false);
            setSendingConfirmed(false);
          }
        }}
      >
        <DialogContent
          showCloseButton={!addMailbox.isPending && !configureAndAddMailbox.isPending}
          className={`max-h-[calc(100dvh-2rem)] overflow-y-auto ${inboxSetup ? "sm:max-w-[40rem]" : "sm:max-w-md"}`}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (inboxSetup) {
                if (setupStepsRemaining === 0) configureAndAddMailbox.mutate(inboxSetup);
              }
              else prepareInbox();
            }}
          >
            <DialogHeader>
              <DialogTitle>{inboxSetup ? "设置收件箱" : "添加收件箱"}</DialogTitle>
            </DialogHeader>

            {!inboxSetup ? (
              <div className="py-5">
                <Field label="邮箱地址">
                  <Input
                    type="email"
                    value={mailboxAddress}
                    onChange={(event) => {
                      setMailboxAddress(event.target.value);
                      setMailboxValidationError(null);
                      if (addMailbox.isError) addMailbox.reset();
                    }}
                    placeholder="support@example.com"
                    autoComplete="off"
                    autoFocus
                    required
                    aria-invalid={Boolean(mailboxValidationError || addMailbox.isError)}
                  />
                </Field>

                {domains.isError && (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                    <p className="text-sm text-destructive">无法检查邮箱配置。</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => domains.refetch()}>
                      重试
                    </Button>
                  </div>
                )}

                {(mailboxValidationError || addMailbox.isError) && (
                  <p className="mt-3 text-sm text-destructive" role="alert">
                    {mailboxValidationError ??
                      (addMailbox.error instanceof Error
                        ? localizeErrorMessage(addMailbox.error.message)
                        : "无法添加此收件箱")}
                  </p>
                )}
              </div>
            ) : (
              <div className="py-5">
                <div className="flex items-center justify-between gap-3 border-b pb-4">
                  <p className="min-w-0 truncate text-sm font-medium">{inboxSetup.address}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={configureAndAddMailbox.isPending}
                    onClick={() => {
                      configureAndAddMailbox.reset();
                      setInboxSetup(null);
                      setRoutingConfirmed(false);
                      setSendingConfirmed(false);
                    }}
                  >
                    编辑
                  </Button>
                </div>

                <p className="pt-4 text-sm leading-5 text-muted-foreground">
                  请在 Cloudflare 中完成以下两步，让此收件箱能够收发邮件。
                </p>

                <ol className="divide-y">
                  <li className="flex items-start gap-3 py-4">
                    <SetupStepNumber number={1} done={routingConfirmed} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">将收到的邮件路由到 Mailroom</h3>
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm leading-5 text-muted-foreground marker:text-muted-foreground/70">
                        <li>
                          打开{" "}
                          <span className="break-words font-medium text-foreground">{inboxSetup.domainName}</span>{" "}
                          的 Email Routing，进入路由规则。
                        </li>
                        <li>
                          启用<span className="font-medium text-foreground">全收（Catch-all）</span>。
                          Mailroom 仍会拒收尚未添加的地址。
                        </li>
                        <li>
                          选择<span className="font-medium text-foreground">发送到 Worker</span>，
                          选择运行此 Mailroom 的 Worker，然后保存。
                        </li>
                      </ol>
                      <details className="mt-2 text-sm leading-5">
                        <summary className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                          使用子域名，或仅路由此地址？
                        </summary>
                        <p className="mt-1 text-muted-foreground">
                          全收仅适用于根域名。也可以将{" "}
                          <span className="break-words font-medium text-foreground">{inboxSetup.address}</span>{" "}
                          添加为自定义地址，并发送到同一个 Worker。
                        </p>
                      </details>
                      <Button asChild type="button" variant="outline" size="sm" className="mt-3">
                        <a href={CLOUDFLARE_EMAIL_ROUTING_URL} target="_blank" rel="noreferrer">
                          打开 Email Routing
                          <ExternalLinkIcon />
                        </a>
                      </Button>
                      <SetupStepConfirm
                        id="confirm-email-routing"
                        checked={routingConfirmed}
                        onCheckedChange={setRoutingConfirmed}
                        label="我已完成路由设置"
                      />
                    </div>
                  </li>
                  <li className="flex items-start gap-3 py-4">
                    <SetupStepNumber number={2} done={sendingConfirmed} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">启用此域名的发信功能</h3>
                      <p className="mt-2 text-sm leading-5 text-muted-foreground">
                        在 Email Sending 中添加{" "}
                        <span className="break-words font-medium text-foreground">{inboxSetup.domainName}</span>{" "}
                        ，等待状态变为“已启用（Active）”。这可能需要几分钟。
                      </p>
                      <Button asChild type="button" variant="outline" size="sm" className="mt-3">
                        <a href={CLOUDFLARE_EMAIL_SENDING_URL} target="_blank" rel="noreferrer">
                          打开 Email Sending
                          <ExternalLinkIcon />
                        </a>
                      </Button>
                      <SetupStepConfirm
                        id="confirm-email-sending"
                        checked={sendingConfirmed}
                        onCheckedChange={setSendingConfirmed}
                        label="发信功能已启用"
                      />
                    </div>
                  </li>
                </ol>

                {configureAndAddMailbox.isError && (
                  <p className="text-sm text-destructive" role="alert">
                    {configureAndAddMailbox.error instanceof Error
                      ? localizeErrorMessage(configureAndAddMailbox.error.message)
                      : "无法添加此收件箱"}
                  </p>
                )}
              </div>
            )}

            <DialogFooter className="flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {inboxSetup && (
                <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
                  {setupStepsRemaining === 0
                    ? "可以添加了"
                    : setupStepsRemaining === 1
                      ? "还剩 1 步"
                      : "还剩 2 步"}
                </p>
              )}
              <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={addMailbox.isPending || configureAndAddMailbox.isPending}
                  onClick={() => setMailboxEditorOpen(false)}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    domains.isLoading ||
                    domains.isError ||
                    (!inboxSetup && !mailboxAddress.trim()) ||
                    (inboxSetup !== null && setupStepsRemaining > 0) ||
                    addMailbox.isPending ||
                    configureAndAddMailbox.isPending
                  }
                >
                  {addMailbox.isPending || configureAndAddMailbox.isPending
                    ? "正在添加…"
                    : "添加收件箱"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={routingAddress !== null}
        onOpenChange={(open) => {
          if (!open) setRoutingAddress(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>设置邮件路由</DialogTitle>
            <DialogDescription>
              如果全收规则或此地址的规则已经将邮件发送到此 Mailroom Worker，
              则无需再做其他设置。
            </DialogDescription>
          </DialogHeader>
          <div>
            <h3 className="text-sm font-medium">全收（Catch-all，建议根域名使用）</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              只需配置一次，以后在 Mailroom 中添加收件箱时无需再添加路由规则。
            </p>
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-6">
            <li>
              打开 <span className="break-all font-medium">{routingAddress?.split("@")[1]}</span> 的
              Email Routing，进入路由规则。
            </li>
            <li>
              启用<span className="font-medium">全收（Catch-all）</span>。
            </li>
            <li>
              选择<span className="font-medium">发送到 Worker</span>，选择运行
              此 Mailroom 的 Worker，然后保存规则。
            </li>
          </ol>
          <p className="text-sm leading-5 text-muted-foreground">
            Mailroom 会拒收尚未添加的地址。特定地址的现有规则
            优先于全收规则。
          </p>
          <details className="text-sm leading-6">
            <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              仅路由此地址，或使用子域名
            </summary>
            <p className="mt-2 text-muted-foreground">
              全收仅适用于根域名。如需单独路由此地址，
              请在路由规则中将 <span className="break-words font-medium text-foreground">{routingAddress}</span> 添加为
              自定义地址。选择“发送到 Worker”，再选择运行
              此 Mailroom 的 Worker，然后保存。
            </p>
          </details>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoutingAddress(null)}>关闭</Button>
            <Button asChild>
              <a href={CLOUDFLARE_EMAIL_ROUTING_URL} target="_blank" rel="noreferrer">
                打开 Email Routing
                <ExternalLinkIcon />
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteInboxOpen}
        onOpenChange={(open) => {
          if (removeMailbox.isPending) return;
          setDeleteInboxOpen(open);
          if (!open) {
            setDeleteInboxConfirmation("");
            removeMailbox.reset();
          }
        }}
      >
        <DialogContent showCloseButton={!removeMailbox.isPending} className="sm:max-w-md">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                mailbox &&
                deleteInboxConfirmation === mailbox.address &&
                !removeMailbox.isPending
              ) {
                removeMailbox.mutate({ id: mailbox.id, address: mailbox.address });
              }
            }}
          >
            <DialogHeader>
              <DialogTitle className="break-words">删除 {mailbox?.address}？</DialogTitle>
              <DialogDescription>
                此操作将永久删除其中的会话、草稿和回复指南，无法撤销。
              </DialogDescription>
            </DialogHeader>

            {mailbox && (
              <Field label={`请输入 ${mailbox.address} 以确认`}>
                <Input
                  value={deleteInboxConfirmation}
                  onChange={(event) => {
                    setDeleteInboxConfirmation(event.target.value);
                    if (removeMailbox.isError) removeMailbox.reset();
                  }}
                  autoComplete="off"
                  autoFocus
                  disabled={removeMailbox.isPending}
                  aria-invalid={removeMailbox.isError}
                />
              </Field>
            )}

            {removeMailbox.isError && (
              <p className="text-sm text-destructive" role="alert">
                {removeMailbox.error instanceof Error
                  ? localizeErrorMessage(removeMailbox.error.message)
                  : "无法删除此收件箱"}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteInboxOpen(false)}
                disabled={removeMailbox.isPending}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  !mailbox ||
                  deleteInboxConfirmation !== mailbox.address ||
                  removeMailbox.isPending
                }
              >
                {removeMailbox.isPending ? "正在删除…" : "删除收件箱"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function parseInboxAddress(value: string): InboxSetupState | null {
  const address = value.trim().toLowerCase();
  const separator = address.lastIndexOf("@");
  if (separator <= 0 || separator === address.length - 1) return null;

  const localPart = address.slice(0, separator);
  const domainName = address.slice(separator + 1);
  const validLocalPart =
    localPart.length <= 64 &&
    !localPart.startsWith(".") &&
    !localPart.endsWith(".") &&
    !localPart.includes("..") &&
    /^[a-z0-9._+-]+$/.test(localPart);
  const validDomain =
    domainName.length <= 253 &&
    domainName.includes(".") &&
    domainName.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );

  return validLocalPart && validDomain ? { address, localPart, domainName } : null;
}

function PlaybookRow(props: {
  playbook: Playbook;
  toggling: boolean;
  deleting: boolean;
  confirmDelete: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const enabled = Boolean(props.playbook.enabled);
  return (
    <ListRow
      title={props.playbook.name}
      badge={
        !enabled && (
          <Badge variant="secondary" className="h-5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground">
            已停用
          </Badge>
        )
      }
      muted={!enabled}
      description={props.playbook.when_to_use}
      detail={props.playbook.instructions}
      entity="回复指南"
      deleting={props.deleting}
      confirmDelete={props.confirmDelete}
      onEdit={props.onEdit}
      onRequestDelete={props.onRequestDelete}
      onCancelDelete={props.onCancelDelete}
      onDelete={props.onDelete}
      leading={
        <Switch
          aria-label={`${enabled ? "停用" : "启用"} ${props.playbook.name}`}
          onCheckedChange={props.onToggle}
          checked={enabled}
          disabled={props.toggling}
          className="mt-0.5"
        />
      }
    />
  );
}

function ListRow(props: {
  title: string;
  badge?: React.ReactNode;
  description: string;
  detail?: string;
  muted?: boolean;
  entity: string;
  leading: React.ReactNode;
  deleting: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group flex items-start gap-3 px-4 py-3.5 sm:px-5">
      <span className="flex h-6 shrink-0 items-center">{props.leading}</span>
      <div className={`min-w-0 flex-1 transition-opacity ${props.muted ? "opacity-60" : ""}`}>
        <div className="flex min-h-6 flex-wrap items-center gap-2">
          <h3 className="text-[13.5px] font-medium text-foreground">{props.title}</h3>
          {props.badge}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
          {props.description}
        </p>
        {props.detail && (
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground/90">
            <span className="font-medium text-foreground/70">回复要求 · </span>
            {props.detail}
          </p>
        )}
      </div>
      {props.confirmDelete ? (
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label={`确认删除 ${props.title}`}>
          <span className="mr-1 hidden text-xs text-destructive sm:inline">删除此{props.entity}？</span>
          <Button variant="ghost" size="sm" onClick={props.onCancelDelete}>
            取消
          </Button>
          <Button variant="destructive" size="sm" onClick={props.onDelete} disabled={props.deleting}>
            {props.deleting ? "正在删除…" : "删除"}
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onEdit}
            className="text-muted-foreground"
            aria-label={`编辑 ${props.title}`}
            title="编辑"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onRequestDelete}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={`删除 ${props.title}`}
            title="删除"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </li>
  );
}

function ListMessage(props: { icon?: React.ReactNode; tone?: "error"; children: React.ReactNode }) {
  return (
    <div
      role={props.tone === "error" ? "alert" : undefined}
      className={`flex items-center gap-3 px-4 py-4 text-[13px] sm:px-5 ${
        props.tone === "error" ? "bg-destructive/5 text-destructive" : "text-muted-foreground"
      }`}
    >
      {props.icon && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
          {props.icon}
        </span>
      )}
      {props.children}
    </div>
  );
}

function MailboxSelect(props: {
  mailboxes: Mailbox[];
  selectedMailboxId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <Select
      value={props.selectedMailboxId === null ? undefined : String(props.selectedMailboxId)}
      onValueChange={(value) => props.onSelect(Number(value))}
    >
      <SelectTrigger className="h-9 w-full bg-background text-sm" aria-label="要配置的收件箱">
        <SelectValue placeholder="选择收件箱" />
      </SelectTrigger>
      <SelectContent>
        {props.mailboxes.map((item) => (
          <SelectItem key={item.id} value={String(item.id)}>
            {item.address}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PlaybookEditor(props: {
  state: PlaybookEditorState;
  saving: boolean;
  error: boolean;
  onChange: (state: PlaybookEditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const valid =
    props.state.name.trim() &&
    props.state.whenToUse.trim() &&
    props.state.instructions.trim();

  const update = (fields: Partial<PlaybookEditorState>) =>
    props.onChange({ ...props.state, ...fields });

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.state.id ? "编辑回复指南" : "新建回复指南"}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Field label="名称">
            <Input
              value={props.state.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="退款申请"
              autoFocus
            />
          </Field>

          <Field label="使用场景">
            <Textarea
              value={props.state.whenToUse}
              onChange={(event) => update({ whenToUse: event.target.value })}
              placeholder="当客户要求取消扣款、撤销付款或退款时使用。"
              rows={3}
            />
          </Field>

          <Field label="回复要求">
            <Textarea
              value={props.state.instructions}
              onChange={(event) => update({ instructions: event.target.value })}
              placeholder="确认已收到申请。在承诺退款前核实付款信息，不要承诺具体到账日期。"
              rows={5}
            />
          </Field>

          <Field label="回复示例（选填）">
            <Textarea
              value={props.state.exampleReply}
              onChange={(event) => update({ exampleReply: event.target.value })}
              placeholder="感谢你的来信…"
              rows={5}
            />
          </Field>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border bg-muted/40 px-3.5 py-3">
            <span className="text-[13px] font-medium text-foreground">启用</span>
            <Switch
              checked={props.state.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
            />
          </label>

          {props.error && (
            <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
              无法保存此回复指南，请检查填写内容后重试。
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={props.onClose}
          >
            取消
          </Button>
          <Button
            onClick={props.onSave}
            disabled={!valid || props.saving}
          >
            {props.saving ? "正在保存…" : props.state.id ? "保存更改" : "创建回复指南"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-foreground">{props.label}</span>
      <span className="mt-1.5 block">{props.children}</span>
    </label>
  );
}

function LabelRow(props: {
  label: Label;
  deleting: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <ListRow
      title={props.label.name}
      description={props.label.condition}
      entity="标签"
      deleting={props.deleting}
      confirmDelete={props.confirmDelete}
      onEdit={props.onEdit}
      onRequestDelete={props.onRequestDelete}
      onCancelDelete={props.onCancelDelete}
      onDelete={props.onDelete}
      leading={<TagIcon className="h-4 w-4 text-muted-foreground" />}
    />
  );
}

function LabelEditor(props: {
  state: LabelEditorState;
  saving: boolean;
  error: boolean;
  errorMessage: string | null;
  onChange: (state: LabelEditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const valid = props.state.name.trim() && props.state.condition.trim();

  const update = (fields: Partial<LabelEditorState>) =>
    props.onChange({ ...props.state, ...fields });

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.state.id ? "编辑标签" : "新建标签"}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Field label="名称">
            <Input
              value={props.state.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="投稿"
              autoFocus
            />
          </Field>

          <Field label="匹配条件">
            <Textarea
              value={props.state.condition}
              onChange={(event) => update({ condition: event.target.value })}
              placeholder="当发件人希望为我们的博客撰写文章，或请求我们发布其投稿时添加此标签。"
              rows={4}
            />
            <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
              系统会根据此描述检查新收到的邮件。现有会话中的回复不会添加标签。
            </span>
          </Field>

          {props.error && (
            <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
              {props.errorMessage ?? "无法保存此标签，请检查填写内容后重试。"}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={props.onClose}
          >
            取消
          </Button>
          <Button
            onClick={props.onSave}
            disabled={!valid || props.saving}
          >
            {props.saving ? "正在保存…" : props.state.id ? "保存更改" : "创建标签"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y" aria-busy="true">
      {[0, 1].map((item) => (
        <div key={item} className="flex animate-pulse items-start gap-3 px-4 py-4 sm:px-5">
          <span className="h-5 w-5 rounded bg-muted" />
          <div className="flex-1 space-y-2">
            <span className="block h-3 w-1/4 rounded bg-muted" />
            <span className="block h-2.5 w-3/4 rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SetupStepNumber(props: { number: number; done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums transition-colors ${
        props.done ? "bg-foreground text-background" : "border text-muted-foreground"
      }`}
    >
      {props.number}
    </span>
  );
}

function SetupStepConfirm(props: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <Checkbox
        id={props.id}
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
      />
      <label htmlFor={props.id} className="cursor-pointer text-sm">
        {props.label}
      </label>
    </div>
  );
}
