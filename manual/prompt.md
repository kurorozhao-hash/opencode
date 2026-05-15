# prompt 函数代码逻辑解析

> 源文件：`opencode/packages/opencode/src/session/prompt.ts` 第1588-1607行

## 概述

[`prompt()`](../packages/opencode/src/session/prompt.ts:1588) 是用户发起新一轮对话的核心入口函数，使用 Effect-TS 的 `Effect.fn` 定义，负责处理从用户输入到 AI 响应的完整流程。

## 输入参数

[`PromptInput`](../packages/opencode/src/session/prompt.ts:2026) 包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionID` | `SessionID` | 是 | 会话唯一标识 |
| `messageID` | `MessageID` | 否 | 消息唯一标识 |
| `model` | `ModelRef` | 否 | 指定使用的模型 |
| `agent` | `string` | 否 | 指定使用的 Agent |
| `noReply` | `boolean` | 否 | 是否不触发 AI 回复 |
| `tools` | `Record<string, boolean>` | 否 | 工具权限配置（已废弃，建议使用 session 权限） |
| `format` | `MessageV2.Format` | 否 | 消息格式 |
| `system` | `string` | 否 | 自定义系统提示 |
| `variant` | `string` | 否 | 模型变体 |
| `parts` | `MessageV2.PartInput[]` | 否 | 消息内容部分（文本、文件、子任务等） |

## 逻辑流程（按执行顺序）

### 1. 获取会话

```typescript
const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
```

- 从会话存储中获取当前会话信息
- 若会话不存在，`Effect.orDie` 会将错误转换为不可恢复的缺陷，直接终止执行

**示例：**

```typescript
// 场景：用户发起对话，input.sessionID = "ses_01HZ3ABCDEF"

// 成功情况：会话存在
// sessions.get 返回：
session = {
  id: "ses_01HZ3ABCDEF",
  title: "代码重构讨论",
  agent: "code",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
  permission: [],
  createdAt: 1716000000000,
  // ...其他会话字段
}
// → 继续后续步骤

// 失败情况：会话不存在（如 sessionID 拼写错误或已被删除）
// sessions.get 抛出错误 → Effect.orDie 将其转为缺陷
// → 整个 prompt 函数立即终止，不再执行后续任何步骤
```

### 2. 清理回滚状态

```typescript
yield* revert.cleanup(session)
```

- 调用 `SessionRevert.Service` 的 `cleanup` 方法
- 清理上一次对话可能残留的回滚（undo）状态
- 确保新一轮对话从干净状态开始

**示例：**

```typescript
// 场景：用户在上一轮对话中执行了 undo 操作，残留了回滚状态

// 清理前：回滚状态可能包含
// revertState = {
//   snapshot: { messages: [...上一轮快照], toolResults: [...] },
//   checkpointID: "ckpt_01HZ3GHIJKL"
// }

// 清理后：所有回滚快照和检查点被移除
// revertState = undefined（或被置空）

// 这一步保证了新对话不会受到上一次 undo 状态的影响
// 例如：用户 undo 了一次工具调用后，再次发送消息时，
// 不会因为残留的回滚状态而导致消息顺序混乱
```

### 3. 创建用户消息

```typescript
const message = yield* createUserMessage(input)
```

内部逻辑：
- 解析 `agent`：若指定则获取对应 Agent，否则使用默认 Agent；若 Agent 不存在则发布 `Session.Event.Error` 事件
- 解析 `model`：按优先级 `input.model → agent.model → 当前会话模型` 确定使用的模型
- 解析 `variant`：确定模型变体配置
- 构建 `MessageV2.User` 消息对象，包含 id、role、sessionID、time、tools、agent、model、system、format 等信息
- 如果 Agent 发生切换，触发 `SessionEvent.AgentSwitched.Sync` 同步事件
- 将用户消息的各 part（文本、文件、子任务等）持久化到数据库

**示例 — Agent 解析：**

```typescript
// 场景1：用户显式指定 agent
// input = { sessionID: "ses_01HZ3ABCDEF", agent: "code", parts: [...] }
// → agents.get("code") 返回 code Agent
// → ag = { name: "code", model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }, ... }

// 场景2：用户未指定 agent
// input = { sessionID: "ses_01HZ3ABCDEF", parts: [...] }
// → agents.defaultInfo() 返回默认 Agent
// → ag = { name: "code", ... }  // 通常默认为 code Agent

// 场景3：用户指定了不存在的 agent
// input = { sessionID: "ses_01HZ3ABCDEF", agent: "nonexistent", parts: [...] }
// → agents.get("nonexistent") 返回 null
// → 发布 Session.Event.Error 事件，错误信息："Agent not found: \"nonexistent\". Available agents: code, architect"
// → 抛出错误，终止执行
```

**示例 — Model 解析（优先级链）：**

```typescript
// 优先级：input.model > agent.model > 当前会话模型(currentModel)

// 场景1：用户显式指定模型（最高优先级）
// input.model = { providerID: "openai", modelID: "gpt-4o" }
// → model = { providerID: "openai", modelID: "gpt-4o" }
// → 忽略 agent.model 和会话模型

// 场景2：用户未指定模型，但 Agent 有默认模型
// input.model = undefined
// ag.model = { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }
// → model = { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }

// 场景3：用户和 Agent 都未指定，回退到会话当前模型
// input.model = undefined, ag.model = undefined
// → currentModel(sessionID) 返回会话上次使用的模型
// → model = { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }
```

**示例 — Agent 切换事件：**

```typescript
// 场景：会话当前使用 "code" Agent，用户切换到 "architect" Agent
// 数据库中 current.agent = "code"
// 新消息 info.agent = "architect"

// current?.agent !== info.agent → true
// → 触发 SessionEvent.AgentSwitched.Sync 事件：
// {
//   sessionID: "ses_01HZ3ABCDEF",
//   timestamp: DateTime.makeUnsafe(1716000000000),
//   agent: "architect"
// }
// → UI 层收到事件后可更新显示，如切换 Agent 标签、更新工具栏等
```

**示例 — Model 切换事件：**

```typescript
// 场景：用户从 claude-sonnet-4-20250514 切换到 gpt-4o
// 数据库中 current.model = { providerID: "anthropic", id: "claude-sonnet-4-20250514", variant: "default" }
// 新消息 info.model = { providerID: "openai", modelID: "gpt-4o", variant: undefined }

// providerID 不同 → 触发 SessionEvent.ModelSwitched.Sync 事件：
// {
//   sessionID: "ses_01HZ3ABCDEF",
//   timestamp: DateTime.makeUnsafe(1716000000000),
//   model: {
//     id: "gpt-4o",
//     providerID: "openai",
//     variant: "default"
//   }
// }
```

**示例 — 消息 Part 解析（文件处理）：**

```typescript
// 场景1：用户附加了一个文本文件 @src/utils/helper.ts
// part = { type: "file", url: "file:///path/to/src/utils/helper.ts", mime: "text/plain" }
// → resolvePart 识别 url.protocol 为 "file:"
// → 调用 Read 工具读取文件内容
// → 返回多个 synthetic part：
// [
//   { type: "text", synthetic: true, text: "Called the Read tool with the following input: {\"filePath\":\"/path/to/src/utils/helper.ts\"}" },
//   { type: "text", synthetic: true, text: "// helper.ts 的完整文件内容..." },
//   { type: "file", url: "file:///path/to/src/utils/helper.ts", mime: "text/plain" }  // 原始 part 保留
// ]

// 场景2：用户附加了一个图片文件 @screenshot.png
// part = { type: "file", url: "file:///path/to/screenshot.png", mime: "image/png" }
// → mime 不是 text/plain，也不是目录
// → 读取文件并转为 base64 data URL
// → 返回：
// [
//   { type: "text", synthetic: true, text: "Called the Read tool with the following input: {\"filePath\":\"/path/to/screenshot.png\"}" },
//   { type: "file", url: "data:image/png;base64,iVBORw0KGgo...", mime: "image/png", filename: "screenshot.png" }
// ]

// 场景3：用户附加了一个 MCP 资源
// part = { type: "file", source: { type: "resource", clientName: "github", uri: "repo://owner/repo/README.md" } }
// → 识别 source.type === "resource"
// → 调用 mcp.readResource("github", "repo://owner/repo/README.md")
// → 将资源内容转为 text part：
// [
//   { type: "text", synthetic: true, text: "Reading MCP resource: README.md (repo://owner/repo/README.md)" },
//   { type: "text", synthetic: true, text: "# My Project\n..." },  // 资源内容
//   { type: "file", ... }  // 原始 part 保留
// ]

// 场景4：用户附加了子任务 part
// part = { type: "agent", name: "architect" }
// → 返回：
// [
//   { type: "agent", name: "architect", messageID: info.id, sessionID: input.sessionID },
//   { type: "text", synthetic: true, text: " Use the above message and context to generate a prompt and call the task tool with subagent: architect . Invoked by user; guaranteed to exist." }
// ]
```

### 4. 更新会话活跃时间

```typescript
yield* sessions.touch(input.sessionID)
```

- 刷新会话的"最后活跃时间"
- 用于会话列表排序和过期管理

**示例：**

```typescript
// 场景：用户在会话列表中，会话按最后活跃时间降序排列

// touch 之前：
// session.lastActiveAt = 1715900000000  // 昨天的时间

// touch 之后：
// session.lastActiveAt = 1716000000000  // 当前时间

// 效果：该会话在会话列表中排到最前面
// 这确保了用户最近交互的会话总是容易找到
```

### 5. 处理权限规则

```typescript
const permissions: Permission.Ruleset = []
for (const [t, enabled] of Object.entries(input.tools ?? {})) {
  permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
}
if (permissions.length > 0) {
  session.permission = permissions
  yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
}
```

- 将 `input.tools`（`Record<string, boolean>`）转换为 `Permission.Ruleset`
- 转换规则：
  - `enabled === true` → `{ permission: t, action: "allow", pattern: "*" }`
  - `enabled === false` → `{ permission: t, action: "deny", pattern: "*" }`
  - `pattern: "*"` 表示匹配该工具的所有操作
- 若有权限规则，同时更新：
  - 内存中的 `session.permission`
  - 数据库中的权限记录（通过 `sessions.setPermission`）

**示例：**

```typescript
// 场景1：用户允许 bash 工具，禁止 file_write 工具
// input.tools = { "bash": true, "file_write": false }

// 转换过程：
// 遍历 Object.entries({ "bash": true, "file_write": false })
// → ["bash", true]  → { permission: "bash", action: "allow", pattern: "*" }
// → ["file_write", false] → { permission: "file_write", action: "deny", pattern: "*" }

// 最终 permissions = [
//   { permission: "bash", action: "allow", pattern: "*" },
//   { permission: "file_write", action: "deny", pattern: "*" }
// ]

// 同时更新：
// 1. 内存：session.permission = permissions
// 2. 数据库：sessions.setPermission({ sessionID: "ses_01HZ3ABCDEF", permission: permissions })

// 场景2：用户未指定任何工具权限
// input.tools = undefined 或 {}

// permissions 数组为空 → 不执行任何更新
// 会话权限保持原有配置不变

// 场景3：只允许特定工具
// input.tools = { "read": true }
// permissions = [{ permission: "read", action: "allow", pattern: "*" }]
// → AI 在此会话中只能使用 read 工具（其他工具的权限取决于会话默认配置）
```

### 6. 条件返回

```typescript
if (input.noReply === true) return message
return yield* loop({ sessionID: input.sessionID })
```

- **`noReply === true`**：直接返回刚创建的用户消息，不触发 AI 回复
  - 适用场景：只需要记录用户输入、不需要 AI 响应（如工具调用结果回传）
- **否则**：调用 [`loop()`](../packages/opencode/src/session/prompt.ts:1847)，进入 AI 对话循环
  - `loop` 内部通过 `state.ensureRunning` 启动或继续运行 `runLoop`
  - `runLoop` 即 LLM 推理 → 工具调用 → 再次推理的循环，直到 AI 不再调用工具为止

**示例 — noReply 路径：**

```typescript
// 场景：工具调用结果回传，不需要 AI 再次回复
// input = {
//   sessionID: "ses_01HZ3ABCDEF",
//   noReply: true,
//   parts: [{ type: "text", text: "File written successfully" }]
// }

// → 创建用户消息，记录 "File written successfully"
// → 直接返回 message，不触发 AI 回复
// → 返回值：{ info: { id: "msg_01HZ3XYZ", role: "user", ... }, parts: [...] }

// 典型使用场景：
// 1. 工具执行完成后，将结果追加到对话历史，但不启动新的 LLM 推理
// 2. 用户只想记录一条消息（如备注、标记），不需要 AI 回应
// 3. 子任务完成后回传结果给父会话
```

**示例 — loop 路径（默认路径）：**

```typescript
// 场景：普通用户对话
// input = {
//   sessionID: "ses_01HZ3ABCDEF",
//   parts: [{ type: "text", text: "帮我重构这个函数" }]
// }

// noReply 未设置（默认 undefined）→ 进入 loop 路径
// → loop({ sessionID: "ses_01HZ3ABCDEF" })
// → state.ensureRunning(sessionID, lastAssistant(sessionID), runLoop(sessionID))
//    确保 runLoop 只运行一个实例（防止并发）
// → runLoop 开始执行（见下方 runLoop 详解）
```

---

## runLoop 详解

> 源码位于 [`runLoop()`](../packages/opencode/src/session/prompt.ts:1617)

`runLoop` 是 AI 对话的核心推理循环，负责反复调用 LLM 直到获得最终回复。

### 循环步骤概览

```
while (true) {
  ① 设置状态为 busy
  ② 获取消息历史 & 定位关键消息
  ③ 退出判定：AI 已完成回复且无待处理工具调用
  ④ 第一步时自动生成会话标题
  ⑤ 处理子任务 (subtask) 或上下文压缩 (compaction)
  ⑥ 检查 token 溢出，必要时触发自动压缩
  ⑦ 验证 Agent 有效性
  ⑧ 构建 Assistant 消息 & 调用 LLM
  ⑨ 处理 LLM 返回结果，决定 break 或 continue
}
循环结束后 → 清理压缩记录 → 返回最后的 Assistant 消息
```

### 步骤详解与示例

#### ① 设置状态为 busy

```typescript
yield* status.set(sessionID, { type: "busy" })
```

**示例：**

```typescript
// 循环每一步开始时，将会话状态设为 "busy"
// UI 层根据此状态显示加载动画/进度指示器

// status 变化：
// { type: "idle" } → { type: "busy" }
```

#### ② 获取消息历史 & 定位关键消息

```typescript
let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
let lastUser: MessageV2.User | undefined
let lastAssistant: MessageV2.Assistant | undefined
let lastFinished: MessageV2.Assistant | undefined
let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
for (let i = msgs.length - 1; i >= 0; i--) {
  const msg = msgs[i]
  if (!lastUser && msg.info.role === "user") lastUser = msg.info
  if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info
  if (!lastFinished && msg.info.role === "assistant" && msg.info.finish) lastFinished = msg.info
  if (lastUser && lastFinished) break
  const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
  if (task && !lastFinished) tasks.push(...task)
}
```

**示例：**

```typescript
// 假设消息历史如下（从旧到新）：
// msgs = [
//   { info: { role: "user", id: "msg_1" }, parts: [...] },        // 用户消息
//   { info: { role: "assistant", id: "msg_2", finish: "stop" }, parts: [...] },  // AI 已完成回复
//   { info: { role: "user", id: "msg_3" }, parts: [{ type: "subtask", ... }] },  // 子任务
//   { info: { role: "assistant", id: "msg_4" }, parts: [...] },   // AI 回复（未完成，有工具调用）
//   { info: { role: "user", id: "msg_5" }, parts: [...] },        // 最新用户消息
// ]

// 从末尾向前遍历：
// i=4: role="user" → lastUser = msg_5
// i=3: role="assistant", finish 未设置 → lastAssistant = msg_4
// i=3: 无 finish → lastFinished 仍为 undefined
// i=3: 遍历 parts，可能找到 subtask/compaction → 加入 tasks
// i=2: role="user" → lastUser 已有值，跳过
// i=2: 无 finish → 继续收集 tasks
// ...

// 结果：
// lastUser = msg_5（最新的用户消息）
// lastAssistant = msg_4（最新的 assistant 消息）
// lastFinished = msg_2（最新已完成的 assistant 消息）
// tasks = [...]（未完成 assistant 之前的待处理任务）
```

#### ③ 退出判定

```typescript
const hasToolCalls =
  lastAssistantMsg?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false

if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) {
  yield* slog.info("exiting loop")
  break
}
```

**示例：**

```typescript
// 场景1：AI 已正常完成回复（无工具调用）
// lastAssistant.finish = "stop"
// hasToolCalls = false
// lastUser.id = "msg_5" < lastAssistant.id = "msg_6"
// → 条件全部满足 → break 退出循环

// 场景2：AI 调用了工具，需要继续循环
// lastAssistant.finish = "tool-calls"
// → "tool-calls" 在排除列表中 → 条件不满足 → continue 继续循环
// （下一步会将工具执行结果发送回 LLM）

// 场景3：AI finish 为 "stop" 但消息中仍包含工具调用
// （某些 Provider 会在 finish 为 "stop" 时返回工具调用）
// lastAssistant.finish = "stop"
// hasToolCalls = true  // 消息中仍有未处理的工具调用
// → hasToolCalls 为 true → 条件不满足 → continue 继续循环

// 场景4：Provider 执行的工具（如 DWS Agent Platform）
// part.metadata?.providerExecuted = true
// → 这些工具已在 Provider 端完成，不需要再循环处理
// → hasToolCalls = false（被过滤掉了）
```

#### ④ 自动生成会话标题

```typescript
if (step === 1)
  yield* title({
    session,
    modelID: lastUser.model.modelID,
    providerID: lastUser.model.providerID,
    history: msgs,
  }).pipe(Effect.ignore, Effect.forkIn(scope))
```

**示例：**

```typescript
// 仅在循环的第一步（step === 1）执行，且为异步 fork 不阻塞主流程

// 场景：新会话的第一轮对话
// 用户发送："帮我重构 src/utils/helper.ts 中的 parseJSON 函数"
// step = 1 → 触发 title 生成
// → title 函数根据用户消息和消息历史，调用 LLM 生成摘要标题
// → 生成结果如："重构 helper.ts 中的 parseJSON 函数"
// → 更新 session.title

// Effect.ignore 确保即使标题生成失败也不影响主流程
// Effect.forkIn(scope) 确保在 scope 结束时清理资源
```

#### ⑤ 处理子任务与上下文压缩

```typescript
const task = tasks.pop()
if (task?.type === "subtask") {
  yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
  continue
}
if (task?.type === "compaction") {
  const result = yield* compaction.process({
    messages: msgs,
    parentID: lastUser.id,
    sessionID,
    auto: task.auto,
    overflow: task.overflow,
  })
  if (result === "stop") break
  continue
}
```

**示例 — 子任务处理：**

```typescript
// 场景：用户通过 Agent 部分触发了子任务
// tasks 中包含一个 subtask part：
// task = { type: "subtask", name: "architect", prompt: "设计数据库架构..." }

// → handleSubtask 启动 "architect" Agent 作为子 Agent
// → 子 Agent 在独立的上下文中运行
// → 子 Agent 完成后，结果回传到当前会话
// → continue 回到 while 循环顶部，继续下一步
```

**示例 — 上下文压缩：**

```typescript
// 场景：对话历史过长，需要压缩上下文
// task = { type: "compaction", auto: true, overflow: false }

// → compaction.process 将旧消息压缩为摘要
// 例如将 50 条历史消息压缩为：
// "之前的对话讨论了：1) 重构方案选择 2) 数据库迁移策略 3) API 设计原则..."

// → result 可能的返回值：
// "continue" → 压缩完成，继续循环
// "stop" → 压缩过程中发现问题，终止循环

// 自动压缩触发条件：当 token 数量接近模型上下文窗口限制时
// overflow = true 表示是因为 token 溢出而触发的紧急压缩
```

#### ⑥ Token 溢出检查

```typescript
if (
  lastFinished &&
  lastFinished.summary !== true &&
  (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
) {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
  continue
}
```

**示例：**

```typescript
// 场景：AI 回复消耗了大量 token，接近模型上限
// lastFinished.tokens = { input: 180000, output: 5000, ... }
// model 上下文窗口 = 200000 tokens

// compaction.isOverflow 检查：180000 / 200000 = 90% > 阈值
// → 返回 true → 触发自动压缩
// → compaction.create 生成一个 compaction 任务
// → continue 回到循环顶部，在步骤⑤中处理这个压缩任务

// 如果 lastFinished.summary === true，说明这是一条摘要消息，不需要再压缩
// 这避免了"压缩的压缩"无限循环
```

#### ⑦ 验证 Agent 有效性

```typescript
const agent = yield* agents.get(lastUser.agent)
if (!agent) {
  const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
  const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
  const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
  yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
  throw error
}
```

**示例：**

```typescript
// 场景：用户消息中指定了一个不存在的 Agent
// lastUser.agent = "custom_agent"（未注册）

// agents.get("custom_agent") → null
// → 构建错误信息："Agent not found: \"custom_agent\". Available agents: code, architect, chat"
// → 发布 Session.Event.Error 事件
// → 抛出错误，终止 runLoop

// 这是一种防御性检查，正常情况下 createUserMessage 阶段已验证过 Agent
// 但在 runLoop 的后续循环步骤中，Agent 可能因配置变更而失效
```

#### ⑧ 构建 Assistant 消息 & 调用 LLM

```typescript
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
msgs = yield* insertReminders({ messages: msgs, agent, session })

const msg: MessageV2.Assistant = {
  id: MessageID.ascending(),
  parentID: lastUser.id,
  role: "assistant",
  // ...构建完整的 assistant 消息对象
}
yield* sessions.updateMessage(msg)
const handle = yield* processor.create({ assistantMessage: msg, sessionID, model })
```

**示例 — 步骤限制：**

```typescript
// 场景1：Agent 设置了最大步骤数
// agent.steps = 50
// step = 50 → isLastStep = true
// → 在 LLM 消息中追加 MAX_STEPS 提示，告知 AI 这是最后一步
// → AI 会尽量完成当前任务，不再发起新的工具调用

// 场景2：Agent 未设置步骤限制
// agent.steps = undefined → maxSteps = Infinity
// → isLastStep 永远为 false
// → AI 可以无限循环直到自然结束
```

**示例 — 工具解析与 LLM 调用：**

```typescript
// resolveTools 根据 agent、session 权限、模型能力等确定可用工具集
// tools = {
//   "bash": { ... },
//   "read": { ... },
//   "write": { ... },
//   "task": { ... },
//   ...
// }

// 如果用户请求了结构化输出 (json_schema)
// format = { type: "json_schema", schema: { ... } }
// → 追加 StructuredOutput 工具，AI 必须调用此工具返回结构化数据

// LLM 调用：
// handle.process({
//   user: lastUser,          // 当前用户消息
//   agent,                   // 使用的 Agent
//   permission: session.permission,  // 权限规则
//   system,                  // 系统提示（环境信息 + 指令 + 技能）
//   messages: modelMsgs,     // 转换后的模型消息格式
//   tools,                   // 可用工具集
//   model,                   // 使用的模型
//   toolChoice,              // 工具选择策略（json_schema 时为 "required"）
// })
```

**示例 — 系统提示构建：**

```typescript
// system 提示由三部分拼接而成：
// env = [ "Current directory: /path/to/project", "OS: darwin", "Shell: /bin/zsh", ... ]
// instructions = [ "You are a helpful coding assistant...", agent 专属指令, ... ]
// skills = "Available skills: debug, refactor, test, ..."

// 最终 system = [
//   "Current directory: /path/to/project",
//   "OS: darwin",
//   "You are a helpful coding assistant...",
//   "Available skills: debug, refactor, test, ..."
// ]
```

**示例 — 中间用户消息提醒：**

```typescript
// 场景：step > 1 且 AI 已经完成过一轮回复，用户在工具调用期间发送了新消息
// 原始用户消息："等等，请先检查测试是否通过"
// → 包装为：
// "<system-reminder>
//  The user sent the following message:
//  等等，请先检查测试是否通过
//
//  Please address this message and continue with your tasks.
//  </system-reminder>"

// 这确保 AI 在多步工具调用过程中不会忽略用户的新消息
```

#### ⑨ 处理 LLM 返回结果

```typescript
if (structured !== undefined) {
  handle.message.structured = structured
  handle.message.finish = handle.message.finish ?? "stop"
  yield* sessions.updateMessage(handle.message)
  return "break"
}
const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
if (finished && !handle.message.error) {
  if (format.type === "json_schema") {
    handle.message.error = new MessageV2.StructuredOutputError({ ... })
    yield* sessions.updateMessage(handle.message)
    return "break"
  }
}
if (result === "stop") return "break"
if (result === "compact") {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true, overflow: !handle.message.finish })
}
return "continue"
```

**示例 — 结构化输出成功：**

```typescript
// 场景：用户请求 JSON 格式的结构化输出
// format = { type: "json_schema", schema: { type: "object", properties: { summary: { type: "string" } } } }
// AI 调用了 StructuredOutput 工具，返回 { summary: "这是一个重构方案" }

// structured = { summary: "这是一个重构方案" }
// → handle.message.structured = { summary: "这是一个重构方案" }
// → handle.message.finish = "stop"
// → 更新数据库中的消息
// → return "break" → 退出循环
```

**示例 — 结构化输出失败：**

```typescript
// 场景：AI 未能调用 StructuredOutput 工具，直接返回了文本回复
// format.type = "json_schema"
// finished = true, handle.message.error = null
// → 创建 StructuredOutputError：{ message: "Model did not produce structured output", retries: 0 }
// → 记录到消息的 error 字段
// → return "break" → 退出循环
```

**示例 — 正常工具调用循环：**

```typescript
// 场景：AI 调用了 read 工具查看文件
// handle.message.finish = "tool-calls"（或 undefined）
// result = "continue"

// → return "continue" → while 循环继续
// → 下一次迭代中，工具结果会作为新的 user 消息出现在 msgs 中
// → AI 收到工具结果后继续推理

// 典型多步流程：
// step 1: AI → "我需要查看文件内容" → 调用 read 工具 → continue
// step 2: AI → "我看到代码了，需要修改..." → 调用 write 工具 → continue
// step 3: AI → "修改完成，以下是总结..." → finish = "stop" → break
```

**示例 — 处理器返回 "stop"：**

```typescript
// 场景：processor.process 返回 "stop"
// 例如：AI 主动停止生成，或达到某个停止条件
// → return "break" → 退出循环
```

**示例 — 处理器返回 "compact"：**

```typescript
// 场景：processor 检测到需要压缩上下文
// result = "compact"
// → compaction.create 生成压缩任务
// overflow = !handle.message.finish
//   如果 finish 为 undefined（AI 还没结束）→ overflow = true（紧急压缩）
//   如果 finish 有值（AI 已结束但 token 仍过多）→ overflow = false（常规压缩）
// → return "continue" → 下一次迭代处理压缩任务
```

### 循环结束

```typescript
yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
return yield* lastAssistant(sessionID)
```

**示例：**

```typescript
// 循环结束后的收尾工作：

// 1. 清理过期的压缩记录（异步执行，不阻塞返回）
// compaction.prune 删除不再需要的压缩快照和中间数据

// 2. 获取最后的 assistant 消息并返回
// lastAssistant(sessionID) 从消息历史中找到最近的非 user 消息
// → 返回完整的 MessageV2.WithParts（包含 info 和 parts）

// 返回给 prompt() 函数的调用者，最终传递给 UI 层展示
```

## 事件触发流程

```
用户调用 prompt(input)
  │
  ├─ ① sessions.get(sessionID)
  │     ├─ 成功 → 返回 session 对象
  │     └─ 失败 → Effect.orDie → 终止执行（不可恢复缺陷）
  │
  ├─ ② revert.cleanup(session)
  │     └─ 清理上轮残留的 undo/回滚状态
  │
  ├─ ③ createUserMessage(input)
  │     ├─ 解析 agent → agents.get / agents.defaultInfo
  │     │     └─ Agent 不存在 → 发布 Session.Event.Error → 终止
  │     ├─ 解析 model → input.model > agent.model > currentModel
  │     ├─ 解析 variant → 确定模型变体
  │     ├─ 构建 MessageV2.User 消息对象
  │     ├─ Agent 切换？ → 触发 SessionEvent.AgentSwitched.Sync
  │     ├─ Model 切换？ → 触发 SessionEvent.ModelSwitched.Sync
  │     ├─ 解析 parts（文本/文件/子任务/MCP资源）
  │     │     ├─ file (text/plain) → Read 工具读取 → synthetic text parts
  │     │     ├─ file (image/*) → 转 base64 data URL
  │     │     ├─ file (resource) → mcp.readResource → 资源内容
  │     │     ├─ file (directory) → Read 工具列出目录
  │     │     └─ agent → 生成 subtask 提示文本
  │     ├─ 持久化消息和 parts 到数据库
  │     └─ 触发 SessionEvent.Prompted.Sync + SessionEvent.Synthetic.Sync
  │
  ├─ ④ sessions.touch(sessionID)
  │     └─ 刷新 lastActiveAt（影响会话列表排序）
  │
  ├─ ⑤ 处理 input.tools → Permission.Ruleset
  │     ├─ tools[bash]=true  → { permission: "bash", action: "allow", pattern: "*" }
  │     ├─ tools[write]=false → { permission: "write", action: "deny", pattern: "*" }
  │     ├─ 更新内存 session.permission
  │     └─ sessions.setPermission → 更新数据库
  │
  └─ ⑥ noReply ?
       │
       ├─ true → 返回用户消息（仅记录，不触发 AI）
       │
       └─ false → loop() → state.ensureRunning → runLoop(sessionID)
                    │
                    └─ while (true) { ... runLoop 推理循环 ... }
                         │
                         ├─ status.set("busy") → UI 显示加载状态
                         │
                         ├─ 获取消息历史 & 定位 lastUser / lastAssistant / lastFinished
                         │
                         ├─ 退出判定：
                         │     finish ≠ "tool-calls" && 无待处理工具调用 && lastUser.id < lastAssistant.id
                         │     → break 退出循环
                         │
                         ├─ step === 1 → 异步生成会话标题 (Effect.forkIn)
                         │
                         ├─ 处理 tasks 队列：
                         │     ├─ subtask → handleSubtask → continue
                         │     └─ compaction → compaction.process → continue / break
                         │
                         ├─ token 溢出检查 → compaction.create(auto: true) → continue
                         │
                         ├─ 验证 Agent 有效性 → 不存在则发布 Error 事件 → throw
                         │
                         ├─ 构建 Assistant 消息 & 调用 LLM：
                         │     ├─ resolveTools → 确定可用工具集
                         │     ├─ json_schema? → 追加 StructuredOutput 工具
                         │     ├─ step > 1? → 包装中间用户消息为 system-reminder
                         │     ├─ 构建 system 提示 (env + instructions + skills)
                         │     └─ processor.process → LLM 推理
                         │
                         ├─ 处理 LLM 结果：
                         │     ├─ structured output 成功 → break
                         │     ├─ structured output 失败 → 记录 error → break
                         │     ├─ result === "stop" → break
                         │     ├─ result === "compact" → 创建压缩任务 → continue
                         │     └─ 否则 → continue（工具调用循环）
                         │
                         └─ 循环结束 → compaction.prune → 返回 lastAssistant
```

## 核心设计意图

此函数是**用户输入 → AI 响应**的关键桥梁，`noReply` 参数将两条路径清晰地分离开来：

1. **仅记录路径**：`noReply = true`，只创建用户消息并返回，适用于不需要 AI 回复的场景
2. **对话循环路径**：`noReply = false`（默认），创建用户消息后进入 LLM 推理循环，实现完整的 AI 对话能力