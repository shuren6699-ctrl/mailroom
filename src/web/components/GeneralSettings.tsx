import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AI_MODEL_CATALOG_URL, DEFAULT_AI_MODEL } from "../../shared/ai-model";
import {
  disableBrowserNotifications,
  enableBrowserNotifications,
  fetchGeneralSettings,
  updateAiModel,
} from "../api";
import { DashLink } from "./DashLink";
import { localizeErrorMessage } from "../ui-messages";
import {
  BrowserPushError,
  createBrowserPushSubscription,
  getBrowserPushState,
  unsubscribeCurrentBrowser,
} from "../push-notifications";
import { BellIcon } from "./Icons";
import { McpSettings } from "./McpSettings";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

export function GeneralSettings(props: {
  isAdmin: boolean;
  onBack: () => void;
  onOpenInboxes?: () => void;
  onOpenMembers?: () => void;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", "general"],
    queryFn: fetchGeneralSettings,
  });
  const browser = useQuery({
    queryKey: ["browser-push-state"],
    queryFn: getBrowserPushState,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const refreshState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["settings", "general"] }),
      queryClient.invalidateQueries({ queryKey: ["browser-push-state"] }),
    ]);
  };

  const enable = useMutation({
    mutationFn: async () => {
      const publicKey = settings.data?.vapid_public_key;
      if (!publicKey) throw new Error("尚未配置浏览器通知。");
      const subscription = await createBrowserPushSubscription(publicKey);
      await enableBrowserNotifications(subscription);
    },
    onSettled: refreshState,
  });

  const disable = useMutation({
    mutationFn: async () => {
      await disableBrowserNotifications();
      await unsubscribeCurrentBrowser();
    },
    onSettled: refreshState,
  });

  const notificationsEnabled = Boolean(settings.data?.browser_notifications_enabled);
  const configured = Boolean(settings.data?.browser_notifications_configured);
  const supported = browser.data?.supported ?? true;
  const blocked = browser.data?.permission === "denied";
  const subscribed = Boolean(browser.data?.subscribed);
  const busy = enable.isPending || disable.isPending;
  const switchDisabled =
    settings.isLoading ||
    settings.isError ||
    browser.isLoading ||
    busy ||
    !configured ||
    (!notificationsEnabled && (!supported || blocked));
  const error = enable.error ?? disable.error;

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="general"
        onBack={props.onBack}
        onOpenGeneral={() => undefined}
        onOpenInboxes={props.onOpenInboxes}
        onOpenMembers={props.onOpenMembers}
      />

      <SettingsPage>
        <SettingsBlock id="notification-settings-heading" title="个人通知" description="通知偏好仅适用于你的账号。">
          <SettingsPanel>
            <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="browser-notifications"
                  className="flex items-center gap-2 text-[13.5px] font-medium text-foreground"
                >
                  <BellIcon className="h-4 w-4 text-muted-foreground" />
                  新邮件通知
                </label>
                <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
                  {notificationDescription({
                    configured,
                    supported,
                    blocked,
                    notificationsEnabled,
                    subscribed,
                  })}
                </p>

                {notificationsEnabled && !subscribed && supported && !blocked && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => enable.mutate()}
                    disabled={busy || !configured}
                  >
                    {enable.isPending ? "正在启用…" : "在此浏览器启用"}
                  </Button>
                )}

                {error && (
                  <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
                    {notificationErrorMessage(error)}
                  </p>
                )}
              </div>
              <Switch
                id="browser-notifications"
                checked={notificationsEnabled}
                onCheckedChange={(checked) =>
                  checked ? enable.mutate() : disable.mutate()
                }
                disabled={switchDisabled}
                aria-describedby="browser-notifications-description"
                className="mt-0.5"
              />
              <span id="browser-notifications-description" className="sr-only">
                仅通知你有权访问的收件箱收到的新邮件。
              </span>
            </div>
          </SettingsPanel>
        </SettingsBlock>

        {settings.isError && <p role="alert" className="text-sm text-destructive">无法加载个人设置。<Button variant="link" onClick={() => settings.refetch()}>重试</Button></p>}

        {props.isAdmin && <AiModelSettings saved={settings.data?.ai_model} />}

        {props.isAdmin && <McpSettings />}
      </SettingsPage>
    </div>
  );
}

function AiModelSettings(props: { saved: string | null | undefined }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string | null>(null);
  const saved = props.saved ?? "";
  const current = value ?? saved;
  const dirty = current.trim() !== saved;

  const save = useMutation({
    mutationFn: () => updateAiModel(current.trim() || null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      setValue(null);
    },
  });

  return (
    <SettingsBlock id="ai-settings-heading" title="AI">
      <SettingsPanel>
        <form
          className="px-4 py-4 sm:px-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty) save.mutate();
          }}
        >
          <label htmlFor="ai-model" className="text-[13.5px] font-medium text-foreground">
            语言模型
          </label>
          <div className="mt-2 flex max-w-xl gap-2">
            <Input
              id="ai-model"
              value={current}
              onChange={(event) => {
                setValue(event.target.value);
                save.reset();
              }}
              placeholder={DEFAULT_AI_MODEL}
              disabled={props.saved === undefined || save.isPending}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-describedby="ai-model-help"
              aria-invalid={save.isError || undefined}
              className="font-mono text-[13px] md:text-[13px]"
            />
            <Button type="submit" variant="outline" disabled={!dirty || save.isPending}>
              {save.isPending ? "正在保存…" : "保存"}
            </Button>
          </div>
          <div id="ai-model-help" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] leading-5 text-muted-foreground">
            <span className="whitespace-nowrap">留空则使用默认模型。</span>
            <DashLink href={AI_MODEL_CATALOG_URL}>模型目录</DashLink>
          </div>
          {save.isError && (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              {save.error instanceof Error ? localizeErrorMessage(save.error.message) : "无法保存模型，请重试。"}
            </p>
          )}
          {save.isSuccess && !dirty && (
            <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
              已保存。
            </p>
          )}
        </form>
      </SettingsPanel>
    </SettingsBlock>
  );
}

function notificationDescription(state: {
  configured: boolean;
  supported: boolean;
  blocked: boolean;
  notificationsEnabled: boolean;
  subscribed: boolean;
}): string {
  if (!state.configured) return "此服务器尚未配置通知推送。";
  if (!state.supported) return "此浏览器不支持推送通知。";
  if (state.blocked) return "此浏览器的网站设置已阻止通知。";
  if (state.notificationsEnabled && state.subscribed) {
    return "你有权访问的收件箱收到新邮件时，此浏览器会通知你。";
  }
  if (state.notificationsEnabled) return "你的通知已开启，但此浏览器尚未订阅。";
  return "你有权访问的收件箱收到新邮件时通知你。";
}

function notificationErrorMessage(error: Error): string {
  if (error instanceof BrowserPushError && error.code === "permission-denied") {
    return "通知未获授权。请在浏览器中修改此网站的通知权限后重试。";
  }
  return error.message ? localizeErrorMessage(error.message) : "无法更新浏览器通知，请重试。";
}
