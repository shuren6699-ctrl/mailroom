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
  onBack: () => void;
  onOpenInboxes: () => void;
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
      if (!publicKey) throw new Error("Browser notifications are not configured.");
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

  const globalEnabled = Boolean(settings.data?.browser_notifications_enabled);
  const configured = Boolean(settings.data?.browser_notifications_configured);
  const supported = browser.data?.supported ?? true;
  const blocked = browser.data?.permission === "denied";
  const subscribed = Boolean(browser.data?.subscribed);
  const busy = enable.isPending || disable.isPending;
  const switchDisabled =
    settings.isLoading ||
    browser.isLoading ||
    busy ||
    !configured ||
    (!globalEnabled && (!supported || blocked));
  const error = enable.error ?? disable.error;

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="general"
        onBack={props.onBack}
        onOpenGeneral={() => undefined}
        onOpenInboxes={props.onOpenInboxes}
      />

      <SettingsPage>
        <SettingsBlock id="notification-settings-heading" title="Notifications">
          <SettingsPanel>
            <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="browser-notifications"
                  className="flex items-center gap-2 text-[13.5px] font-medium text-foreground"
                >
                  <BellIcon className="h-4 w-4 text-muted-foreground" />
                  New email notifications
                </label>
                <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
                  {notificationDescription({
                    configured,
                    supported,
                    blocked,
                    globalEnabled,
                    subscribed,
                  })}
                </p>

                {globalEnabled && !subscribed && supported && !blocked && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => enable.mutate()}
                    disabled={busy || !configured}
                  >
                    {enable.isPending ? "Enabling…" : "Enable on this browser"}
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
                checked={globalEnabled}
                onCheckedChange={(checked) =>
                  checked ? enable.mutate() : disable.mutate()
                }
                disabled={switchDisabled}
                aria-describedby="browser-notifications-description"
                className="mt-0.5"
              />
              <span id="browser-notifications-description" className="sr-only">
                Applies to new email received by every inbox in this workspace.
              </span>
            </div>
          </SettingsPanel>
        </SettingsBlock>

        <AiModelSettings saved={settings.data?.ai_model} />

        <McpSettings />
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
            Language model
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
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          <div id="ai-model-help" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] leading-5 text-muted-foreground">
            <span className="whitespace-nowrap">Leave empty for default.</span>
            <DashLink href={AI_MODEL_CATALOG_URL}>Model catalog</DashLink>
          </div>
          {save.isError && (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              {save.error instanceof Error ? save.error.message : "Couldn’t save the model. Try again."}
            </p>
          )}
          {save.isSuccess && !dirty && (
            <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
              Saved.
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
  globalEnabled: boolean;
  subscribed: boolean;
}): string {
  if (!state.configured) return "Push delivery has not been configured on this server.";
  if (!state.supported) return "This browser does not support push notifications.";
  if (state.blocked) return "Notifications are blocked in this browser's site settings.";
  if (state.globalEnabled && state.subscribed) {
    return "This browser will notify you when any inbox receives a new email.";
  }
  if (state.globalEnabled) return "Notifications are on, but this browser is not subscribed yet.";
  return "Get notified when any inbox receives a new email.";
}

function notificationErrorMessage(error: Error): string {
  if (error instanceof BrowserPushError && error.code === "permission-denied") {
    return "Notifications were not allowed. Change this site's notification permission in your browser to try again.";
  }
  return error.message || "Couldn’t update browser notifications. Try again.";
}
