# Compaction 使用 LLM 生成摘要的完整实现细节

## 一、整体流程

```
compaction.create()          → 插入一条带 compaction 部分的 user 消息（标记任务）
       ↓
runLoop 下次迭代 Step 8      → 检测到 compaction 任务
       ↓
compaction.process()         → 真正执行压缩，调用 LLM 生成摘要
```

---

## 二、`create()` — 创建压缩任务

> 源码位置：[`compaction.ts:584-612`](../packages/opencode/src/session/compaction.ts:584)

仅做一件事：插入一条 `user` 消息 + `compaction` 部分，作为后续处理的标记。

```typescript
const msg = yield* session.updateMessage({
  id: MessageID.ascending(),
  role: "user",
  model: input.model,
  sessionID: input.sessionID,
  agent: input.agent,
  time: { created: Date.now() },
})
yield* session.updatePart({
  type: "compaction",
  auto: input.auto,        // 是否自动触发
  overflow: input.overflow, // 是否溢出触发
})
```

同时触发 `SessionEvent.Compaction.Started` 同步事件通知前端。

---

## 三、`process()` — 真正的压缩实现

> 源码位置：[`compaction.ts:348-582`](../packages/opencode/src/session/compaction.ts:348)

这是核心，分为 **7 个子步骤**：

### 3.1 溢出回放准备

```typescript
// compaction.ts:369-385
if (input.overflow) {
  // 从 parentID 向前找第一条非 compaction 的 user 消息
  for (let i = idx - 1; i >= 0; i--) {
    if (msg.info.role === "user" && !msg.parts.some(p => p.type === "compaction")) {
      replay = { info: msg.info, parts: msg.parts }  // 保存这条用户消息
      messages = input.messages.slice(0, i)            // 截断，不包含该消息
      break
    }
  }
}
```

**原理**：溢出压缩时，最近一轮用户消息可能因上下文过大而从未被 LLM 处理。这条消息被保存为 `replay`，压缩完成后会重新插入消息历史，确保 LLM 在下一轮能看到它。

**示例**：
```
消息: [User1, Asst1, User2(带大图片), Asst2(溢出!)]
overflow=true → replay = User2, messages = [User1, Asst1]
压缩后: [User_compaction, Asst_summary, User2(重新插入)]
```

### 3.2 获取压缩专用智能体和模型

```typescript
// compaction.ts:387-391
const agent = yield* agents.get("compaction")  // 使用名为 "compaction" 的专用智能体
const model = agent.model
  ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)  // 可配置专用小模型
  : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)  // 回退到用户模型
```

**原理**：系统内置名为 `"compaction"` 的智能体，可以配置使用更便宜的小模型（如 Haiku）来生成摘要，节省成本。

**示例**：
```
compaction 智能体配置: { name: "compaction", model: { providerID: "anthropic", modelID: "claude-haiku-4" } }
→ 使用 Haiku 生成摘要，而非 Sonnet/Opus
```

### 3.3 选择要压缩的消息范围（`select`）

```typescript
// compaction.ts:396-400
const selected = yield* select({
  messages: history.filter((_, index) => !hidden.has(index)),
  cfg,
  model,
})
```

**`select()` 函数**（[`compaction.ts:249-298`](../packages/opencode/src/session/compaction.ts:249)）的核心逻辑：

1. **确定保留轮数**：`tail_turns = cfg.compaction?.tail_turns ?? 2`（默认保留最近 2 轮）
2. **计算保留预算**：`preserveRecentBudget` = 可用上下文的 25%，最少 2000 token，最多 8000 token
3. **从最近的轮次开始倒推**：在预算内尽可能多保留最近几轮
4. **如果某轮超出预算**：尝试用 `splitTurn` 在该轮内切分，保留后部分
5. **返回**：`{ head: 要压缩的旧消息, tail_start_id: 保留的起始消息ID }`

**`turns()` 函数**（[`compaction.ts:142-158`](../packages/opencode/src/session/compaction.ts:142)）：将消息按"轮"分组，每轮从一条 user 消息开始到下一条 user 消息之前。

**`splitTurn()` 函数**（[`compaction.ts:160-183`](../packages/opencode/src/session/compaction.ts:160)）：在某轮内从后向前搜索，找到不超过剩余预算的最大切分点。

**示例**：
```
消息: [U1,A1, U2,A2, U3,A3, U4,A4]
                  ↑ head（压缩）    ↑ tail（保留）
                  tail_start_id = U3.id

保留预算 = 6000 tokens
U3+A3 = 3000 → 保留
U4+A4 = 2000 → 保留
总计 5000 < 6000 → 两轮都保留
```

### 3.4 构建摘要提示词（`buildPrompt`）

**摘要模板**（[`compaction.ts:41-76`](../packages/opencode/src/session/compaction.ts:41)）：

```typescript
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template>...
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
```

**增量更新 vs 新建**（[`compaction.ts:122-133`](../packages/opencode/src/session/compaction.ts:122)）：

```typescript
function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? "Update the anchored summary below using the conversation history above.\n" +
      "<previous-summary>\n" + input.previousSummary + "\n</previous-summary>"
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}
```

- 如果之前已有摘要（`previousSummary`），提示 LLM **更新**已有摘要，保留仍有效的信息
- 如果没有，提示 LLM **新建**摘要

**`previousSummary` 来源**（[`compaction.ts:393-395`](../packages/opencode/src/session/compaction.ts:393)）：

```typescript
const prior = completedCompactions(history)  // 找到之前已完成的压缩
const previousSummary = prior.at(-1)?.summary  // 取最近一次的摘要文本
```

**示例**：
```
首次压缩提示: "Create a new anchored summary from the conversation history above."
二次压缩提示: "Update the anchored summary below using the conversation history above.
               <previous-summary>
               ## Goal
               - 修复类型错误
               ...
               </previous-summary>"
```

### 3.5 转换消息为模型格式（截断工具输出）

```typescript
// compaction.ts:408-413
const msgs = structuredClone(selected.head)  // 深拷贝，不修改原消息
yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
  stripMedia: true,              // 移除图片等媒体内容
  toolOutputMaxChars: 2_000,     // 工具输出截断到 2000 字符
})
```

**原理**：压缩时发送给 LLM 的消息历史经过精简：
- 图片等媒体内容被移除（节省大量 token）
- 工具输出从可能的上万字符截断到 2000 字符
- 这是**深拷贝**，不影响数据库中的原始消息
- 插件钩子 `experimental.chat.messages.transform` 允许在发送前修改消息

**示例**：
```
原始工具输出: "export function parseConfig() {\n  // 500行代码...\n}"  (15000 字符)
截断后: "export function parseConfig() {\n  // 500行代码...\n}".slice(0, 2000)  (2000 字符)
```

### 3.6 调用 LLM 生成摘要

```typescript
// compaction.ts:415-461
const msg: MessageV2.Assistant = {
  id: MessageID.ascending(),
  role: "assistant",
  parentID: input.parentID,
  sessionID: input.sessionID,
  mode: "compaction",
  agent: "compaction",
  summary: true,    // ← 标记为摘要消息
  ...
}
yield* session.updateMessage(msg)
const processor = yield* processors.create({ assistantMessage: msg, sessionID, model })
const result = yield* processor.process({
  user: userMessage,
  agent,
  sessionID: input.sessionID,
  tools: {},           // ← 无工具！摘要生成不允许调用工具
  system: [],          // ← 无系统提示词
  messages: [
    ...modelMessages,  // 精简后的旧消息历史
    {
      role: "user",
      content: [{ type: "text", text: nextPrompt }],  // 摘要提示词
    },
  ],
  model,
})
```

**关键设计**：
- `tools: {}` — 空！摘要生成是纯文本任务，LLM 不允许调用任何工具
- `system: []` — 无系统提示词，避免注入无关指令
- 消息序列：`[旧消息1, 旧消息2, ..., 摘要提示词]`
- 使用同一个 `processor.process` → `llm.stream` → `streamText` 链路，与正常对话完全一致
- `summary: true` 标记确保流事件处理中跳过前端通知（不显示文本增量等）

**示例**：
```
发送给 LLM 的消息:
  messages: [
    { role: "user", content: "帮我修复类型错误" },
    { role: "assistant", content: "让我看看文件..." },
    { role: "user", content: [tool_result: "文件内容(截断到2000字)..."] },
    { role: "assistant", content: "我修复了类型错误" },
    { role: "user", content: "Create a new anchored summary from the conversation history above.\n\n<template>..." }
  ]
  tools: {}
  system: []

LLM 返回:
  "## Goal
   - 修复 src/utils.ts 中的类型错误

   ## Progress
   ### Done
   - 读取了 src/utils.ts 文件
   - 修复了 parseConfig 函数的类型注解

   ## Relevant Files
   - src/utils.ts: 包含 parseConfig 函数，已修复类型

   ..."
```

### 3.7 后续处理

```typescript
// compaction.ts:463-581
```

**3.7.1 压缩后仍溢出 → 标记错误，停止循环**

```typescript
if (result === "compact") {
  processor.message.error = new MessageV2.ContextOverflowError({
    message: replay
      ? "Conversation history too large to compact - exceeds model context limit"
      : "Session too large to compact - context exceeds model limit even after stripping media",
  }).toObject()
  processor.message.finish = "error"
  yield* session.updateMessage(processor.message)
  return "stop"
}
```

**原理**：如果 LLM 生成摘要后仍然返回 `"compact"`（说明上下文依然溢出），则彻底放弃——标记错误并停止循环。

**3.7.2 更新 compaction 部分的 tail_start_id**

```typescript
if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
  yield* session.updatePart({
    ...compactionPart,
    tail_start_id: selected.tail_start_id,
  })
}
```

**原理**：如果此次压缩重新计算了保留范围（tail_start_id 发生变化），更新 compaction 部分以反映新的消息保留边界。`filterCompacted` 函数在读取消息历史时会使用此字段。

**3.7.3 压缩成功 + 自动触发 → 插入后续消息**

```typescript
if (result === "continue" && input.auto) {
  if (replay) {
    // 溢出场景：重新插入被回放的用户消息
    const replayMsg = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      agent: original.agent,
      model: original.model,
      ...
    })
    for (const part of replay.parts) {
      if (part.type === "compaction") continue  // 跳过 compaction 部分
      // 媒体文件替换为文本占位符
      const replayPart = part.type === "file" && MessageV2.isMedia(part.mime)
        ? { type: "text", text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
        : part
      yield* session.updatePart({ ...replayPart, id: PartID.ascending(), messageID: replayMsg.id })
    }
  }

  if (!replay) {
    // 非溢出场景：检查是否需要插入 "继续" 消息
    const { enabled } = yield* plugin.trigger("experimental.compaction.autocontinue", ...)
    if (enabled) {
      const continueMsg = yield* session.updateMessage({ role: "user", ... })
      yield* session.updatePart({
        type: "text",
        synthetic: true,
        metadata: { compaction_continue: true },
        text: (input.overflow
          ? "The previous request exceeded the provider's size limit..."
          : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      })
    }
  }
}
```

**两种后续消息的区别**：

| 场景 | 插入的消息 | 说明 |
|------|-----------|------|
| 溢出 + 有 replay | 重新插入原始用户消息（媒体替换为占位符） | 确保 LLM 能看到因溢出而未处理的用户请求 |
| 非溢出 | 合成的 "Continue if you have next steps" 消息 | 提示 LLM 继续工作或停下来 |

**3.7.4 发布压缩完成事件**

```typescript
if (processor.message.error) return "stop"
if (result === "continue") {
  const summary = summaryText(...)  // 提取摘要文本
  yield* sync.run(SessionEvent.Compaction.Ended.Sync, {
    sessionID: input.sessionID,
    text: summary ?? "",
    include: selected.tail_start_id,
  })
  yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
}
return result
```

---

## 四、溢出判断原理

> 源码位置：[`overflow.ts:19-26`](../packages/opencode/src/session/overflow.ts:19)

```typescript
function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false  // 用户禁用了自动压缩
  if (input.model.limit.context === 0) return false       // 模型无上下文限制

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)  // 总 token >= 可用上限
}
```

**可用上限（`usable`）计算**（[`overflow.ts:8-17`](../packages/opencode/src/session/overflow.ts:8)）：

```typescript
function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context   // 模型上下文窗口大小
  const reserved = input.cfg.compaction?.reserved
    ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))  // 默认预留 20000

  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)      // 有 input 限制：input限制 - 预留
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model))  // 无 input 限制：上下文窗口 - 最大输出
}
```

**常量**（[`compaction.ts:34-39`](../packages/opencode/src/session/compaction.ts:34)）：

| 常量 | 值 | 说明 |
|------|-----|------|
| `PRUNE_MINIMUM` | 20,000 | 修剪触发的最低 token 阈值 |
| `PRUNE_PROTECT` | 40,000 | 修剪时保护的最近工具输出 token 量 |
| `TOOL_OUTPUT_MAX_CHARS` | 2,000 | 压缩时工具输出截断字符数 |
| `DEFAULT_TAIL_TURNS` | 2 | 默认保留的最近对话轮数 |
| `MIN_PRESERVE_RECENT_TOKENS` | 2,000 | 保留预算最小值 |
| `MAX_PRESERVE_RECENT_TOKENS` | 8,000 | 保留预算最大值 |
| `COMPACTION_BUFFER` | 20,000 | 溢出判断的预留缓冲区 |

**示例**：
```
模型: Claude Sonnet (context=200000, maxOutput=8192)
usable = 200000 - 8192 = 191808
当 tokens.total >= 191808 → isOverflow = true → 触发压缩
```

---

## 五、`prune()` — 修剪旧工具输出

> 源码位置：[`compaction.ts:302-346`](../packages/opencode/src/session/compaction.ts:302)

与 `process()` 不同，`prune` **不调用 LLM**，而是直接删除旧工具调用的输出内容。

```typescript
const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
  const cfg = yield* config.get()
  if (!cfg.compaction?.prune) return  // 用户未启用修剪则跳过

  // 从最新消息向前遍历
  loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
    if (msg.info.role === "user") turns++
    if (turns < 2) continue                  // 最近 2 轮不修剪
    if (msg.info.role === "assistant" && msg.info.summary) break  // 遇到压缩摘要停止

    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue       // 只修剪已完成的
      if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue  // 保护 "skill" 等工具
      if (part.state.time.compacted) break loop             // 已修剪过的停止

      const estimate = Token.estimate(part.state.output)
      total += estimate
      if (total <= PRUNE_PROTECT) continue  // 最近 40000 token 内的工具输出保留
      pruned += estimate
      toPrune.push(part)                    // 超过保护区的加入修剪列表
    }
  }

  if (pruned > PRUNE_MINIMUM) {
    for (const part of toPrune) {
      part.state.time.compacted = Date.now()  // 标记已修剪
      yield* session.updatePart(part)
    }
  }
})
```

**原理**：
1. 从最新消息向前遍历
2. 最近 2 轮不修剪
3. 最近 40000 token 的工具输出受保护
4. 超出保护区的已完成工具输出标记为 `compacted`
5. 只有当修剪总量超过 20000 token 时才真正执行

**注意**：`prune` 在 `runLoop` 结束后以后台 fork 方式执行（`Effect.forkIn(scope)`），不阻塞主流程。

---

## 六、完整执行流程示例

```
=== 初始状态 ===
消息: [User1, Asst1, User2, Asst2, User3, Asst3]
tokens.total = 185000, usable = 191808 → 未溢出

=== User4 发送后，Asst4 返回 ===
tokens.total = 195000 > 191808 → 溢出!

=== runLoop Step 9: isOverflow = true ===
→ compaction.create({ auto: true })
  → 插入 User_compaction 消息

=== runLoop 下次迭代 Step 8: 检测到 compaction ===
→ compaction.process()
  3.1: overflow=false → 无 replay
  3.2: agent = "compaction", model = claude-haiku-4
  3.3: select() → tail_turns=2
       保留 U3+A3+U4+A4（约 6000 tokens）
       head = [U1, A1, U2, A2]（压缩为摘要）
       tail_start_id = U3.id
  3.4: buildPrompt() → "Create a new anchored summary..."
  3.5: 转换消息 → 移除媒体，截断工具输出
  3.6: processor.process({ tools: {}, system: [], messages: [旧消息, 摘要提示] })
       → LLM (Haiku) 生成摘要
       → result = "continue"
  3.7: 无 replay → 插入合成 "Continue" 消息
       → 返回 "continue"

=== 压缩后的消息序列 ===
[User_compaction, Asst_summary(摘要), User3, Asst3, User4, Asst4, User_continue]
                     ↑ 旧消息被压缩    ↑ 保留的最近2轮

=== runLoop 结束后 ===
→ compaction.prune() 后台执行
  修剪 U1/U2/A1/A2 中超过 40000 token 保护区的旧工具输出
```

---

## 七、问答

### Q: subtask 和 compaction 会不会在同一轮 runLoop 中先后执行？

**A: 理论上可能共存于 `tasks` 数组，但实际几乎不会先后执行。**

**`tasks` 的收集逻辑**（[`prompt.ts:1634-1643`](../packages/opencode/src/session/prompt.ts:1634)）：

```typescript
let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
for (let i = msgs.length - 1; i >= 0; i--) {
  ...
  if (lastUser && lastFinished) break   // ← 关键：找到 lastUser 和 lastFinished 后立即停止
  const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
  if (task && !lastFinished) tasks.push(...task)  // ← 只在 lastFinished 之前收集
}
```

**关键约束**：

1. **每次迭代只消费一个 task**：`tasks.pop()` 只取一个
2. **`handleSubtask` 设置 `finish = "tool-calls"`**（[`prompt.ts:833`](../packages/opencode/src/session/prompt.ts:833)），意味着它创建的 assistant 消息有 finish 标记
3. **`compaction.process` 也创建带 finish 的 summary assistant 消息**

**场景 1：不同 user 消息中的 subtask 和 compaction**

```
[User1(compaction), Asst1(finish=stop), User2(subtask), Asst2(finish=tool-calls)]
```

迭代 N 向后遍历：
- i=3: Asst2(finish=tool-calls) → `lastAssistant=Asst2`, `lastFinished=Asst2`
- i=2: User2(subtask) → `lastUser=User2`，**但 `lastUser && lastFinished` → break！**
- tasks 为空（`!lastFinished` 为 false，不收集）

**User2 的 subtask 根本不会被收集到 tasks 中**，因为 `lastFinished` 在它之前就被设置了。

**场景 2：同一条 user 消息中同时包含 compaction 和 subtask**

```
[User1(compaction+subtask), Asst1(无finish), User2, Asst2(finish=stop)]
```

- 向后遍历到 User1 时，`!lastFinished` 为 true，两个 task 都被收集
- `tasks.pop()` 取出一个（假设是 subtask）→ `handleSubtask` → continue
- **下一迭代**：重新遍历消息，此时 `handleSubtask` 创建的 assistant 消息（`finish="tool-calls"`）成为 `lastFinished`，**break 提前触发**，compaction 不会被收集

**结论**：

| 场景 | 是否可能 subtask + compaction 都执行 |
|------|-------------------------------------|
| 不同 user 消息中 | **不可能** — `lastFinished` 提前终止遍历 |
| 同一条 user 消息中 | **理论上可能共存于 tasks**，但首次 pop 一个后，下次迭代时 `lastFinished` 导致另一个不被收集 |

**边界情况**：如果 `handleSubtask` 创建的 assistant 消息恰好在 `lastUser` 之后（`lastUser.id < lastAssistant.id`），且 `finish="tool-calls"` 不满足退出条件，循环继续时，Step 9 的**溢出检测**可能会另外触发 `compaction.create()`——但这是一个**新的压缩任务**，而非消费之前未处理的那个。