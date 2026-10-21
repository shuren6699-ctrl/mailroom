import { useDeferredValue, useEffect, useRef, useState } from "react";
import { keepPreviousData, QueryClientProvider, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  accessSetupError,
  fetchLabels,
  fetchMailboxes,
  fetchCurrentUser,
  fetchThreads,
  searchThreads,
  THREAD_PAGE_SIZE,
  type ThreadCursor,
  type CurrentUser,
} from "./api";
import { AccessSetup } from "./components/AccessSetup";
import { AgentSettings } from "./components/AgentSettings";
import { GeneralSettings } from "./components/GeneralSettings";
import { MembersSettings } from "./components/MembersSettings";
import { Button } from "@/components/ui/button";
import { ComposeEmailProvider, useCompose } from "./components/ComposeEmail";
import { InboxIcon } from "./components/Icons";
import { Sidebar } from "./components/Sidebar";
import { ThreadList, type ThreadFilter, type ThreadScope } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { useUnreadIndicator } from "./use-unread-indicator";
import { reconcileBrowserPushIdentity } from "./push-notifications";
import { createWorkspaceQueryClient } from "./workspace-query-client";

type WorkspaceView = "inbox" | "archive" | "settings";
type SettingsSection = "general" | "inboxes" | "members";

export function App() {
  const queryClient = useQueryClient();
  const [activeIdentity, setActiveIdentity] = useState<string | null>(null);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [identityTransitionError, setIdentityTransitionError] = useState(false);
  const [identityTransitionAttempt, setIdentityTransitionAttempt] = useState(0);
  const reconciledPushEmail = useRef<string | null>(null);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: fetchCurrentUser,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (me.isSuccess && !me.isFetching) setIdentityVerified(true);
  }, [me.isFetching, me.isSuccess]);
  const identity = identityVerified && me.data && !me.isError
    ? JSON.stringify([me.data.email, me.data.role, me.data.enabled, [...me.data.mailbox_ids].sort((a, b) => a - b)])
    : null;
  const identityEmail = identity === null ? null : me.data!.email.trim().toLowerCase();

  useEffect(() => {
    if (identity === activeIdentity) {
      setIdentityTransitionError(false);
      return;
    }
    let cancelled = false;
    setActiveIdentity(null);
    setIdentityTransitionError(false);
    // Never reuse mailbox, message, settings or mutation data across identities
    // or permission changes. Unmount the workspace before clearing its queries.
    void (async () => {
      try {
        await queryClient.cancelQueries({ predicate: (query) => query.queryKey[0] !== "me" });
        if (cancelled) return;
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
        queryClient.getMutationCache().clear();
        // Missing persistent ownership also triggers cleanup inside the helper,
        // covering subscriptions created before per-member notifications existed.
        if (identityEmail !== null && reconciledPushEmail.current !== identityEmail) {
          reconciledPushEmail.current = null;
          await reconcileBrowserPushIdentity(identityEmail);
          if (cancelled) return;
          reconciledPushEmail.current = identityEmail;
        }
        if (!cancelled) setActiveIdentity(identity);
      } catch {
        if (!cancelled) setIdentityTransitionError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [activeIdentity, identity, identityEmail, identityTransitionAttempt, queryClient]);

  const setupError = accessSetupError(me.error);
  if (setupError) return <AccessSetup error={setupError} onRetry={() => { void me.refetch(); }} retrying={me.isFetching} />;
  if (me.isError) return <IdentityState title="无法确认当前账号权限" detail="请重试；若账号已停用，请联系管理员。" onRetry={() => { void me.refetch(); }} retrying={me.isFetching} />;
  if (identityTransitionError) return <IdentityState title="无法完成此浏览器的账号切换" detail="旧账号的浏览器通知尚未清理，请重试。" onRetry={() => { setIdentityTransitionError(false); setIdentityTransitionAttempt((attempt) => attempt + 1); }} />;
  if (!identityVerified || !me.data || identity !== activeIdentity) return <IdentityState title="正在确认账号权限…" />;
  if (!me.data.enabled) return <IdentityState title="当前账号尚未启用" detail="尚未添加为成员或已被停用，请联系管理员。" />;

  return <AuthenticatedApp key={activeIdentity} user={me.data} />;
}

function AuthenticatedApp({ user }: { user: CurrentUser }) {
  const isAdmin = user.role === "admin";
  // A late mutation callback may still run after unmounting. Keeping its client
  // separate prevents it from writing private data into the next user's cache.
  const [workspaceQueryClient] = useState(createWorkspaceQueryClient);
  useEffect(() => () => {
    void workspaceQueryClient.cancelQueries();
    workspaceQueryClient.clear();
  }, [workspaceQueryClient]);
  return (
    <QueryClientProvider client={workspaceQueryClient}>
    <ComposeEmailProvider isAdmin={isAdmin}>
    <Routes>
      <Route path="/" element={<Navigate to="/inbox" replace />} />
      <Route path="/inbox" element={<Workspace view="inbox" user={user} />} />
      <Route path="/inbox/:threadId" element={<Workspace view="inbox" user={user} />} />
      <Route path="/archive" element={<Workspace view="archive" user={user} />} />
      <Route path="/archive/:threadId" element={<Workspace view="archive" user={user} />} />
      <Route path="/mailboxes/:mailboxId" element={<Workspace view="inbox" mailboxScoped user={user} />} />
      <Route
        path="/mailboxes/:mailboxId/threads/:threadId"
        element={<Workspace view="inbox" mailboxScoped user={user} />}
      />
      <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
      <Route
        path="/settings/general"
        element={<Workspace view="settings" settingsSection="general" user={user} />}
      />
      <Route
        path="/settings/inboxes"
        element={isAdmin ? <Workspace view="settings" settingsSection="inboxes" user={user} /> : <Navigate to="/settings/general" replace />}
      />
      <Route
        path="/settings/inboxes/:mailboxId"
        element={isAdmin ? <Workspace view="settings" settingsSection="inboxes" user={user} /> : <Navigate to="/settings/general" replace />}
      />
      <Route path="/settings/members" element={isAdmin ? <Workspace view="settings" settingsSection="members" user={user} /> : <Navigate to="/settings/general" replace />} />
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
    </ComposeEmailProvider>
    </QueryClientProvider>
  );
}

function Workspace(props: {
  user: CurrentUser;
  view: WorkspaceView;
  mailboxScoped?: boolean;
  settingsSection?: SettingsSection;
}) {
  const navigate = useNavigate();
  const openCompose = useCompose();
  const location = useLocation();
  const params = useParams<{ mailboxId?: string; threadId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const autoSelectedScope = useRef<string | null>(null);
  const isAdmin = props.user.role === "admin";

  const routeMailboxId = parseId(params.mailboxId);
  const selectedMailbox =
    props.mailboxScoped ||
    (props.view === "settings" && props.settingsSection === "inboxes")
      ? routeMailboxId
      : null;
  const selectedThread = parseId(params.threadId);
  const search = searchParams.get("q") ?? "";
  const filter = parseFilter(searchParams.get("filter"));
  const activeLabel = parseId(searchParams.get("label") ?? undefined);
  const deferredSearch = useDeferredValue(search.trim());
  const isArchive = props.view === "archive";
  const isMailView = props.view !== "settings";
  const autoSelected = (location.state as { autoSelected?: boolean } | null)?.autoSelected === true;

  const mailboxes = useQuery({
    queryKey: ["mailboxes"],
    queryFn: fetchMailboxes,
    retry: (failureCount, error) => !accessSetupError(error) && failureCount < 3,
    refetchIntervalInBackground: true,
  });
  useUnreadIndicator(
    accessSetupError(mailboxes.error)
      ? 0
      : mailboxes.data?.reduce((sum, mailbox) => sum + mailbox.unread_count, 0),
  );
  const labels = useQuery({ queryKey: ["labels"], queryFn: () => fetchLabels() });
  const threadQuery = {
    mailboxId: selectedMailbox,
    labelId: activeLabel,
    unread: filter === "unread",
  };
  const threads = useInfiniteQuery({
    queryKey: ["threads", props.view, selectedMailbox, deferredSearch, activeLabel, filter],
    queryFn: ({ pageParam }) =>
      deferredSearch
        ? searchThreads(deferredSearch, threadQuery)
        : fetchThreads({ ...threadQuery, status: isArchive ? "archived" : "open" }, pageParam),
    initialPageParam: null as ThreadCursor | null,
    getNextPageParam: (lastPage) => {
      const last = lastPage.at(-1);
      return deferredSearch || !last || lastPage.length < THREAD_PAGE_SIZE
        ? undefined
        : { at: last.last_message_at, id: last.id };
    },
    placeholderData: keepPreviousData,
    enabled: isMailView && Boolean(mailboxes.data?.length),
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.some(
          (thread) =>
            thread.draft_run_status === "queued" || thread.draft_run_status === "generating",
        ),
      )
        ? 3_000
        : 30_000,
  });
  const threadRows = threads.data?.pages.flat() ?? [];
  const noMailboxAccess = !isAdmin && props.user.mailbox_ids.length === 0;

  const listPath = isArchive
    ? "/archive"
    : selectedMailbox === null
      ? "/inbox"
      : `/mailboxes/${selectedMailbox}`;

  useEffect(() => {
    if (selectedThread !== null) autoSelectedScope.current = listPath;
  }, [listPath, selectedThread]);

  useEffect(() => {
    if (!isAdmin && routeMailboxId !== null && !props.user.mailbox_ids.includes(routeMailboxId)) {
      navigate("/inbox", { replace: true });
    }
  }, [isAdmin, navigate, props.user.mailbox_ids, routeMailboxId]);

  useEffect(() => {
    if (
      isMailView &&
      selectedThread === null &&
      autoSelectedScope.current !== listPath &&
      threadRows.length &&
      !threads.isPlaceholderData &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      autoSelectedScope.current = listPath;
      navigate(
        { pathname: `${threadListBase(listPath)}/${threadRows[0].id}`, search: location.search },
        { replace: true, state: { autoSelected: true } },
      );
    }
  }, [
    isMailView,
    listPath,
    location.search,
    navigate,
    selectedThread,
    threadRows,
    threads.isPlaceholderData,
  ]);

  useEffect(() => {
    if (
      props.view !== "settings" ||
      props.settingsSection !== "inboxes" ||
      selectedMailbox !== null ||
      !mailboxes.data?.length
    ) return;
    const defaultMailbox =
      mailboxes.data.find((mailbox) => mailbox.agent_mode !== "off") ?? mailboxes.data[0];
    navigate(`/settings/inboxes/${defaultMailbox.id}`, { replace: true });
  }, [mailboxes.data, navigate, props.settingsSection, props.view, selectedMailbox]);

  const selectMailbox = (id: number | null) => {
    navigate(id === null ? "/inbox" : `/mailboxes/${id}`);
  };

  const selectScope = (scope: ThreadScope) => {
    if (scope === "archive") navigate("/archive");
    else selectMailbox(scope === "all" ? null : scope);
  };

  const openSettings = () => {
    navigate("/settings/general");
  };

  const openInboxSettings = () => {
    const mailboxId =
      selectedMailbox ??
      mailboxes.data?.find((mailbox) => mailbox.agent_mode !== "off")?.id ??
      mailboxes.data?.[0]?.id;
    navigate(mailboxId ? `/settings/inboxes/${mailboxId}` : "/settings/inboxes");
  };

  const updateQuery = (key: "q" | "filter" | "label", value: string, defaultValue = "") => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (!value || value === defaultValue) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  const selectedMailboxName = isArchive
    ? "已归档"
    : selectedMailbox === null
      ? "所有收件箱"
      : (mailboxes.data?.find((mailbox) => mailbox.id === selectedMailbox)?.address ??
        "收件箱");
  const scopeUnread = (mailboxes.data ?? [])
    .filter((mailbox) => selectedMailbox === null || mailbox.id === selectedMailbox)
    .reduce((sum, mailbox) => sum + mailbox.unread_count, 0);
  const inboxIsEmpty =
    props.view === "inbox" &&
    selectedThread === null &&
    !threads.isLoading &&
    !threads.isError &&
    !threads.isPlaceholderData &&
    deferredSearch === "" &&
    filter === "all" &&
    activeLabel === null &&
    threadRows.length === 0;

  const setupError = accessSetupError(mailboxes.error);
  if (setupError) {
    return (
      <AccessSetup
        error={setupError}
        onRetry={() => window.location.reload()}
        retrying={mailboxes.isFetching}
      />
    );
  }

  return (
    <div className="flex h-dvh min-h-[560px] overflow-hidden bg-background text-foreground">
      <Sidebar
        mailboxes={mailboxes.data ?? []}
        selected={selectedMailbox}
        activeView={props.view}
        onSelect={selectMailbox}
        onOpenArchive={() => navigate("/archive")}
        onOpenSettings={openSettings} onLogout={() => window.location.assign("/cdn-cgi/access/logout?returnTo=/")}
        onCompose={() => { if (mailboxes.data?.length) openCompose(selectedMailbox); }}
        composeDisabled={!mailboxes.data?.length}
      />

      {props.view === "settings" ? (
        <main className="min-w-0 flex-1 overflow-hidden">
          {props.settingsSection === "general" ? (
            <GeneralSettings
              isAdmin={isAdmin}
              onBack={() => navigate("/inbox")}
              onOpenInboxes={isAdmin ? openInboxSettings : undefined}
              onOpenMembers={isAdmin ? () => navigate("/settings/members") : undefined}
            />
          ) : props.settingsSection === "members" ? (
            <MembersSettings onBack={() => navigate("/inbox")} onOpenGeneral={() => navigate("/settings/general")} onOpenInboxes={openInboxSettings} />
          ) : (
            <AgentSettings
              mailboxes={mailboxes.data ?? []}
              mailboxId={selectedMailbox}
              onSelectMailbox={(id) => navigate(`/settings/inboxes/${id}`)}
              onMailboxDeleted={(nextMailboxId) =>
                navigate(
                  nextMailboxId === null
                    ? "/settings/inboxes"
                    : `/settings/inboxes/${nextMailboxId}`,
                  { replace: true },
                )
              }
              onOpenGeneral={() => navigate("/settings/general")}
              onOpenMembers={() => navigate("/settings/members")}
              onBack={() => navigate("/inbox")}
            />
          )}
        </main>
      ) : (
        <>
          <ThreadList
            mailboxes={mailboxes.data ?? []}
            threads={threadRows}
            labels={labels.data ?? []}
            title={selectedMailboxName}
            selected={selectedThread}
            selectedMailbox={selectedMailbox}
            scope={isArchive ? "archive" : (selectedMailbox ?? "all")}
            archive={isArchive}
            unreadCount={!isArchive && !deferredSearch && activeLabel === null ? scopeUnread : null}
            showMailboxChip={selectedMailbox === null}
            search={search}
            filter={filter}
            activeLabel={activeLabel}
            loading={threads.isLoading}
            fetching={threads.isFetching && !threads.isFetchingNextPage}
            hasMore={threads.hasNextPage}
            loadingMore={threads.isFetchingNextPage}
            onLoadMore={() => threads.fetchNextPage()}
            error={threads.isError}
            detailsOpen={selectedThread !== null}
            emptyInbox={inboxIsEmpty}
            noMailboxAccess={noMailboxAccess}
            composeDisabled={!mailboxes.data?.length}
            onSearch={(query) => updateQuery("q", query)}
            onFilter={(nextFilter) => updateQuery("filter", nextFilter, "all")}
            onSelectLabel={(id) => updateQuery("label", id === null ? "" : String(id))}
            onSelectScope={selectScope}
            onOpenSettings={openSettings}
            onCompose={() => { if (mailboxes.data?.length) openCompose(selectedMailbox); }}
            onOpenMailboxSettings={isAdmin ? (id) => navigate(`/settings/inboxes/${id}`) : undefined}
            onSelect={(id) =>
              navigate({ pathname: `${threadListBase(listPath)}/${id}`, search: location.search })
            }
            onMarkedUnread={(ids) => {
              if (selectedThread !== null && ids.includes(selectedThread)) {
                navigate({ pathname: listPath, search: location.search });
              }
            }}
          />
          <main
            className={`min-w-0 flex-1 overflow-hidden ${selectedThread === null ? "hidden md:block" : "block"}`}
          >
            {selectedThread !== null && !noMailboxAccess ? (
              <ThreadView
                key={selectedThread}
                threadId={selectedThread}
                deferMarkRead={autoSelected}
                onBack={() => navigate({ pathname: listPath, search: location.search })}
                onMoved={() => navigate({ pathname: listPath, search: location.search })}
              />
            ) : (
              <EmptyReadingPane empty={inboxIsEmpty} noMailboxAccess={noMailboxAccess} />
            )}
          </main>
        </>
      )}
    </div>
  );
}

function EmptyReadingPane(props: { empty: boolean; noMailboxAccess?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-canvas px-6 pb-16 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <InboxIcon className="h-5 w-5" />
      </span>
      <p className="mt-3 text-[13px] font-medium text-foreground">
        {props.noMailboxAccess ? "尚未分配收件箱" : props.empty ? "这里还没有邮件" : "尚未选择会话"}
      </p>
      <p className="mt-1 max-w-64 text-[12.5px] leading-5 text-muted-foreground">
        {props.noMailboxAccess ? "请联系管理员为你分配收件箱权限。" : props.empty ? (
          "收到的新邮件会显示在左侧列表中。"
        ) : (
          <>
            从列表中选择会话，或按{" "}
            <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-background px-1 align-[1px] font-sans text-[11px] font-medium">
              /
            </kbd>{" "}
            搜索。
          </>
        )}
      </p>
    </div>
  );
}

function IdentityState(props: { title: string; detail?: string; onRetry?: () => void; retrying?: boolean }) {
  return <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-foreground">
    <InboxIcon className="h-7 w-7 text-muted-foreground" />
    <h1 className="text-sm font-medium" role="status">{props.title}</h1>
    {props.detail && <p className="max-w-sm text-[13px] leading-6 text-muted-foreground">{props.detail}</p>}
    {props.onRetry && <Button variant="outline" size="sm" onClick={props.onRetry} disabled={props.retrying}>{props.retrying ? "正在重试…" : "重试"}</Button>}
  </main>;
}

function parseId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseFilter(value: string | null): ThreadFilter {
  return value === "unread" ? value : "all";
}

function threadListBase(listPath: string): string {
  return listPath.startsWith("/mailboxes/") ? `${listPath}/threads` : listPath;
}
