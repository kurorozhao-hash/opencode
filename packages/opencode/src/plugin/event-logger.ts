import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import { readdirSync, statSync } from "fs"

const log = Log.create({ service: "plugin.event-logger" })

/**
 * Event Logger Plugin Configuration
 */
export interface EventLoggerConfig {
  /** Log level: DEBUG, INFO, WARN, ERROR */
  level?: "DEBUG" | "INFO" | "WARN" | "ERROR"
  /** Log output format */
  output?: {
    format?: "json" | "text"
    directory?: string
  }
  /** Log retention policy */
  retention?: {
    days?: number
    maxSizeMB?: number
  }
  /** Event filters */
  filters?: {
    include?: string[]
    exclude?: string[]
  }
}

/**
 * Event log entry structure
 */
interface EventLogEntry {
  timestamp: number
  type: string
  source: "bus" | "hook"
  properties: unknown
  sessionID?: string
}

/**
 * Log buffer for batch writing
 */
class LogBuffer {
  private buffer: EventLogEntry[] = []
  private readonly maxSize = 100
  private flushTimer?: NodeJS.Timeout
  private readonly flushInterval = 5000 // 5 seconds

  constructor(private readonly logDir: string, private readonly format: string) {}

  async add(entry: EventLogEntry): Promise<void> {
    this.buffer.push(entry)
    
    if (this.buffer.length >= this.maxSize) {
      await this.flush()
    } else if (!this.flushTimer) {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => {
      void this.flush()
    }, this.flushInterval)
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    if (this.buffer.length === 0) return

    const entries = this.buffer.splice(0, this.buffer.length)
    await this.writeEntries(entries)
  }

  private async writeEntries(entries: EventLogEntry[]): Promise<void> {
    try {
      const today = new Date().toISOString().split("T")[0]
      const logFile = path.join(this.logDir, `llm-event-logger-${today}.jsonl`)
      
      const lines = entries
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"

      await fs.appendFile(logFile, lines, "utf-8")
    } catch (error) {
      log.error("Failed to write event log", { error, count: entries.length })
    }
  }
}

/**
 * Log cleanup manager
 */
class LogCleanup {
  private cleanupTimer?: NodeJS.Timeout
  private readonly cleanupInterval = 24 * 60 * 60 * 1000 // 24 hours

  constructor(
    private readonly logDir: string,
    private readonly retentionDays: number,
    private readonly maxSizeMB: number,
  ) {}

  start(): void {
    // Run cleanup on start
    void this.cleanup()
    
    // Schedule periodic cleanup
    this.cleanupTimer = setInterval(() => {
      void this.cleanup()
    }, this.cleanupInterval)
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  private async cleanup(): Promise<void> {
    try {
      await this.cleanupByAge()
      await this.cleanupBySize()
    } catch (error) {
      log.error("Log cleanup failed", { error })
    }
  }

  private async cleanupByAge(): Promise<void> {
    const files = await this.getLogFiles()
    const cutoffTime = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000

    for (const file of files) {
      const stats = statSync(file)
      if (stats.mtimeMs < cutoffTime) {
        await fs.unlink(file)
        log.info("Deleted old log file", { file, reason: "age" })
      }
    }
  }

  private async cleanupBySize(): Promise<void> {
    const files = await this.getLogFiles()
    let totalSize = 0

    // Calculate total size
    for (const file of files) {
      const stats = statSync(file)
      totalSize += stats.size
    }

    const maxSizeBytes = this.maxSizeMB * 1024 * 1024

    // If exceeds max size, delete oldest files first
    if (totalSize > maxSizeBytes) {
      const sortedFiles = files.sort((a, b) => {
        return statSync(a).mtimeMs - statSync(b).mtimeMs
      })

      for (const file of sortedFiles) {
        if (totalSize <= maxSizeBytes) break
        
        const stats = statSync(file)
        await fs.unlink(file)
        totalSize -= stats.size
        log.info("Deleted log file", { file, reason: "size" })
      }
    }
  }

  private async getLogFiles(): Promise<string[]> {
    try {
      const files = readdirSync(this.logDir)
      return files
        .filter((f) => f.startsWith("llm-event-logger-") && f.endsWith(".jsonl"))
        .map((f) => path.join(this.logDir, f))
    } catch {
      return []
    }
  }
}

/**
 * Event Logger Plugin
 * 
 * Monitors all OpenCode events and logs them to files for debugging,
 * auditing, and system behavior analysis.
 */
export const EventLoggerPlugin = async (
  input: PluginInput,
  options?: EventLoggerConfig,
): Promise<Hooks> => {
  const config: EventLoggerConfig = {
    level: options?.level ?? "DEBUG",
    output: {
      format: options?.output?.format ?? "json",
      directory: options?.output?.directory ?? path.join(Global.Path.data, "logs", "llm-event-logger"),
    },
    retention: {
      days: options?.retention?.days ?? 30,
      maxSizeMB: options?.retention?.maxSizeMB ?? 100,
    },
    filters: options?.filters ?? {},
  }

  // Ensure log directory exists
  const logDir = config.output!.directory!
  await fs.mkdir(logDir, { recursive: true }).catch(() => {})

  log.info("Event logger plugin initialized", { 
    level: config.level,
    directory: logDir,
    retentionDays: config.retention!.days,
    maxSizeMB: config.retention!.maxSizeMB,
  })

  const buffer = new LogBuffer(logDir, config.output!.format!)
  
  // Start log cleanup manager
  const cleanup = new LogCleanup(
    logDir,
    config.retention!.days!,
    config.retention!.maxSizeMB!,
  )
  cleanup.start()

  /**
   * Check if event type should be logged based on filters
   */
  function shouldLog(eventType: string): boolean {
    const filters = config.filters!
    
    // Check exclude list first
    if (filters.exclude?.some((pattern) => matchPattern(eventType, pattern))) {
      return false
    }
    
    // If include list is set, only log matching events
    if (filters.include?.length) {
      return filters.include.some((pattern) => matchPattern(eventType, pattern))
    }
    
    return true
  }

  /**
   * Simple pattern matching (supports * wildcard)
   */
  function matchPattern(text: string, pattern: string): boolean {
    if (!pattern.includes("*")) {
      return text === pattern
    }
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
    return regex.test(text)
  }

  /**
   * Log an event
   */
  async function logEvent(type: string, source: "bus" | "hook", properties: unknown, sessionID?: string): Promise<void> {
    if (!shouldLog(type)) return

    const entry: EventLogEntry = {
      timestamp: Date.now(),
      type,
      source,
      properties,
      sessionID,
    }

    await buffer.add(entry)
  }

  return {
    /**
     * Monitor all Bus events
     */
    async event({ event }) {
      await logEvent(event.type, "bus", event.properties)
    },

    /**
     * Monitor chat message events
     */
    async "chat.message"(input, output) {
      await logEvent("chat.message", "hook", {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
      }, input.sessionID)
    },

    /**
     * Monitor tool execution before
     */
    async "tool.execute.before"(input, output) {
      await logEvent("tool.execute.before", "hook", {
        sessionID: input.sessionID,
        tool: input.tool,
        callID: input.callID,
        args: output.args,
      }, input.sessionID)
    },

    /**
     * Monitor tool execution after
     */
    async "tool.execute.after"(input, output) {
      await logEvent("tool.execute.after", "hook", {
        sessionID: input.sessionID,
        tool: input.tool,
        callID: input.callID,
        title: output.title,
        metadata: output.metadata,
      }, input.sessionID)
    },

    /**
     * Monitor command execution
     */
    async "command.execute.before"(input, output) {
      await logEvent("command.execute.before", "hook", {
        sessionID: input.sessionID,
        command: input.command,
        arguments: input.arguments,
      }, input.sessionID)
    },

    /**
     * Monitor permission requests
     */
    async "permission.ask"(input, output) {
      await logEvent("permission.ask", "hook", {
        permission: input,
        status: output.status,
      })
    },

    /**
     * Monitor shell environment
     */
    async "shell.env"(input, output) {
      await logEvent("shell.env", "hook", {
        cwd: input.cwd,
        sessionID: input.sessionID,
      }, input.sessionID)
    },

    /**
     * Monitor chat parameters
     */
    async "chat.params"(input, output) {
      await logEvent("chat.params", "hook", {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model?.id,
        temperature: output.temperature,
      }, input.sessionID)
    },

    /**
     * Monitor chat headers
     */
    async "chat.headers"(input, output) {
      // Redact sensitive headers before logging
      const safeHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(output.headers)) {
        if (key.toLowerCase() === "authorization" || key.toLowerCase() === "cookie") {
          safeHeaders[key] = "[REDACTED]"
        } else {
          safeHeaders[key] = value
        }
      }
      await logEvent("chat.headers", "hook", {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model?.id,
        headers: safeHeaders,
      }, input.sessionID)
    },

    /**
     * Monitor tool definition modifications
     */
    async "tool.definition"(input, output) {
      await logEvent("tool.definition", "hook", {
        toolID: input.toolID,
        description: output.description,
      })
    },

    /**
     * Monitor message transformations
     */
    async "experimental.chat.messages.transform"(input, output) {
      await logEvent("experimental.chat.messages.transform", "hook", {
        messageCount: output.messages?.length,
      })
    },

    /**
     * Monitor system prompt transformations
     */
    async "experimental.chat.system.transform"(input, output) {
      await logEvent("experimental.chat.system.transform", "hook", {
        sessionID: input.sessionID,
        model: input.model?.id,
        systemLength: output.system?.length,
      }, input.sessionID)
    },

    /**
     * Monitor session compaction
     */
    async "experimental.session.compacting"(input, output) {
      await logEvent("experimental.session.compacting", "hook", {
        sessionID: input.sessionID,
        contextCount: output.context?.length,
        hasCustomPrompt: !!output.prompt,
      }, input.sessionID)
    },

    /**
     * Monitor compaction auto-continue
     */
    async "experimental.compaction.autocontinue"(input, output) {
      await logEvent("experimental.compaction.autocontinue", "hook", {
        sessionID: input.sessionID,
        agent: input.agent,
        enabled: output.enabled,
        overflow: input.overflow,
      }, input.sessionID)
    },

    /**
     * Monitor text completion
     */
    async "experimental.text.complete"(input, output) {
      await logEvent("experimental.text.complete", "hook", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
        textLength: output.text?.length,
      }, input.sessionID)
    },
  }
}