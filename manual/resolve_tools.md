# `resolveTools` 函数详细分析报告

## 一、概览

[`resolveTools`](../packages/opencode/src/session/prompt.ts:516) 是 `SessionPrompt` 模块中的核心工具解析函数，负责将**内置工具（registry tools）**和**MCP 外部工具**统一转换为 AI SDK (`ai` 包) 的 `AITool` 格式，供 LLM 流式调用使用。函数通过 `Effect.fn` 定义，运行在 Effect 生态中。

**注：** 同名函数在 [`llm.ts:450`](../packages/opencode/src/session/llm.ts:450) 还有一个**过滤型**实现，仅做权限+用户配置的过滤，不涉及工具构建——两者职责不同，下文仅分析 `prompt.ts` 中的完整构建版本。

---

## 二、输入输出

### 输入类型（第 516-524 行）

```typescript
input: {
  agent: Agent.Info          // 当前 agent 信息
  model: Provider.Model      // 当前模型（含 providerID、api.id）
  session: Session.Info      // 当前 session 信息
  tools?: Record<string, boolean>  // 用户级工具开关（key=工具名, value=启用/禁用）
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean  // 是否跳过 agent 专属工具检查
  messages: MessageV2.WithParts[]  // 当前消息列表
}
```

### 输出

```typescript
Record<string, AITool>  // 键为工具 ID，值为 ai-sdk Tool 实例
```

---

## 三、控制流与数据流

### 阶段 1：初始化与上下文工厂（第 525-561 行）

1. **计时开始**：`using _ = log.time("resolveTools")` — Effect 资源安全计时
2. **初始化空工具集**：`const tools: Record<string, AITool> = {}`
3. **获取运行器与操作引用**：`runner()` 返回 `EffectBridge`（将 Effect 转为 Promise），`ops()` 返回操作句柄

4. **构建 `context` 工厂函数**（第 530-561 行）：
   - 为每个工具执行提供统一的 `Tool.Context` 对象
   - **`metadata`**：更新工具调用的运行时元数据（标题、metadata），仅在状态为 `running`/`pending` 时更新
   - **`ask`**：权限请求，合并 agent 和 session 的权限规则（`Permission.merge`），失败时 `orDie`
   - **`abort`**：直接透传 `options.abortSignal`
   - **`extra`**：携带 `model`、`bypassAgentCheck`、`promptOps`

#### 阶段 1 详细示例

**步骤 1-3：初始化示例**

```typescript
// 当 resolveTools 被调用时，首先创建空的工具容器
// 例如：input = { agent: coderAgent, model: claudeModel, session: sess123, ... }

using _ = log.time("resolveTools") // 开始计时，函数返回时自动结束计时并记录耗时

const tools: Record<string, AITool> = {}  // 空字典，例如最终会变成：
// { "read": AITool, "edit": AITool, "shell": AITool, "mcp_github_search": AITool, ... }

const run = yield* runner()   // EffectBridge 实例，后续 run.promise(someEffect) 可将 Effect 转为 Promise
const promptOps = yield* ops() // SessionPrompt 操作句柄，用于触发插件钩子等
```

**步骤 4：`context` 工厂函数示例**

假设 LLM 调用了 `read` 工具，传入 `args = { path: "src/index.ts" }`, `options = { toolCallId: "call_abc123", abortSignal: signal }`：

```typescript
const ctx = context(args, options)
// 构建出的 ctx 对象如下：
// {
//   sessionID: "sess_456",                    // 来自 input.session.id
//   abort: AbortSignal { aborted: false },     // 来自 options.abortSignal
//   messageID: "msg_789",                      // 来自 input.processor.message.id
//   callID: "call_abc123",                     // 来自 options.toolCallId
//   extra: {                                   // 携带额外上下文信息
//     model: { providerID: "anthropic", api: { id: "claude-3-opus" } },
//     bypassAgentCheck: false,
//     promptOps: SessionPromptOps { ... }
//   },
//   agent: "coder",                            // 来自 input.agent.name
//   messages: [/* 当前对话的所有消息 */],        // 来自 input.messages
//   metadata: [Function],                      // 见下方详细说明
//   ask: [Function],                           // 见下方详细说明
// }
```

**`metadata` 调用示例**：

```typescript
// 当工具执行过程中需要更新 UI 显示的状态（例如文件读取进度）
ctx.metadata({ title: "Reading src/index.ts", metadata: { lines: 100 } })

// 内部执行流程：
// 1. 调用 input.processor.updateToolCall("call_abc123", match => ...)
// 2. 检查 match.state.status:
//    - 若 status === "running" 或 "pending" → 更新为新的 title/metadata/input/time
//    - 若 status === "completed" → 跳过更新（避免竞态覆盖已完成状态）
// 3. 更新后的状态:
//    {
//      title: "Reading src/index.ts",
//      metadata: { lines: 100 },
//      status: "running",
//      input: { path: "src/index.ts" },
//      time: { start: 1715800000000 },
//    }
```

**`ask` 权限请求示例**：

```typescript
// 当工具需要请求权限（如 shell 工具执行危险命令）
yield* ctx.ask({
  permission: "shell",
  patterns: ["bash -c rm *"],
  always: [],
})

// 内部执行流程：
// 1. 构造 Permission.Request:
//    {
//      permission: "shell",
//      patterns: ["bash -c rm *"],
//      always: [],
//      sessionID: "sess_456",
//      tool: { messageID: "msg_789", callID: "call_abc123" },
//      ruleset: Permission.merge(input.agent.permission, input.session.permission)
//              // 例如: agent.permission = ["shell:allow:bash"] + session.permission = []
//              // 合并后: ["shell:allow:bash"]
//    }
// 2. 调用 permission.ask(request)
//    - 若 ruleset 允许 → 直接返回（Effect.succeed）
//    - 若 ruleset 拒绝 → Effect.fail，由 .pipe(Effect.orDie) 转为致死错误
//    - 若需用户确认 → 弹出权限对话框等待用户决策
```

### 阶段 2：注册内置工具（第 563-604 行）

遍历 `registry.tools()` 返回的工具列表：

1. **schema 转换**（第 568 行）：
   - `ToolJsonSchema.fromTool(item)` → `ProviderTransform.schema(input.model, ...)`
   - 按模型特征对 JSON Schema 做适配转换

2. **构建 `AITool`**（第 569-603 行）：
   - `tool({ description, inputSchema, execute })` 构建 ai-sdk 工具
   - **execute 逻辑**：
     - 通过 `run.promise()` 将 Effect 转为 Promise（满足 ai-sdk 异步接口）
     - 触发 `tool.execute.before` 插件钩子
     - 调用 `item.execute(args, ctx)` 执行工具本体
     - 对结果中的 `attachments` 附加 `id`/`sessionID`/`messageID`
     - 触发 `tool.execute.after` 插件钩子
     - **abort 检测**：若 `abortSignal.aborted`，立即调用 `completeToolCall` 完成该调用

#### 阶段 2 详细示例

**假设 `registry.tools()` 返回了 3 个内置工具**：`read`、`edit`、`shell`

**步骤 1：schema 转换示例**

以 `read` 工具为例，其原始参数定义通过 `Schema.Struct` 声明：

```typescript
// read 工具的原始参数定义（简化）
const Parameters = Schema.Struct({
  path: Schema.String,
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
})

// 步骤 1a: ToolJsonSchema.fromTool(item) 将其转为标准 JSON Schema
// 输出:
// {
//   type: "object",
//   properties: {
//     path: { type: "string", description: "文件路径" },
//     offset: { type: "number", description: "起始行号" },
//     limit: { type: "number", description: "读取行数" },
//   },
//   required: ["path"]
// }

// 步骤 1b: ProviderTransform.schema(input.model, schema)
// 根据当前模型做适配。例如某些模型不支持 optional 字段，需要转换：
// - 对于 Anthropic Claude: 可能需要将 optional 字段添加 default 值
// - 对于 OpenAI GPT: 可能需要调整 description 格式
// - 对于 Gemini: 可能需要移除某些不支持的 schema 特性
```

**步骤 2：构建 AITool 并注册示例**

```typescript
// 遍历注册过程：
for (const item of registry.tools({ modelID, providerID, agent })) {
  // 假设当前遍历到 read 工具：
  // item = {
  //   id: "read",
  //   description: "Read the contents of a file at the given path",
  //   parameters: Schema.Struct({ path: String, offset: Number, limit: Number }),
  //   execute: (args, ctx) => Effect.gen(function* () { ... })
  // }

  const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))

  tools["read"] = tool({
    description: "Read the contents of a file at the given path",
    inputSchema: jsonSchema(schema),
    execute(args, options) {
      // args = { path: "src/index.ts" } （由 LLM 生成）
      // options = { toolCallId: "call_read_001", abortSignal: controller.signal }
      return run.promise(
        Effect.gen(function* () {
          // 1. 构建 context
          const ctx = context(args, options)
          // ctx = { sessionID: "sess_456", callID: "call_read_001", ... }

          // 2. 触发 before 钩子
          yield* plugin.trigger("tool.execute.before",
            { tool: "read", sessionID: "sess_456", callID: "call_read_001" },
            { args: { path: "src/index.ts" } }
          )
          // 例如日志插件可在此记录：[Tool Call Start] read({ path: "src/index.ts" })

          // 3. 执行工具本体
          const result = yield* item.execute(args, ctx)
          // result = {
          //   title: "Read src/index.ts",
          //   metadata: { lines: 42 },
          //   output: "import { Effect } from 'effect'\n...",
          //   attachments: [
          //     { type: "file", mime: "text/plain", url: "data:text/plain;base64,..." }
          //   ]
          // }

          // 4. 为 attachments 补充关联 ID
          const output = {
            ...result,
            attachments: result.attachments?.map((attachment) => ({
              ...attachment,                        // { type: "file", mime: "text/plain", url: "data:..." }
              id: PartID.ascending(),               // 生成唯一 ID: "part_001"
              sessionID: ctx.sessionID,             // "sess_456"
              messageID: input.processor.message.id, // "msg_789"
            })),
          }
          // output.attachments = [
          //   { type: "file", mime: "text/plain", url: "data:...", id: "part_001", sessionID: "sess_456", messageID: "msg_789" }
          // ]

          // 5. 触发 after 钩子
          yield* plugin.trigger("tool.execute.after",
            { tool: "read", sessionID: "sess_456", callID: "call_read_001", args },
            output
          )
          // 例如日志插件可在此记录：[Tool Call End] read → 42 lines, 1 attachment

          // 6. abort 检测
          if (options.abortSignal?.aborted) {
            // 用户取消了请求，立即完成该工具调用
            yield* input.processor.completeToolCall("call_read_001", output)
            // 这会更新 UI 状态为 "completed"，防止悬挂的工具调用
          }

          return output
        })
      )
    }
  })
}
// 遍历结束后 tools = { "read": AITool, "edit": AITool, "shell": AITool }
```

**abort 检测场景示例**：

```typescript
// 用户在工具执行期间点击了"停止"按钮：
// 1. abortSignal 变为 aborted: true
// 2. 但 Effect.gen 内部已在执行 item.execute()，无法中断
// 3. 当 item.execute() 返回后，检测到 abortSignal.aborted === true
// 4. 调用 completeToolCall 将结果标记为完成，避免 UI 上工具状态永远停在 "running"

// 注意：这里存在设计缺陷——若工具执行耗时很长（如 shell 执行长命令），
// abort 信号无法在执行过程中被检测到，只能等到执行完成后再处理
```

### 阶段 3：注册 MCP 工具（第 606-691 行）

遍历 `mcp.tools()` 返回的外部工具：

1. **过滤**（第 608 行）：跳过无 `execute` 的工具项
2. **schema 转换**（第 610-612 行）：
   - `asSchema(item.inputSchema).jsonSchema` → `ProviderTransform.schema(...)` → 重新赋值 `item.inputSchema`
3. **execute 包装**（第 613-689 行）：
   - 同样通过 `run.promise()` 包装
   - 触发 `tool.execute.before` 钩子
   - **权限请求**：`ctx.ask({ permission: key, patterns: ["*"], always: ["*"] })` — MCP 工具默认需要权限确认
   - 执行 `Effect.promise(() => execute(args, opts))` — 将 MCP 原生 Promise 转为 Effect
   - 带有 `Effect.withSpan` 遥测标记
   - **结果后处理**（第 641-683 行）— MCP 特有逻辑：
     - 遍历 `result.content`，分离 `text`/`image`/`resource` 三种类型
     - `image` → 转为 `data:` URI 的 file attachment
     - `resource` → 提取 text 和 blob，blob 转为 base64 data URI attachment
     - 对合并后的文本调用 `truncate.output()` 做截断处理
     - 构建包含 `metadata.truncated` 和可选 `outputPath` 的输出对象
   - 触发 `tool.execute.after` 钩子
   - **abort 检测**：同内置工具逻辑
4. **注册**（第 690 行）：`tools[key] = item` — 直接修改原 MCP 工具对象

#### 阶段 3 详细示例

**假设 `mcp.tools()` 返回了 2 个 MCP 工具**：`github_search_issues`、`slack_send_message`

**步骤 1：过滤无 execute 的工具**

```typescript
for (const [key, item] of Object.entries(yield* mcp.tools())) {
  // 遍历结果示例：
  // ["github_search_issues", { inputSchema: {...}, execute: [Function] }]
  // ["slack_send_message", { inputSchema: {...}, execute: [Function] }]
  // ["some_deprecated_tool", { inputSchema: {...}, execute: undefined }]  // ← 将被跳过

  const execute = item.execute
  if (!execute) continue  // 跳过没有 execute 方法的工具（如纯资源型工具）
}
```

**步骤 2：schema 转换示例**

```typescript
// 以 github_search_issues 工具为例：
// 原始 inputSchema（由 MCP 服务器提供）:
// {
//   type: "object",
//   properties: {
//     query: { type: "string", description: "Search query" },
//     repo: { type: "string", description: "Repository name" },
//     limit: { type: "number", description: "Max results" }
//   },
//   required: ["query"]
// }

// 步骤 2a: 将 inputSchema 转为标准 JSON Schema
const schema = yield* Effect.promise(() =>
  Promise.resolve(asSchema(item.inputSchema).jsonSchema)
)
// 注意：这里用 Effect.promise 包装，是因为 asSchema() 可能返回 Promise
// （MCP 工具的 schema 可能来自远程服务器，需要异步获取）

// 步骤 2b: 根据当前模型做适配
const transformed = ProviderTransform.schema(input.model, schema)

// 步骤 2c: 直接修改原 MCP 工具对象的 inputSchema（⚠️ 变异操作）
item.inputSchema = jsonSchema(transformed)
// 风险：若 resolveTools 被多次调用，schema 转换会被重复应用
// 第一次调用: inputSchema = jsonSchema(transformed)
// 第二次调用: inputSchema = jsonSchema(ProviderTransform.schema(model, jsonSchema(transformed)))
// 这会导致 schema 结构被层层嵌套包装，最终损坏
```

**步骤 3：execute 包装示例**

```typescript
// 假设 LLM 调用 github_search_issues 工具，传入:
// args = { query: "bug in auth", repo: "opencode", limit: 5 }
// opts = { toolCallId: "call_mcp_001", abortSignal: controller.signal }

item.execute = (args, opts) =>
  run.promise(
    Effect.gen(function* () {
      // === 3a: 构建 context ===
      const ctx = context(args, opts)
      // ctx = { sessionID: "sess_456", callID: "call_mcp_001", ... }

      // === 3b: 触发 before 钩子 ===
      yield* plugin.trigger("tool.execute.before",
        { tool: "github_search_issues", sessionID: "sess_456", callID: "call_mcp_001" },
        { args: { query: "bug in auth", repo: "opencode", limit: 5 } }
      )

      // === 3c: 权限请求 + 执行 ===
      const result = yield* Effect.gen(function* () {
        // MCP 工具默认需要权限确认
        yield* ctx.ask({
          permission: "github_search_issues",  // 工具名即权限名
          metadata: {},
          patterns: ["*"],   // 通配符：匹配所有操作模式
          always: ["*"],     // 通配符：总是允许（但首次仍需确认）
        })
        // 首次调用：弹出权限对话框 "允许 github_search_issues 访问？"
        // 用户选择"始终允许"后：后续调用直接通过（always: ["*"] 生效）

        // 执行 MCP 原生 execute（返回 Promise），转为 Effect
        return yield* Effect.promise(() => execute(args, opts))
        // execute 是 MCP SDK 提供的函数，实际调用远程 MCP 服务器
      }).pipe(
        Effect.withSpan("Tool.execute", {
          attributes: {
            "tool.name": "github_search_issues",
            "tool.call_id": "call_mcp_001",
            "session.id": "sess_456",
            "message.id": "msg_789",
          },
        }),
        // withSpan 为 OpenTelemetry 追踪添加标记，便于性能分析和调试
      )

      // 假设 result = {
      //   content: [
      //     { type: "text", text: "Found 3 issues:\n1. #42 - Auth token expired..." },
      //     { type: "image", mimeType: "image/png", data: "iVBORw0KGgo..." },
      //     { type: "resource", resource: {
      //       uri: "file:///issues/auth_bug.md",
      //       mimeType: "text/markdown",
      //       text: "# Auth Bug Report\n..."
      //     }},
      //     { type: "resource", resource: {
      //       uri: "file:///issues/screenshot.png",
      //       mimeType: "image/png",
      //       blob: "iVBORw0KGgo..."
      //     }},
      //   ],
      //   metadata: { total_count: 3, page: 1 }
      // }

      // === 3d: 触发 after 钩子 ===
      yield* plugin.trigger("tool.execute.after",
        { tool: "github_search_issues", sessionID: "sess_456", callID: "call_mcp_001", args },
        result
      )

      // === 3e: 结果后处理（MCP 特有逻辑）===
      const textParts: string[] = []
      const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []

      for (const contentItem of result.content) {
        if (contentItem.type === "text") {
          // 文本内容 → 收集到 textParts
          textParts.push(contentItem.text)
          // textParts = ["Found 3 issues:\n1. #42 - Auth token expired..."]
        }
        else if (contentItem.type === "image") {
          // 图片内容 → 转为 data URI attachment
          attachments.push({
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,iVBORw0KGgo...",
          })
        }
        else if (contentItem.type === "resource") {
          const { resource } = contentItem
          if (resource.text) {
            // resource 中的文本 → 收集到 textParts
            textParts.push(resource.text)
            // textParts = ["Found 3 issues...", "# Auth Bug Report\n..."]
          }
          if (resource.blob) {
            // resource 中的二进制 → 转为 data URI attachment
            attachments.push({
              type: "file",
              mime: resource.mimeType ?? "application/octet-stream",  // 无 mimeType 时回退
              url: "data:image/png;base64,iVBORw0KGgo...",
              filename: resource.uri,  // "file:///issues/screenshot.png"
            })
          }
        }
      }
      // 此时：
      // textParts = ["Found 3 issues:\n1. #42 - Auth token expired...", "# Auth Bug Report\n..."]
      // attachments = [
      //   { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo..." },
      //   { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo...",
      //     filename: "file:///issues/screenshot.png" }
      // ]

      // === 3f: 文本截断 ===
      const truncated = yield* truncate.output(
        textParts.join("\n\n"),  // 用双换行拼接所有文本
        // "Found 3 issues:\n1. #42 - Auth token expired...\n\n# Auth Bug Report\n..."
        {},
        input.agent
      )
      // 若文本过长（超过模型 token 限制），截断处理：
      // truncated = {
      //   content: "Found 3 issues:\n1. #42 - Auth token expired...\n[truncated]",
      //   truncated: true,
      //   outputPath: "/tmp/truncated_output_abc123.txt"  // 完整输出保存到临时文件
      // }
      // 若文本未超限：
      // truncated = {
      //   content: "Found 3 issues:\n1. #42 - Auth token expired...\n\n# Auth Bug Report\n...",
      //   truncated: false,
      // }

      const metadata = {
        ...result.metadata,  // 保留 MCP 返回的原始 metadata: { total_count: 3, page: 1 }
        truncated: truncated.truncated,  // true 或 false
        ...(truncated.truncated && { outputPath: truncated.outputPath }),
        // 仅在截断时包含 outputPath: "/tmp/truncated_output_abc123.txt"
      }
      // metadata = { total_count: 3, page: 1, truncated: true, outputPath: "/tmp/truncated_output_abc123.txt" }

      const output = {
        title: "",
        metadata,
        output: truncated.content,  // 截断后的文本
        attachments: attachments.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),   // "part_002", "part_003"
          sessionID: ctx.sessionID, // "sess_456"
          messageID: input.processor.message.id, // "msg_789"
        })),
        content: result.content,  // 保留原始 MCP content 用于调试/审计
      }

      // === 3g: abort 检测 ===
      if (opts.abortSignal?.aborted) {
        yield* input.processor.completeToolCall("call_mcp_001", output)
      }

      return output
    })
  )

// 步骤 4: 注册到 tools 字典
tools["github_search_issues"] = item  // ⚠️ 直接将修改后的原对象放入字典
```

### 阶段 4：返回（第 693 行）

返回完整的 `tools` 字典。

#### 阶段 4 详细示例

```typescript
return tools

// 最终返回的工具字典示例：
// {
//   // ===== 内置工具 =====
//   "read": AITool {
//     description: "Read the contents of a file at the given path",
//     inputSchema: jsonSchema({ type: "object", properties: { path: {...}, offset: {...}, limit: {...} }, required: ["path"] }),
//     execute: [Function: execute]  // 包装了 Effect.gen → run.promise 的异步函数
//   },
//   "edit": AITool {
//     description: "Edit a file with search and replace",
//     inputSchema: jsonSchema({ type: "object", properties: { file_path: {...}, search: {...}, replace: {...} }, required: ["file_path", "search", "replace"] }),
//     execute: [Function: execute]
//   },
//   "shell": AITool {
//     description: "Execute a shell command",
//     inputSchema: jsonSchema({ type: "object", properties: { command: {...} }, required: ["command"] }),
//     execute: [Function: execute]
//   },
//
//   // ===== MCP 工具 =====
//   "github_search_issues": AITool {
//     description: "Search for GitHub issues",  // 来自 MCP 服务器
//     inputSchema: jsonSchema(transformed),      // 经过 ProviderTransform 适配的 schema
//     execute: [Function: execute]               // 包装了权限请求 + Effect.promise + 结果后处理
//   },
//   "slack_send_message": AITool {
//     description: "Send a message to a Slack channel",
//     inputSchema: jsonSchema(transformed),
//     execute: [Function: execute]
//   },
// }
//
// 该字典会被传递给 ai-sdk 的 streamText() 函数：
//   const result = streamText({ model, messages, tools: resolveToolsOutput, ... })
// LLM 在生成回复时，可以根据 tools 字典中的描述和 schema 决定调用哪个工具，
// ai-sdk 负责将 LLM 的 tool_call 请求路由到对应 AITool.execute 函数
```

**返回值在流水线中的位置**：

```
resolveTools (prompt.ts)          resolveTools (llm.ts)
构建完整工具字典        ──→       过滤权限/用户配置
Record<string, AITool>           Record<string, Tool>
       │                                │
       └──────────→ streamText({ tools: filteredTools })
                         │
                         └──→ LLM 选择并调用工具
```

---

## 四、关键数据结构与算法

| 数据结构 | 用途 |
|---|---|
| `Record<string, AITool>` | 最终输出，工具 ID → ai-sdk Tool 映射 |
| `Tool.Context` | 工具执行上下文，含 session/message/abort/权限 |
| `ProviderTransform.schema()` | 模型适配层，按模型特征转换 JSON Schema |
| `EffectBridge` | Effect ↔ Promise 桥接，将 Effect 生态嵌入 ai-sdk 异步接口 |

---

## 五、边界条件与异常处理

### 已处理的边界

1. **abort 信号**（第 596-598、684-686 行）：检测 `abortSignal.aborted`，若已取消则立即 `completeToolCall`
2. **MCP 工具无 execute**（第 608 行）：`if (!execute) continue` 跳过
3. **metadata 更新竞态**（第 540 行）：检查 `match.state.status` 仅在 `running`/`pending` 时更新，避免覆盖已完成状态
4. **MCP resource 缺失 mimeType**（第 657 行）：回退到 `"application/octet-stream"`

### 未显式处理的异常

1. **`registry.tools()` 或 `mcp.tools()` 失败**：依赖 Effect 的 Generator 传播，无局部 catch
2. **`ProviderTransform.schema()` 转换失败**：同上，由 Effect 管道传播
3. **`truncate.output()` 失败**：MCP 工具输出截断失败会中断整个工具执行
4. **`item.execute()` 抛出同步异常**：内置工具的 execute 在 `Effect.gen` 内，Effect 会捕获；但 MCP 的 `execute` 通过 `Effect.promise` 包装，Promise rejection 会被 Effect 捕获

---

## 六、复杂度分析

### 时间复杂度

- 设内置工具数为 N，MCP 工具数为 M
- **整体 O(N + M)**：两次独立遍历，每次内部操作为 O(1)（schema 转换、对象构建）
- MCP 工具的结果后处理中，`result.content` 遍历为 O(C)（C = content 条目数），`truncate.output` 取决于文本长度

### 空间复杂度

- **O(N + M)**：工具字典存储
- 每个 AITool 对象包含闭包（context 工厂、execute 函数），但闭包共享 `input` 引用

---

## 七、潜在缺陷与风险

1. **MCP 工具对象变异**（第 612、613 行）：
   - `item.inputSchema = jsonSchema(transformed)` 和 `item.execute = ...` 直接修改了 `mcp.tools()` 返回的原对象
   - 若同一 MCP 工具被多次 resolve（如多轮对话），schema 转换会被**重复应用**，导致 schema 被层层嵌套包装
   - **风险等级：高** — 多次调用可能导致 schema 结构损坏

2. **context 工厂闭包捕获 `input`**（第 530 行）：
   - 每次 `context(args, options)` 创建新对象，但引用同一个 `input`
   - 若 `input.processor.message` 在并发执行中被修改，可能导致 `messageID` 不一致

3. **MCP 权限请求过于宽松**（第 623 行）：
   - `patterns: ["*"], always: ["*"]` — 意味着所有 MCP 工具的权限请求都使用通配符
   - 每次调用都会触发 `ctx.ask`，但 `always: ["*"]` 可能导致自动放行

4. **内置工具无输出截断**：
   - MCP 工具对输出做了 `truncate.output()` 处理，但内置工具（第 581-590 行）直接返回结果，无截断逻辑
   - 长输出的内置工具可能消耗大量 token

5. **abort 处理不完整**：
   - 仅在 execute 完成后检查 abort（第 596、684 行），未在执行过程中检查
   - 若工具执行耗时很长，abort 信号无法中断正在执行的 Effect

---

## 八、可改进点与建议

1. **避免 MCP 工具对象变异**：
   ```typescript
   // 改为创建新对象而非修改原对象
   tools[key] = {
     ...item,
     inputSchema: jsonSchema(transformed),
     execute: (args, opts) => ...
   }
   ```

2. **统一内置/MCP 工具的输出截断**：将 `truncate.output()` 提取为公共后处理步骤，内置工具也应截断

3. **abort 支持改进**：在 Effect 执行中通过 `Effect.race(Effect.never, Effect.async(listen => abortSignal.addEventListener(...)))` 实现真正的取消

4. **MCP 权限精细化**：为不同 MCP 工具配置不同的权限 pattern，而非统一通配符

5. **`input.tools` 参数未使用**：函数签名接受 `tools?: Record<string, boolean>` 但函数体内未引用——该过滤逻辑在 [`llm.ts:resolveTools`](../packages/opencode/src/session/llm.ts:450) 中单独实现，存在职责混淆

---

## 九、与 `llm.ts:resolveTools` 的对比

| 维度 | prompt.ts 版本 | llm.ts 版本 |
|---|---|---|
| 职责 | 构建完整的 AITool 字典 | 过滤已有工具字典 |
| 输入 | agent/model/session/processor/... | tools + agent + permission + user |
| 输出 | `Record<string, AITool>` | `Record<string, Tool>`（过滤后） |
| 权限处理 | 通过 `ctx.ask` 运行时检查 | 通过 `Permission.disabled` + `user.tools` 静态过滤 |
| 调用顺序 | 先 prompt.ts 构建 → 后 llm.ts 过滤 | — |

两者形成**构建→过滤**的流水线关系。

---

## 十、结论

`resolveTools` 是一个双阶段工具构建器，将内置工具和 MCP 工具统一为 ai-sdk 格式。其核心设计合理——通过 context 工厂统一执行上下文、通过 EffectBridge 桥接 Effect 与 Promise。但存在**MCP 对象变异**（多次调用风险）、**输出截断不一致**、**`input.tools` 未使用**等值得关注的问题。建议优先修复 MCP 工具对象变异问题，并统一内置/MCP 工具的后处理流程。