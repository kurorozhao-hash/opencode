# 核心处理（工具解析 → LLM 调用 → 结果判断）

> 源码位置：[`prompt.ts:1739-1837`](../packages/opencode/src/session/prompt.ts:1739)
>
> 本文档从 [`runloop.md`](./runloop.md) 的 Step 13 剥离而来，详细拆解 `runLoop` 中最复杂、最核心的处理步骤。

这是整个 `runLoop` 最复杂、最核心的步骤，被包裹在一个 `Effect.gen` 中，返回 `"break"` 或 `"continue"`。

```typescript
// prompt.ts:1739-1837
const outcome: "break" | "continue" = yield* Effect.gen(function* () {
  // ... 13a ~ 13i 子步骤 ...
}).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
```

## 13a: 检查是否绕过智能体工具检查

```typescript
// prompt.ts:1740-1741
const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
```

**原理**：如果最后一条用户消息包含 `agent` 类型的部分（如用户通过 `@code` 引用了子智能体），则允许使用不属于当前智能体的工具。这是因为 `agent` 部分会合成一段指令，让 LLM 调用 `task` 工具委派给子智能体，而 `task` 工具可能不在当前智能体的工具列表中。

**示例**：
```
用户输入: "帮我重构代码 @code" → parts 包含 { type: "agent", name: "code" }
bypassAgentCheck = true → resolveTools 时不过滤 agent 专属工具
```

## 13b: 解析工具

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
```
resolveTools 返回:
{
  "bash": AITool { description: "Execute bash command", execute: [Function] },
  "read_file": AITool { description: "Read file contents", execute: [Function] },
  "write_file": AITool { description: "Write to file", execute: [Function] },
  "mcp_github_search": AITool { description: "Search GitHub", execute: [Function] },
  ...
}
```

## 13c: 结构化输出工具

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
```
format = { type: "json_schema", schema: { type: "object", properties: { name: { type: "string" } } } }
→ 注入 StructuredOutput 工具 → LLM 必须调用此工具返回 { name: "..." }
→ structured = { name: "..." }
```

## 13d: 后台生成摘要

```typescript
// prompt.ts:1762-1763
if (step === 1)
  yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))
```

**原理**：仅在第一步时，后台 fork 执行摘要生成。与标题生成类似，不阻塞主流程。

## 13e: 中间用户消息提醒

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
```
LLM 正在执行第2步工具调用时，用户发送: "等一下，先看看 test.ts"
原文本: "等一下，先看看 test.ts"
包装后: "<system-reminder>\nThe user sent the following message:\n等一下，先看看 test.ts\n\nPlease address this message and continue with your tasks.\n</system-reminder>"
```

## 13f: 插件消息变换

```typescript
// prompt.ts:1783
yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
```

**原理**：触发实验性插件钩子，允许插件在消息发送给 LLM 之前修改消息内容。这是扩展点。

## 13g: 并行准备系统提示词和模型消息

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
```
system = [
  "You are running on macOS with zsh shell...",      // env
  "Always use TypeScript strict mode...",             // instructions (from .opencode/instructions.md)
  "Available skills: dispatching-parallel-agents...", // skills
]
```

## 13h: 调用 LLM（核心中的核心）

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
```
输入:
  system: ["You are a coding assistant...", "Always use TypeScript..."]
  messages: [{ role: "user", content: "帮我重构代码" }, ...]
  tools: { bash, read_file, write_file, ... }

LLM 流式返回:
  text-delta: "我来帮你重构代码。"  → 前端实时显示
  tool-call: read_file({ path: "src/utils.ts" })  → 执行工具 → tool-result
  text-delta: "我已经读取了文件，现在开始重构..."  → 前端实时显示
  
  → result = "continue"（因为调用了工具，需要下一轮处理工具结果）
```

## 13i: 结果后处理

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