# SessionProcessor.process 逻辑分析

> 源文件：`packages/opencode/src/session/processor.ts` (710-789 行)

这段代码定义了 `SessionProcessor` 的核心 `process` 方法及 `Handle` 对象的创建，是 LLM 流式处理的主循环。下面逐段拆解：

---

## 第一段：`process` 函数入口与上下文初始化 (710-713)

```ts
const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
  slog.info("process")
  ctx.needsCompaction = false
  ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
})
```

- 接收 `LLM.StreamInput` 参数，即 LLM 调用所需的流式输入
- 重置 `ctx.needsCompaction = false`，确保每次处理开始时没有残留的压缩标记
- 读取配置项 `experimental.continue_loop_on_deny`，决定当工具调用被拒绝时是否继续循环。默认情况下 `shouldBreak = true`（遇到拒绝就中断）

### 示例：上下文初始化的具体场景

`LLM.StreamInput` 的完整结构如下（定义于 [`llm.ts`](opencode/packages/opencode/src/session/llm.ts:36)）：

```ts
type StreamInput = {
  user: MessageV2.User          // 当前用户消息
  sessionID: string             // 会话 ID
  parentSessionID?: string      // 父会话 ID（子代理场景）
  model: Provider.Model         // 使用的模型（含 providerID、modelID）
  agent: Agent.Info             // 代理信息（含工具列表、权限规则等）
  permission?: Permission.Ruleset // 权限规则集
  system: string[]              // 系统提示词数组
  messages: ModelMessage[]      // 历史消息列表
  small?: boolean               // 是否使用小模型
  tools: Record<string, Tool>   // 可用工具映射
  retries?: number              // 重试次数
  toolChoice?: "auto" | "required" | "none" // 工具选择策略
}
```

**场景 1：首次调用（正常初始化）**

```ts
// 假设用户发送了一条消息，外层循环构造了 streamInput：
const streamInput = {
  user: { id: "msg-001", role: "user", content: "帮我读取 src/index.ts 的内容" },
  sessionID: "session-abc",
  model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
  agent: { name: "code", tools: { readFile: ..., writeFile: ... } },
  system: ["You are a coding assistant..."],
  messages: [...历史消息],
  tools: { readFile: ..., writeFile: ..., grep: ... },
  toolChoice: "auto",
}

// process 入口执行：
// 1. slog.info("process") → 日志输出 [session.id=session-abc][messageID=msg-002] process
// 2. ctx.needsCompaction = false → 清除上轮可能残留的压缩标记
// 3. ctx.shouldBreak = true → 默认配置下，工具被拒绝时将中断循环
```

**场景 2：配置了 `continue_loop_on_deny`（权限拒绝后继续）**

```ts
// 配置文件中设置了 experimental.continue_loop_on_deny = true
// 此时 ctx.shouldBreak = false
// 效果：当用户拒绝某个工具的权限请求时，不会设置 ctx.blocked = true
//       而是继续处理后续的工具调用和文本生成

// 对比 ctx.shouldBreak 的作用（在 failToolCall 中，第 217-219 行）：
// if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
//   ctx.blocked = ctx.shouldBreak  // shouldBreak=true → blocked=true → 最终返回 "stop"
//                                   // shouldBreak=false → blocked=false → 最终返回 "continue"
// }
```

**场景 3：上下文压缩后的重试调用**

```ts
// 上一轮 process 返回了 "compact"，外层循环压缩了对话历史后再次调用 process
// 此时 ctx.needsCompaction 可能仍为 true（上一轮设置的），需要在入口重置
// ctx.needsCompaction = false → 确保本轮不会因为残留标记而提前终止流
```

---

## 第二段：流式处理核心 (715-725)

```ts
return yield* Effect.gen(function* () {
  yield* Effect.gen(function* () {
    ctx.currentText = undefined
    ctx.reasoningMap = {}
    const stream = llm.stream(streamInput)

    yield* stream.pipe(
      Stream.tap((event) => handleEvent(event)),
      Stream.takeUntil(() => ctx.needsCompaction),
      Stream.runDrain,
    )
  })
})
```

- **初始化状态**：清空 `currentText`（当前文本片段）和 `reasoningMap`（推理内容映射），确保干净的起始状态
- **创建流**：调用 `llm.stream()` 创建 LLM 事件流
- **流消费管线**：
  - `Stream.tap(handleEvent)` — 对每个流事件执行 `handleEvent`（分发处理 start/reasoning/tool/text/finish 等事件，更新消息部件、触发工具调用等）
  - `Stream.takeUntil(() => ctx.needsCompaction)` — 当检测到需要上下文压缩时提前终止流（由 `handleEvent` 中检测 `ContextOverflowError` 设置）
  - `Stream.runDrain` — 消费完整个流

### 示例：流式事件处理的具体场景

`LLM.Event` 是由 Vercel AI SDK `streamText` 返回的 `fullStream` 的元素类型（定义于 [`llm.ts`](opencode/packages/opencode/src/session/llm.ts:55)），包含以下事件类型：

```ts
type Event =
  | { type: "start" }
  | { type: "reasoning-start"; id: string; providerMetadata?: ... }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: ... }
  | { type: "reasoning-end"; id: string; providerMetadata?: ... }
  | { type: "tool-input-start"; id: string; toolName: string; providerExecuted?: boolean }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: any; providerMetadata?: ... }
  | { type: "tool-result"; toolCallId: string; output: { output: string; metadata: ...; attachments?: ... } }
  | { type: "tool-error"; toolCallId: string; error: unknown }
  | { type: "error"; error: unknown }
  | { type: "start-step" }
  | { type: "finish-step"; finishReason: string; usage: ...; providerMetadata?: ... }
  | { type: "text-start"; providerMetadata?: ... }
  | { type: "text-delta"; text: string; providerMetadata?: ... }
  | { type: "text-end"; providerMetadata?: ... }
  | { type: "finish" }
```

**场景 1：LLM 返回纯文本回复的完整事件流**

```ts
// 用户问："什么是 TypeScript？"
// LLM 不需要调用工具，直接返回文本。事件流顺序如下：

const events = [
  { type: "start" },                          // handleEvent → status.set("busy")
  { type: "start-step" },                     // handleEvent → 创建快照、发布 Step.Started 事件、写入 step-start 部件
  { type: "text-start", providerMetadata: {} },// handleEvent → 创建 currentText 部件 { type: "text", text: "" }
  { type: "text-delta", text: "TypeScript" },  // handleEvent → currentText.text += "TypeScript", 发送 delta 更新
  { type: "text-delta", text: " is a" },       // handleEvent → currentText.text += " is a"
  { type: "text-delta", text: " typed..." },   // handleEvent → currentText.text += " typed..."
  { type: "text-end" },                        // handleEvent → 触发 plugin "experimental.text.complete"、发布 Text.Ended、更新部件
  { type: "finish-step", finishReason: "stop", usage: {...} }, // handleEvent → 计算 token/cost、写入 step-finish 部件、检查是否溢出
  { type: "finish" },                          // handleEvent → 直接 return
]

// 此时 ctx 状态：
// ctx.currentText = undefined（text-end 已清空）
// ctx.reasoningMap = {}（无推理内容）
// ctx.toolcalls = {}（无工具调用）
// ctx.needsCompaction = false（token 未溢出）
```

**场景 2：LLM 先推理再调用工具的事件流**

```ts
// 用户问："读取 package.json 文件并告诉我项目名称"
// LLM 先推理（extended thinking），然后调用 readFile 工具

const events = [
  { type: "start" },
  { type: "start-step" },
  // 推理阶段
  { type: "reasoning-start", id: "reasoning-1" },    // handleEvent → 创建 reasoningMap["reasoning-1"] = { type: "reasoning", text: "" }
  { type: "reasoning-delta", id: "reasoning-1", text: "用户想要..." }, // reasoningMap["reasoning-1"].text += "用户想要..."
  { type: "reasoning-delta", id: "reasoning-1", text: "读取 package.json" },
  { type: "reasoning-end", id: "reasoning-1" },      // handleEvent → 更新部件、从 reasoningMap 中删除
  // 工具调用阶段
  { type: "tool-input-start", id: "call-abc", toolName: "readFile" },  // handleEvent → 创建 ToolPart { status: "pending" }、注册到 ctx.toolcalls
  { type: "tool-input-delta", id: "call-abc", delta: '{"path' },       // handleEvent → 发送 Tool.Input.Delta 事件
  { type: "tool-input-delta", id: "call-abc", delta: '":"package.json"}' },
  { type: "tool-input-end", id: "call-abc" },                          // handleEvent → 发送 Tool.Input.Ended 事件
  { type: "tool-call", toolCallId: "call-abc", toolName: "readFile", input: { path: "package.json" } },
  // handleEvent → 发布 Tool.Called 事件、更新部件状态为 { status: "running", input: {path: "package.json"} }
  // → 检查 doom loop（最近3次是否同名同参调用）
  // 工具执行完成后：
  { type: "tool-result", toolCallId: "call-abc", output: { output: '{"name": "opencode", ...}', metadata: {} } },
  // handleEvent → 发布 Tool.Success 事件、completeToolCall 更新部件为 { status: "completed" }
  { type: "finish-step", finishReason: "tool-calls", usage: {...} },
  { type: "finish" },
]
```

**场景 3：上下文溢出导致流提前终止**

```ts
// 对话历史过长，LLM 返回 ContextOverflowError

const events = [
  { type: "start" },
  { type: "start-step" },
  { type: "error", error: ContextOverflowError },  // handleEvent → throw error
  // 错误被外层 catchCauseIf 捕获 → halt() 中检测到 ContextOverflowError
  // → ctx.needsCompaction = true
  // → bus.publish(Session.Event.Error, ...)
  // → Stream.takeUntil(() => ctx.needsCompaction) 检测到 true，提前终止流
]

// 或者：finish-step 中检测到 token 溢出（processor.ts 第 540-545 行）：
// if (isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })) {
//   ctx.needsCompaction = true
// }
// 此后 takeUntil 条件满足，流提前终止
```

---

## 第三段：中断处理 (727-734)

```ts
.pipe(
  Effect.onInterrupt(() =>
    Effect.gen(function* () {
      aborted = true
      if (!ctx.assistantMessage.error) {
        yield* halt(new DOMException("Aborted", "AbortError"))
      }
    }),
  ),
)
```

- 当流被外部中断（如用户取消）时触发
- 设置 `aborted = true` 标记
- 如果助手消息还没有错误状态，则调用 `halt()` 进行错误处理（记录错误、发布事件、设置 idle 状态）
- 避免在中断时已经有错误的情况下重复调用 `halt`

### 示例：中断处理的具体场景

**场景 1：用户主动取消请求**

```ts
// 用户在 LLM 正在生成回复时点击了"停止"按钮
// Effect-TS 的中断机制触发 onInterrupt 回调

// 执行流程：
// 1. aborted = true
//    → 标记当前处理已被中断，影响后续 parse() 对错误的分类
//    → parse() 中传入 aborted 变量（第 136-140 行）：
//      const parse = (e: unknown) => MessageV2.fromError(e, {
//        providerID: input.model.providerID,
//        aborted,  // aborted=true 时，错误会被识别为 AbortError 而非 APIError
//      })

// 2. 检查 ctx.assistantMessage.error 是否已存在
//    → 如果为 undefined（消息还没有错误），调用 halt()
//    → halt() 内部（第 684-708 行）：
//      - slog.error("process", { error: "Aborted", stack: ... })
//      - error = parse(new DOMException("Aborted", "AbortError"))
//      - 不是 ContextOverflowError，所以走正常错误路径
//      - 发布 SessionEvent.Step.Failed.Sync 事件
//      - ctx.assistantMessage.error = error
//      - bus.publish(Session.Event.Error, { sessionID, error })
//      - status.set(sessionID, { type: "idle" })
```

**场景 2：中断时已有错误（避免重复 halt）**

```ts
// LLM 返回了一个错误（如 500），halt() 已经被调用过
// 此时 ctx.assistantMessage.error 已经被设置
// 然后流被中断（中断可能在错误传播过程中发生）

// 执行流程：
// 1. aborted = true
// 2. ctx.assistantMessage.error 已存在（非 undefined）
//    → 跳过 halt() 调用，避免重复设置错误和发布事件
//    → 这防止了：
//      - 错误被覆盖（之前的 APIError 被 AbortError 覆盖）
//      - 重复发布 Session.Event.Error 事件
//      - 重复设置 status 为 idle
```

**场景 3：`aborted` 标记对错误解析的影响**

```ts
// aborted 标记影响 MessageV2.fromError() 的行为：
// - aborted = false 时：网络错误可能被解析为 APIError（可重试）
// - aborted = true 时：同样的错误被解析为 AbortError（不可重试）

// 这确保了：
// 1. 用户主动取消后，不会触发重试逻辑（因为 aborted=true → AbortError → retryable() 返回 undefined）
// 2. cleanup() 中未完成的工具调用会被标记为 "Tool execution aborted"（第 673 行）
```

---

## 第四段：非中断错误捕获与重试 (735-766)

```ts
Effect.catchCauseIf(
  (cause) => !Cause.hasInterruptsOnly(cause),
  (cause) => Effect.fail(Cause.squash(cause)),
),
Effect.retry(
  SessionRetry.policy({
    provider: input.model.providerID,
    parse,
    set: (info) => {
      const event = sync.run(SessionEvent.Retried.Sync, {
        sessionID: ctx.sessionID,
        attempt: info.attempt,
        error: { message: info.message, isRetryable: true },
        timestamp: DateTime.makeUnsafe(Date.now()),
      })
      return event.pipe(
        Effect.andThen(
          status.set(ctx.sessionID, {
            type: "retry",
            attempt: info.attempt,
            message: info.message,
            action: info.action,
            next: info.next,
          }),
        ),
      )
    },
  }),
),
```

- **`catchCauseIf`**：仅捕获**非纯中断**类型的错误（纯中断由 `onInterrupt` 处理）。将 Cause 转换为普通失败以便重试机制处理
- **`Effect.retry`**：使用 `SessionRetry.policy` 定义重试策略，该策略：
  - 根据 `provider` 和错误类型判断是否可重试（如速率限制、免费额度超限等）
  - 从响应头中提取退避延迟（`retry-after-ms`、`retry-after`）
  - `set` 回调在每次重试前执行：
    - 通过 `sync.run` 发布 `SessionEvent.Retried.Sync` 事件，记录重试信息
    - 更新会话状态为 `"retry"`，包含尝试次数、错误消息、下一步时间等，供 UI 展示重试进度

### 示例：错误捕获与重试的具体场景

**场景 1：速率限制触发重试（429 Too Many Requests）**

```ts
// LLM 返回 429 状态码，响应头包含 retry-after-ms

// 错误对象（APIError）：
const apiError = {
  _tag: "APIError",
  data: {
    statusCode: 429,
    isRetryable: true,
    message: "Rate limit exceeded",
    responseHeaders: {
      "retry-after-ms": "5000"  // 5 秒后重试
    },
    responseBody: '{"error": "too_many_requests"}'
  }
}

// 重试策略执行流程（retry.ts 第 175-198 行）：
// 1. SessionRetry.policy 的 Schedule 检查错误是否可重试
//    → retryable(apiError, "anthropic") 返回 { message: "Rate limit exceeded" }
//    → 不是 ContextOverflowError，所以不会被排除

// 2. 计算等待时间
//    → delay(attempt=1, apiError) 检查响应头
//    → 发现 retry-after-ms = "5000"，返回 5000ms
//    → 如果没有响应头，使用指数退避：RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR^(attempt-1)
//       attempt=1 → 2000ms, attempt=2 → 4000ms, attempt=3 → 8000ms, ...

// 3. set 回调被调用：
//    → sync.run(SessionEvent.Retried.Sync, {
//        sessionID: "session-abc",
//        attempt: 1,
//        error: { message: "Rate limit exceeded", isRetryable: true },
//        timestamp: ...
//      })
//    → status.set("session-abc", {
//        type: "retry",
//        attempt: 1,
//        message: "Rate limit exceeded",
//        action: undefined,  // 普通速率限制没有 action
//        next: Date.now() + 5000,  // 5 秒后重试
//      })
//    → UI 显示 "Retrying in 5s... (attempt 1)"
```

**场景 2：免费额度超限触发升级提示**

```ts
// 免费用户的 token 用量超限

const apiError = {
  _tag: "APIError",
  data: {
    statusCode: 403,
    isRetryable: true,
    message: "Free usage limit exceeded",
    responseHeaders: {},
    responseBody: '{"error": "FreeUsageLimitError"}'
  }
}

// retryable() 返回（retry.ts 第 75-87 行）：
// {
//   message: "Free usage exceeded, subscribe to Go",
//   action: {
//     reason: "free_tier_limit",
//     provider: "anthropic",
//     title: "Free limit reached",
//     message: "Subscribe to OpenCode Go for reliable access...",
//     label: "subscribe",
//     link: "https://opencode.ai/go"
//   }
// }

// set 回调中 status.set 包含 action 信息：
// → UI 显示 "Free limit reached" + "Subscribe" 按钮（链接到 Go 页面）
```

**场景 3：5xx 服务器错误自动重试**

```ts
// 提供商服务器暂时不可用

const apiError = {
  _tag: "APIError",
  data: {
    statusCode: 503,
    isRetryable: false,  // SDK 未标记为可重试
    message: "Service Unavailable",
    responseHeaders: {},
    responseBody: '{"code": "service_unavailable"}'
  }
}

// retryable() 逻辑（retry.ts 第 74 行）：
// if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
// → isRetryable=false 但 statusCode=503 >= 500
// → 仍然返回 { message: "Service Unavailable" }，允许重试

// 这确保了即使 SDK 未标记为可重试，5xx 错误仍会被重试
// 因为 5xx 是瞬时性服务器故障，通常可以自行恢复
```

**场景 4：不可重试的错误直接失败**

```ts
// 非重试性错误（如 400 Bad Request、401 Unauthorized）

const apiError = {
  _tag: "APIError",
  data: {
    statusCode: 400,
    isRetryable: false,
    message: "Invalid request",
    responseHeaders: {},
    responseBody: "Bad request"
  }
}

// retryable() 返回 undefined → Schedule.done() 终止重试
// 错误传播到 Effect.catch(halt)，由 halt() 处理最终错误
// ctx.assistantMessage.error = parse(apiError)
// → 返回 "stop"
```

**场景 5：ContextOverflowError 被排除重试**

```ts
// 上下文溢出错误不应重试（重试同样的请求只会再次溢出）

const overflowError = { _tag: "ContextOverflowError", ... }

// retryable() 第 69 行：
// if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
// → 返回 undefined，Schedule.done() 终止重试

// 但 ContextOverflowError 在 halt() 中有特殊处理（第 687-690 行）：
// ctx.needsCompaction = true
// → 最终返回 "compact"，外层循环压缩对话历史后重新调用 process
```

---

## 第五段：最终错误兜底与清理 (767-768)

```ts
Effect.catch(halt),
Effect.ensuring(cleanup()),
```

- **`Effect.catch(halt)`**：重试耗尽后的最终错误兜底，调用 `halt()` 处理：
  - 如果是 `ContextOverflowError`，设置 `needsCompaction = true` 并发布错误事件
  - 否则设置助手消息的错误字段，发布 `Session.Event.Error`，将状态设为 idle
- **`Effect.ensuring(cleanup())`**：无论成功、失败还是中断，都执行 `cleanup()`：
  - 生成快照补丁（如有文件变更）
  - 保存未完成的文本/推理片段
  - 等待所有工具调用完成（最多 250ms 超时）
  - 将未完成的工具调用标记为 `error` 状态
  - 设置消息完成时间并更新

### 示例：错误兜底与清理的具体场景

**场景 1：重试耗尽后 halt() 处理最终错误**

```ts
// 速率限制重试 3 次后仍然失败，Schedule 终止重试
// 错误传播到 Effect.catch(halt)

// halt() 执行流程（第 684-708 行）：
// 1. slog.error("process", { error: "Rate limit exceeded", stack: ... })
// 2. error = parse(apiError)
// 3. 不是 ContextOverflowError → 走正常错误路径
// 4. 发布 SessionEvent.Step.Failed.Sync 事件：
//    sync.run(SessionEvent.Step.Failed.Sync, {
//      sessionID: "session-abc",
//      error: { type: "unknown", message: "Rate limit exceeded" },
//      timestamp: ...
//    })
// 5. ctx.assistantMessage.error = error
// 6. bus.publish(Session.Event.Error, { sessionID: "session-abc", error })
// 7. status.set("session-abc", { type: "idle" })
// → 最终返回 "stop"（因为 ctx.assistantMessage.error 存在）
```

**场景 2：cleanup() 保存未完成的文本片段**

```ts
// LLM 在生成文本过程中被中断，currentText 还未保存

// 假设中断时的状态：
// ctx.currentText = {
//   id: "part-003",
//   messageID: "msg-002",
//   sessionID: "session-abc",
//   type: "text",
//   text: "To fix this bug, you need to",  // 未完成的文本
//   time: { start: 1700000000000 },
// }

// cleanup() 执行流程（第 640-645 行）：
// 1. 检测到 ctx.currentText 存在
// 2. const end = Date.now()  // 记录结束时间
// 3. ctx.currentText.time = { start: 1700000000000, end: 1700000005000 }
// 4. yield* session.updatePart(ctx.currentText)  // 保存到数据库
// 5. ctx.currentText = undefined  // 清空引用

// 这确保了：即使被中断，用户也能看到已生成的部分文本
```

**场景 3：cleanup() 保存未完成的推理片段**

```ts
// LLM 在推理（extended thinking）过程中被中断

// 假设中断时的状态：
// ctx.reasoningMap = {
//   "reasoning-1": {
//     id: "part-005",
//     type: "reasoning",
//     text: "Let me analyze the code structure...",  // 未完成的推理
//     time: { start: 1700000000000 },
//   }
// }

// cleanup() 执行流程（第 647-654 行）：
// 1. 遍历 reasoningMap 中所有未完成的推理片段
// 2. 为每个片段设置结束时间
// 3. yield* session.updatePart({ ...part, time: { start: ..., end: ... } })
// 4. ctx.reasoningMap = {}  // 清空映射
```

**场景 4：cleanup() 处理未完成的工具调用**

```ts
// 工具正在执行时被中断

// 假设中断时的状态：
// ctx.toolcalls = {
//   "call-abc": {
//     done: Deferred<void>,  // 工具尚未完成
//     partID: "part-010",
//     messageID: "msg-002",
//     sessionID: "session-abc",
//   }
// }

// cleanup() 执行流程（第 656-679 行）：
// 第一步：等待工具完成（最多 250ms）
// yield* Effect.forEach(
//   Object.values(ctx.toolcalls),
//   (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
//   { concurrency: "unbounded" }
// )
// → 如果工具在 250ms 内完成，正常继续
// → 如果超时，Effect.ignore 忽略超时错误，继续执行

// 第二步：标记未完成的工具调用为 error
// for (const toolCallID of Object.keys(ctx.toolcalls)) {
//   const match = yield* readToolCall(toolCallID)
//   if (!match) continue
//   yield* session.updatePart({
//     ...part,
//     state: {
//       ...part.state,
//       status: "error",
//       error: "Tool execution aborted",
//       metadata: { ...metadata, interrupted: true },
//       time: { start: part.state.time.start, end: Date.now() },
//     }
//   })
// }
// → UI 显示工具调用状态为 "error: Tool execution aborted"
```

**场景 5：cleanup() 生成快照补丁**

```ts
// 工具执行过程中修改了文件，需要记录变更

// 假设 ctx.snapshot 存在（在 start-step 时创建的快照哈希）
// cleanup() 执行流程（第 625-638 行）：
// 1. const patch = yield* snapshot.patch(ctx.snapshot)
//    → 对比当前文件系统与快照，生成差异补丁
//    → patch = { hash: "abc123", files: [
//        { path: "src/index.ts", content: "修改后的内容" },
//        { path: "src/utils.ts", content: "新增文件内容" },
//      ]}
// 2. if (patch.files.length) → 有文件变更
// 3. yield* session.updatePart({
//      id: PartID.ascending(),
//      type: "patch",
//      hash: "abc123",
//      files: [...变更文件列表],
//    })
//    → 将补丁信息保存为消息部件，供 UI 显示文件变更
// 4. ctx.snapshot = undefined  // 清空快照引用
```

---

## 第六段：返回结果判定 (771-774)

```ts
if (ctx.needsCompaction) return "compact"
if (ctx.blocked || ctx.assistantMessage.error) return "stop"
return "continue"
```

根据处理结果返回三种状态之一（`Result` 类型）：

| 返回值 | 含义 |
|--------|------|
| `"compact"` | 上下文溢出，需要压缩对话历史后重试 |
| `"stop"` | 被阻塞（如权限拒绝且 `shouldBreak=true`）或出现错误，停止循环 |
| `"continue"` | 正常完成，可以继续下一轮（由外层循环决定是否还有工具调用需要处理） |

### 示例：返回结果判定的具体场景

**场景 1：返回 `"compact"` — 上下文溢出**

```ts
// 对话历史过长，token 超过了模型限制
// 触发路径有两种：

// 路径 A：finish-step 中检测到 token 溢出（processor.ts 第 540-545 行）
// const usage = Session.getUsage({ model, usage, providerMetadata })
// if (isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })) {
//   ctx.needsCompaction = true  // → takeUntil 终止流
// }

// 路径 B：LLM 返回 ContextOverflowError（processor.ts 第 687-690 行）
// halt() 中检测到 ContextOverflowError → ctx.needsCompaction = true

// 结果判定：
// ctx.needsCompaction = true → return "compact"
// 外层循环（session.ts）收到 "compact" 后：
//   1. 压缩对话历史（使用 summary 模型生成摘要）
//   2. 用压缩后的消息重新调用 process()
```

**场景 2：返回 `"stop"` — 权限被拒绝且 shouldBreak=true**

```ts
// 用户拒绝了工具的权限请求，且未配置 continue_loop_on_deny

// 触发路径（processor.ts 第 217-219 行）：
// failToolCall() 中：
//   if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
//     ctx.blocked = ctx.shouldBreak  // shouldBreak=true → blocked=true
//   }

// 结果判定：
// ctx.needsCompaction = false
// ctx.blocked = true  → return "stop"
// 外层循环收到 "stop" 后终止会话处理循环

// 对比：如果 shouldBreak=false（配置了 continue_loop_on_deny）
//   ctx.blocked = false → return "continue"
//   外层循环继续处理后续的工具调用
```

**场景 3：返回 `"stop"` — LLM 返回不可重试的错误**

```ts
// LLM 返回 400 Bad Request，不可重试

// 触发路径：
// 1. catchCauseIf 捕获错误
// 2. retryable() 返回 undefined → 不重试
// 3. Effect.catch(halt) → halt() 处理
// 4. ctx.assistantMessage.error = parse(apiError)

// 结果判定：
// ctx.needsCompaction = false
// ctx.blocked = false
// ctx.assistantMessage.error 存在 → return "stop"
```

**场景 4：返回 `"continue"` — 正常完成且有工具调用**

```ts
// LLM 调用了工具（如 readFile），工具执行成功，finishReason = "tool-calls"

// 处理流程：
// 1. handleEvent 处理 tool-call → 更新部件状态为 running
// 2. 工具执行完成 → tool-result → completeToolCall 更新部件状态为 completed
// 3. finish-step → finishReason: "tool-calls"，计算 token/cost

// 结果判定：
// ctx.needsCompaction = false
// ctx.blocked = false
// ctx.assistantMessage.error = undefined
// → return "continue"

// 外层循环收到 "continue" 后：
//   检查 assistantMessage.finish === "tool-calls"
//   → 如果是，构造新的 streamInput（包含工具结果）再次调用 process()
//   → 如果 finish !== "tool-calls"，终止循环
// 这实现了 Agent 的"工具调用→获取结果→继续推理"的多轮交互
```

**场景 5：返回 `"continue"` — 正常完成且无工具调用**

```ts
// LLM 直接返回文本回复，不需要工具调用，finishReason = "stop"

// 处理流程：
// 1. text-start → text-delta → text-end（文本生成完成）
// 2. finish-step → finishReason: "stop"

// 结果判定：
// → return "continue"

// 外层循环收到 "continue" 后：
//   检查 assistantMessage.finish === "stop"
//   → 不是 "tool-calls"，终止循环
//   → 会话完成，助手消息完整
```

---

## 第七段：返回 Handle 对象 (777-784)

```ts
return {
  get message() { return ctx.assistantMessage },
  updateToolCall,
  completeToolCall,
  process,
} satisfies Handle
```

返回满足 `Handle` 接口的对象：

| 属性 | 说明 |
|------|------|
| `message` | getter 访问当前助手消息 |
| `updateToolCall` | 更新工具调用部件 |
| `completeToolCall` | 完成工具调用 |
| `process` | 上面定义的核心处理函数 |

### 示例：Handle 对象的具体使用场景

**Handle 接口定义**（[`processor.ts`](opencode/packages/opencode/src/session/processor.ts:35)）：

```ts
export interface Handle {
  readonly message: MessageV2.Assistant           // 当前助手消息
  readonly updateToolCall: (                      // 更新工具调用部件
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (                    // 完成工具调用
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>  // 核心处理函数
}
```

**场景 1：外层循环使用 Handle 的典型流程**

```ts
// session.ts 中的外层循环（简化版）：
const handle = yield* SessionProcessor.create({
  assistantMessage,
  sessionID: "session-abc",
  model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
})

let result: Result
do {
  result = yield* handle.process(streamInput)

  switch (result) {
    case "compact":
      // 压缩对话历史后重新构造 streamInput
      streamInput = yield* compactMessages(streamInput)
      continue
    case "stop":
      // 终止循环
      break
    case "continue":
      // 检查是否有工具调用需要继续
      if (handle.message.finish === "tool-calls") {
        streamInput = yield* appendToolResults(streamInput, handle.message)
        continue
      }
      break
  }
} while (result === "continue" || result === "compact")
```

**场景 2：`handle.message` 的实时访问**

```ts
// handle.message 是一个 getter，始终返回最新的助手消息状态
// 因为 ctx.assistantMessage 是引用类型，process() 中的修改会实时反映

// 在 process() 执行期间：
handle.message  // → { id: "msg-002", role: "assistant", content: [...正在更新的部件...], finish: undefined }

// process() 完成后：
handle.message  // → { id: "msg-002", role: "assistant", content: [...完整部件列表], finish: "stop",
                //      cost: 0.003, tokens: { input: 1500, output: 500 }, time: { completed: ... } }
```

**场景 3：`updateToolCall` 的外部调用**

```ts
// 某些场景下，外部代码需要修改工具调用的状态
// 例如：UI 更新工具调用的进度信息

yield* handle.updateToolCall("call-abc", (part) => ({
  ...part,
  state: {
    ...part.state,
    // 更新工具调用的元数据（如进度百分比）
    metadata: { ...part.state.metadata, progress: 50 },
  },
}))
// → 返回更新后的 ToolPart（如果工具调用存在）
// → 如果工具调用不存在，返回 undefined
```

**场景 4：`completeToolCall` 的外部调用**

```ts
// 当工具在外部执行完毕时，需要将结果写回消息
// 例如：长时间运行的工具（如构建任务）完成时

yield* handle.completeToolCall("call-abc", {
  title: "Build completed",
  metadata: { exitCode: 0 },
  output: "Build successful. 10 files compiled.",
  attachments: [],  // 无附件
})
// → 将工具调用部件状态更新为 { status: "completed", output: "...", time: { end: ... } }
// → 结束 Deferred，通知 cleanup() 该工具已完成
```

---

## 整体执行流程

```
process(streamInput)
  ├─ 初始化上下文（清空压缩标记、读取配置）
  ├─ 创建 LLM 流并消费事件
  │   ├─ handleEvent 处理每个事件（文本/推理/工具调用等）
  │   └─ 检测到上下文溢出时提前终止流
  ├─ 中断 → onInterrupt → halt()
  ├─ 非中断错误 → 重试策略（指数退避 + 状态通知）
  │   └─ 重试耗尽 → halt()
  ├─ 无论如何 → cleanup()（保存未完成内容、标记中断工具）
  └─ 返回 "compact" | "stop" | "continue"
```

这是一个典型的 Effect-TS 风格的流式处理管线，通过管道组合实现了完整的 LLM 交互生命周期：流式消费 → 错误重试 → 中断处理 → 资源清理 → 结果判定。