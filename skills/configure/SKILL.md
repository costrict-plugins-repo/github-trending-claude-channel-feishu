---
name: configure
description: 配置飞书 Channel — 写入 App ID / App Secret 并说明访问策略。当用户粘贴飞书凭证、问「怎么配」「谁能连到我」、或要查看 channel 状态时触发。
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /feishu:configure — 飞书 Channel 凭证配置

把 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 写入状态目录下的 `.env`，并引导用户了解配对与访问策略。服务端启动时会读取该 `.env`（以及进程环境变量）。

**状态目录**（下文记为 `STATE_DIR`）：若已设置环境变量 `FEISHU_STATE_DIR` 则用之，否则为 `~/.claude/channels/feishu`。  
凭证文件：`$STATE_DIR/.env`。访问策略：`$STATE_DIR/access.json`。

传入参数：`$ARGUMENTS`

---

## 按参数分发

### 无参数 — 状态与引导

读取 `$STATE_DIR/.env` 与 `$STATE_DIR/access.json`，给用户完整现状：

1. **凭证** — 检查 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 是否已设置。已设置则做脱敏展示（例如 App ID 保留前缀 `cli_` 与少量字符，Secret 仅显示前 4 位）。

2. **访问** — 读取 `access.json`（缺失则等价默认：`dmPolicy: "pairing"`，空白名单、空 `pending`、空 `groups`）。展示：
   - DM 策略及一句话含义
   - `allowFrom`：数量；列出 `open_id` / `chat_id`（`ou_` / `oc_`）摘要
   - `pending`：数量；若有则列出配对码、发送方、大致剩余时间
   - 已配置群聊 `groups`：数量

3. **下一步** — 根据状态给出可执行建议：
   - 缺任一凭证 → *「在 [飞书开放平台](https://open.feishu.cn/app/) 创建企业自建应用，拿到 App ID 与 App Secret；在本会话执行 `/feishu:configure <app_id> <app_secret>`。」* 并提醒 README 中的权限与事件：`im:message:receive_as_bot`、`im:message:send_as_bot`、长连接订阅 `im.message.receive_v1` 等。
   - 凭证齐、策略为 `pairing` 且白名单为空 → *「在飞书里给机器人发一条私聊，记下返回的 6 位十六进制配对码，在本机执行 `/feishu:access pair <code>`。」*
   - 凭证齐且已有允许对象 → *「可以用了。在飞书私聊或已配置的群里 @ 机器人即可。」*

**始终推动收紧权限。** 最终目标应是 `allowlist` 加明确名单。`pairing` 只是用来收集尚不认识的 `open_id` 的过渡态；名单齐全后应主动建议执行 `/feishu:access policy allowlist`，不要长期停在 `pairing`。

对话节奏：

1. 看 `allowFrom`，告诉用户当前有谁。
2. 问：*「是否只有这些人应通过该应用连到 Claude？」*
3. **若确认且策略仍是 `pairing`** → 主动提议执行 `/feishu:access policy allowlist`，不必等用户开口。
4. **若还有人未加入** → *「让对方在飞书里给机器人发消息，你用 `/feishu:access pair <code>` 逐个批准；人齐后再执行本 skill 我们收紧策略。」* 若对方能提供 `open_id`：*「可直接 `/feishu:access allow <open_id>`。」*
5. **若白名单为空且本人尚未配对** → *「请先用你自己的飞书账号给机器人发消息拿到配对码，把自己加进白名单，再处理其他人。」*
6. **若已是 `allowlist`** → 确认即为锁定态；新增人员用 `allow` 或受控配对，无需为了加人而长期 reopen `pairing`。

### `<app_id> <app_secret>` — 保存凭证

1. 将 `$ARGUMENTS` 按空白拆成两段（trim）；第一段为 App ID（通常以 `cli_` 开头），第二段为 App Secret。若段数不对，提示正确格式并停止。
2. `mkdir -p "$STATE_DIR"`（注意：若用户 shell 未导出 `FEISHU_STATE_DIR`，对 agent 而言默认路径为 `~/.claude/channels/feishu`，与 `access.ts` 中 `STATE_DIR` 一致）。
3. 若已有 `.env`，读入后更新或追加 `FEISHU_APP_ID=`、`FEISHU_APP_SECRET=` 两行，保留其他键。值不要用引号包裹。
4. `chmod 600 "$STATE_DIR/.env"`。
5. 保存后复述无参数状态，并提醒：**服务端在启动时读入 `.env`**，改凭证后需重启 channel 进程或重新加载插件后再生效。

### `clear` — 清除凭证

从 `.env` 中删除 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 行（若仅剩这些行可删整个文件）。说明清除后需重启 channel。

---

## 实现说明

- 目录可能尚不存在（从未启动过 server），缺失按「未配置」处理，不要当致命错误。
- `access.json` 在每条入站消息时会被重新读取；通过 `/feishu:access` 改策略一般**无需**重启。凭证变更需要重启 channel / MCP 进程。
- 若用户使用自定义 `FEISHU_STATE_DIR`，所有路径都相对于该目录，与运行时 `feishu.ts` / `access.ts` 行为一致。
