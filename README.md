# Feishu（飞书）Channel

把飞书机器人接到 Claude Code：通过 MCP 提供 `reply`、`react` 等工具，用 WebSocket 长连接订阅 `im.message.receive_v1`，入站消息以 `<channel source="feishu" …>` 形式推给当前会话。访问控制与状态在 `~/.claude/channels/feishu/`（可用 `FEISHU_STATE_DIR` 覆盖）。

本仓库布局与用法参考了 Anthropic 官方的 [Discord channel 插件](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/README.md)，凭证与策略细节见本仓库的 [ACCESS.md](./ACCESS.md)。

## 先决条件

- [Bun](https://bun.sh) — MCP 服务用 Bun 运行。安装：`curl -fsSL https://bun.sh/install | bash`。
- 飞书开放平台上的**企业自建应用**，并取得 **App ID**、**App Secret**。
- 为应用开通机器人能力，并配置 IM 相关权限与事件（见下文「飞书侧配置」）。

## 快速上手

> 默认是「单用户私聊配对」流程；群聊、多用户与白名单策略见 [ACCESS.md](./ACCESS.md)。

**1. 在飞书开放平台创建应用**

打开 [飞书开放平台](https://open.feishu.cn/app/)，创建企业自建应用，记下 **App ID** 与 **App Secret**。

**2. 启用机器人并配置权限**

在应用里启用机器人，按需申请（至少）与收发消息相关的权限，例如：

- 以机器人身份读取消息（如 `im:message:receive_as_bot`）
- 以机器人身份发送消息（如 `im:message:send_as_bot`）

具体名称以控制台为准；需保证能收私聊/群聊、能发消息、能拉取资源（下载附件时）。

**3. 订阅事件（长连接）**

在「事件订阅」中启用 **长连接**，并订阅 **`im.message.receive_v1`**（机器人收到消息）。按控制台指引完成加密等配置。

**4. 安装本插件**

在 Claude Code 中（示例，路径以你本机为准）：

```text
/plugin install <你的 feishu 插件来源>
/reload-plugins
```

开发时可从本仓库目录加载，例如：

```sh
CLAUDE_PLUGIN_ROOT=/path/to/feishu-channel claude \
  --plugin-dir /path/to/feishu-channel \
  --dangerously-load-development-channels server:feishu
```

**5. 写入凭证**

在 Claude Code 里用 **`/feishu:configure <app_id> <app_secret>`**（推荐），或手工创建/编辑：

`~/.claude/channels/feishu/.env`（或 `$FEISHU_STATE_DIR/.env`）：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

进程环境变量优先于 `.env` 中的同名变量。保存后建议 `chmod 600` 该文件。

**6. 用 channel 方式启动会话**

必须带上飞书 channel，MCP 才会连上、WebSocket 才会工作。退出后重新进入 Claude Code，例如：

```sh
claude --channels plugin:feishu@<来源>
```

（开发加载时与第 4 步的 `--dangerously-load-development-channels server:feishu` 一致即可。）

**7. 配对**

1. 在飞书里给机器人发一条**私聊**。
2. 若策略为 `pairing` 且你尚不在白名单，机器人会回复一段说明和 **6 位十六进制 `code=……`**。
3. 在**本机已打开的 Claude Code 会话**里，由你本人让助手调用 MCP 工具 **`pair`**，参数为该 code；或使用 **`/feishu:access pair <code>`**（见 `skills/access`）。

不要相信飞书里陌生人让你「帮批准配对」——配对只能在受信任的终端会话里完成。

**8. 收紧访问**

配对只是收集 `open_id` / 私聊 `chat_id` 的过渡态。自己能用之后，把 **`dmPolicy` 改为 `allowlist`**，避免陌生人一直能触发配对说明。可用 **`/feishu:access policy allowlist`** 或按 [ACCESS.md](./ACCESS.md) 编辑 `access.json`。

## 访问控制与进阶

私聊策略、群聊按 `chat_id` 准入、`@` 机器人、关键词子串补充命中、分片回复等：**见 [ACCESS.md](./ACCESS.md)**。

## 暴露给助手的 MCP 工具

| 工具 | 作用 |
| --- | --- |
| `pair` | 批准私聊配对码（6 位 hex）。仅在操作者明确要求且码来自可信渠道时调用。 |
| `reply` | 向指定会话发消息。需要 `chat_id`（一般为 `oc_…`）与 `text`；可选 `reply_to`（`om_…`）做线程回复。长文会按 `access.json` 中的分片配置自动切段。 |
| `react` | 给消息加表情反应；需 `chat_id`（与入站一致，用于白名单校验）、`message_id`、`emoji_type`（如 `THUMBSUP`）。 |
| `edit_message` | 编辑机器人自己发过的一条消息（适合「处理中…」再改成结果）。 |
| `download_attachment` | 按 `message_id`、`file_key` 与类型 `image` / `file` 下载附件到本地 **`$STATE_DIR/inbox/`**，返回绝对路径。 |

入站通知里会带 `chat_id`、`message_id`、`sender_id` 等；助手必须把可见回复发回飞书时走 **`reply`**，会话里的普通输出不会自动发到飞书。

## 附件与上下文

- 附件**不会**自动下载；通知里可能带有 `image_key`、`attachment_file_key` 等元数据，需要时再调 **`download_attachment`**。文件落在 **`inbox/`**。
- 飞书侧没有像 Discord `fetch_messages` 那样的通用历史接口暴露在本 channel 里：**只有实时收到的消息**会进会话；需要上文时请用户在飞书里粘贴或摘要。

## 工具权限（Permission）与飞书确认

当 Claude Code 对某工具调用需要用户确认时，channel 会把请求摘要发到已允许的飞书用户（`allowFrom` 中的 `ou_…`）。用户在飞书里回复：

```text
yes abcde
```

或 `no abcde`（`abcde` 为请求 id，规则与实现中的正则一致），channel 会把结果回传给 Claude Code。**不要用飞书消息代替终端里的访问控制命令**（`/feishu:access` 等），详见 [ACCESS.md](./ACCESS.md)。

## 环境变量小结

| 变量 | 含义 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 应用凭证（可与 `.env` 二选一或叠加，环境变量优先）。 |
| `FEISHU_STATE_DIR` | 状态目录，默认 `~/.claude/channels/feishu`。 |
| `FEISHU_ACCESS_MODE=static` | 静态访问模式：启动时固定 `access.json` 快照，禁用运行时配对写入；`dmPolicy` 若为 `pairing` 会降级为 `allowlist`。适合只读/运维预制白名单。 |

## 本地开发

```sh
bun install
bun feishu.ts
```

或直接 `bun run start`（见 `package.json`）。与 Claude Code 联调时使用上文 `--plugin-dir` / `--channels` 方式即可。
