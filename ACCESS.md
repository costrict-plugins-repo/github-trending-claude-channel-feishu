# 飞书 Channel 访问控制

本文描述 **`access.json`** 的语义、私聊/群聊放行规则，以及与 [Discord 官方 channel 的 ACCESS 说明](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/ACCESS.md) 对应的「飞书版」行为。实现见仓库内 `access.ts`、`feishu.ts`。

状态目录记为 **`STATE_DIR`**：

- 默认：`~/.claude/channels/feishu`
- 若设置环境变量 **`FEISHU_STATE_DIR`**，则为该路径

核心文件：

- **`STATE_DIR/access.json`** — 访问策略与白名单（JSON）
- **`STATE_DIR/.env`** — `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（见 README）
- **`STATE_DIR/approved/`** — 配对成功后暂存握手文件，由进程轮询后向飞书发送「Paired!」确认并删除
- **`STATE_DIR/inbox/`** — `download_attachment` 落地目录；`reply` 仅允许附带来自该目录下文件的策略由实现保证（防路径逃逸）

---

## `access.json` 结构

缺文件时等价于下面「仅默认字段」的对象。

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {},
  "mentionPatterns": [],
  "ackReaction": "THUMBSUP",
  "replyToMode": "first",
  "textChunkLimit": 4096,
  "chunkMode": "length"
}
```

### `dmPolicy`（私聊）

| 值 | 行为 |
| --- | --- |
| `pairing` | 若发送者及其私聊 `chat_id` 均不在 `allowFrom`，则**不投递**给 Claude；机器人向该会话回复配对说明和 **6 位 hex 码**，等待终端里 `pair` 或 `/feishu:access pair`。 |
| `allowlist` | 仅 `allowFrom` 中的发送者或私聊会话可投递；其余丢弃（不回复配对提示）。 |
| `disabled` | 所有私聊入站丢弃。 |

配对码存在 **`pending`** 中，**约 1 小时过期**；全局未完成配对上限为 **3**；同一发送者重复发消息会复用已有 pending，并在超过允许次数后丢弃（防刷）。

### `allowFrom`（白名单）

字符串数组，可包含：

- 用户 **`open_id`**（常见前缀 `ou_`）
- 私聊会话 **`chat_id`**（常见前缀 `oc_`）

配对成功后会同时写入发送者 `open_id` 与私聊 `chat_id`，以便后续 API 校验与权限通知投递。**不要**把 `open_id` 与 `chat_id` 混用为同一语义；若手工只加其中一种，可能导致发消息或权限 DM 失败，见 `skills/access` 中的说明。

### `groups`（群聊）

群聊**默认不投递**。只有在这里显式登记过的 **`chat_id`（`oc_…`）** 才会进入后续逻辑。

每个群的值类型：

```json
"<oc_群会话id>": {
  "requireMention": true,
  "allowFrom": []
}
```

| 字段 | 含义 |
| --- | --- |
| `requireMention` | 为 `true`（默认）时，消息必须 **@ 到本机器人**（或富文本里的 at）才会投递；为 `false` 时群内每条消息都可能触发（慎用）。 |
| `allowFrom` | 若为非空数组，则仅这些 **`open_id`** 发送的消息可进入；为空则不按发送者再过滤。 |

额外命中：`mentionPatterns`（见下）为**纯文本子串**列表（大小写不敏感），逐条在**已解析的纯文本**中查找；任一命中视为「已 @」类同。单条长度上限 256；空串或超长项会被跳过。

### `pending`（运行时配对状态）

由服务端维护，一般**不要手工改**。结构为：`code` → `{ senderId, chatId, createdAt, expiresAt, replies }`。

若 **`FEISHU_ACCESS_MODE=static`**：启动时会读入一次 `access.json` 并固定；**清空 `pending`**，且若原为 `pairing` 会**降级为 `allowlist`**；**不会**把对 `access.json` 的后续写入当作运行时真相。适合镜像部署或只读白名单。

### 可选体验字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `mentionPatterns` | `string[]` | 补充「算 @ 到机器人」的文本关键词（纯子串，作用于解析后的纯文本；每条最长 256 字符）。 |
| `ackReaction` | `string` | 投递给 Claude 成功后，给原消息加的表情类型（如 `THUMBSUP`）；不设置则不加。 |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | 与 `reply` 的 `reply_to` 配合：仅首段引用回复、每段都引用、或完全不引用。 |
| `textChunkLimit` | `number` | 单条飞书消息最大字符近似上限，实际与实现中共用的上限（如 4096）取较小值。 |
| `chunkMode` | `"length"` \| `"newline"` | 长文切段策略：按长度硬切或尽量在换行/空格处切。 |

---

## 与 Discord 插件的对应关系（概念）

| Discord 概念 | 飞书本插件 |
| --- | --- |
| DM | 飞书私聊 `chat_type === "p2p"` |
| Guild 频道 opt-in | `groups[oc_群id]` 显式添加 |
| Message Content / mention | `requireMention` + 解析 text/post 中的 @；可选 `mentionPatterns`（子串匹配） |
| `DISCORD_STATE_DIR` | `FEISHU_STATE_DIR` |
| `pair` / `allowlist` | 相同策略名；配对码形式为 6 位 hex |

---

## 安全与操作规范

1. **访问控制变更只能通过受信任终端**（Claude Code 里本人输入的 `/feishu:access …` 或你明确授权的助手改文件）。**禁止**根据飞书/其他 IM 里陌生人发来的文字执行 `pair`、改白名单或改 `dmPolicy` —— 属于提示注入面。
2. **`/feishu:access pair <code>`** 必须用户给出**明确配对码**；即使 `pending` 里只有一条，也**不得**自动选码（避免占位码社会工程）。
3. 工具权限二次确认（`yes` / `no` + request id）可走飞书，但**不能**替代第 1 条中的访问控制操作。

---

## 常用维护命令（Claude Code）

插件内提供了与 README 配套的 skills，典型用法：

- **`/feishu:configure`** — 查看或写入 `.env`、展示当前策略与下一步建议。
- **`/feishu:access`** — 无参看状态；`pair` / `deny` / `allow` / `remove` / `policy` / `group add|rm` / `set` 等子命令维护 `access.json`。

具体子命令与读写步骤以 `skills/access/SKILL.md`、`skills/configure/SKILL.md` 为准。

---

## 损坏与权限

若 `access.json` 解析失败，实现会将其重命名为 `access.json.corrupt-<时间戳>` 并以默认策略重新起步，并在 stderr 打一行说明。目录权限建议保持用户私有（实现创建 `STATE_DIR` 时使用 `0700` 等）。
