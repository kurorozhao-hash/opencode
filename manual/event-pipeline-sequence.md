# OpenCode 事件触发业务流程 — 管道时序图

本文档以 Mermaid 时序图形式，展示 14 种日志事件在 opencode 核心业务流程中的触发时序与管道关系。

## 1. 完整会话生命周期总览

```mermaid
sequenceDiagram
    participant User as 用户
    participant Prompt as SessionPrompt
    participant RunLoop as SessionPrompt.run
    participant LLM as LLM.run
    participant Processor as SessionProcessor
    participant Session as Session
    participant Status as SessionStatus
    participant Question as Question
    participant Summary as SessionSummary
    participant Revert as SessionRevert
    participant Plugin as Plugin Hooks

    User->>Prompt: prompt(input)
    Prompt->>Prompt: createUserMessage() 解析用户消息
    Prompt->>Plugin: chat.message
    Prompt->>RunLoop: runLoop(sessionID) 进入循环

    loop Agent Loop (每轮对话)
        RunLoop->>Status: set(sessionID, {type:"busy"})
        Status-->>Plugin: session.status

        RunLoop->>Processor: create() 创建处理器
        RunLoop->>Processor: process(streamInput)

        Processor->>LLM: stream(streamInput) 请求LLM流

        Note over LLM: ─── LLM 请求管道 ───
        LLM->>Plugin: experimental.chat.system.transform
        LLM->>Plugin: chat.params
        LLM->>Plugin: chat.headers
        Note over LLM: ─── 发起 HTTP 请求 ───

        LLM-->>Processor: Stream<Event> 流式响应

        Note over Processor: ─── 流式响应处理管道 ───

        Processor->>Status: set(sessionID, {type:"busy"}) [start事件]

        alt 流式文本增量
            Processor->>Session: updatePartDelta()
            Session-->>Plugin: message.part.delta
        end

        alt 推理增量
            Processor->>Session: updatePartDelta()
            Session-->>Plugin: message.part.delta
        end

        alt 文本完成
            Processor->>Plugin: experimental.text.complete
        end

        alt 工具调用
            Processor->>Plugin: tool.execute.before
            Note over Processor: 执行工具
            alt 工具需要提问
                Processor->>Question: ask()
                Question-->>Plugin: question.asked
                User-->>Question: 用户回答
                Question-->>Plugin: question.replied
            end
            alt 工具需要权限
                Note over Processor: Permission.ask() → question.asked
            end
            alt 工具是 Shell
                Processor->>Plugin: shell.env
            end
            Processor->>Plugin: tool.execute.after
        end

        Processor->>Status: set(sessionID, {type:"idle"})
        Status-->>Plugin: session.status
        Status-->>Plugin: session.idle

        RunLoop->>Summary: summarize() [step=1时]
        Summary-->>Plugin: session.diff
    end

    User->>Revert: revert() [用户回滚时]
    Revert-->>Plugin: session.diff
```

## 2. LLM 请求管道（3 个事件）

展示 `LLM.run()` 中 3 个插件钩子的顺序触发：

```mermaid
sequenceDiagram
    participant Processor as SessionProcessor
    participant LLM as LLM.run
    participant Plugin as Plugin.trigger

    Processor->>LLM: stream(streamInput)

    Note over LLM: 1. 构建系统提示词
    LLM->>Plugin: experimental.chat.system.transform
    Note right of Plugin: 允许插件变换 system prompt

    Note over LLM: 2. 组装请求参数
    LLM->>Plugin: chat.params
    Note right of Plugin: 允许插件修改 temperature/topP/maxOutputTokens 等

    Note over LLM: 3. 组装请求头
    LLM->>Plugin: chat.headers
    Note right of Plugin: 允许插件注入自定义 HTTP headers

    Note over LLM: 4. 发起 LLM HTTP 请求
    LLM-->>Processor: Stream<Event> 流式响应
```

## 3. 流式响应处理管道（2 个事件）

展示 `SessionProcessor.process()` 处理 LLM 流式响应的事件触发：

```mermaid
sequenceDiagram
    participant LLM as LLM Stream
    participant Processor as SessionProcessor
    participant Session as Session
    participant Plugin as Plugin.trigger
    participant Status as SessionStatus

    LLM-->>Processor: start
    Processor->>Status: set(sessionID, {type:"busy"})
    Status-->>Plugin: session.status

    alt 文本流式增量
        LLM-->>Processor: text-start
        LLM-->>Processor: text-delta (多次)
        Processor->>Session: updatePartDelta()
        Session-->>Plugin: message.part.delta
        LLM-->>Processor: text-end
        Processor->>Plugin: experimental.text.complete
    end

    alt 推理流式增量
        LLM-->>Processor: reasoning-start
        LLM-->>Processor: reasoning-delta (多次)
        Processor->>Session: updatePartDelta()
        Session-->>Plugin: message.part.delta
        LLM-->>Processor: reasoning-end
    end

    alt 工具调用
        LLM-->>Processor: tool-input-start
        LLM-->>Processor: tool-input-delta (多次)
        LLM-->>Processor: tool-input-end
        LLM-->>Processor: tool-call
        LLM-->>Processor: tool-result / tool-error
    end

    LLM-->>Processor: finish-step
    LLM-->>Processor: finish

    Processor->>Status: set(sessionID, {type:"idle"})
    Status-->>Plugin: session.status
    Status-->>Plugin: session.idle
```

## 4. 工具执行管道（3 个事件）

展示工具执行生命周期中 `tool.execute.before` → `shell.env` → `tool.execute.after` 的管道：

```mermaid
sequenceDiagram
    participant AI as AI SDK
    participant Prompt as SessionPrompt
    participant Plugin as Plugin.trigger
    participant Tool as Tool.execute
    participant Shell as ShellTool
    participant Question as Question
    participant Permission as Permission

    AI->>Prompt: tool.execute(args, options)

    Prompt->>Plugin: tool.execute.before
    Note right of Plugin: {tool, sessionID, callID, args}

    alt 工具需要权限确认
        Prompt->>Permission: ask()
        Permission-->>Plugin: question.asked
        Note right of Plugin: 等待用户授权
        Permission-->>Plugin: question.replied
    end

    Prompt->>Tool: execute(args, ctx)

    alt 工具类型为 Shell
        Tool->>Shell: shellEnv(ctx, cwd)
        Shell->>Plugin: shell.env
        Note right of Plugin: {cwd, sessionID, callID} → 返回 {env}
        Note over Shell: 合并环境变量后执行命令
    end

    alt 工具执行中需要用户输入
        Tool->>Question: ask()
        Question-->>Plugin: question.asked
        Note right of Plugin: 等待用户回答
        Question-->>Plugin: question.replied
    end

    Tool-->>Prompt: result

    Prompt->>Plugin: tool.execute.after
    Note right of Plugin: {tool, sessionID, callID, args, output}
```

## 5. 用户交互管道（2 个事件）

展示 `question.asked` / `question.replied` 的问答流程：

```mermaid
sequenceDiagram
    participant Caller as 调用方
    participant Question as Question Service
    participant Bus as Bus
    participant UI as TUI / Web UI
    participant User as 用户

    Caller->>Question: ask({sessionID, questions})
    Question->>Bus: publish(Event.Asked, info)
    Bus-->>UI: question.asked
    Note right of UI: 显示问题给用户

    User->>UI: 选择/输入答案
    UI->>Question: reply({requestID, answers})
    Question->>Bus: publish(Event.Replied, ...)
    Bus-->>Caller: question.replied
    Note right of Caller: 继续执行（Deferred resolve）
```

## 6. 会话状态管道（2 个事件）

展示 `session.status` / `session.idle` 的状态流转：

```mermaid
sequenceDiagram
    participant RunLoop as SessionPrompt.run
    participant Status as SessionStatus.set
    participant Bus as Bus
    participant Plugin as Plugin Hooks

    Note over RunLoop: 用户发送消息，进入 Agent Loop

    RunLoop->>Status: set(sessionID, {type:"busy"})
    Status->>Bus: publish(Event.Status, {sessionID, status:{type:"busy"}})
    Bus-->>Plugin: session.status [busy]

    Note over RunLoop: LLM 流式处理中...

    RunLoop->>Status: set(sessionID, {type:"idle"})
    Status->>Bus: publish(Event.Status, {sessionID, status:{type:"idle"}})
    Bus-->>Plugin: session.status [idle]
    Status->>Bus: publish(Event.Idle, {sessionID})
    Bus-->>Plugin: session.idle

    Note over RunLoop: 如有工具调用，再次进入 busy

    RunLoop->>Status: set(sessionID, {type:"busy"})
    Status->>Bus: publish(Event.Status, {sessionID, status:{type:"busy"}})
    Bus-->>Plugin: session.status [busy]

    RunLoop->>Status: set(sessionID, {type:"idle"})
    Status->>Bus: publish(Event.Status, {sessionID, status:{type:"idle"}})
    Bus-->>Plugin: session.status [idle]
    Status->>Bus: publish(Event.Idle, {sessionID})
    Bus-->>Plugin: session.idle
```

## 7. 会话差异管道（1 个事件）

展示 `session.diff` 在回滚和摘要两种场景下的触发：

```mermaid
sequenceDiagram
    participant Caller as 调用方
    participant Revert as SessionRevert
    participant Summary as SessionSummary
    participant Bus as Bus
    participant Plugin as Plugin Hooks

    alt 场景1: 会话回滚
        Caller->>Revert: revert({sessionID, messageID})
        Note over Revert: 恢复快照 → 计算差异
        Revert->>Bus: publish(Session.Event.Diff, {sessionID, diff})
        Bus-->>Plugin: session.diff
    end

    alt 场景2: 会话摘要（每轮 step=1 时）
        Caller->>Summary: summarize({sessionID, messageID})
        Note over Summary: 获取所有消息 → 计算差异
        Summary->>Bus: publish(Session.Event.Diff, {sessionID, diff})
        Bus-->>Plugin: session.diff
    end
```

## 8. 事件管道汇总图

以管道视角展示所有 14 种事件的触发顺序和数据流向：

```mermaid
flowchart LR
    subgraph 用户输入阶段
        A[用户消息] --> B[chat.message]
    end

    subgraph LLM请求管道
        B --> C[experimental.chat.system.transform]
        C --> D[chat.params]
        D --> E[chat.headers]
    end

    subgraph 流式响应管道
        E --> F[session.status busy]
        F --> G[message.part.delta]
        G --> H[experimental.text.complete]
    end

    subgraph 工具执行管道
        H --> I[tool.execute.before]
        I --> J{需要权限?}
        J -->|是| K[question.asked]
        K --> L[question.replied]
        L --> M{是Shell工具?}
        J -->|否| M
        M -->|是| N[shell.env]
        M -->|否| O[工具执行]
        N --> O
        O --> P[tool.execute.after]
    end

    subgraph 会话状态管道
        P --> Q[session.status idle]
        Q --> R[session.idle]
    end

    subgraph 会话差异管道
        R --> S[session.diff]
    end

    style B fill:#e1f5fe
    style C fill:#fff3e0
    style D fill:#fff3e0
    style E fill:#fff3e0
    style F fill:#e8f5e9
    style G fill:#e8f5e9
    style H fill:#e8f5e9
    style I fill:#fce4ec
    style K fill:#f3e5f5
    style L fill:#f3e5f5
    style N fill:#fce4ec
    style P fill:#fce4ec
    style Q fill:#e8f5e9
    style R fill:#e8f5e9
    style S fill:#e0f2f1
```

> 颜色说明：
> - 蓝色：用户输入事件
> - 橙色：LLM 请求管道事件
> - 绿色：流式响应/会话状态事件
> - 粉色：工具执行事件
> - 紫色：用户交互问答事件
> - 青色：会话差异事件