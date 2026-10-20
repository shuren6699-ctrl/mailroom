# 团队登录白名单自动同步

管理员可以在 Mailroom 的“设置 → 成员与权限”中维护成员和邮箱权限。
连接 Cloudflare 后，保存成员会把已启用成员同步到现有 `mailroom-team` 登录策略。
停用成员会先立即撤销 Mailroom 内的邮件访问权限，再同步 Cloudflare。

## 首次连接

1. 在 Cloudflare 创建一个自定义 API Token，授予 **Access: Apps and Policies → 编辑** 权限，账号资源只选择当前 Mailroom 所在账号。
2. 在 **Workers 和 Pages → mailroom → 设置 → 变量和密钥** 添加密钥 `CF_ACCESS_API_TOKEN`，填入该令牌并部署。
3. 回到“成员与权限”刷新页面，检查成员名单，再点击 **立即同步**。

令牌只存入 Worker Secret，不填到 Mailroom 页面、聊天或代码仓库。
`ACCESS_SYNC_ACCOUNT_ID` 和 `ACCESS_SYNC_POLICY_ID` 是非密钥的部署配置，当前实例已配置到既有团队策略。

首次同步会用本页全部已启用成员替换团队策略的邮箱列表；旧白名单中未添加为启用成员的邮箱会被移除。
如果要保留这些成员，请先在本页添加并分配收件箱，再执行同步。
固定管理员始终保留。独立的 Cloudflare 账户成员登录规则继续由 Cloudflare 管理，Mailroom 内的成员权限仍会检查每次请求。

## 状态和重试

- **尚未连接**：没有有效的服务端配置或令牌，成员配置可以保存，团队登录规则暂未同步。
- **待同步**：名单有变更、首次尚未验证，或其他同步正在处理。可以点击立即同步并等待状态刷新。
- **同步失败**：成员配置已经保存，按页面提示检查令牌权限、目标策略或网络后重试。
- **已同步**：最近一次成功更新已覆盖当前成员版本。页面会显示最近同步时间。

同步只更新固定的邮箱 Allow 策略，并保留其 Require、Exclude 和会话等限制。遇到非邮箱规则、意外策略名称或无法保留的条件时会停止更新并提示错误。
Cloudflare 中手工修改名单后，应回到成员页点击立即同步，以成员页名单重新核对。

官方接口和权限说明：[Update an Access reusable policy](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/update/)。
