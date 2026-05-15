# OpenCode Session 函数调用流程详解

## 📋 目录

- [概览](#概览)
- [核心函数调用链](#核心函数调用链)
- [详细流程说明](#详细流程说明)
- [数据流向](#数据流向)
- [关键决策点](#关键决策点)
- [函数参数与返回值](#函数参数与返回值)

---

## 概览

OpenCode 的 session 模块负责处理用户输入与 AI 模型的交互。整个流程从用户输入开始，经过消息创建、工具解析、LLM 调用，最终返回响应结果。

### 核心文件

- **prompt.ts** - 提示词管理和对话流程控制
- **session.ts** - 会话管理
- **message-v2.ts** - 消息处理
- **processor.ts** - LLM 响应处理
- **llm.ts** - LLM 服务集成
- **compaction.ts** - 上下文压缩

---

## 核心函数调用链

```
用户输入
    ↓
prompt(input)
    ├─ sessions.get(sessionID)
    ├─ revert.cleanup(session)
    ├─ createUserMessage(input)
    │   ├─ agents.get(agentName)
    │   ├─ provider.getModel(providerID, modelID)
    │   ├─ resolvePart(part)  [递归处理每个部分]
    │   │   ├─ 处理文件类型
    │   │   ├─ 处理 agent 类型
    │   │   └─ 处理文本类型
    │   ├─ sessions.updateMessage(info)
    │   └─ sessions.updatePart(part)
    ├─ sessions.touch(sessionID)
    └─ loop({ sessionID })
        └─ state.ensureRunning(sessionID, fallback, runLoop(sessionID))
            └─ runLoop(sessionID)
                └─ while (true) {
                    ├─ status.set(sessionID, { type: "busy" })
                    ├─ MessageV2.filterCompactedEffect(sessionID)
                    ├─ 检查退出条件
                    ├─ getModel(providerID, modelID, sessionID)
                    ├─ agents.get(agentName)
                    ├─ resolveTools({ agent, model, session, ... })
                    │   ├─ registry.tools({ modelID, providerID, agent })
                    │   ├─ mcp.tools()
                    │   └─ 构建工具执行上下文
                    ├─ 准备系统提示词
                    │   ├─ sys.skills(agent)
                    │   ├─ sys.environment(model)
                    │   ├─ instruction.system()
                    │   └─ MessageV2.toModelMessagesEffect(msgs, model)
                    ├─ handle.process({
                    │     user, agent, permission, sessionID,
                    │     system, messages, tools, model
                    │   })
                    │   ├─ processor.create({ assistantMessage, sessionID, model })
                    │   ├─ llm.stream({
                    │   │     user, sessionID, model, agent,
                    │   │     system, messages, tools
                    │   │   })
                    │   ├─ 处理流事件
                    │   │   ├─ text-delta → 更新文本部分
                    │   │   ├─ tool-call → 创建工具调用
                    │   │   └─ reasoning → 更新推理部分
                    │   ├─ 执行工具调用
                    │   │   ├─ 权限检查
                    │   │   ├─ 执行工具
                    │   │   └─ 返回结果
                    │   └─ 返回结果：continue | stop | compact
                    └─ 根据结果决策
                        ├─ result === "stop" → break
                        ├─ result === "compact" → compaction.create()
                        └─ result === "continue" → continue
                }
```

---

## 详细流程说明

### 1. 入口函数：prompt()

**位置**: `opencode/packages/opencode/src/session/prompt.ts:1283`

**功能**: 处理用户输入的主入口函数

**执行步骤**:

```typescript
1. 获取会话信息
   const session = yield* sessions.get(input.sessionID)

2. 清理回滚状态
   yield* revert.cleanup(session)

3. 创建用户消息
   const message = yield* createUserMessage(input)

4. 更新会话时间戳
   yield* sessions.touch(input.sessionID)

5. 处理权限设置
   - 遍历 input.tools
   - 设置 allow/deny 权限

6. 检查是否需要回复
   if (input.noReply === true) return message

7. 进入对话循环
   return yield* loop({ sessionID: input.sessionID })
```

**关键代码**:

```typescript
const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts> = 
  Effect.fn("SessionPrompt.prompt")(function* (input: PromptInput) {
    const session = yield* sessions.get(input.sessionID)
    yield* revert.cleanup(session)
    const message = yield* createUserMessage(input)
    yield* sessions.touch(input.sessionID)

    // 权限处理
    const permissions: Permission.Ruleset = []
    for (const [t, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
    }

    if (input.noReply === true) return message
    return yield* loop({ sessionID: input.sessionID })
  })
```

---

### 2. 创建用户消息：createUserMessage()

**位置**: `opencode/packages/opencode/src/session/prompt.ts:925`

**功能**: 解析用户输入并创建消息对象

**执行步骤**:

```typescript
1. 获取智能体配置
   const agentName = input.agent || (yield* agents.defaultAgent())
   const ag = yield* agents.get(agentName)

2. 确定使用的模型
   const model = input.model ?? ag.model ?? (yield* lastModel(input.sessionID))

3. 创建用户消息对象
   const info: MessageV2.User = {
     id: MessageID.ascending(),
     role: "user",
     sessionID: input.sessionID,
     time: { created: Date.now() },
     tools: input.tools,
     agent: ag.name,
     model: { providerID, modelID, variant },
     system: input.system,
     format: input.format,
   }

4. 解析消息部分 (resolvePart)
   - 处理文件部分 (type: "file")
     - 从 URL 读取文件内容
     - 处理 MCP 资源
     - 编码为 base64
   - 处理智能体部分 (type: "agent")
     - 添加智能体调用提示
   - 处理文本部分 (type: "text")
     - 直接使用文本内容

5. 保存消息到数据库
   yield* sessions.updateMessage(info)
   for (const part of parts) yield* sessions.updatePart(part)

6. 返回消息对象
   return { info, parts }
```

**处理的不同部分类型**:

| 类型 | 说明 | 处理方式 |
|------|------|----------|
| file | 文件附件 | 读取文件内容，编码为 base64 |
| agent | 智能体调用 | 保留原始 agent 部分 + 合成指令文本，引导 LLM 调用 task 工具委派给子智能体 |
| text | 文本内容 | 直接使用 |
| subtask | 子任务 | 直接保留原始部分，用于标题生成等场景 |

**各部分类型详细说明**:

#### Agent 部分（智能体调用）

**数据结构**（`MessageV2.AgentPart`，位于 `message-v2.ts:170`）:

```typescript
{
  type: "agent",
  name: string,          // 智能体名称，如 "code"
  source?: {             // 可选，引用在原文中的位置
    value: string,
    start: number,
    end: number,
  }
}
```

**`resolvePart` 处理逻辑**（`prompt.ts:1436-1452`）:

```typescript
if (part.type === "agent") {
  const perm = Permission.evaluate("task", part.name, ag.permission)
  const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
  return [
    { ...part, messageID: info.id, sessionID: input.sessionID },  // 保留原始 agent 部分
    {
      messageID: info.id,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      text: " Use the above message and context to generate a prompt and call the task tool with subagent: " + part.name + hint
    }
  ]
}
```

**处理结果**: 解析后产生两个部分：
1. `{ type: "agent", name: "code" }` — 原始 agent 引用
2. `{ type: "text", synthetic: true, text: "Use the above message and context to generate a prompt and call the task tool with subagent: code" }` — **合成的指令文本**，告诉 LLM 应当调用 `task` 工具并以 `code` 作为 subagent 来处理

**举例**: 用户在对话中通过 `@code` 引用了 code 智能体，输入内容为 "帮我重构这个函数 @code"，解析后：
- 原始 agent 引用被保留
- 额外生成合成文本指令，引导 LLM 在后续对话循环中通过 tool-call 机制调用 `task` 工具来委派给 `code` 子智能体

**本质**: agent 部分不是直接调用另一个智能体，而是**生成一段合成文本指令**，让当前 LLM 在后续对话循环中通过 tool-call 机制调用 `task` 工具来委派给子智能体。

#### Subtask 部分（子任务）

**数据结构**（`MessageV2.SubtaskPart`，位于 `message-v2.ts:193`）:

```typescript
{
  type: "subtask",
  prompt: string,        // 子任务的具体指令，如 "修复 src/utils.ts 中的类型错误"
  description: string,   // 子任务描述，如 "修复类型错误"
  agent: string,         // 执行该子任务的智能体名称，如 "code"
  model?: {              // 可选的模型指定
    providerID: string,
    modelID: string,
  },
  command?: string,      // 可选的命令
}
```

**`resolvePart` 处理逻辑**: subtask 部分在 `resolvePart` 中走默认分支，直接保留原始部分：

```typescript
return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
```

**主要用途**: subtask 部分主要用于**会话标题生成**（`prompt.ts:337-348`）。当检测到用户消息只包含 subtask 时，会直接用 `subtask.prompt` 拼接作为标题生成的输入，而非走完整的消息转换流程：

```typescript
const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")
const msgs = onlySubtasks
  ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
  : yield* MessageV2.toModelMessagesEffect(context, mdl)
```

**举例**: 当主智能体通过 `task` 工具创建子任务时，子任务消息包含：
- `prompt`: "修复 src/utils.ts 中的类型错误"
- `description`: "修复类型错误"
- `agent`: "code"
- `model`: 可选，如 `{ providerID: "anthropic", modelID: "claude-sonnet-4" }`

**本质**: subtask 是结构化的任务描述信息，由主智能体创建，携带任务指令、描述、执行智能体等元数据，供后续处理（如标题生成、任务分发）使用。

---

### 3. 对话循环入口：loop()

**位置**: `opencode/packages/opencode/src/session/prompt.ts:1603`

**功能**: 启动对话循环的管理函数

**执行步骤**:

```typescript
const loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts> = 
  Effect.fn("SessionPrompt.loop")(function* (input) {
    return yield* state.ensureRunning(
      input.sessionID,
      lastAssistant(input.sessionID),  // fallback: 返回最后的助手消息
      runLoop(input.sessionID)         // 实际的工作函数
    )
  })
```

**state.ensureRunning() 详解**:

`ensureRunning` 是基于**有限状态机**的单次调度机制，**不是轮询/定时器**。它通过 `Runner`（位于 `effect/runner.ts`）实现，内部用 `SynchronizedRef` 管理四种状态：

| 状态 | 含义 |
|------|------|
| `Idle` | 空闲，无任务运行 |
| `Running` | 有 `runLoop` 正在执行 |
| `Shell` | 有 Shell 任务在执行 |
| `ShellThenRun` | Shell 在执行，但已有 `runLoop` 在排队等待 |

**状态转换与行为**（`runner.ts:115-138`）:

```typescript
const ensureRunning = (work: Effect.Effect<A, E>) =>
  SynchronizedRef.modifyEffect(ref, Effect.fnUntraced(function* (st) {
    switch (st._tag) {
      case "Running":
      case "ShellThenRun":
        // 已有 runLoop 在跑 → 不重复启动，异步等待当前 runLoop 完成
        return [awaitDone(st.run.done), st] as const
      case "Shell": {
        // Shell 在执行 → 将 runLoop 排队，等 Shell 结束后自动启动
        const run = { id: next(), done: yield* Deferred.make(), work } satisfies PendingHandle
        return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
      }
      case "Idle": {
        // 空闲 → 立即启动 runLoop
        const done = yield* Deferred.make<A, E | Cancelled>()
        const run = yield* startRun(work, done)
        return [awaitDone(done), { _tag: "Running", run }] as const
      }
    }
  })).pipe(Effect.flatten)
```

**各状态下的行为详解**:

1. **`Idle`（空闲）**: 立即通过 `startRun` 将 `runLoop` 作为一个 fiber fork 出去执行，状态转为 `Running`，通过 `Deferred.await(done)` 等待结果

2. **`Running`（已有任务在跑）**: **不会执行新的 `runLoop`**，传入的 `work` 被完全忽略。只做一件事：`awaitDone(st.run.done)`，即 `Deferred.await` 异步挂起当前 fiber，等待正在运行的 `runLoop` 完成后恢复，并返回其结果。这是 Effect 语义下的异步挂起（不阻塞线程），基于 `Deferred` 的一次性通知机制

3. **`Shell`（Shell 在执行）**: 将 `runLoop` 排队为 `PendingHandle`，状态转为 `ShellThenRun`，等 Shell 完成后自动启动 `runLoop`

4. **`ShellThenRun`**: 同 `Running`，等待已排队的 `runLoop` 完成

**为什么 `Running` 状态下不需要启动新的 `runLoop`？**

因为 `runLoop` 内部是 `while(true)` 循环，每次迭代都会重新读取消息历史。如果用户快速连续发送两条消息：
- 第一条消息触发 `ensureRunning`，状态 `Idle` → 启动 `runLoop` → `Running`
- 第二条消息触发 `ensureRunning`，状态 `Running` → 不启动新 `runLoop`，等待当前的完成
- 当前正在跑的 `runLoop` 在下一次循环迭代时会读取到第二条用户消息，自然就会处理它

**`ensureRunning` 的语义**: "确保有一个 `runLoop` 在跑"，而不是"启动一个新的 `runLoop`"。

**取消处理**: 如果当前 `runLoop` 被取消（`Cancelled`），`awaitDone` 会走 `onInterrupt` 分支，即返回 `lastAssistant(sessionID)` 作为 fallback 结果。

**完整流程图**:

```
prompt() → loop() → ensureRunning(sessionID, fallback, runLoop(sessionID))
                                    ↓
                            Runner 状态机判断
                                    ↓
                       Idle → fork runLoop fiber → Running
                                    ↓
                          runLoop 内部 while(true)
                            ├─ 调用 LLM
                            ├─ 处理工具调用
                            ├─ finish=stop → break 退出
                            └─ finish=tool-calls → continue 循环
                                    ↓
                          运行结束 → finishRun() → Deferred.done() → Idle
```

---

### 4. 核心运行循环：runLoop()

**位置**: `opencode/packages/opencode/src/session/prompt.ts:1312`

**功能**: 核心对话循环，持续调用 LLM 直到完成

**循环结构**:

```typescript
const runLoop: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts> = 
  Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID) {
    let step = 0
    const session = yield* sessions.get(sessionID)

    while (true) {
      // 步骤 1: 设置状态
      yield* status.set(sessionID, { type: "busy" })
      step++

      // 步骤 2: 获取消息历史
      let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

      // 步骤 3: 分析消息历史
      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      // ... 向后遍历查找

      // 步骤 4: 检查退出条件
      if (lastAssistant?.finish && 
          !["tool-calls"].includes(lastAssistant.finish) &&
          !hasToolCalls &&
          lastUser.id < lastAssistant.id) {
        break
      }

      // 步骤 5: 获取模型配置
      const model = yield* getModel(
        lastUser.model.providerID,
        lastUser.model.modelID,
        sessionID
      )

      // 步骤 6: 获取智能体配置
      const agent = yield* agents.get(lastUser.agent)

      // 步骤 7: 解析工具
      const tools = yield* resolveTools({
        agent,
        model,
        session,
        processor: handle,
        bypassAgentCheck: false,
        messages: msgs
      })

      // 步骤 8: 准备系统提示词
      const [skills, env, instructions, modelMsgs] = yield* Effect.all([
        sys.skills(agent),
        Effect.sync(() => sys.environment(model)),
        instruction.system().pipe(Effect.orDie),
        MessageV2.toModelMessagesEffect(msgs, model),
      ])
      const system = [...env, ...(skills ? [skills] : []), ...instructions]

      // 步骤 9: 处理结构化输出
      const format = lastUser.format ?? { type: "text" as const }
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      // 步骤 10: 调用处理器
      const result = yield* handle.process({
        user: lastUser,
        agent,
        permission: session.permission,
        sessionID,
        parentSessionID: session.parentID,
        system,
        messages: modelMsgs,
        tools,
        model,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })

      // 步骤 11: 根据结果决策
      if (result === "stop") {
        break
      }
      if (result === "compact") {
        yield* compaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
          overflow: !handle.message.finish,
        })
      }
      // result === "continue" -> 继续循环
    }

    // 返回最终的助手消息
    const final = yield* lastAssistant(sessionID)
    return final
  })
```

**循环退出条件**:

| 条件 | 说明 |
|------|------|
| `finish === "stop"` | 正常完成 |
| `finish === "length"` | 达到最大长度 |
| `!hasToolCalls && finish !== "tool-calls"` | 无待处理工具调用 |
| `result === "stop"` | 处理器返回停止 |

**循环继续条件**:

| 条件 | 说明 |
|------|------|
| `hasToolCalls` | 有工具调用待处理 |
| `finish === "tool-calls"` | 工具调用未完成 |
| `result === "continue"` | 处理器返回继续 |
| `result === "compact"` | 需要压缩上下文 |

---

### 5. 工具解析：resolveTools()

**位置**: `opencode/packages/opencode/src/session/prompt.ts:357`

**功能**: 注册和配置所有可用工具

**执行步骤**:

```typescript
1. 获取内置工具
   for (const item of yield* registry.tools({
     modelID, providerID, agent
   })) {
     // 转换 schema
     const schema = ProviderTransform.schema(model, z.toJSONSchema(item.parameters))
     
     // 注册工具
     tools[item.id] = tool({
       id: item.id,
       description: item.description,
       inputSchema: jsonSchema(schema),
       execute(args, options) {
         // 执行工具
         const result = yield* item.execute(args, context)
         return result
       }
     })
   }

2. 获取 MCP 工具
   for (const [key, item] of Object.entries(yield* mcp.tools())) {
     // 转换 schema
     const schema = yield* Effect.promise(() => 
       Promise.resolve(asSchema(item.inputSchema).jsonSchema)
     )
     const transformed = ProviderTransform.schema(model, schema)
     
     // 注册 MCP 工具
     item.inputSchema = jsonSchema(transformed)
     item.execute = (args, opts) => {
       // 执行 MCP 工具
       const result = yield* Effect.promise(() => execute(args, opts))
       // 处理结果
       return { output, attachments }
     }
   }

3. 构建工具执行上下文
   const context = (args, options) => ({
     sessionID,
     abort: options.abortSignal,
     messageID: processor.message.id,
     callID: options.toolCallId,
     agent: agent.name,
     messages,
     metadata: (val) => processor.updateToolCall(...),
     ask: (req) => permission.ask(...),
   })

4. 返回工具字典
   return tools
```

**工具执行上下文包含**:

| 属性 | 类型 | 说明 |
|------|------|------|
| sessionID | SessionID | 会话ID |
| abort | AbortSignal | 中断信号 |
| messageID | MessageID | 消息ID |
| callID | string | 工具调用ID |
| agent | string | 智能体名称 |
| messages | MessageV2.WithParts[] | 消息历史 |
| metadata | Function | 更新工具调用元数据 |
| ask | Function | 权限请求 |

---

### 6. LLM 响应处理：handle.process()

**位置**: `opencode/packages/opencode/src/session/processor.ts`

**功能**: 处理 LLM 的流式响应

**执行流程**:

```typescript
1. 创建处理器
   const handle = yield* processor.create({
     assistantMessage,
     sessionID,
     model
   })

2. 调用 LLM 流
   const result = yield* handle.process({
     user, sessionID, parentSessionID, model,
     agent, permission, system, messages, tools
   })

3. 内部实现
   handle.process = (streamInput) => {
     // 启动 LLM 流
     const stream = llm.stream(streamInput)
     
     // 处理流事件
     yield* Stream.runForEach(stream, (event) => {
       switch (event.type) {
         case "text-delta":
           // 更新文本部分
           currentText.text += event.text
           
         case "tool-call":
           // 创建工具调用
           const toolCall = {
             id: PartID.ascending(),
             type: "tool",
             tool: event.toolName,
             callID: event.toolCallId,
             state: { status: "pending", input: event.args }
           }
           
         case "tool-result":
           // 执行工具
           const result = yield* executeTool(event)
           toolCall.state = {
             status: "completed",
             output: result.output,
             attachments: result.attachments
           }
           
         case "finish":
           // 标记完成
           assistantMessage.finish = event.finishReason
           
         case "error":
           // 处理错误
           assistantMessage.error = event.error
       }
     })
     
     // 返回结果
     if (needsCompaction) return "compact"
     if (shouldStop) return "stop"
     return "continue"
   }
```

**流事件类型**:

| 事件类型 | 说明 | 处理方式 |
|---------|------|----------|
| text-delta | 文本增量 | 追加到文本部分 |
| tool-call | 工具调用 | 创建待执行的工具调用 |
| tool-result | 工具结果 | 更新工具调用状态 |
| reasoning | 推理过程 | 更新推理部分 |
| finish | 完成标记 | 设置 finish 状态 |
| error | 错误 | 记录错误信息 |

---

### 7. LLM 服务调用：llm.stream()

**位置**: `opencode/packages/opencode/src/session/llm.ts:73`

**功能**: 调用 LLM 提供商的 API

**执行步骤**:

```typescript
1. 获取提供商配置
   const [language, cfg, item, info] = yield* Effect.all([
     provider.getLanguage(input.model),
     config.get(),
     provider.getProvider(input.model.providerID),
     auth.get(input.model.providerID),
   ])

2. 构建请求参数
   const request = {
     model: input.model.api.id,
     messages: input.messages,
     system: input.system,
     tools: input.tools,
     temperature: cfg.temperature,
     maxTokens: ProviderTransform.maxOutputTokens(input.model),
     ...providerSpecificOptions
   }

3. 调用 streamText
   const result = yield* streamText({
     model: language,
     ...request,
     onTokensChange: (tokens) => {
       // 更新 token 统计
     }
   })

4. 返回流
   return result.fullStream
```

**支持的提供商**:

- OpenAI (GPT, Codex)
- Anthropic (Claude)
- Google (Gemini)
- 其他兼容提供商

---

### 8. 上下文压缩：compaction.create()

**位置**: `opencode/packages/opencode/src/session/compaction.ts:42`

**触发条件**: `result === "compact"`

**功能**: 压缩会话历史以释放上下文空间

**执行步骤**:

```typescript
1. 检查是否需要压缩
   const isOverflow = yield* compaction.isOverflow({
     tokens: assistantMessage.tokens,
     model
   })

2. 创建压缩消息
   yield* compaction.create({
     sessionID,
     agent,
     model,
     auto: true,
     overflow: true
   })

3. 压缩实现
   - 标记旧消息为已压缩
   - 生成摘要（可选）
   - 修剪工具调用输出
   - 保留关键信息

4. 继续循环
```

**压缩策略**:

| 策略 | 触发条件 | 操作 |
|------|----------|------|
| 自动压缩 | token 超过阈值 | 压缩旧消息 |
| 溢出压缩 | 上下文溢出 | 立即压缩 |
| 修剪工具输出 | 工具输出过长 | 删除旧输出 |

---

## 数据流向

### 消息流转

```
用户输入
    ↓
PromptInput {
  sessionID,
  parts: [
    { type: "text", text: "..." },
    { type: "file", url: "..." }
  ],
  agent,
  model
}
    ↓
MessageV2.User {
  id,
  sessionID,
  role: "user",
  agent,
  model,
  time: { created }
}
    ↓
MessageV2.Part[] {
  { type: "text", text: "..." },
  { type: "file", url: "data:..." }
}
    ↓
数据库保存
    ↓
ModelMessage[] {
  { role: "user", content: [...] },
  { role: "assistant", content: [...] }
}
    ↓
LLM API 请求
    ↓
Stream<Event>
    ↓
MessageV2.Assistant {
  id,
  sessionID,
  role: "assistant",
  agent,
  modelID,
  providerID,
  finish: "stop" | "tool-calls" | "length",
  tokens: { input, output, reasoning, cache },
  cost
}
    ↓
MessageV2.Part[] {
  { type: "text", text: "AI response" },
  { type: "tool", tool: "bash", state: {...} }
}
    ↓
数据库保存
    ↓
返回给用户
```

### Token 统计流程

```
LLM Response
    ↓
Token 统计 {
  input: number,
  output: number,
  reasoning: number,
  cache: {
    read: number,
    write: number
  }
}
    ↓
计算成本
    ↓
更新会话统计
    ↓
检查上下文溢出
    ↓
触发压缩（如果需要）
```

---

## 关键决策点

### 决策点 1: noReply 检查

**位置**: `prompt()` 函数

**条件**: `input.noReply === true`

**结果**: 
- ✅ true → 直接返回用户消息，不进入循环
- ❌ false → 进入对话循环

---

### 决策点 2: 循环退出检查

**位置**: `runLoop()` 函数

**条件**: 
```typescript
lastAssistant?.finish &&
!["tool-calls"].includes(lastAssistant.finish) &&
!hasToolCalls &&
lastUser.id < lastAssistant.id
```

**结果**:
- ✅ 满足 → break 退出循环
- ❌ 不满足 → 继续循环

---

### 决策点 3: 处理结果判断

**位置**: `runLoop()` 函数

**条件**: `result` 值

**结果**:
- `"stop"` → break 退出循环
- `"compact"` → 触发压缩，然后 continue
- `"continue"` → continue 继续循环

---

### 决策点 4: 结构化输出

**位置**: `runLoop()` 函数

**条件**: `format.type === "json_schema"`

**结果**:
- ✅ true → 添加结构化输出提示词，设置 toolChoice="required"
- ❌ false → 使用普通文本输出

---

### 决策点 5: 上下文溢出

**位置**: `processor.ts`

**条件**: `isOverflow(tokens, model)`

**结果**:
- ✅ true → 返回 "compact"
- ❌ false → 继续处理

---

## 函数参数与返回值

### PromptInput

```typescript
interface PromptInput {
  sessionID: SessionID
  parts: Array<
    | { type: "text"; text: string }
    | { type: "file"; url: string; filename?: string; mime: string }
    | { type: "agent"; name: string }
  >
  agent?: string
  model?: { providerID: ProviderID; modelID: ModelID; variant?: string }
  tools?: Record<string, boolean>
  system?: string[]
  format?: OutputFormat
  messageID?: MessageID
  noReply?: boolean
}
```

### MessageV2.WithParts

```typescript
interface WithParts {
  info: User | Assistant
  parts: Part[]
}

interface User {
  id: MessageID
  sessionID: SessionID
  role: "user"
  agent: string
  model: { providerID: ProviderID; modelID: ModelID; variant?: string }
  time: { created: number }
  tools?: Record<string, boolean>
  system?: string[]
  format?: OutputFormat
}

interface Assistant {
  id: MessageID
  sessionID: SessionID
  parentID?: MessageID
  role: "assistant"
  agent: string
  modelID: ModelID
  providerID: ProviderID
  finish?: "stop" | "tool-calls" | "length" | "unknown"
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost: number
  time: { created: number; completed?: number }
  path?: { cwd: string; root: string }
  error?: unknown
}

type Part =
  | TextPart
  | ToolPart
  | FilePart
  | ReasoningPart
  | PatchPart
  | SnapshotPart
```

### SessionProcessor.Result

```typescript
type Result = "compact" | "stop" | "continue"
```

---

## 总结

OpenCode 的函数调用流程采用了清晰的分层架构：

1. **入口层**: `prompt()` 函数负责接收用户输入并初始化会话
2. **消息层**: `createUserMessage()` 解析和创建消息对象
3. **循环层**: `runLoop()` 管理整个对话循环
4. **工具层**: `resolveTools()` 注册和配置工具
5. **处理层**: `processor` 处理 LLM 响应流
6. **服务层**: `llm.stream()` 调用 AI 提供商 API

每个层次职责明确，通过 Effect 框架管理副作用和依赖注入，实现了高度可测试和可维护的代码结构。