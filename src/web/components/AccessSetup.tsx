import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ApiError } from "../api";
import { currentWorkerName, workerDashboardUrl } from "../cloudflare-dashboard";
import { CopyField } from "./CopyField";
import { DashLink } from "./DashLink";

/** Shown instead of the workspace until Cloudflare Access protects this Worker. */
export function AccessSetup(props: { error: ApiError; onRetry: () => void; retrying: boolean }) {
  const { code, hint } = props.error;
  // Access adds a signed assertion to every request it lets through; a hint
  // means the visitor already signed in, so only the variables are left.
  const accessActive = Boolean(hint) || code === "access_invalid";
  const mismatch = code === "access_invalid";
  const workerName = currentWorkerName();

  return (
    <div className="flex h-dvh min-h-[560px] justify-center overflow-y-auto bg-canvas px-4 py-10 text-foreground md:py-16">
      <div className="w-full max-w-[620px]">
        <h1 className="text-[20px] font-semibold tracking-tight">完成 Mailroom 访问保护设置</h1>
        <p className="mt-2 max-w-xl text-[13.5px] leading-6 text-muted-foreground">
          请先通过 Cloudflare Access 保护此 Worker，然后才能访问邮件。
        </p>

        <ol className="mt-8 space-y-3">
          <Step n={1} title="启用 Access" state={accessActive ? "done" : "current"}>
            <p>
              在{" "}
              <DashLink href={workerDashboardUrl("access")}>
                {workerName ? `${workerName} Worker 的 Access 页面` : "Worker 的 Access 页面"}
              </DashLink>
              ，选择<strong>启用访问</strong>，使用 <strong>Cloudflare 账户</strong>策略，然后刷新此页面。
            </p>
          </Step>

          <Step n={2} title="添加两个变量" state={accessActive ? "current" : "todo"}>
            <p>
              {mismatch ? "以下值与 Access 应用不匹配。请前往" : "请前往"}{" "}
              <DashLink href={workerDashboardUrl("settings")}>设置</DashLink> → 变量和密钥，
              {mismatch ? "更新以下变量：" : "添加以下变量："}
            </p>
            <div className="mt-3 space-y-2">
              <CopyField
                label="WEB_ACCESS_TEAM_DOMAIN"
                value={hint?.team_domain ?? "完成第 1 步后显示"}
                placeholder={!hint}
              />
              <CopyField
                label="WEB_ACCESS_AUD"
                value={hint?.aud ?? "完成第 1 步后显示"}
                placeholder={!hint}
              />
            </div>
          </Step>
        </ol>

        <Button className="mt-6" onClick={props.onRetry} disabled={props.retrying}>
          {props.retrying ? "正在检查…" : "重新检查"}
        </Button>
      </div>
    </div>
  );
}

function Step(props: {
  n: number;
  title: string;
  state: "done" | "current" | "todo";
  children: ReactNode;
}) {
  const done = props.state === "done";
  return (
    <li
      className={`rounded-xl border bg-background px-4 py-4 sm:px-5 ${props.state === "todo" ? "opacity-60" : ""}`}
      aria-current={props.state === "current" ? "step" : undefined}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${done ? "bg-foreground text-background" : "border text-foreground"}`}
        >
          {done ? "✓" : props.n}
        </span>
        <h2 className={`text-[14px] font-medium ${done ? "text-muted-foreground" : ""}`}>
          {props.title}
        </h2>
      </div>
      {!done && (
        <div className="mt-3 pl-9 text-[13px] leading-6 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
          {props.children}
        </div>
      )}
    </li>
  );
}
