# OpenCode 日志事件类型分析

本文档记录了 `llm-event-logger` 中所有 14 种事件类型及其在 opencode 代码中的触发函数。

## 事件类型总览

| # | Type | 触发函数 | 文件位置 | 触发方式 |
|---|------|---------|---------|---------|
| 1 | `chat.headers` | `LLM.run()` | llm.ts:182 | `plugin.trigger("chat.headers", ...)` |
| 2 | `chat.message` | `SessionPrompt.prompt()` | prompt.ts:1461 | `plugin.trigger("chat.message", ...)` |
| 3 | `chat.params` | `LLM.run()` | llm.ts:161 | `plugin.trigger("chat.params", ...)` |
| 4 | `experimental.chat.system.transform` | `LLM.run()` | llm.ts:118 | `plugin.trigger(...)` |
| 5 | `experimental.text.complete` | `SessionProcessor.process()` | processor.ts:590 | `plugin.trigger(...)` (text-end 分支) |
| 6 | `message.part.delta` | `Session.updatePartDelta()` | session.ts:812 | `bus.publish(Event.PartDelta, ...)` |
| 7 | `question.asked` | `Question.ask()` | question/index.ts:156 | `bus.publish(Event.Asked, ...)` |
| 8 | `question.replied` | `Question.reply()` | question/index.ts:178 | `bus.publish(Event.Replied, ...)` |
| 9 | `session.diff` | `SessionRevert.revert()` / `SessionSummary.summarize()` | revert.ts:80 / summary.ts:118 | `bus.publish(Session.Event.Diff, ...)` |
| 10 | `session.idle` | `SessionStatus.set()` | status.ts:81 | `bus.publish(Event.Idle, ...)` (当 status.type === "idle") |
| 11 | `session.status` | `SessionStatus.set()` | status.ts:79 | `bus.publish(Event.Status, ...)` |
| 12 | `shell.env` | `SessionPrompt.prompt()` / `ShellTool.shellEnv()` | prompt.ts:1005 / shell.ts:412 | `plugin.trigger("shell.env", ...)` |
| 13 | `tool.execute.after` | `SessionPrompt.prompt()` | prompt.ts:591 | `plugin.trigger("tool.execute.after", ...)` |
| 14 | `tool.execute.before` | `SessionPrompt.prompt()` | prompt.ts:576 | `plugin.trigger("tool.execute.before", ...)` |

> 文件位置均为相对路径，基于 `opencode/packages/opencode/src/`。

## 按触发函数分组

### LLM.run() — 触发 3 个事件

文件：`opencode/packages/opencode/src/session/llm.ts:76`

| 事件类型 | 行号 | 说明 |
|---------|------|------|
| `experimental.chat.system.transform` | 118 | 在构建系统提示词后触发，允许插件对 system prompt 进行变换 |
| `chat.params` | 161 | 在组装 LLM 请求参数后触发，允许插件修改 temperature、topP 等参数 |
| `chat.headers` | 182 | 在组装请求头后触发，允许插件注入自定义 HTTP 头 |

### SessionPrompt.prompt() — 触发 5 个事件

文件：`opencode/packages/opencode/src/session/prompt.ts:1585`

| 事件类型 | 行号 | 说明 |
|---------|------|------|
| `tool.execute.before` | 576 | 在工具执行前触发，携带工具名、sessionID、callID 和参数 |
| `tool.execute.after` | 591 | 在工具执行后触发，携带执行结果和附件信息 |
| `shell.env` | 1005 | 在执行 shell 命令前触发，允许插件注入环境变量 |
| `chat.message` | 1461 | 在用户消息解析完成后触发，携带消息和解析后的 parts |

### SessionProcessor.process() — 触发 2 个事件（含间接）

文件：`opencode/packages/opencode/src/session/processor.ts:710`

| 事件类型 | 行号 | 说明 |
|---------|------|------|
| `message.part.delta` | 572 (间接) | 在 `text-delta` 和 `reasoning-delta` 分支中调用 `session.updatePartDelta()` |
| `experimental.text.complete` | 590 | 在 `text-end` 分支中触发，允许插件对完成的文本进行后处理 |

### SessionStatus.set() — 触发 2 个事件

文件：`opencode/packages/opencode/src/session/status.ts:77`

| 事件类型 | 行号 | 说明 |
|---------|------|------|
| `session.status` | 79 | 每次设置会话状态时触发 |
| `session.idle` | 81 | 仅当 status.type === "idle" 时触发（已废弃，由 session.status 替代） |

### Question.ask() / Question.reply() — 各触发 1 个事件

文件：`opencode/packages/opencode/src/question/index.ts`

| 事件类型 | 函数 | 行号 | 说明 |
|---------|------|------|------|
| `question.asked` | `Question.ask()` | 156 | 向用户发起提问时触发 |
| `question.replied` | `Question.reply()` | 178 | 用户回答提问后触发 |

### SessionRevert.revert() / SessionSummary.summarize() — 各触发 1 个事件

| 事件类型 | 函数 | 文件 | 行号 | 说明 |
|---------|------|------|------|------|
| `session.diff` | `SessionRevert.revert()` | revert.ts | 80 | 会话回滚后触发，携带文件差异信息 |
| `session.diff` | `SessionSummary.summarize()` | summary.ts | 118 | 会话摘要计算后触发，携带文件差异信息 |

### ShellTool.shellEnv() — 触发 1 个事件

文件：`opencode/packages/opencode/src/tool/shell.ts:411`

| 事件类型 | 行号 | 说明 |
|---------|------|------|
| `shell.env` | 412 | 在 shell 工具执行前触发，允许插件注入环境变量 |

## 按事件类别分组

### Chat 相关（LLM 对话生命周期）

- `experimental.chat.system.transform` — 系统提示词变换
- `chat.params` — 请求参数组装
- `chat.headers` — 请求头组装
- `chat.message` — 用户消息发送

### Message 相关（消息流式传输）

- `message.part.delta` — 消息部分增量更新（流式文本/推理增量）

### Tool 相关（工具执行生命周期）

- `tool.execute.before` — 工具执行前
- `tool.execute.after` — 工具执行后

### Session 相关（会话状态管理）

- `session.status` — 会话状态变更
- `session.idle` — 会话空闲（已废弃）
- `session.diff` — 会话文件差异

### Question 相关（用户交互问答）

- `question.asked` — 向用户提问
- `question.replied` — 用户回答

### Shell 相关（Shell 环境配置）

- `shell.env` — Shell 环境变量注入

### Experimental 相关（实验性功能）

- `experimental.chat.system.transform` — 系统提示词变换
- `experimental.text.complete` — 文本完成后的后处理