/** Translate service errors for display without changing API responses or stored mail. */
const ERROR_MESSAGES: Record<string, string> = {
  "nothing to update": "没有需要保存的更改。",
  "no fields to update": "没有需要保存的更改。",
  "the model must be text": "模型名称必须是文本。",
  "enter a model id like openai/gpt-6-luna or @cf/meta/llama-3.1-8b-instruct": "请输入模型 ID，例如 openai/gpt-6-luna 或 @cf/meta/llama-3.1-8b-instruct。",
  "browser notifications are not configured on this server": "服务器尚未配置浏览器通知。",
  "the browser returned an invalid push subscription": "浏览器返回的通知订阅无效，请重新启用通知。",
  "the browser returned an incomplete push subscription": "浏览器返回的通知订阅不完整，请重新启用通知。",
  "this browser does not support push notifications": "当前浏览器不支持推送通知。",
  "notifications are blocked in this browser": "浏览器已阻止通知，请在网站权限中允许通知。",
  "could not subscribe this browser": "无法为当前浏览器启用通知，请稍后重试。",
  "enter a valid domain, such as example.com": "请输入有效域名，例如 example.com。",
  "invalid domain": "域名无效。",
  "domain not found": "找不到该域名。",
  "use letters, numbers, dots, dashes, or underscores": "请使用字母、数字、点、连字符或下划线。",
  "choose a domain": "请选择域名。",
  "finish setting up this domain first": "请先完成此域名的收发设置。",
  "this inbox already exists": "此收件箱已存在。",
  "invalid agent_mode": "AI 草稿模式无效。",
  "invalid inbox": "收件箱无效。",
  "inbox not found": "找不到该收件箱。",
  "type the inbox address to confirm deletion": "请输入完整邮箱地址以确认删除。",
  "wait for the current email to finish sending, then try again": "请等待当前邮件发送完成后再试。",
  "inbox changed while it was being deleted": "收件箱在删除期间发生了变化，请刷新后重试。",
  "mailbox_id is required": "请选择收件箱。",
  "invalid playbook id": "回复指南无效。",
  "playbook not found": "找不到该回复指南。",
  "a label with this name already exists": "已存在同名标签。",
  "invalid label id": "标签无效。",
  "label not found": "找不到该标签。",
  "status must be open, archived or needs_human": "会话状态无效，请刷新后重试。",
  "thread not found": "找不到该会话。",
  "conversation not found": "找不到该会话。",
  "invalid conversation": "会话无效。",
  "invalid attachment": "附件无效。",
  "attachment not found": "找不到该附件。",
  "attachment file is unavailable": "附件文件暂时无法访问。",
  "invalid draft run": "草稿任务无效。",
  "draft run not found": "找不到该草稿任务。",
  "a newer customer message has replaced this draft run": "已有新的来信，请查看最新邮件的草稿。",
  "this draft is already ready": "此草稿已生成。",
  "turn on ai drafting for this inbox first": "请先为此收件箱启用 AI 草稿。",
  "the latest message does not need an ai draft": "最新邮件不需要生成 AI 草稿。",
  "automated messages are not drafted": "自动发送的邮件不会生成回复草稿。",
  "the ai couldn’t write a new draft. try again": "AI 未能生成新草稿，请重试。",
  "this conversation has no customer message to reply to": "此会话没有可回复的来信。",
  "an ai draft is still being generated": "AI 正在生成草稿，请稍后再试。",
  "a newer customer message arrived while drafting": "生成草稿期间收到了新来信，请查看最新邮件。",
  "the generated draft could not be stored": "生成的草稿未能保存，请重试。",
  "ids must contain 1-100 conversation ids": "每次请选择 1 至 100 个会话。",
  "action must be read, unread, archive or unarchive": "操作无效，请刷新后重试。",
  "text is required": "请输入回复内容或添加附件。",
  "reply text is required": "请输入回复内容或添加附件。",
  "message text is required": "请输入邮件正文或添加附件。",
  "subject is required": "请输入邮件主题。",
  "attempt_id is required": "发送请求缺少标识，请关闭编辑窗口后重试。",
  "invalid draft_id": "草稿无效，请刷新后重试。",
  "cross-origin requests are not allowed": "请求来源不匹配，请从邮箱网页重新操作。",
  "web authentication is not configured": "尚未完成网页登录验证设置。",
  "authentication required": "请先登录邮箱。",
  "an access user identity is required": "请使用获准访问的个人邮箱登录。",
  "authentication service unavailable": "登录验证服务暂时不可用，请稍后重试。",
  "invalid or expired access assertion": "登录已失效，请刷新页面并重新登录。",
  "new email requires exactly one recipient": "请填写一个收件人邮箱地址。",
  "enter one valid recipient email address": "请输入一个有效的收件人邮箱地址。",
  "choose a sending inbox": "请选择发件邮箱。",
  "invalid send request; close this message and try again": "发送请求无效，请关闭写信窗口后重试。",
  "submit the message as a multipart form": "邮件提交格式无效，请刷新后重试。",
  "the message form could not be read": "无法读取邮件内容，请刷新后重试。",
  "attachments must be non-empty files": "附件必须是非空文件。",
  "attach up to 10 files, totaling no more than 3 mb": "最多添加 10 个附件，总大小不超过 3 MB。",
  "attachments cannot be empty": "不能添加空附件。",
  "attachment disposition must be attachment or inline": "附件类型无效，请重新添加。",
  "inbox domain is not ready for outbound sending": "发件域名尚未就绪，请先完成域名发信设置。",
  "daily mcp send limit reached": "已达到今日 MCP 发信限额。",
  "send attempt disappeared": "找不到发送记录，请刷新后检查发送状态。",
  "reply attempt disappeared": "找不到回复记录，请刷新后检查发送状态。",
  "send attempt id was already used for different content": "此发送请求已用于其他内容，请重新打开写信窗口。",
  "reply attempt id was already used for different content": "此回复请求已用于其他内容，请刷新会话后重试。",
  "conversation advanced after it was read; read it again before replying": "会话已有新邮件，请刷新并阅读后再回复。",
  "no inbound message to reply to": "没有可回复的来信。",
  "reply has too many recipients": "回复的收件人数量过多。",
  "reply recipient changed after it was reviewed; read the conversation again": "回复收件人已发生变化，请重新查看会话后再发送。",
  "search query is too long; use fewer or shorter terms": "搜索内容过长，请减少关键词或缩短搜索内容。",
  "invalid cursor": "列表位置已失效，请刷新后重试。",
  "failed to fetch": "网络连接失败，请检查网络后重试。",
  "networkerror when attempting to fetch resource": "网络连接失败，请检查网络后重试。",
  "load failed": "加载失败，请检查网络后重试。",
  "internal server error": "服务器暂时无法完成操作，请稍后重试。",
};

const FIELD_NAMES: Record<string, string> = {
  name: "名称",
  description: "说明",
  instructions: "指令",
  condition: "条件",
  when_to_use: "使用条件",
  example_reply: "示例回复",
};

export function localizeErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "操作未完成，请稍后重试。";
  const key = trimmed.replace(/[.!]$/, "").toLowerCase();
  if (Object.hasOwn(ERROR_MESSAGES, key)) return ERROR_MESSAGES[key]!;
  const status = key.match(/^(?:request failed|could not send) \((\d{3})\)$/);
  if (status) return "请求失败（状态码 " + status[1] + "），请稍后重试。";
  const subject = trimmed.match(/^Enter a subject of 1[–-](\d+) characters without line breaks$/);
  if (subject) return "主题需为 1 至 " + subject[1] + " 个字符，且不能换行。";
  const length = trimmed.match(/^Message text must be at most ([\d,]+) characters$/);
  if (length) return "邮件正文最多为 " + length[1] + " 个字符。";
  const files = trimmed.match(/^A message can carry at most (\d+) attachments$/);
  if (files) return "每封邮件最多添加 " + files[1] + " 个附件。";
  const size = trimmed.match(/^Attachments are limited to (\d+) MB in total$/);
  if (size) return "附件总大小不能超过 " + size[1] + " MB。";
  const labels = trimmed.match(/^This inbox already has the maximum of (\d+) labels$/);
  if (labels) return "此收件箱最多可创建 " + labels[1] + " 个标签。";
  const instruction = trimmed.match(/^Keep the instruction under (\d+) characters$/);
  if (instruction) return "修改要求不能超过 " + instruction[1] + " 个字符。";
  const empty = trimmed.match(/^(name|description|instructions|condition) cannot be empty$/);
  if (empty) return FIELD_NAMES[empty[1]!] + "不能为空。";
  const fieldError = key.match(/^(name|description|instructions|condition|when_to_use|example_reply) (?:is|are) (required|too long)$/);
  if (fieldError) return FIELD_NAMES[fieldError[1]!] + (fieldError[2] === "required" ? "不能为空。" : "过长，请缩短内容。");
  // Keep unknown provider diagnostics available, with a Chinese explanation.
  return /[\u3400-\u9fff]/u.test(trimmed) ? message : "操作未完成：" + message;
}
