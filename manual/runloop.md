# runLoop() 核心运行循环 — 逐步拆解与实现原理

> 源码位置：[`prompt.ts:1617-1845`](../packages/opencode/src/session/prompt.ts:1617)

## 全局概览

`runLoop` 是一个 `while(true)` 无限循环，每次迭代完成一轮"用户意图 → LLM 推理 → 工具执行 → 结果判断"的完整周期。循环退出的唯一条件是 LLM 返回了最终结果（无待处理工具调用）。

```
┌──────────────────────────────────────────────────────┐
│  初始化（循环外）: ctx, slog, step, session          │
│                                                      │
│  while (true) {                                      │
│    Step 1:  设置状态 busy                            │
│    Step 2:  获取消息历史                              │
│    Step 3:  向后遍历消息，提取关键引用                │
│    Step 4:  检查退出条件                             │
│    Step 5:  递增步数 + 后台生成标题                   │
│    Step 6:  获取模型配置                             │
│    Step 7:  处理 subtask 任务                        │
│    Step 8:  处理 compaction 压缩任务                  │
│    Step 9:  检查上下文溢出                           │
│    Step 10: 获取智能体配置 + 步数限制                 │
│    Step 11: 插入提醒消息                             │
│    Step 12: 创建助手消息 + 处理器                     │
│    Step 13: 核心处理（工具解析 → LLM调用 → 结果判断） │
│    Step 14: 根据 outcome 决策                        │
│  }                                                   │
│                                                      │
│  收尾: 后台压缩修剪 + 返回最后助手消息                │
└──────────────────────────────────────────────────────┘
```

---

## 初始化（循环外）

```typescript
// prompt.ts:1618-1623
const ctx = yield* InstanceState.context       // 项目上下文（directory, worktree）
const slog = elog.with({ sessionID })          // 带会话ID的结构化日志
let structured: unknown                        // 结构化输出结果（json_schema 模式用）
let step = 0                                   // 循环步数计数器
const session = yield* sessions.get(sessionID).pipe(Effect.orDie)  // 获取会话信息，失败则崩溃
```

**原理**：这些变量在整个循环生命周期内共享。`step` 用于限制最大循环次数（防死循环），`structured` 用于 JSON Schema 结构化输出模式，`session` 提供权限等会话级配置。

**示例**：

```typescript
// ===== 场景：用户在会话中发送 "帮我重构 src/utils.ts 中的 parseConfig 函数" =====

// ctx 包含项目上下文信息
const ctx = {
  directory: "/home/user/my-project",    // 项目工作目录
  worktree: "/home/user/my-project",     // git worktree 路径
}
// → 这决定了后续工具执行时的 cwd（当前工作目录），如 read_file 会相对于此目录解析路径

// slog 是带会话ID的结构化日志，用于调试追踪
const slog = elog.with({ sessionID: "sess_01JXABC123" })
// → 后续 slog.info("loop", { step: 1 }) 会输出: { sessionID: "sess_01JXABC123", step: 1 }

// structured 初始为 undefined，仅在 json_schema 模式下被赋值
let structured: unknown  // 如果用户请求 JSON 输出，这里会存储解析后的结构化结果
// 例：用户请求 { type: "json_schema", schema: { type: "object", properties: { files: { type: "array" } } } }
// → structured 最终会被赋值为 { files: ["src/utils.ts"] }

// step 从 0 开始，每次循环迭代递增
let step = 0  // 第1次迭代后 step=1，第2次迭代后 step=2，...
// → 用于: (1) 仅在 step===1 时生成标题/摘要 (2) 检查是否超过 agent.steps 上限

// session 包含会话级配置，获取失败则 Effect.orDie 直接崩溃
const session = yield* sessions.get("sess_01JXABC123").pipe(Effect.orDie)
// session = {
//   id: "sess_01JXABC123",
//   title: "New Session",           // 默认标题，后续会被标题生成覆盖
//   parentID: undefined,            // 非子会话时为 undefined
//   permission: [                   // 权限规则列表
//     { rule: "allow", tool: "read_file" },
//     { rule: "deny", tool: "bash", params: { command: "rm -rf *" } },
//   ],
//   ...其他元数据
// }
// → 权限规则会在 Step 13 中 resolveTools 时使用，决定哪些工具可自动执行、哪些需用户确认
```

---

## Step 1: 设置状态为 busy

```typescript
// prompt.ts:1626
yield* status.set(sessionID, { type: "busy" })
```

**原理**：将会话状态设为 `busy`，通知前端/UI 层"正在处理中"。这是 Effect 语义下的同步操作——状态更新完成后才继续。

**为什么每次循环迭代都要设置？** 因为上一次迭代可能触发了 `compaction`（压缩），中间状态可能变为 `idle`，需要重新标记为 `busy`。

**示例**：

```
=== 前端/UI 状态轮询的完整生命周期 ===

时间线:
  t0: 用户点击发送 → status.set("busy")
      前端显示: 🔄 "正在思考..."

  t1: LLM 返回文本 → status 仍为 "busy"（循环未结束）
      前端显示: 🔄 "正在生成回复..."

  t2: LLM 调用工具 → status 仍为 "busy"
      前端显示: 🔄 "正在执行工具..."

  t3: 工具执行完成，进入第2次迭代 → status.set("busy")（重新确认）
      前端显示: 🔄 "正在继续处理..."

  t4: LLM 返回最终回答，循环退出 → status.set("idle")
      前端显示: ✅ "完成"

=== 为什么每次迭代都要重新设置？ ===

场景：第1次迭代中 LLM 返回了大量 token，触发 compaction
  t0: 第1次迭代 → status.set("busy")
  t1: compaction.process() 执行期间，内部可能将状态临时设为其他值
  t2: 第2次迭代开始 → 必须重新 status.set("busy")，确保前端知道仍在处理中
      如果不重新设置，前端可能误以为处理已完成

=== 底层数据流 ===

// status.set 内部实现（简化）
status.set(sessionID, { type: "busy" })
  → 更新内存中的状态存储: Map<SessionID, Status>
  → 通过 bus 发布 Session.Event.StatusChange 事件
  → 前端订阅此事件，实时更新 UI

// 前端轮询示例
const response = await fetch(`/api/session/${sessionID}/status`)
// response: { type: "busy" } 或 { type: "idle" }
```

---

## Step 2: 获取消息历史

```typescript
// prompt.ts:1629
let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
```

**原理**：从数据库读取该会话的所有消息，并执行 `filterCompacted` 过滤——将已被压缩（compacted）的旧消息替换为摘要，只保留最近的有效消息。

**`filterCompacted` 核心逻辑**（[`message-v2.ts:1013-1063`](../packages/opencode/src/session/message-v2.ts:1013)）：

1. 正序遍历所有消息，记录已生成摘要的 assistant 消息对应的 parentID
2. 当遇到带 `compaction` 部分的 user 消息时，跳过被压缩的旧消息
3. 最终重排消息，将压缩摘要放在正确的位置

**示例**：

```
=== 场景1：无压缩的普通消息读取 ===

数据库中的消息:
  msg_001: { role: "user",    text: "帮我重构代码" }
  msg_002: { role: "assistant", text: "让我先看看文件...", finish: "tool-calls" }
  msg_003: { role: "user",    text: "[read_file 结果]", synthetic: true }
  msg_004: { role: "assistant", text: "我已读取文件，开始重构...", finish: "tool-calls" }
  msg_005: { role: "user",    text: "[write_file 结果]", synthetic: true }

filterCompactedEffect 返回:
  msgs = [msg_001, msg_002, msg_003, msg_004, msg_005]
  → 所有消息都未被压缩，原样返回

=== 场景2：有压缩的消息读取 ===

数据库中的消息（已触发过压缩）:
  msg_001: { role: "user",    text: "帮我修复 bug" }
  msg_002: { role: "assistant", text: "我发现了问题...", summary: true }  ← 已被标记为摘要
  msg_003: { role: "user",    text: "继续", compaction: { ... } }         ← 压缩摘要消息
  msg_004: { role: "assistant", text: "好的，我继续修复...", finish: "stop" }

filterCompactedEffect 返回:
  msgs = [msg_003, msg_004]
  → msg_001 和 msg_002 被过滤掉（因为 msg_002.summary = true）
  → msg_003 包含压缩摘要，作为新的"起点"替代旧消息

=== 场景3：每次迭代重新读取的必要性 ===

第1次迭代:
  msgs = [User("修复bug")]  // 只有用户消息
  → LLM 调用 read_file 工具
  → 工具执行后，数据库新增: User(tool_result), Assistant(工具调用记录)

第2次迭代:
  msgs = [User("修复bug"), Assistant(tool_call), User(tool_result)]  // 重新读取，包含新消息
  → LLM 看到工具结果，继续处理

如果第2次迭代不重新读取，LLM 就看不到工具执行的结果！
```

每次循环迭代都重新读取，因为上一轮的工具执行可能已添加新消息。

---

## Step 3: 向后遍历消息，提取关键引用

```typescript
// prompt.ts:1631-1643
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

**原理**：从最新消息向最早消息遍历，提取四个关键引用：

| 变量 | 含义 | 用途 |
|------|------|------|
| `lastUser` | 最近的用户消息 | 确定使用哪个 agent、model、format |
| `lastAssistant` | 最近的助手消息 | 检查 finish 状态、是否有工具调用 |
| `lastFinished` | 最近已完成（有 finish 标记）的助手消息 | 判断是否需要压缩、是否需要 system-reminder |
| `tasks` | 未处理的 subtask/compaction 任务 | 分发子任务或执行压缩 |

**为什么从后向前遍历？** 效率——通常最新的消息就在末尾，找到 `lastUser` 和 `lastFinished` 后立即 `break`。

**`tasks` 收集逻辑**：只在 `lastFinished` 之前的消息中收集——因为 `lastFinished` 之后的任务是尚未被处理的新任务。

**示例**：

```typescript
// ===== 场景1：简单对话，2轮消息 =====

// msgs = [
//   msg_0: { info: { role: "user", id: "msg_001" }, parts: [{ type: "text", text: "修复bug" }] },
//   msg_1: { info: { role: "assistant", id: "msg_002", finish: "stop" }, parts: [{ type: "text" }] },
// ]

// 从后向前遍历:
i=1: msg.info.role === "assistant" → lastAssistant = msg_1.info
     msg.info.finish === "stop"    → lastFinished = msg_1.info
i=0: msg.info.role === "user"      → lastUser = msg_0.info
     lastUser && lastFinished → break!

// 结果:
// lastUser = msg_0.info (User "修复bug")
// lastAssistant = msg_1.info (Assistant, finish="stop")
// lastFinished = msg_1.info
// tasks = [] (没有 subtask/compaction 部分)

// ===== 场景2：多步工具调用，含 subtask =====

// msgs = [
//   msg_0: { info: { role: "user", id: "msg_001" }, parts: [{ type: "text" }] },
//   msg_1: { info: { role: "assistant", id: "msg_002", finish: "stop" }, parts: [{ type: "text" }] },
//   msg_2: { info: { role: "user", id: "msg_003" }, parts: [
//     { type: "subtask", agent: "code", prompt: "修复类型错误" }  ← subtask 部分
//   ]},
//   msg_3: { info: { role: "assistant", id: "msg_004", finish: "tool-calls" }, parts: [{ type: "tool" }] },
//   msg_4: { info: { role: "user", id: "msg_005" }, parts: [{ type: "text", text: "继续" }] },
// ]

// 从后向前遍历:
i=4: msg.info.role === "user"       → lastUser = msg_4.info
i=3: msg.info.role === "assistant"  → lastAssistant = msg_3.info
     msg.info.finish === "tool-calls" → lastFinished 仍为 undefined (tool-calls 不是"完成")
     lastUser 已找到但 lastFinished 未找到 → 继续
     parts 无 subtask/compaction → tasks 不变
i=2: msg.info.role === "user"       → lastUser 已有值，跳过
     parts 包含 subtask → tasks.push(subtask_part)
     → tasks = [subtask_part]
i=1: msg.info.role === "assistant"  → lastAssistant 已有值，跳过
     msg.info.finish === "stop"     → lastFinished = msg_1.info
     lastUser && lastFinished → break!

// 结果:
// lastUser = msg_4.info (最近的 User "继续")
// lastAssistant = msg_3.info (Assistant, finish="tool-calls")
// lastFinished = msg_1.info (最近已完成的 Assistant)
// tasks = [subtask_part] ← 在 lastFinished 之前收集到的

// ===== 场景3：tasks 收集的边界条件 =====

// 关键逻辑: 只在 lastFinished 之前收集 tasks
// 因为 lastFinished 之后的 subtask/compaction 是新产生的，尚未被处理
// 而 lastFinished 之前的 tasks 是上次循环遗留的、需要本轮处理的

// 例如: compaction 任务在 lastFinished 之后产生
// msgs = [..., User(compaction), Assistant(finish="stop", summary=true)]
//        ↑ lastFinished = 这条 Assistant
// 遍历到 compaction 时，lastFinished 已找到 → break 之前不再收集
// 因为这条 compaction 已经被处理过了（summary=true 说明压缩已完成）
```

---

## Step 4: 检查退出条件

```typescript
// prompt.ts:1645-1665
if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

const lastAssistantMsg = msgs.findLast(
  (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
)
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

**原理**：这是循环退出的核心判断。四个条件**全部满足**才退出：

| 条件 | 含义 |
|------|------|
| `lastAssistant?.finish` | 助手消息有完成标记（stop/length/unknown） |
| `!["tool-calls"].includes(finish)` | 完成原因不是"还有工具调用" |
| `!hasToolCalls` | 助手消息中没有待处理的工具调用部分 |
| `lastUser.id < lastAssistant.id` | 助手消息比用户消息更新（已经回复了用户） |

**为什么需要 `hasToolCalls` 检查？** 注释说明：某些 Provider（如 OpenAI）即使响应中包含工具调用，`finish` 也可能返回 `"stop"` 而非 `"tool-calls"`。因此必须额外检查消息中是否真的有工具调用部分。

**`providerExecuted` 是什么？** DWS Agent Platform 等提供商会在其流内自行执行工具，结果已包含在流中。这些工具调用标记为 `providerExecuted`，不需要 re-loop 回传结果。

**示例**：

```typescript
// ===== 场景1：正常退出 — LLM 返回文本回答 =====

// lastAssistant = { finish: "stop", id: "msg_010" }
// lastUser = { id: "msg_005" }
// lastAssistantMsg.parts = [{ type: "text", text: "修复完成！" }]  // 无工具调用

// 逐条检查:
// lastAssistant.finish = "stop"                     → true (有完成标记)
// !["tool-calls"].includes("stop")                  → true (完成原因不是工具调用)
// !hasToolCalls                                     → true (确实没有工具调用)
// lastUser.id("msg_005") < lastAssistant.id("msg_010") → true (助手已回复用户)
// → 四个条件全部满足 → break! 退出循环

// ===== 场景2：不退出 — LLM 调用了工具 =====

// lastAssistant = { finish: "tool-calls", id: "msg_008" }
// lastAssistantMsg.parts = [
//   { type: "tool", tool: "read_file", state: { status: "completed" } }
// ]

// 逐条检查:
// lastAssistant.finish = "tool-calls"               → truthy
// !["tool-calls"].includes("tool-calls")            → false ← 不满足！
// → 不退出，继续循环（需要将工具结果回传给 LLM）

// ===== 场景3：OpenAI 特殊行为 — finish="stop" 但有工具调用 =====

// OpenAI 的某些模型即使返回了工具调用，finish_reason 也可能是 "stop" 而非 "tool_calls"
// lastAssistant = { finish: "stop", id: "msg_012" }
// lastAssistantMsg.parts = [
//   { type: "tool", tool: "bash", state: { status: "pending" } }  // 有工具调用！
// ]

// 逐条检查:
// lastAssistant.finish = "stop"                     → truthy
// !["tool-calls"].includes("stop")                  → true
// !hasToolCalls                                     → false ← 有工具调用！
// → 不退出，继续循环（这是 hasToolCalls 检查的核心价值）

// ===== 场景4：不退出 — 用户发送了新消息 =====

// 用户在 LLM 回复后又发送了新消息
// lastAssistant = { finish: "stop", id: "msg_010" }
// lastUser = { id: "msg_015" }  // 比助手消息更新

// 逐条检查:
// lastAssistant.finish = "stop"                     → truthy
// !["tool-calls"].includes("stop")                  → true
// !hasToolCalls                                     → true
// lastUser.id("msg_015") < lastAssistant.id("msg_010") → false ← 用户消息更新！
// → 不退出，需要处理用户新消息

// ===== 场景5：providerExecuted 工具 — 退出 =====

// DWS Agent Platform 等提供商在流内自行执行工具，结果已包含在流中
// lastAssistant = { finish: "stop", id: "msg_020" }
// lastAssistantMsg.parts = [
//   { type: "tool", metadata: { providerExecuted: true } }  // 提供商已执行的工具
// ]

// hasToolCalls 检查:
// part.type === "tool" && !part.metadata?.providerExecuted
// → type 是 "tool" 但 providerExecuted=true → 不计入 hasToolCalls
// hasToolCalls = false

// 逐条检查:
// 四个条件都满足 → break! 退出循环
// 因为这些工具调用已被提供商处理，不需要 re-loop 回传结果
```

---

## Step 5: 递增步数 + 后台生成标题

```typescript
// prompt.ts:1667-1674
step++
if (step === 1)
  yield* title({
    session,
    modelID: lastUser.model.modelID,
    providerID: lastUser.model.providerID,
    history: msgs,
  }).pipe(Effect.ignore, Effect.forkIn(scope))
```

**原理**：

- **`step++`**：每次循环迭代递增，用于限制最大步数（Step 10 中使用）
- **标题生成**：仅在第一次迭代（`step === 1`）触发，使用 `Effect.forkIn(scope)` **fork 到后台 fiber** 执行，不阻塞主循环
  - `Effect.ignore`：即使标题生成失败也不影响主流程
  - `Effect.forkIn(scope)`：在当前 scope 中 fork，scope 关闭时自动清理

**标题生成做了什么？** 调用 LLM 生成一个简短标题，截断到 100 字符，更新到会话记录中。

**示例**：

```typescript
// ===== 场景：用户第一次输入 =====

// 用户输入: "帮我重构 src/utils.ts 中的 parseConfig 函数"
// step 从 0 递增到 1

step++  // step = 1

// step === 1 → 触发标题生成（仅第一次迭代）
// title() 内部逻辑:
//   1. 检查 session.parentID → undefined（非子会话）→ 继续
//   2. 检查 Session.isDefaultTitle(session.title) → true（标题还是 "New Session"）→ 继续
//   3. 找到第一条真实用户消息
//   4. 调用 LLM（使用小模型，如 claude-haiku）生成标题
//      输入: "Generate a title for this conversation:\n帮我重构 src/utils.ts 中的 parseConfig 函数"
//      输出: "重构 parseConfig 函数"
//   5. 截断到 100 字符: "重构 parseConfig 函数"（未超限）
//   6. sessions.setTitle({ sessionID, title: "重构 parseConfig 函数" })

// Effect.forkIn(scope) → 在后台 fiber 中执行，不阻塞主循环
// Effect.ignore → 即使标题生成失败（如 LLM 超时），也不影响主流程

// ===== 第2次迭代 =====

step++  // step = 2

// step !== 1 → 不触发标题生成
// 标题生成只在第一次迭代时执行一次

// ===== Effect.forkIn(scope) 的作用 =====

// scope 是外层的 Scope，当 runLoop 结束时 scope 关闭
// 所有 forkIn(scope) 的后台 fiber 会自动被取消
// 这确保了: 如果主循环因错误退出，标题生成/摘要生成等后台任务也会被清理

// 示例:
// 主循环运行中 → scope 开启 → 后台标题生成 fiber 在运行
// 主循环异常退出 → scope 关闭 → 后台 fiber 收到取消信号 → 自动清理
```

---

## Step 6: 获取模型配置

```typescript
// prompt.ts:1676
const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
const task = tasks.pop()
```

**原理**：

- **`getModel`**：根据 providerID 和 modelID 获取完整的模型配置（API ID、能力、选项、token 限制等）
- **`tasks.pop()`**：取出最近一个待处理任务（subtask 或 compaction），`pop` 是后进先出

**为什么用 `pop()` 而不是 `shift()`？** 任务是从后向前收集的，`pop` 取出的是时间上最近的任务。

**示例**：

```typescript
// ===== 场景：获取模型配置 =====

// 用户在 lastUser 中指定了模型:
// lastUser.model = { providerID: "anthropic", modelID: "claude-sonnet-4" }

const model = yield* getModel("anthropic", "claude-sonnet-4", sessionID)
// model = {
//   id: "claude-sonnet-4-20250514",           // 实际 API 使用的模型 ID（含日期后缀）
//   providerID: "anthropic",                   // 提供商标识
//   api: { id: "claude-sonnet-4-20250514" },   // API 调用时的模型标识
//   capabilities: {
//     temperature: true,                       // 支持温度参数
//     topP: true,                              // 支持 top_p 参数
//     reasoning: true,                         // 支持推理/思考模式
//     caching: true,                           // 支持 prompt caching
//   },
//   options: {
//     maxOutputTokens: 16384,                  // 最大输出 token 数
//     contextWindow: 200000,                   // 上下文窗口大小
//     inputPrice: 3,                           // 输入价格（每百万 token）
//     outputPrice: 15,                         // 输出价格（每百万 token）
//   },
// }

// ===== tasks.pop() 的 LIFO 行为 =====

// 假设 tasks 是从后向前收集的: [compaction_A, subtask_B, subtask_C]
// 注意: 遍历是从后向前的，所以 tasks 数组中越靠后的元素在时间上越早

const task = tasks.pop()
// task = subtask_C (最后加入的 = 时间上最近的)

// 为什么要 LIFO？
// 因为从后向前遍历时，先遇到的（后加入 tasks 的）是时间上更新的任务
// 而 pop() 取出的是最后加入的元素，即时间上最早的任务
// 这确保了: 先处理较早产生的任务，后处理较晚产生的任务
// (实际上 tasks 通常只有 0-1 个元素，LIFO vs FIFO 影响不大)

// ===== 模型配置在后续步骤中的使用 =====

// model 在 Step 9 中用于检查上下文溢出:
//   compaction.isOverflow({ tokens: lastFinished.tokens, model })
//   → 比较 lastFinished.tokens.input 与 model.options.contextWindow

// model 在 Step 12 中用于创建 assistant 消息:
//   msg.modelID = model.id
//   msg.providerID = model.providerID

// model 在 Step 13h 中用于 LLM 调用:
//   handle.process({ ..., model })
//   → llm.stream() 使用 model.api.id 作为实际调用的模型标识
```

---

## Step 7: 处理 subtask 任务

```typescript
// prompt.ts:1679-1682
if (task?.type === "subtask") {
  yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
  continue
}
```

**原理**：如果从 `tasks` 中取出的任务是 `subtask` 类型，则调用 `handleSubtask` 处理后直接 `continue` 进入下一次循环迭代。

**`handleSubtask` 做了什么**（[`prompt.ts:696-780+`](../packages/opencode/src/session/prompt.ts:696)）：

1. 获取 task 工具实例：`const { task: taskTool } = yield* registry.named()`
2. 确定子任务模型：`task.model` 或回退到当前模型
3. 创建 assistant 消息（代表子任务的执行）
4. 创建 tool part（status: "running"），记录子任务输入
5. 触发 `tool.execute.before` 插件钩子
6. 验证子智能体存在：`agents.get(task.agent)`
7. **执行 task 工具**：`taskTool.execute(taskArgs, context)` — 这会创建子会话并运行子智能体
8. 处理执行结果，更新 tool part 状态为 completed 或 error

**示例**：

```typescript
// ===== 场景：主智能体(code)委派子任务给子智能体 =====

// 假设 tasks.pop() 返回:
const task: MessageV2.SubtaskPart = {
  type: "subtask",
  agent: "code",                    // 子智能体名称
  prompt: "修复 src/utils.ts 中的类型错误",  // 子任务提示词
  description: "修复类型错误",       // 子任务描述（显示在前端）
  model: { providerID: "anthropic", modelID: "claude-haiku-5" },  // 可选：指定子智能体使用的模型
  command: undefined,               // 可选：命令行指令
}

// handleSubtask 内部执行流程:

// 1. 获取 task 工具实例
const { task: taskTool } = yield* registry.named()
// taskTool 是内置的 TaskTool，用于创建和管理子会话

// 2. 确定子任务模型（优先使用 task 指定的，否则回退到当前模型）
const taskModel = task.model
  ? yield* getModel("anthropic", "claude-haiku-5", sessionID)  // 使用指定的小模型
  : model  // 回退到主循环的模型（如 claude-sonnet-4）

// 3. 创建 assistant 消息（代表子任务的执行载体）
const assistantMessage = yield* sessions.updateMessage({
  id: "msg_01HX002...",
  role: "assistant",
  agent: "code",              // 子智能体名称
  modelID: taskModel.id,      // 子任务使用的模型
  ...
})

// 4. 创建 tool part（记录子任务状态）
let part = yield* sessions.updatePart({
  type: "tool",
  tool: "task",               // TaskTool.id
  state: {
    status: "running",        // 标记为运行中
    input: {
      prompt: "修复 src/utils.ts 中的类型错误",
      description: "修复类型错误",
      subagent_type: "code",
    },
    time: { start: Date.now() },
  },
})

// 5. 验证子智能体存在
const taskAgent = yield* agents.get("code")
// 如果不存在 → 抛出错误: `Agent not found: "code". Available agents: code, plan, build`

// 6. 执行 task 工具（核心）
const result = yield* taskTool.execute(
  {
    prompt: "修复 src/utils.ts 中的类型错误",
    description: "修复类型错误",
    subagent_type: "code",
  },
  {
    agent: "code",
    sessionID,
    abort: taskAbort.signal,    // 可取消
    messages: msgs,             // 传入消息历史作为上下文
    // ...其他上下文
  }
)
// taskTool.execute 内部:
//   → 创建子会话（childSessionID）
//   → 在子会话中运行子智能体
//   → 子智能体执行自己的 runLoop（递归！）
//   → 返回 { output: "修复结果...", title: "修复类型错误", metadata: {...} }

// 7. 更新 tool part 状态为 completed
part = yield* sessions.updatePart({
  ...part,
  state: {
    status: "completed",
    output: "已修复 3 处类型错误：\n1. 第12行: string → number\n2. ...",
    title: "修复类型错误",
    time: { start: ..., end: Date.now() },
  },
})

// 8. 如果有 command，还会创建一条合成用户消息，提示 LLM 总结结果
// "Summarize the task tool output above and continue with your task."

// 9. handleSubtask 返回后，主循环 continue → 进入下一次迭代
// 下一次迭代中，LLM 会看到子任务的输出，可以基于结果继续工作

// ===== 错误场景 =====

// 如果子智能体执行失败:
//   taskTool.execute 抛出错误
//   → Effect.catchCause 捕获错误
//   → error = new Error("Tool execution failed: ...")
//   → part.state.status 更新为 "error"
//   → part.state.error = "Tool execution failed: ..."
//   → 主循环 continue，LLM 在下一轮看到错误信息后可以决定如何处理

// 如果子智能体被中断:
//   → Effect.onInterrupt 触发
//   → taskAbort.abort() 取消子任务
//   → part.state.status 更新为 "error", error = "Cancelled"
//   → assistantMessage.finish = "tool-calls"
```

---

## Step 8: 处理 compaction 压缩任务

```typescript
// prompt.ts:1684-1694
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

**原理**：如果取出的任务是 `compaction` 类型，则执行上下文压缩处理。

**`compaction.process` 做了什么**：

1. 使用 LLM 对旧消息生成摘要
2. 将摘要作为新的 user 消息（带 `compaction` 部分）插入消息历史
3. 旧的 assistant 消息标记为 `summary: true`
4. 返回 `"stop"` 或 `"continue"`

**`auto` vs `overflow`**：
- `auto: true` — 自动触发的常规压缩（token 接近阈值）
- `overflow: true` — 溢出压缩（token 已超过限制，必须立即压缩）

**示例**：

```typescript
// ===== 场景1：自动压缩（auto=true） =====

// tasks.pop() 返回:
const task: MessageV2.CompactionPart = {
  type: "compaction",
  auto: true,       // 自动触发（token 接近阈值）
  overflow: false,  // 非溢出
}

// 当前消息历史（tokens 逐渐累积）:
// msgs = [
//   User("修复bug"),                     // ~50 tokens
//   Assistant("让我看看文件...", 3000 tokens),
//   User("[read_file 结果]", 5000 tokens),
//   Assistant("我找到了问题...", 4000 tokens),
//   User("[write_file 结果]", 2000 tokens),
//   Assistant("修复完成", 2000 tokens),  // 总计 ~14000 tokens，接近阈值
//   User("再帮我加个测试"),              // 新用户消息
// ]

// compaction.process 内部:
//   1. 选择需要压缩的旧消息（通常是前面的几轮）
//   2. 调用 LLM 生成摘要:
//      输入: "Summarize the following conversation: User修复bug, Assistant看文件..."
//      输出: "用户要求修复bug，助手读取文件后发现类型错误，修改了parseConfig函数"
//   3. 创建压缩消息:
//      User_compaction = {
//        text: "以下是之前对话的摘要: 用户要求修复bug，助手读取文件后发现类型错误...",
//        compaction: { ... }
//      }
//   4. 旧 assistant 消息标记 summary: true
//   5. 重排消息

// 压缩后:
// msgs = [
//   User_compaction("摘要: 用户要求修复bug..."),  // 压缩摘要 ~200 tokens
//   Assistant_summary,                            // 标记 summary: true
//   User("再帮我加个测试"),                       // 保留最新用户消息
// ]
// → 总 tokens 从 ~14000 降到 ~200，释放大量上下文空间

// compaction.process 返回 "continue" → 主循环 continue → 下次迭代处理新用户消息

// ===== 场景2：溢出压缩（overflow=true） =====

// tasks.pop() 返回:
const task2: MessageV2.CompactionPart = {
  type: "compaction",
  auto: true,
  overflow: true,  // 溢出！token 已超过模型上下文窗口限制
}

// 溢出压缩时，compaction.process 的行为更激进:
//   - 可能压缩更多轮次
//   - 可能截断过长的工具输出
//   - 确保压缩后 token 数在安全范围内

// 如果压缩失败（即使压缩后仍溢出）:
//   → compaction.process 返回 "stop"
//   → 主循环 break，退出

// ===== 场景3：compaction.process 返回 "stop" =====

// 当压缩无法有效降低 token 数（如单条消息就超过上下文窗口）:
if (result === "stop") break
// → 主循环直接退出，无法继续处理

// ===== 为什么采用 "创建任务 → 下次迭代处理" 的模式？ =====

// 注意: compaction 任务是在上一次迭代的 Step 9 中通过 compaction.create() 创建的
// 而不是在同一迭代中直接调用 compaction.process()
// 原因:
//   1. 消息历史的读取（Step 2）和写入（compaction.process）需要在不同迭代中完成
//   2. 确保消息 ID 的递增顺序正确
//   3. 避免在同一次迭代中修改正在遍历的消息列表
//
// 流程:
//   迭代 N:   Step 9 检测溢出 → compaction.create() → continue
//   迭代 N+1: Step 2 读取消息（包含 compaction 部分）→ Step 3 收集 tasks
//             → Step 8 task.type === "compaction" → compaction.process()
```

---

## Step 9: 检查上下文溢出

```typescript
// prompt.ts:1696-1703
if (
  lastFinished &&
  lastFinished.summary !== true &&
  (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
) {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
  continue
}
```

**原理**：这是一个**主动溢出检测**，与 Step 8 的被动处理不同。

三个条件同时满足才触发：
1. `lastFinished` 存在 — 有已完成的助手消息
2. `lastFinished.summary !== true` — 该消息不是压缩摘要本身
3. `compaction.isOverflow(tokens, model)` — token 数超过模型上下文窗口限制

**`compaction.create`**：创建一个 compaction 任务（插入带 `compaction` 部分的 user 消息），然后 `continue` 让下一次迭代在 Step 8 中处理它。

**为什么不直接调用 `compaction.process`？** 采用"创建任务 → 下次迭代处理"的模式，确保消息历史的读取和写入在正确的迭代顺序中完成。

**示例**：

```typescript
// ===== 场景1：检测到上下文溢出 =====

// lastFinished = {
//   id: "msg_050",
//   role: "assistant",
//   finish: "stop",
//   summary: false,          // ← 不是压缩摘要本身
//   tokens: {
//     input: 180000,         // ← 已使用 180K tokens
//     output: 5000,
//     reasoning: 20000,
//   },
// }

// model = {
//   options: {
//     contextWindow: 200000, // ← 模型上下文窗口 200K
//   },
// }

// 三个条件检查:
// 1. lastFinished 存在 → true
// 2. lastFinished.summary !== true → true (不是摘要)
// 3. compaction.isOverflow({ tokens: lastFinished.tokens, model })
//    → 180000 / 200000 = 90% → 超过阈值（通常是 80-90%）→ true

// 触发压缩:
yield* compaction.create({
  sessionID,
  agent: lastUser.agent,     // 如 "code"
  model: lastUser.model,     // 如 { providerID: "anthropic", modelID: "claude-sonnet-4" }
  auto: true,                // 自动触发
})

// compaction.create 做了什么:
//   1. 创建一条 user 消息，包含 compaction 部分:
//      { type: "compaction", auto: true, overflow: false }
//   2. 插入到消息历史中
//   → 下一次迭代时，Step 3 会收集到这个 compaction 任务
//   → Step 8 会处理它

// continue → 进入下一次迭代

// ===== 场景2：不触发压缩 =====

// lastFinished = {
//   tokens: { input: 50000 },  // ← 只用了 50K tokens
//   summary: false,
// }

// model.options.contextWindow = 200000

// isOverflow → 50000 / 200000 = 25% → 未超过阈值 → false
// → 不触发压缩，继续后续步骤

// ===== 场景3：lastFinished 是压缩摘要 → 不触发 =====

// lastFinished = {
//   tokens: { input: 180000 },
//   summary: true,            // ← 这是压缩产生的摘要
// }

// 条件2: lastFinished.summary !== true → false
// → 不触发压缩（避免对压缩摘要再压缩，形成无限循环）

// ===== isOverflow 的计算逻辑 =====

// compaction.isOverflow 内部（简化）:
// function isOverflow({ tokens, model }) {
//   const ratio = tokens.input / model.options.contextWindow
//   return ratio >= THRESHOLD  // 如 0.85（85%）
// }
//
// 注意: 这里用的是 input tokens（包含所有历史消息 + system prompt）
// 而不是 output tokens（只包含 LLM 生成的部分）
// 因为上下文溢出的瓶颈在于输入端——历史消息太长导致无法发送给 LLM

// ===== 为什么 compaction.create 而不是 compaction.process？ =====

// 关键设计决策: 此步骤只"创建"压缩任务，不"执行"压缩
// 原因:
//   1. 当前迭代的 msgs 变量已经读取完成，直接修改会导致数据不一致
//   2. 压缩需要重新读取消息历史（可能包含刚创建的 compaction 部分）
//   3. 采用"标记 → 下次处理"模式确保状态转换的原子性
//
// 时间线:
//   迭代 K:   Step 9 → compaction.create() → continue
//             → 数据库中新增一条带 compaction 部分的 user 消息
//   迭代 K+1: Step 2 → 重新读取消息（包含新的 compaction 部分）
//             Step 3 → tasks = [compaction_part]
//             Step 8 → compaction.process() → 执行实际压缩
```

---

## Step 10: 获取智能体配置 + 步数限制

```typescript
// prompt.ts:1705-1714
const agent = yield* agents.get(lastUser.agent)
if (!agent) {
  const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
  const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
  const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
  yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
  throw error
}
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
```

**原理**：

1. **获取智能体**：根据用户消息中指定的 agent 名称获取配置（工具列表、权限、提示词、步数限制等）
2. **智能体不存在**：发布错误事件并抛出异常，附带可用智能体列表作为提示
3. **步数限制**：`agent.steps` 定义了该智能体的最大循环次数，默认 `Infinity`（无限制）
4. **`isLastStep`**：如果当前步数已达到限制，后续会在消息末尾追加 `MAX_STEPS` 提示词，强制 LLM 只返回文本不再调用工具

**`MAX_STEPS` 提示词内容**（[`max-steps.txt`](../packages/opencode/src/session/prompt/max-steps.txt)）：

```
CRITICAL - MAXIMUM STEPS REACHED
The maximum number of steps allowed for this task has been reached.
Tools are disabled until next user input. Respond with text only.
...
```

**示例**：

```typescript
// ===== 场景1：正常获取智能体配置 =====

// lastUser.agent = "code"
const agent = yield* agents.get("code")
// agent = {
//   name: "code",
//   steps: 50,                     // 最多循环 50 次
//   hidden: false,
//   prompt: "You are an expert coding assistant...",
//   tools: ["bash", "read_file", "write_file", "edit_file", ...],
//   permission: [
//     { rule: "allow", tool: "read_file" },
//     { rule: "allow", tool: "bash", params: { command: "ls *" } },
//     { rule: "deny", tool: "bash", params: { command: "rm -rf *" } },
//   ],
// }

const maxSteps = agent.steps ?? Infinity  // 50
const isLastStep = step >= maxSteps       // step=1 → false

// ===== 场景2：智能体不存在 =====

// lastUser.agent = "unknown_agent"（用户拼写错误）
const agent = yield* agents.get("unknown_agent")
// agent = undefined

// 进入错误处理:
const available = (yield* agents.list())
  .filter((a) => !a.hidden)
  .map((a) => a.name)
// available = ["code", "plan", "build"]

const hint = ` Available agents: code, plan, build`
const error = new NamedError.Unknown({
  message: `Agent not found: "unknown_agent". Available agents: code, plan, build`
})

// 发布错误事件 → 前端显示错误提示
yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })

// 抛出错误 → Effect 捕获 → 会话结束
throw error

// ===== 场景3：达到最大步数 =====

// step = 50, maxSteps = 50
const isLastStep = step >= maxSteps  // true

// isLastStep=true 的效果（在 Step 13h 中）:
// messages 末尾追加:
//   { role: "assistant", content: "CRITICAL - MAXIMUM STEPS REACHED\nThe maximum number of steps allowed for this task has been reached.\nTools are disabled until next user input. Respond with text only." }

// 这是一个"预填充"技巧:
//   → LLM 看到这条"助手消息"，认为自己已经开始写回答了
//   → 只能续写文本总结，不会调用工具
//   → 确保循环在有限步数内退出

// ===== 场景4：无步数限制的智能体 =====

// 某些智能体没有设置 steps
const agent = yield* agents.get("chat")
// agent = { name: "chat", steps: undefined, ... }

const maxSteps = agent.steps ?? Infinity  // Infinity
const isLastStep = step >= Infinity       // 永远为 false

// → 该智能体没有步数限制，可以无限循环直到 LLM 返回最终回答
// → 退出依赖于 Step 4 的条件判断

// ===== 步数限制的实际意义 =====

// 防止死循环场景:
//   LLM 反复调用工具，每次工具结果都触发新的工具调用
//   如: read_file → 发现问题 → edit_file → 验证失败 → read_file → ...
//   没有步数限制，可能无限循环消耗 API 费用
//   50 步限制确保: 即使 LLM 陷入循环，也会在 50 步后被强制终止
```

---

## Step 11: 插入提醒消息

```typescript
// prompt.ts:1715
msgs = yield* insertReminders({ messages: msgs, agent, session })
```

**原理**：`insertReminders`（[`prompt.ts:379-514`](../packages/opencode/src/session/prompt.ts:379)）根据当前智能体类型，在用户消息中注入合成文本部分：

| 场景 | 注入内容 |
|------|----------|
| agent === "plan" | `PROMPT_PLAN`：计划模式提示（只读，禁止编辑） |
| 上一个 agent 是 "plan"，当前是 "build" | `BUILD_SWITCH`：切换到构建模式的提示 |
| 实验性 plan mode | 详细的 5 阶段工作流提示（探索→设计→审查→最终计划→退出） |

**这些提醒是 `synthetic: true` 的文本部分**，不影响用户原始输入，但对 LLM 的行为有约束力。

**示例**：

```typescript
// ===== 场景1：plan 模式 — 注入只读提示 =====

// agent.name = "plan", 非 experimental 模式
// 用户输入: "帮我设计一个缓存系统"

// insertReminders 内部:
//   找到最后一条用户消息 userMessage
//   agent.name === "plan" → 推入 PROMPT_PLAN 文本部分

userMessage.parts.push({
  id: "part_01HX003...",
  type: "text",
  text: PROMPT_PLAN,
  // PROMPT_PLAN 内容类似:
  // "Plan mode ACTIVE - READ-ONLY phase. STRICTLY FORBIDDEN: ANY file edits, running non-readonly tools, or making any changes to the system."
  synthetic: true,  // ← 标记为合成部分，不影响用户原始输入
})

// 返回修改后的 messages → LLM 看到只读约束，不会调用 write_file 等编辑工具

// ===== 场景2：从 plan 切换到 build — 注入构建模式提示 =====

// agent.name = "build"
// 消息历史中存在 agent === "plan" 的 assistant 消息（wasPlan = true）
// 用户输入: "开始实施计划"

// insertReminders 内部:
//   wasPlan = true, agent.name === "build" → 推入 BUILD_SWITCH 文本部分

userMessage.parts.push({
  type: "text",
  text: BUILD_SWITCH,
  // BUILD_SWITCH 内容类似:
  // "The user has switched from plan to build mode. You can now make edits and run tools."
  synthetic: true,
})

// ===== 场景3：experimental plan mode — 注入详细5阶段工作流 =====

// Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE = true
// agent.name = "plan", 上一个 assistant 消息的 agent !== "plan"（首次进入 plan 模式）

// insertReminders 注入一个超长的 system-reminder:
const planReminder = `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits
(with the exception of the plan file mentioned below), run any non-readonly tools, or otherwise make any changes to the system.

## Plan File Info:
No plan file exists yet. You should create your plan at /home/user/project/.opencode/plan.md using the write tool.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request...
1. Focus on understanding the user's request and the code associated with their request
2. Launch up to 3 explore agents IN PARALLEL...

### Phase 2: Design
Goal: Design an implementation approach...

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.

### Phase 4: Final Plan
Goal: Write your final plan to the plan file...

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan...
</system-reminder>`

userMessage.parts.push({
  type: "text",
  text: planReminder,
  synthetic: true,
})

// → LLM 看到详细的5阶段工作流指导，按照探索→设计→审查→最终计划→退出的流程执行

// ===== 场景4：从 experimental plan 切换到 build — 注入计划文件提示 =====

// agent.name = "build" (不是 plan)
// assistantMessage?.info.agent === "plan" (上一步是 plan 智能体)
// 计划文件存在: /home/user/project/.opencode/plan.md

userMessage.parts.push({
  type: "text",
  text: `${BUILD_SWITCH}\n\nA plan file exists at /home/user/project/.opencode/plan.md. You should execute on the plan defined within it`,
  synthetic: true,
})

// → LLM 看到提示，知道有计划文件可以参考，按照计划执行

// ===== synthetic: true 的意义 =====

// 所有注入的文本部分都标记 synthetic: true
// 作用:
//   1. 在 Step 13e 中，synthetic 部分不会被 <system-reminder> 再次包装
//      (避免嵌套提醒: "<system-reminder>The user sent: <system-reminder>Plan mode...</system-reminder></system-reminder>")
//   2. 在消息展示时，前端可以区分用户真实输入和系统注入内容
//   3. 在日志/调试中，可以清楚地看到哪些是系统行为
```

---

## Step 12: 创建助手消息 + 处理器

```typescript
// prompt.ts:1717-1737
const msg: MessageV2.Assistant = {
  id: MessageID.ascending(),
  parentID: lastUser.id,
  role: "assistant",
  mode: agent.name,
  agent: agent.name,
  variant: lastUser.model.variant,
  path: { cwd: ctx.directory, root: ctx.worktree },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: model.id,
  providerID: model.providerID,
  time: { created: Date.now() },
  sessionID,
}
yield* sessions.updateMessage(msg)
const handle = yield* processor.create({
  assistantMessage: msg,
  sessionID,
  model,
})
```

**原理**：

1. **构造 assistant 消息**：创建一个空的助手消息对象，ID 递增，关联到 `lastUser`，初始 token/cost 为 0
2. **存入数据库**：`sessions.updateMessage(msg)` 持久化
3. **创建处理器**：`processor.create()` 返回一个 `Handle` 对象，包含：
   - `message` — 可变的助手消息引用（流式更新）
   - `updateToolCall` — 更新工具调用状态
   - `completeToolCall` — 完成工具调用
   - `process` — 核心处理函数（Step 13 使用）

**`processor.create` 内部初始化**（[`processor.ts:116-132`](../packages/opencode/src/session/processor.ts:116)）：

```typescript
const ctx: ProcessorContext = {
  assistantMessage: input.assistantMessage,
  sessionID: input.sessionID,
  model: input.model,
  toolcalls: {},          // 工具调用映射
  shouldBreak: false,     // 权限拒绝时是否中断
  snapshot: initialSnapshot, // 文件系统快照
  blocked: false,         // 是否被权限阻止
  needsCompaction: false, // 是否需要压缩
  currentText: undefined, // 当前文本部分
  reasoningMap: {},       // 推理部分映射
}
```

**示例**：

```typescript
// ===== 场景：创建助手消息和处理器 =====

// 假设:
// ctx = { directory: "/home/user/project", worktree: "/home/user/project" }
// lastUser = { id: "msg_01HABC...", model: { variant: "default" } }
// agent = { name: "code" }
// model = { id: "claude-sonnet-4-20250514", providerID: "anthropic" }

// Step 12a: 构造空的 assistant 消息
const msg: MessageV2.Assistant = {
  id: MessageID.ascending(),        // 生成递增ID: "msg_01HXYZ..."
  parentID: "msg_01HABC...",        // 关联到用户消息（形成消息树）
  role: "assistant",
  mode: "code",                     // 智能体名称
  agent: "code",                    // 智能体名称
  variant: "default",               // 模型变体
  path: {
    cwd: "/home/user/project",      // 当前工作目录
    root: "/home/user/project",     // git worktree 路径
  },
  cost: 0,                          // 费用（流式处理中累积）
  tokens: {
    input: 0,                       // 输入 token（流式处理中累积）
    output: 0,                      // 输出 token
    reasoning: 0,                   // 推理 token（如 Claude thinking）
    cache: { read: 0, write: 0 },   // 缓存 token
  },
  modelID: "claude-sonnet-4-20250514",
  providerID: "anthropic",
  time: { created: Date.now() },    // 创建时间（completed 在流结束时设置）
  sessionID: "sess_01JXABC123",
}

// Step 12b: 存入数据库
yield* sessions.updateMessage(msg)
// → 数据库中新增一条 assistant 消息记录
// → 前端可以立即看到一条"空的"助手消息（显示加载状态）

// Step 12c: 创建处理器
const handle = yield* processor.create({
  assistantMessage: msg,
  sessionID,
  model,
})

// handle 是一个 Handle 对象，包含:
// handle = {
//   message: msg,                    // 可变引用（流式更新中会修改此对象）
//   updateToolCall(partID, update),  // 更新工具调用状态
//   completeToolCall(partID, result),// 完成工具调用
//   process(input),                  // 核心处理函数（Step 13h 使用）
// }

// processor.create 内部初始化 ProcessorContext:
// const ctx: ProcessorContext = {
//   assistantMessage: msg,           // 同一个引用
//   sessionID: "sess_01JXABC123",
//   model: { id: "claude-sonnet-4-20250514", ... },
//   toolcalls: {},                   // 工具调用映射: callID → ToolPart
//   shouldBreak: false,              // 权限拒绝时设为 true
//   snapshot: initialSnapshot,       // 文件系统快照（用于检测文件变更）
//   blocked: false,                  // 是否被权限阻止
//   needsCompaction: false,          // 是否需要压缩
//   currentText: undefined,          // 当前正在生成的文本部分
//   reasoningMap: {},                // 推理部分映射
// }

// ===== msg 对象在流式处理中的变化 =====

// 创建时:
// msg.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
// msg.finish = undefined
// msg.time.completed = undefined

// LLM 流式返回后:
// msg.tokens = { input: 5200, output: 350, reasoning: 1200, cache: { read: 3000, write: 500 } }
// msg.finish = "stop"
// msg.cost = 0.032  // 根据 token 和价格计算
// msg.time.completed = Date.now()

// 为什么 msg 是可变引用？
//   因为流式处理中有大量增量更新（每个 text-delta, tool-call 等事件）
//   使用可变引用避免每次更新都创建新对象，减少 GC 压力
//   handle.message 和 ctx.assistantMessage 指向同一个对象
//   → 任何地方对 msg 的修改都会在其他引用中可见

// ===== parentID 与消息树结构 =====

// 消息通过 parentID 形成树形结构:
//
//   User("修复bug") ← msg_001
//       │
//       ├── Assistant("让我看看...") ← msg_002, parentID=msg_001
//       │       │
//       │       └── User("[tool_result]") ← msg_003, parentID=msg_002
//       │               │
//       │               └── Assistant("修复完成") ← msg_004, parentID=msg_003
//       │
//       └── [如果用户编辑重发]: User("换个方式修复") ← msg_005, parentID=msg_001
//
// 这种树结构支持:
//   - 消息分支（用户可以编辑并重新发送）
//   - 消息回溯（追溯到任意消息继续对话）
//   - filterCompacted 时正确重建消息链
```

---

## Step 13: 核心处理（工具解析 → LLM 调用 → 结果判断）

这是整个 `runLoop` 最复杂、最核心的步骤，被包裹在一个 `Effect.gen` 中，返回 `"break"` 或 `"continue"`。

```typescript
// prompt.ts:1739-1837
const outcome: "break" | "continue" = yield* Effect.gen(function* () {
  // ... 13a ~ 13i 子步骤 ...
}).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
```

### 13a: 检查是否绕过智能体工具检查

```typescript
// prompt.ts:1740-1741
const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
```

**原理**：如果最后一条用户消息包含 `agent` 类型的部分（如用户通过 `@code` 引用了子智能体），则允许使用不属于当前智能体的工具。这是因为 `agent` 部分会合成一段指令，让 LLM 调用 `task` 工具委派给子智能体，而 `task` 工具可能不在当前智能体的工具列表中。

**示例**：

```typescript
// ===== 场景1：用户通过 @ 引用子智能体 → bypassAgentCheck=true =====

// 用户输入: "帮我重构代码 @code"
// lastUserMsg.parts 包含:
//   { type: "text", text: "帮我重构代码" }
//   { type: "agent", name: "code" }  ← 用户通过 @code 引用了子智能体

const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
// bypassAgentCheck = true

// 为什么需要 bypass？
// 当用户 @code 时，系统会合成一条指令让 LLM 调用 task 工具委派给 code 子智能体
// 但 task 工具可能不在当前智能体（如 "plan"）的工具列表中
// bypassAgentCheck=true → resolveTools 不会过滤掉 task 工具
// → LLM 可以调用 task 工具创建子任务

// ===== 场景2：普通用户输入 → bypassAgentCheck=false =====

// 用户输入: "帮我修复 bug"
// lastUserMsg.parts 只包含:
//   { type: "text", text: "帮我修复 bug" }
//   没有 agent 类型的部分

const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
// bypassAgentCheck = false

// → resolveTools 严格按照当前智能体的工具列表过滤
// → 如果当前是 "plan" 智能体，不会暴露 "code" 智能体的专属工具
```

### 13b: 解析工具

```typescript
// prompt.ts:1743-1751
const tools = yield* resolveTools({
  agent,
  session,
  model,
  tools: lastUser.tools,
  processor: handle,
  bypassAgentCheck,
  messages: msgs,
})
```

**原理**：`resolveTools`（[`prompt.ts:516-693`](../packages/opencode/src/session/prompt.ts:516)）构建当前迭代可用的所有工具字典。流程：

1. **注册内置工具**：遍历 `registry.tools({modelID, providerID, agent})`，为每个工具：
   - 转换 JSON Schema 以适配模型提供商
   - 包装 `execute` 函数，注入执行上下文（sessionID, abortSignal, callID, 权限检查等）
   - 触发 `tool.execute.before` / `tool.execute.after` 插件钩子

2. **注册 MCP 工具**：遍历 `mcp.tools()`，为每个外部工具：
   - 转换 schema
   - 包装 `execute`，注入权限询问（MCP 工具默认需要用户确认）
   - 处理 MCP 返回结果（文本、图片、资源）
   - 对过长输出执行截断：`truncate.output()`

3. **构建工具执行上下文**：每个工具执行时都会收到 `Tool.Context`：
   ```typescript
   {
     sessionID,        // 会话ID
     abort,            // AbortSignal（用于取消）
     messageID,        // 当前助手消息ID
     callID,           // 工具调用ID
     agent,            // 智能体名称
     messages,         // 消息历史
     metadata,         // 更新工具调用元数据的回调
     ask,              // 权限请求回调
   }
   ```

**示例**：

```typescript
// ===== resolveTools 的完整执行流程 =====

// 输入参数:
// agent = { name: "code", tools: ["bash", "read_file", "write_file", "edit_file"] }
// session = { permission: [{ rule: "allow", tool: "read_file" }] }
// model = { id: "claude-sonnet-4-20250514", providerID: "anthropic" }
// bypassAgentCheck = false

// ===== 阶段1：注册内置工具 =====

// registry.tools({ modelID, providerID, agent }) 返回所有注册的工具
// 对每个工具:

// 1a. 转换 JSON Schema（适配不同模型提供商）
// Anthropic 要求 schema 中不能有 "default" 字段
// OpenAI 要求 additionalProperties: false
// 转换函数: convertSchema(tool.schema, providerID)
//
// 原始 schema:
// { type: "object", properties: { path: { type: "string", default: "." } }, additionalProperties: true }
//
// 转换后（Anthropic）:
// { type: "object", properties: { path: { type: "string" } } }  ← 移除 default

// 1b. 包装 execute 函数（注入执行上下文和权限检查）
const wrappedExecute = async (args, context) => {
  // 执行前: 触发 tool.execute.before 插件钩子
  await plugin.trigger("tool.execute.before", { tool: toolName, sessionID, callID }, { args })

  // 权限检查
  const decision = await permission.ask({
    tool: toolName,
    args,
    sessionID,
    ruleset: Permission.merge(agent.permission, session.permission),
  })
  // decision: "allow" | "deny" | "ask"
  // 如果 "deny" → 抛出 PermissionDeniedError
  // 如果 "ask"  → 弹出 UI 让用户确认

  // 执行工具
  const result = await tool.execute(args, {
    sessionID,
    abort: context.abort,
    messageID: context.messageID,
    callID: context.callID,
    agent: context.agent,
    messages: context.messages,
    metadata: context.metadata,
    ask: context.ask,
  })

  // 执行后: 触发 tool.execute.after 插件钩子
  await plugin.trigger("tool.execute.after", { tool: toolName, sessionID, callID }, result)

  return result
}

// ===== 阶段2：注册 MCP 工具 =====

// mcp.tools() 返回外部 MCP 服务器提供的工具
// 如: mcp_github_search, mcp_slack_send, mcp_database_query 等

// MCP 工具的特殊处理:
// 1. 默认需要用户确认（MCP 工具可能有副作用）
//    → ask() 回调被配置为总是弹出确认对话框
// 2. 处理 MCP 返回结果（多种格式）
//    result.map(item => {
//      if (item.type === "text") return item.text
//      if (item.type === "image") return { type: "image", url: item.data }
//      if (item.type === "resource") return { type: "resource", uri: item.uri }
//    })
// 3. 对过长输出执行截断
//    if (output.length > MAX_OUTPUT_LENGTH) {
//      output = truncate.output(output, { maxLength: 50000 })
//    }

// ===== 最终返回的工具字典 =====

const tools = {
  // 内置工具
  "bash": AITool {
    description: "Execute a bash command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    execute: [wrapped function],
  },
  "read_file": AITool {
    description: "Read file contents",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: [wrapped function],
  },
  "write_file": AITool {
    description: "Write content to a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    execute: [wrapped function],
  },
  "edit_file": AITool {
    description: "Edit specific parts of a file",
    parameters: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } } },
    execute: [wrapped function],
  },

  // MCP 工具
  "mcp_github_search": AITool {
    description: "Search GitHub repositories and code",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: [wrapped function with confirmation dialog],
  },

  // bypassAgentCheck 影响的工具
  // 当 bypassAgentCheck=false 时:
  //   "task" 工具不在 "code" 智能体的工具列表中 → 不包含
  // 当 bypassAgentCheck=true 时（用户 @code）:
  //   "task" 工具被包含 → LLM 可以调用它委派子任务
}

// ===== 工具执行上下文（每个工具执行时收到的参数） =====

// Tool.Context = {
//   sessionID: "sess_01JXABC123",     // 当前会话ID
//   abort: AbortSignal,               // 取消信号（用户点击停止时触发）
//   messageID: "msg_01HXYZ...",       // 当前助手消息ID
//   callID: "call_01HDEF...",         // 工具调用ID（对应 AI SDK 的 toolCallID）
//   agent: "code",                    // 当前智能体名称
//   messages: [...],                  // 消息历史
//   metadata: (val) => Effect,        // 更新工具调用元数据的回调
//   ask: (req) => Effect,             // 权限请求回调（弹出确认对话框）
// }
```

### 13c: 结构化输出工具

```typescript
// prompt.ts:1753-1760
if (lastUser.format?.type === "json_schema") {
  tools["StructuredOutput"] = createStructuredOutputTool({
    schema: lastUser.format.schema,
    onSuccess(output) {
      structured = output
    },
  })
}
```

**原理**：如果用户请求 JSON Schema 格式的输出，则注入一个特殊的 `StructuredOutput` 工具。LLM 被强制调用此工具（`toolChoice: "required"`），工具的参数就是目标 schema。`onSuccess` 回调将结果保存到外层 `structured` 变量。

**示例**：

```typescript
// ===== 场景：用户请求 JSON Schema 格式的输出 =====

// 用户消息中指定了 format:
// lastUser.format = {
//   type: "json_schema",
//   schema: {
//     type: "object",
//     properties: {
//       files: { type: "array", items: { type: "string" }, description: "需要修改的文件列表" },
//       changes: { type: "array", items: { type: "string" }, description: "修改说明列表" },
//     },
//     required: ["files", "changes"],
//   },
// }

// 13c: 注入 StructuredOutput 工具
tools["StructuredOutput"] = createStructuredOutputTool({
  schema: lastUser.format.schema,
  onSuccess(output) {
    structured = output  // 将结构化输出保存到外层变量
  },
})

// StructuredOutput 工具定义（简化）:
// {
//   description: "Output structured data matching the specified schema",
//   parameters: {
//     type: "object",
//     properties: {
//       files: { type: "array", items: { type: "string" } },
//       changes: { type: "array", items: { type: "string" } },
//     },
//     required: ["files", "changes"],
//   },
//   execute: (args) => {
//     onSuccess(args)  // args 就是 LLM 填充的 JSON
//     return "Structured output generated successfully"
//   },
// }

// 13g: 注入结构化输出的系统提示
system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
// STRUCTURED_OUTPUT_SYSTEM_PROMPT 类似:
// "You must use the StructuredOutput tool to provide your response.
//  Do not include any other text in your response. Call the StructuredOutput tool with the appropriate arguments."

// 13h: 设置 toolChoice 为 "required"
const result = yield* handle.process({
  ...
  toolChoice: "required",  // ← 强制 LLM 必须调用工具（即 StructuredOutput）
})

// LLM 执行流程:
//   → LLM 看到系统提示，知道必须调用 StructuredOutput
//   → LLM 调用 StructuredOutput({ files: ["src/utils.ts", "src/types.ts"], changes: ["修复类型注解", "添加泛型参数"] })
//   → onSuccess 被触发: structured = { files: [...], changes: [...] }
//   → 工具返回: "Structured output generated successfully"

// 13i: 检测到 structured !== undefined
//   → handle.message.structured = { files: [...], changes: [...] }
//   → handle.message.finish = "stop"
//   → return "break"  ← 退出循环

// ===== 如果 LLM 没有调用 StructuredOutput 工具（失败场景）=====

// 某些模型可能忽略 toolChoice: "required" 的约束
// LLM 直接返回文本: "需要修改 src/utils.ts 和 src/types.ts"
// → structured 仍为 undefined
// → finished = true, format.type === "json_schema"
// → 标记错误: handle.message.error = StructuredOutputError({ message: "Model did not produce structured output" })
// → return "break"  ← 退出循环，返回错误

// ===== 对比普通文本模式 =====

// lastUser.format = undefined 或 { type: "text" }
// → 不注入 StructuredOutput 工具
// → toolChoice = undefined（LLM 自由选择是否调用工具）
// → structured 始终为 undefined
// → 13i 中的结构化输出检查跳过
```

### 13d: 后台生成摘要

```typescript
// prompt.ts:1762-1763
if (step === 1)
  yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))
```

**原理**：仅在第一步时，后台 fork 执行摘要生成。与标题生成类似，不阻塞主流程。

**示例**：

```typescript
// ===== 后台摘要生成 =====

// step === 1 → 触发摘要生成（仅第一次迭代）

// summary.summarize 内部:
//   1. 获取用户消息的所有部分（文本、工具调用等）
//   2. 调用 LLM（小模型）生成简短摘要
//   3. 将摘要存储到数据库，关联到 messageID
//
// 示例:
//   用户消息: "帮我修复 src/utils.ts 中的类型错误，重点是 parseConfig 函数的返回类型"
//   LLM 生成摘要: "修复 parseConfig 返回类型错误"
//   → 存储为消息的 summary 字段

// Effect.ignore: 即使摘要生成失败也不影响主流程
//   场景: LLM 超时、模型不可用、网络错误 → 静默忽略
//   摘要是可选的增强功能，不是核心流程

// Effect.forkIn(scope): 在 scope 中 fork 后台 fiber
//   → 不阻塞主循环，主循环立即继续 Step 13e
//   → scope 关闭时自动取消后台 fiber

// 与标题生成的对比:
//   title(): 为会话生成标题，更新 session.title
//   summary.summarize(): 为消息生成摘要，存储在消息记录中
//   两者都在 step===1 时后台执行，互不干扰
```

### 13e: 中间用户消息提醒

```typescript
// prompt.ts:1765-1781
if (step > 1 && lastFinished) {
  for (const m of msgs) {
    if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
    for (const p of m.parts) {
      if (p.type !== "text" || p.ignored || p.synthetic) continue
      if (!p.text.trim()) continue
      p.text = [
        "<system-reminder>",
        "The user sent the following message:",
        p.text,
        "",
        "Please address this message and continue with your tasks.",
        "</system-reminder>",
      ].join("\n")
    }
  }
}
```

**原理**：在多步循环中（`step > 1`），如果用户在 LLM 执行工具期间发送了新消息，这些消息可能被 LLM 忽略。此步骤将这些用户消息包装在 `<system-reminder>` 标签中，提醒 LLM 注意处理。

**过滤条件**：
- `m.info.id <= lastFinished.id` — 跳过已被处理的消息
- `p.ignored` — 跳过被忽略的部分
- `p.synthetic` — 跳过合成部分
- `!p.text.trim()` — 跳过空文本

**示例**：

```typescript
// ===== 场景1：LLM 执行工具期间用户发送了新消息 =====

// 消息历史:
// msgs = [
//   User("修复bug"),                                     // id: msg_001
//   Assistant("让我看看...", finish="tool-calls"),       // id: msg_002, lastFinished
//   User("[read_file 结果]"),                            // id: msg_003, synthetic
//   Assistant("发现问题...", finish="tool-calls"),       // id: msg_004
//   User("[write_file 结果]"),                           // id: msg_005, synthetic
//   User("等一下，先看看 test.ts"),                       // id: msg_006 ← 用户新消息！
// ]

// step = 2, lastFinished = msg_002 (finish="tool-calls"... 注意: 实际上 tool-calls 不算 finished)
// 修正: lastFinished 应该有 finish 且不是 "tool-calls"
// 假设 lastFinished = Assistant(finish="stop", id: msg_002)

// 遍历 msgs:
for (const m of msgs) {
  if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
  // m.info.id <= msg_002 → 跳过 msg_001（用户初始消息，已被处理）
  // m.info.id > msg_002 → 处理 msg_003, msg_005, msg_006

  for (const p of m.parts) {
    if (p.type !== "text" || p.ignored || p.synthetic) continue
    // msg_003: synthetic=true → 跳过（工具结果）
    // msg_005: synthetic=true → 跳过（工具结果）
    // msg_006: type="text", ignored=false, synthetic=false → 需要包装！

    if (!p.text.trim()) continue
    // "等一下，先看看 test.ts".trim() → 非空 → 继续

    // 包装消息
    p.text = [
      "<system-reminder>",
      "The user sent the following message:",
      "等一下，先看看 test.ts",
      "",
      "Please address this message and continue with your tasks.",
      "</system-reminder>",
    ].join("\n")
  }
}

// 包装后的 msg_006.parts[0].text:
// "<system-reminder>
//  The user sent the following message:
//  等一下，先看看 test.ts
//
//  Please address this message and continue with your tasks.
//  </system-reminder>"

// → LLM 看到这条提醒，会先处理用户的新消息（查看 test.ts），然后继续原有任务

// ===== 场景2：没有中间用户消息 =====

// msgs = [
//   User("修复bug"),                          // id: msg_001
//   Assistant("让我看看...", finish="stop"),  // id: msg_002, lastFinished
//   User("继续"),                             // id: msg_003
// ]

// step = 2, lastFinished.id = msg_002
// 遍历 msgs:
//   msg_001: id <= msg_002 → 跳过
//   msg_003: id > msg_002, role="user" → 检查 parts
//     p.type = "text", !p.synthetic, !p.ignored, text.trim() 非空
//     → 包装! 但这条 "继续" 是最后一条用户消息（即 lastUser），LLM 本来就会看到它
//     → 虽然会被包装，但由于 lastUser.id < lastAssistant.id 在 Step 4 不满足
//     → 所以不会导致重复处理的问题

// ===== 过滤条件的意义 =====

// p.ignored: 某些用户消息部分被标记为忽略（如已处理的确认对话框）
//   → 跳过，避免重复提醒

// p.synthetic: 系统注入的合成部分（如工具结果、compaction 摘要）
//   → 跳过，这些不是用户主动发送的消息
//   → 如: User("[read_file 结果]") 的 parts 是 synthetic=true

// !p.text.trim(): 空文本部分
//   → 跳过，没有实际内容需要提醒

// ===== 为什么只在 step > 1 时执行？ =====

// step === 1: 这是第一次迭代，消息中只有用户的初始消息
//   没有已完成的 assistant 消息（lastFinished 可能为 undefined）
//   不存在"中间消息"需要提醒
//   条件: step > 1 && lastFinished → 两个都不满足 → 跳过

// step > 1: 多步循环中，LLM 可能在执行工具时用户又发了消息
//   这些消息可能被 LLM 忽略（因为 LLM 正在处理工具结果）
//   需要包装成 <system-reminder> 引起 LLM 注意
```

### 13f: 插件消息变换

```typescript
// prompt.ts:1783
yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
```

**原理**：触发实验性插件钩子，允许插件在消息发送给 LLM 之前修改消息内容。这是扩展点。

**示例**：

```typescript
// ===== 插件消息变换 =====

// plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
//
// 这是一个实验性扩展点，允许插件在消息发送给 LLM 之前修改消息内容
//
// 可能的用例:
//   1. 数据脱敏: 插件扫描消息中的敏感信息（如 API key、密码），替换为占位符
//   2. 消息增强: 插件在消息中注入额外的上下文信息
//   3. 内容过滤: 插件过滤掉不符合规范的内容
//   4. 自定义提示词: 插件根据业务需求修改 system prompt 或用户消息

// 示例插件实现（伪代码）:
// plugin.register("experimental.chat.messages.transform", (event, data) => {
//   for (const msg of data.messages) {
//     for (const part of msg.parts) {
//       if (part.type === "text") {
//         // 脱敏: 将 API key 替换为占位符
//         part.text = part.text.replace(/sk-[a-zA-Z0-9]{32,}/g, "[API_KEY_REDACTED]")
//       }
//     }
//   }
// })

// 注意:
//   - 这是一个实验性 API，可能在未来版本中变更或移除
//   - 修改消息会影响 LLM 的输入，但不影响数据库中存储的原始消息
//   - 因为 msgs 是从数据库读取的副本，修改不会回写到数据库
```

### 13g: 并行准备系统提示词和模型消息

```typescript
// prompt.ts:1785-1793
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),              // 获取技能描述（如可用技能列表）
  sys.environment(model),         // 获取环境信息（操作系统、shell等）
  instruction.system().pipe(Effect.orDie), // 获取自定义指令（.opencode/instructions.md）
  MessageV2.toModelMessagesEffect(msgs, model), // 将内部消息转换为 AI SDK 格式
])
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
const format = lastUser.format ?? { type: "text" as const }
if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
```

**原理**：这是 `runLoop` 中唯一的**并行**操作。四个独立任务通过 `Effect.all` 同时执行：

| 任务 | 说明 |
|------|------|
| `sys.skills(agent)` | 获取智能体可用的技能提示 |
| `sys.environment(model)` | 获取运行环境描述（OS、shell、工作目录等） |
| `instruction.system()` | 获取用户自定义的系统指令文件内容 |
| `MessageV2.toModelMessagesEffect(msgs, model)` | 将内部 `MessageV2.WithParts[]` 转换为 Vercel AI SDK 的 `ModelMessage[]` 格式 |

**最终 system prompt 组装顺序**：`env → instructions → skills → [STRUCTURED_OUTPUT_SYSTEM_PROMPT]`

**示例**：

```typescript
// ===== 场景：并行准备系统提示词和模型消息 =====

// 输入:
// agent = { name: "code" }
// model = { id: "claude-sonnet-4-20250514", providerID: "anthropic" }
// msgs = [User("修复bug"), Assistant("让我看看..."), User("[read_file 结果]")]

// Effect.all 并行执行四个独立任务:
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  // 任务1: 获取技能描述
  sys.skills(agent),
  // 返回: "Available skills: dispatching-parallel-agents, systematic-debugging, test-driven-development, ...
  //        Use skills when user tasks match skill descriptions.
  //        Activate by calling activate_skill with the skill name."

  // 任务2: 获取环境信息
  sys.environment(model),
  // 返回: "You are running on macOS 15.7.4 with /bin/zsh shell.
  //        The absolute path of the user's workspace is: /home/user/project
  //        The current system time is Friday, May 15, 2026."

  // 任务3: 获取自定义指令
  instruction.system().pipe(Effect.orDie),
  // 读取 .opencode/instructions.md 文件内容
  // 返回: "Always use TypeScript strict mode. Prefer functional components in React.
  //        All API endpoints must have error handling. Use Zod for runtime validation."

  // 任务4: 将内部消息转换为 AI SDK 格式
  MessageV2.toModelMessagesEffect(msgs, model),
  // 内部 MessageV2 格式:
  //   { info: { role: "user" }, parts: [{ type: "text", text: "修复bug" }] }
  // 转换为 AI SDK 格式:
  //   { role: "user", content: "修复bug" }
  //
  // 特殊处理:
  //   - tool parts → 转换为 tool_invocation 格式
  //   - image parts → 转换为 image 格式
  //   - reasoning parts → 根据模型能力决定是否包含
  //   - 文件附件 → 转换为合适的 content 格式
])

// 组装 system prompt（顺序很重要！）:
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
// system = [
//   "You are running on macOS 15.7.4 with /bin/zsh shell...",      // env（环境信息，最前面）
//   "Always use TypeScript strict mode. Prefer functional...",      // instructions（自定义指令）
//   "Available skills: dispatching-parallel-agents, ...",           // skills（技能列表）
// ]

// 如果用户请求 JSON Schema 输出，追加结构化输出提示:
const format = lastUser.format ?? { type: "text" as const }
if (format.type === "json_schema") {
  system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
  // "You must use the StructuredOutput tool to provide your response..."
}

// ===== 为什么用 Effect.all 并行？ =====

// 四个任务完全独立:
//   sys.skills()      → 读取技能配置文件
//   sys.environment() → 获取系统环境变量
//   instruction.system() → 读取 .opencode/instructions.md
//   MessageV2.toModelMessagesEffect() → 转换消息格式
//
// 并行执行可以减少等待时间（特别是如果有 IO 操作）
// Effect.all 的 concurrency 默认为 "unbounded"（全部并行）
//
// 如果顺序执行: 4 * 50ms = 200ms
// 并行执行: max(50ms) = 50ms
// 节省 ~150ms

// ===== system prompt 顺序的意义 =====

// env 在最前面 → LLM 首先知道运行环境（OS、shell、目录）
// instructions 在中间 → 用户的编码规范覆盖通用行为
// skills 在最后 → 可选的增强能力，只在需要时使用
// STRUCTURED_OUTPUT → 仅在 json_schema 模式下追加

// 这个顺序确保了: 环境信息 > 用户自定义指令 > 技能提示 > 格式要求
// 越靠后的内容优先级越高（LLM 对最近的内容更敏感）
```

### 13h: 调用 LLM（核心中的核心）

```typescript
// prompt.ts:1794-1805
const result = yield* handle.process({
  user: lastUser,
  agent,
  permission: session.permission,
  sessionID,
  parentSessionID: session.parentID,
  system,
  messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
  tools,
  model,
  toolChoice: format.type === "json_schema" ? "required" : undefined,
})
```

**原理**：这是真正调用 LLM 的核心。`handle.process` 内部流程：

**1. 启动 LLM 流**（[`processor.ts:719`](../packages/opencode/src/session/processor.ts:719)）：

```typescript
const stream = llm.stream(streamInput)
```

**2. `llm.stream` 实现**（[`llm.ts:419-433`](../packages/opencode/src/session/llm.ts:419)）：

```typescript
const stream = (input) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const ctrl = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (ctrl) => Effect.sync(() => ctrl.abort()),
        )
        const result = yield* run({ ...input, abort: ctrl.signal })
        return Stream.fromAsyncIterable(result.fullStream, ...)
      }),
    ),
  )
```

**3. `run` 函数**（[`llm.ts:76-417`](../packages/opencode/src/session/llm.ts:76)）— LLM 调用的最终实现：

```
并行获取配置: provider.getLanguage + config.get + provider.getProvider + auth.get
               (Effect.all, concurrency: "unbounded")
    ↓
构建 system prompt（agent prompt + custom prompt + user system）
    ↓
插件钩子: chat.system.transform / chat.params / chat.headers
    ↓
工具解析和过滤（权限检查、LiteLLM 兼容性处理）
    ↓
最终调用: streamText({
  model: wrapLanguageModel({ model: language, middleware }),
  messages,
  system,
  tools,
  temperature, maxOutputTokens, ...
  abortSignal,
})
```

**4. 流事件处理**（[`processor.ts:224-621`](../packages/opencode/src/session/processor.ts:224)）：

```typescript
yield* stream.pipe(
  Stream.tap((event) => handleEvent(event)),
  Stream.takeUntil(() => ctx.needsCompaction),
  Stream.runDrain,
)
```

`handleEvent` 处理的事件类型：

| 事件 | 处理 |
|------|------|
| `text-start` | 创建文本部分，sync 通知前端 |
| `text-delta` | 追加文本，增量更新数据库，sync 通知前端 |
| `text-end` | 触发 `experimental.text.complete` 插件钩子，完成文本部分 |
| `reasoning-start/delta/end` | 推理部分（如 Claude 的 thinking），类似文本流处理 |
| `tool-input-start` | 创建 tool part（status: "pending"） |
| `tool-input-delta` | 流式接收工具参数 |
| `tool-input-end` | 参数接收完成 |
| `tool-call` | 更新 tool part（status: "running"），执行 doom loop 检测 |
| `tool-result` | 更新 tool part（status: "completed"），处理附件 |
| `tool-error` | 更新 tool part（status: "error"），检查权限拒绝 |
| `start-step` | 记录文件系统快照，sync 通知前端 |
| `finish-step` | 计算 token/cost，生成文件补丁，检查溢出 |
| `error` | 抛出错误 |

**5. 流处理完成后返回结果**（[`processor.ts:771-773`](../packages/opencode/src/session/processor.ts:771)）：

```typescript
if (ctx.needsCompaction) return "compact"
if (ctx.blocked || ctx.assistantMessage.error) return "stop"
return "continue"
```

**`isLastStep` 的作用**：如果已达到最大步数，在消息末尾注入一个 assistant 消息：

```
{ role: "assistant", content: "CRITICAL - MAXIMUM STEPS REACHED..." }
```

这迫使 LLM 看到这个"预填充"的助手消息，只能续写文本总结，不再调用工具。

**示例**：

```typescript
// ===== 场景1：LLM 正常调用工具的完整流式处理 =====

// 输入:
// system: [
//   "You are running on macOS...",
//   "Always use TypeScript strict mode...",
//   "Available skills: ...",
// ]
// messages: [
//   { role: "user", content: "帮我重构 src/utils.ts 中的 parseConfig 函数" },
//   // ... 之前的工具调用结果
// ]
// tools: { bash, read_file, write_file, edit_file }
// model: { id: "claude-sonnet-4-20250514" }

// handle.process 内部执行流程:

// 1. 启动 LLM 流
const stream = llm.stream({
  agent,
  user: lastUser,
  system,
  messages: [...modelMsgs],
  tools,
  model,
  sessionID,
})

// 2. llm.stream 内部（简化）:
//    → 获取 provider 配置和认证信息
//    → 构建 system prompt（agent.prompt + custom prompt + system）
//    → 触发 chat.system.transform / chat.params / chat.headers 插件钩子
//    → 过滤工具（权限检查）
//    → 最终调用 Vercel AI SDK 的 streamText():
const result = streamText({
  model: wrapLanguageModel({ model: language, middleware }),
  messages: [{ role: "user", content: "帮我重构..." }],
  system: "You are a coding assistant...",
  tools: { bash: {...}, read_file: {...}, ... },
  temperature: 0.5,
  maxOutputTokens: 16384,
  abortSignal: ctrl.signal,
})

// 3. 流事件处理循环:
yield* stream.pipe(
  Stream.tap((event) => handleEvent(event)),
  Stream.takeUntil(() => ctx.needsCompaction),
  Stream.runDrain,
)

// 事件序列示例:
//
// 事件1: text-start
//   → ctx.currentText = { id: "part_001", type: "text", text: "" }
//   → 前端收到 sync 事件，开始显示文本区域
//
// 事件2-5: text-delta "我", "来", "帮", "你"
//   → ctx.currentText.text = "我来帮你"
//   → 增量更新数据库
//   → 前端收到 sync 事件，实时显示文字
//
// 事件6: text-delta "重构代码。"
//   → ctx.currentText.text = "我来帮你重构代码。"
//
// 事件7: text-end
//   → 触发 experimental.text.complete 插件钩子
//   → 完成文本部分，存入数据库
//   → 前端收到 sync 事件，文本区域显示完成
//
// 事件8: tool-input-start (tool: "read_file", callID: "call_001")
//   → 创建 ToolPart: { type: "tool", callID: "call_001", tool: "read_file", state: { status: "pending" } }
//   → 前端显示工具调用卡片（loading 状态）
//
// 事件9-10: tool-input-delta '{"', 'path'
//   → 流式接收工具参数 JSON
//
// 事件11: tool-input-end
//   → 参数接收完成: { path: "src/utils.ts" }
//
// 事件12: tool-call (callID: "call_001", tool: "read_file", args: { path: "src/utils.ts" })
//   → 更新 ToolPart.state.status = "running"
//   → 触发 doom loop 检测（检查工具调用频率）
//   → 执行工具:
//     const result = await tools["read_file"].execute(
//       { path: "src/utils.ts" },
//       { sessionID, abort: signal, messageID, callID: "call_001", ... }
//     )
//   → 权限检查: read_file 在 allow 列表中 → 自动通过
//   → 执行结果: "export function parseConfig(config: string): any { ... }"
//
// 事件13: tool-result (callID: "call_001", output: "export function parseConfig...")
//   → 更新 ToolPart.state.status = "completed"
//   → 处理附件（如文件 diff）
//   → 前端显示工具调用结果
//
// 事件14: start-step
//   → 记录文件系统快照
//   → 前端收到 step 开始通知
//
// 事件15: finish-step
//   → 计算 token: { input: 5200, output: 350, reasoning: 0 }
//   → 计算费用: cost = (5200 * 3 + 350 * 15) / 1_000_000 = $0.021
//   → 生成文件补丁（比较快照差异）
//   → 检查是否溢出: 5200 / 200000 = 2.6% → 未溢出
//   → 更新 handle.message.tokens, handle.message.cost
//
// 事件16: finish
//   → handle.message.finish = "tool-calls"（因为调用了工具）

// 4. 返回结果:
if (ctx.needsCompaction) return "compact"
if (ctx.blocked || ctx.assistantMessage.error) return "stop"
return "continue"  // ← 因为调用了工具，需要下一轮处理

// ===== 场景2：LLM 返回文本回答（不调用工具）=====

// 事件序列:
//   text-start → text-delta("修复完成！") → text-end → start-step → finish-step → finish
//   → handle.message.finish = "stop"
//   → return "continue"
//   → Step 4 在下一次迭代中检测到 finish="stop" 且无工具调用 → break

// ===== 场景3：权限拒绝 =====

// LLM 调用 bash({ command: "rm -rf /" })
// 权限检查: deny 规则匹配 → 拒绝执行
// → ctx.blocked = true
// → tool-error 事件
// → return "stop"
// → Step 14 break

// ===== 场景4：isLastStep 时的行为 =====

// step = 50, maxSteps = 50, isLastStep = true
// messages 末尾追加:
//   { role: "assistant", content: "CRITICAL - MAXIMUM STEPS REACHED..." }

// 这是一个"预填充"技巧:
//   → AI SDK 看到这条 assistant 消息，将其作为 LLM 的前缀
//   → LLM 只能续写这段文本，不能调用工具
//   → 确保循环在有限步数内退出
//
// 示例: LLM 看到的消息末尾:
//   [
//     ...之前的消息,
//     { role: "assistant", content: "CRITICAL - MAXIMUM STEPS REACHED\nThe maximum number of steps..." }
//   ]
// LLM 续写: "\nI've completed the following tasks:\n1. Fixed the type error in parseConfig\n2. ..."
// → finish = "stop" → 下一次迭代 Step 4 break

// ===== Effect.ensuring 清理 =====

// 无论 handle.process 成功还是失败:
//   Effect.ensuring(instruction.clear(handle.message.id))
//   → 清理与该消息关联的临时指令
//   临时指令是 .opencode/instructions.md 中可能为特定消息动态添加的指令
//   清理避免临时指令泄漏到后续消息处理中
```

### 13i: 结果后处理

```typescript
// prompt.ts:1807-1836
// 结构化输出处理
if (structured !== undefined) {
  handle.message.structured = structured
  handle.message.finish = handle.message.finish ?? "stop"
  yield* sessions.updateMessage(handle.message)
  return "break" as const
}

// 结构化输出失败处理
const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
if (finished && !handle.message.error) {
  if (format.type === "json_schema") {
    handle.message.error = new MessageV2.StructuredOutputError({
      message: "Model did not produce structured output",
      retries: 0,
    }).toObject()
    yield* sessions.updateMessage(handle.message)
    return "break" as const
  }
}

// 正常结果判断
if (result === "stop") return "break" as const
if (result === "compact") {
  yield* compaction.create({
    sessionID,
    agent: lastUser.agent,
    model: lastUser.model,
    auto: true,
    overflow: !handle.message.finish,
  })
}
return "continue" as const
```

**原理**：三层判断：

1. **结构化输出成功**：`structured` 被赋值 → 设置到消息 → break
2. **结构化输出失败**：LLM 完成了但没有调用 `StructuredOutput` 工具 → 标记错误 → break
3. **正常结果**：
   - `"stop"` → break（被权限阻止或出错）
   - `"compact"` → 创建压缩任务 → continue
   - `"continue"` → continue（有工具调用待处理）

**`Effect.ensuring` 清理**：

```typescript
}).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
```

无论成功还是失败，都会清理与该消息关联的临时指令。

---

## Step 14: 根据 outcome 决策

```typescript
// prompt.ts:1838-1839
if (outcome === "break") break
continue
```

**原理**：极简判断。`"break"` 退出循环，否则 `continue` 进入下一次迭代。

**整个循环决策汇总**：

```
outcome 来源:
  → structured 输出成功 → "break"
  → structured 输出失败 → "break"
  → handle.process 返回 "stop" → "break"
  → handle.process 返回 "compact" → "continue" (先创建压缩任务)
  → handle.process 返回 "continue" → "continue"
```

**示例**：

```typescript
// ===== outcome 决策的完整场景 =====

// 场景1: outcome = "break" → 退出循环
//   触发条件:
//     a. 结构化输出成功: structured = { files: [...] }
//     b. 结构化输出失败: LLM 没调用 StructuredOutput
//     c. 权限拒绝: ctx.blocked = true
//     d. LLM 流处理错误: ctx.assistantMessage.error 存在
//
//   结果:
//     if (outcome === "break") break
//     → 跳出 while(true) 循环
//     → 进入收尾阶段

// 场景2: outcome = "continue" → 继续循环
//   触发条件:
//     a. handle.process 返回 "continue"（LLM 调用了工具，需要回传结果）
//     b. handle.process 返回 "compact"（需要压缩，已创建压缩任务）
//
//   结果:
//     continue → 回到 while(true) 顶部
//     → Step 1: 重新设置 busy
//     → Step 2: 重新读取消息（可能包含新的工具结果或压缩摘要）
//     → 继续下一轮迭代

// ===== 决策路径汇总图 =====

// handle.process() 返回值:
//   "continue" ──────────────────→ outcome = "continue" → continue
//                                   (最常见的路径: LLM 调用了工具)
//
//   "stop" ─────────────────────→ outcome = "break" → break
//                                   (权限拒绝或错误)
//
//   "compact" ─→ compaction.create() → outcome = "continue" → continue
//                                   (需要压缩，下次迭代 Step 8 处理)
//
// structured !== undefined ────→ outcome = "break" → break
//                                   (JSON Schema 输出成功)
//
// structured === undefined 且
//   format === "json_schema" ──→ outcome = "break" → break
//                                   (JSON Schema 输出失败)

// ===== 为什么不在 Step 13 中直接 break/continue？ =====

// Step 13 被包裹在 Effect.gen 中，返回值是 "break" | "continue"
// 而不是直接在 Effect.gen 内 break/continue
// 原因:
//   1. Effect.gen 内的 break/continue 作用于内部的 generator，不是外部的 while(true)
//   2. Effect.ensuring 需要在 outcome 确定后才执行清理
//   3. 将决策逻辑集中在一处，更容易理解和维护
//
// 流程:
//   Effect.gen { ... return "break" }  → outcome = "break"
//     → Effect.ensuring(instruction.clear(...))  → 清理
//   if (outcome === "break") break  → 退出 while(true)
```

---

## 收尾：循环结束后

```typescript
// prompt.ts:1842-1843
yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
return yield* lastAssistant(sessionID)
```

**原理**：

1. **`compaction.prune`**：后台 fork 执行压缩修剪——清理过旧的工具调用输出，释放存储空间。`Effect.ignore` 忽略错误，`Effect.forkIn(scope)` 不阻塞返回。
2. **`lastAssistant(sessionID)`**：获取会话中最后一条助手消息（包含完整文本和工具调用结果），作为 `runLoop` 的返回值。

**示例**：

```typescript
// ===== 收尾阶段的完整流程 =====

// 循环退出后，执行两个收尾操作:

// 操作1: 后台修剪旧输出（不阻塞）
yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))

// compaction.prune 做了什么:
//   1. 扫描会话中的所有工具调用输出
//   2. 找到过长的输出（超过截断阈值）
//   3. 截断旧的工具输出，只保留关键信息
//   4. 更新数据库中的 tool part
//
// 为什么需要修剪？
//   工具可能返回非常长的输出（如 read_file 读取大文件）
//   这些输出在消息历史中占用大量空间
//   修剪后释放空间，减少下次 LLM 调用的 token 消耗
//
// 示例:
//   修剪前: ToolPart.output = "1: import React...\n2: import useState...\n...（500行）"
//   修剪后: ToolPart.output = "1: import React...\n2: import useState...\n...（前50行）\n... (truncated)"

// Effect.ignore: 修剪失败不影响主流程
// Effect.forkIn(scope): 后台执行，不阻塞返回

// 操作2: 返回最后一条助手消息
return yield* lastAssistant(sessionID)

// lastAssistant 做了什么:
//   1. 从数据库查询会话中最后一条 role="assistant" 的消息
//   2. 包含完整的 parts（文本、工具调用、推理等）
//   3. 作为 runLoop 的返回值
//
// 返回值示例:
// {
//   info: {
//     id: "msg_01HXFINAL",
//     role: "assistant",
//     finish: "stop",
//     agent: "code",
//     modelID: "claude-sonnet-4-20250514",
//     tokens: { input: 5200, output: 350, reasoning: 1200, cache: { read: 3000, write: 500 } },
//     cost: 0.032,
//     time: { created: 1715769600000, completed: 1715769615000 },
//   },
//   parts: [
//     { type: "text", text: "我已经修复了类型错误..." },
//     { type: "tool", tool: "read_file", state: { status: "completed", output: "..." } },
//     { type: "tool", tool: "edit_file", state: { status: "completed", output: "..." } },
//     { type: "text", text: "修改完成！具体改动如下：\n1. 第12行..." },
//   ],
// }
//
// 这个返回值会被上层的 shellImpl 等函数使用:
//   → 前端展示最终回答
//   → 父会话获取子任务的执行结果
//   → 日志记录和审计追踪

// ===== runLoop 的完整生命周期总结 =====

// 1. 初始化: 获取上下文、会话信息
// 2. 循环:
//    a. 设置 busy 状态
//    b. 读取消息历史
//    c. 提取关键引用
//    d. 检查退出条件
//    e. 处理 subtask/compaction/溢出
//    f. 获取智能体配置
//    g. 创建助手消息和处理器
//    h. 调用 LLM + 处理工具调用
//    i. 根据结果决策
// 3. 收尾: 修剪 + 返回最后助手消息
//
// 核心设计原则:
//   - 每次 LLM 调用可能产生工具调用 → 需要循环
//   - 工具结果需要回传给 LLM → 需要重新读取消息
//   - 上下文可能溢出 → 需要压缩机制
//   - 步数需要限制 → 防止死循环
//   - 状态转换需要原子性 → 创建任务+下次处理模式
```

---

## 完整执行流程示例

以用户输入"帮我修复 src/utils.ts 中的类型错误"为例：

```
=== 初始化 ===
session = { id: "sess_123", permission: [...] }
ctx = { directory: "/home/user/project", worktree: "/home/user/project" }
step = 0

=== 第1次迭代 (step=1) ===
Step 1:  status → busy
Step 2:  msgs = [User("修复类型错误")]
Step 3:  lastUser=User, lastAssistant=undefined, lastFinished=undefined
Step 4:  退出条件不满足（无 lastAssistant.finish）→ 继续
Step 5:  step=1, 后台生成标题 "修复类型错误"
Step 6:  model = claude-sonnet-4, task = undefined
Step 7-9: 无 subtask/compaction/溢出
Step 10: agent = code, maxSteps=50, isLastStep=false
Step 11: 注入提醒（无特殊提醒）
Step 12: 创建 assistant 消息 + processor
Step 13:
  13b: tools = { bash, read_file, write_file, ... }
  13g: 并行准备 system prompt + model messages
  13h: handle.process() → LLM 流式返回
       → text-delta: "让我先看看文件内容"
       → tool-call: read_file({ path: "src/utils.ts" })
       → tool-result: "文件内容..."
       → finish-step: tokens={input:5000, output:200}
       → finish: "tool-calls"
  13i: result = "continue"
Step 14: outcome = "continue" → continue

=== 第2次迭代 (step=2) ===
Step 1:  status → busy
Step 2:  msgs = [User, Assistant(read_file), User(tool_result), ]  ← 包含工具结果
Step 3:  lastUser=User(tool_result), lastAssistant=上一步的assistant
Step 4:  finish="tool-calls" → 不退出
Step 6:  model = claude-sonnet-4
Step 13:
  13h: handle.process() → LLM 看到工具结果后继续
       → text-delta: "我发现了类型错误，修复如下..."
       → tool-call: write_file({ path: "src/utils.ts", content: "..." })
       → tool-result: "写入成功"
       → finish-step: tokens={input:8000, output:500}
       → finish: "stop"
  13i: result = "continue"  ← 因为有工具调用，需要下一轮
Step 14: outcome = "continue" → continue

=== 第3次迭代 (step=3) ===
Step 2:  msgs = [..., Assistant(write_file, finish="stop")]
Step 3:  lastAssistant.finish = "stop", hasToolCalls = false
Step 4:  四个退出条件全部满足 → break!

=== 收尾 ===
后台 prune → 返回最后的助手消息
```