import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ACCESS_APPLICATIONS_URL } from "../cloudflare-dashboard";
import { CopyField } from "./CopyField";
import { DashLink } from "./DashLink";
import { SettingsBlock, SettingsPanel } from "./SettingsNavigation";

/**
 * MCP clients must reach discovery, registration, token, and /mcp without an
 * Access session. Fetching without cookies shows whether Access intercepts them.
 */
async function checkPublicOAuth(): Promise<boolean> {
  try {
    const response = await fetch("/.well-known/oauth-protected-resource/mcp", {
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
    });
    if (!response.ok) return false;
    const metadata = (await response.json()) as { resource?: string };
    return metadata.resource === `${window.location.origin}/mcp`;
  } catch {
    return false;
  }
}

export function McpSettings() {
  const status = useQuery({
    queryKey: ["mcp-public-oauth"],
    queryFn: checkPublicOAuth,
    staleTime: 0,
    refetchInterval: false,
  });
  const { origin, host } = window.location;

  return (
    <SettingsBlock
      id="mcp-settings-heading"
      title="MCP"
      description="将此网址添加到 MCP 客户端，即可通过客户端读取和发送邮件。"
    >
      <SettingsPanel>
        <div className="px-4 py-4 sm:px-5">
          <CopyField value={`${origin}/mcp`} />
        </div>

        {status.data === false && (
          <div className="border-t px-4 py-4 text-[13px] leading-6 text-muted-foreground sm:px-5 [&_strong]:font-medium [&_strong]:text-foreground">
            <p>
              Access 正在阻止 MCP 客户端连接。请在{" "}
              <DashLink href={ACCESS_APPLICATIONS_URL}>Access 应用程序</DashLink>中，
              为以下路径添加自托管应用，并配置适用于<strong>所有人（Everyone）</strong>的
              <strong>绕过（Bypass）</strong>策略：
            </p>
            <div className="mt-3 space-y-2">
              <CopyField value={`${host}/mcp`} />
              <CopyField value={`${host}/.well-known`} />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => status.refetch()}
              disabled={status.isFetching}
            >
              {status.isFetching ? "正在检查…" : "重新检查"}
            </Button>
          </div>
        )}
      </SettingsPanel>
    </SettingsBlock>
  );
}
