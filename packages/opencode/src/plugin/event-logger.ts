import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { readdirSync, statSync } from "fs"

/** Same layout as Global.Path.data when XDG_DATA_HOME is unset (~/.local/share/opencode). */
function defaultOpencodeDataDir() {
  const dataHome = process.env.XDG_DATA_HOME?.trim()
  return path.join(dataHome || path.join(os.homedir(), ".local", "share"), "opencode")
}

const pluginLog = {
  info(message: string, data?: Record<string, unknown>) {
    console.error(`[opencode:event-logger] ${message}`, data ?? "")
  },
  error(message: string, data?: Record<string, unknown>) {
    console.error(`[opencode:event-logger] ${message}`, data ?? "")
  },
}

const GLOBAL_SESSION_FILE_KEY = "global"

function trimSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const t = value.trim()
  return t || undefined
}

function extractSessionIdFromProperties(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return
  const p = properties as Record<string, unknown>
  const top =
    trimSessionId(p.sessionID) ??
    trimSessionId(p.sessionId) ??
    trimSessionId(
      typeof p.aggregateID === "string" && p.aggregateID.startsWith("ses") ? p.aggregateID : undefined,
    )
  if (top) return top
  const data = p.data
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>
    const inner = trimSessionId(d.sessionID) ?? trimSessionId(d.sessionId)
    if (inner) return inner
  }
  const nested = p.session
  if (nested && typeof nested === "object") {
    const s = nested as Record<string, unknown>
    if (typeof s.id === "string" && s.id.trim()) return s.id.trim()
  }
  return
}

/** Safe single path segment for `llm-event-logger-<this>.jsonl`. */
function sessionKeyForFilename(sessionID: string | undefined, properties: unknown): string {
  const raw = sessionID?.trim() || extractSessionIdFromProperties(properties)
  if (!raw) return GLOBAL_SESSION_FILE_KEY
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 240)
  return cleaned || GLOBAL_SESSION_FILE_KEY
}

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
 * All log lines use local time: yyyyMMdd HH:mm:ss
 */
function formatLogTimestamp(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const h = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${y}${mo}${day} ${h}:${mi}:${s}`
}

/**
 * Event log entry structure
 */
interface EventLogEntry {
  timestamp: string
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
  private readonly maxSize = 50
  private flushTimer?: NodeJS.Timeout
  private readonly flushInterval = 1000
  private readonly logDir: string
  private readonly format: string
  /** Sanitized session id (or `global`) — one file per key: llm-event-logger-<key>.jsonl */
  private readonly sessionFileKey: string

  constructor(logDir: string, format: string, sessionFileKey: string) {
    this.logDir = logDir
    this.format = format
    this.sessionFileKey = sessionFileKey
  }

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
      const logFile = path.join(this.logDir, `llm-event-logger-${this.sessionFileKey}.jsonl`)
      
      const lines = entries
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"

      await fs.appendFile(logFile, lines, "utf-8")
    } catch (error) {
      pluginLog.error("Failed to write event log", { error, count: entries.length })
    }
  }
}

/**
 * Log cleanup manager
 */
class LogCleanup {
  private cleanupTimer?: NodeJS.Timeout
  private readonly cleanupInterval = 24 * 60 * 60 * 1000 // 24 hours
  private readonly logDir: string
  private readonly retentionDays: number
  private readonly maxSizeMB: number

  constructor(logDir: string, retentionDays: number, maxSizeMB: number) {
    this.logDir = logDir
    this.retentionDays = retentionDays
    this.maxSizeMB = maxSizeMB
  }

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
      pluginLog.error("Log cleanup failed", { error })
    }
  }

  private async cleanupByAge(): Promise<void> {
    const files = await this.getLogFiles()
    const cutoffTime = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000

    for (const file of files) {
      const stats = statSync(file)
      if (stats.mtimeMs < cutoffTime) {
        await fs.unlink(file)
        pluginLog.info("Deleted old log file", { file, reason: "age" })
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
        pluginLog.info("Deleted log file", { file, reason: "size" })
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
      directory: options?.output?.directory ?? path.join(defaultOpencodeDataDir(), "logs", "llm-event-logger"),
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

  pluginLog.info("Event logger plugin initialized", {
    level: config.level,
    directory: logDir,
    retentionDays: config.retention!.days,
    maxSizeMB: config.retention!.maxSizeMB,
  })

  const buffers = new Map<string, LogBuffer>()
  function bufferForSession(sessionFileKey: string): LogBuffer {
    const hit = buffers.get(sessionFileKey)
    if (hit) return hit
    const next = new LogBuffer(logDir, config.output!.format!, sessionFileKey)
    buffers.set(sessionFileKey, next)
    return next
  }

  async function flushAllBuffers() {
    await Promise.all([...buffers.values()].map((b) => b.flush()))
  }
  const drain = () => {
    void flushAllBuffers()
  }
  process.once("beforeExit", drain)

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
      timestamp: formatLogTimestamp(Date.now()),
      type,
      source,
      properties,
      sessionID,
    }

    const key = sessionKeyForFilename(sessionID, properties)
    await bufferForSession(key).add(entry)
  }

  return {
    /**
     * Monitor all Bus events
     */
    async event({ event }) {
      const sid = extractSessionIdFromProperties(event.properties)
      await logEvent(event.type, "bus", event.properties, sid)
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
        messages: output.messages,
      })
    },

    /**
     * Monitor LLM stream input payload
     */
    async "experimental.chat.stream_input"(input, output) {
      await logEvent("experimental.chat.stream_input", "hook", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        agent: input.agent,
        model: input.model,
        systemLength: output.streamInput.system?.length,
        messageCount: output.streamInput.messages?.length,
        toolChoice: output.streamInput.toolChoice,
        small: output.streamInput.small,
        retries: output.streamInput.retries,
        streamInput: config.level === "DEBUG" ? output.streamInput : undefined,
      }, input.sessionID)
    },

    /**
     * Monitor raw LLM stream events
     */
    async "experimental.chat.handle_event"(input, output) {
      await logEvent("experimental.chat.handle_event", "hook", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        agent: input.agent,
        model: input.model,
        // Explicitly keep event.type for query and debugging
        eventType: output.type,
        event: output.value,
      }, input.sessionID)
    },

    /**
     * Monitor system prompt transformations
     */
    async "experimental.chat.system.transform"(input, output) {
      await logEvent("experimental.chat.system.transform", "hook", {
        sessionID: input.sessionID,
        model: input.model?.id,
        systemLength: output.system?.length,
        system: output.system,
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
        context: output.context,
        prompt: output.prompt,
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
        text: output.text,
      }, input.sessionID)
    },
  }
}