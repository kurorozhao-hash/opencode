#!/usr/bin/env node
import fs from "fs/promises"
import path from "path"
import { createReadStream, statSync } from "fs"
import { createInterface } from "readline"
import { Global } from "@opencode-ai/core/global"

/**
 * Event Log Query Tool
 * 
 * Usage:
 *   opencode-event-logs [options]
 * 
 * Options:
 *   --start <date>      Start date (YYYY-MM-DD)
 *   --end <date>        End date (YYYY-MM-DD)
 *   --type <pattern>    Filter by event type (supports wildcards)
 *   --session <id>      Filter by session ID
 *   --stats             Show statistics only
 *   --tail <n>          Show last N events
 *   --help              Show help message
 */

interface QueryOptions {
  start?: Date
  end?: Date
  type?: string
  sessionID?: string
  stats?: boolean
  tail?: number
}

interface EventEntry {
  /** Local time yyyyMMdd HH:mm:ss (new); legacy logs may use epoch ms number. */
  timestamp: string | number
  type: string
  properties: unknown
  sessionID?: string
}

const LOG_TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** Milliseconds for range filters; NaN if unreadable. */
function entryTimeMs(entry: EventEntry): number {
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp
  if (typeof entry.timestamp !== "string") return NaN
  const m = LOG_TIMESTAMP_RE.exec(entry.timestamp.trim())
  if (!m) return NaN
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  const s = Number(m[6])
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

interface EventStats {
  totalEvents: number
  eventTypes: Map<string, number>
  sessions: Set<string>
  errors: number
  timeRange: { start: number; end: number }
}

const DEFAULT_LOG_DIR = path.join(Global.Path.data, "logs", "llm-event-logger")

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): QueryOptions & { help?: boolean } {
  const result: QueryOptions & { help?: boolean } = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case "--start":
        result.start = new Date(args[++i])
        break
      case "--end":
        result.end = new Date(args[++i])
        break
      case "--type":
        result.type = args[++i]
        break
      case "--session":
        result.sessionID = args[++i]
        break
      case "--stats":
        result.stats = true
        break
      case "--tail":
        result.tail = parseInt(args[++i], 10)
        break
      case "--help":
      case "-h":
        result.help = true
        break
    }
  }

  return result
}

/**
 * Show help message
 */
function showHelp(): void {
  console.log(`
Event Logger Query Tool

Usage:
  opencode-event-logs [options]

Options:
  --start <date>      Start date (YYYY-MM-DD)
  --end <date>        End date (YYYY-MM-DD)
  --type <pattern>    Filter by event type (supports wildcards, e.g., session.*)
  --session <id>      Filter by session ID
  --stats             Show statistics only
  --tail <n>          Show last N events (default: 20)
  --help, -h          Show this help message

Examples:
  # Show last 50 events
  opencode-event-logs --tail 50

  # Show events from specific date range
  opencode-event-logs --start 2024-01-01 --end 2024-01-31

  # Show all session events
  opencode-event-logs --type "session.*"

  # Show events for a specific session
  opencode-event-logs --session sess_abc123

  # Show event statistics
  opencode-event-logs --stats
`)
}

/**
 * Match pattern with wildcard support
 */
function matchPattern(text: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return text === pattern
  }
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
  return regex.test(text)
}

/**
 * Get log files; optional start/end filter uses file mtime (works for per-session filenames).
 */
async function getLogFiles(logDir: string, start?: Date, end?: Date): Promise<string[]> {
  const files = await fs.readdir(logDir)

  return files
    .filter((f) => f.startsWith("llm-event-logger-") && f.endsWith(".jsonl"))
    .map((f) => path.join(logDir, f))
    .filter((f) => {
      if (!start && !end) return true
      const stats = statSync(f)
      const m = stats.mtime
      if (start && m < start) return false
      if (end && m > end) return false
      return true
    })
    .sort()
}

/**
 * Read events from log files
 */
async function* readEvents(files: string[], options: QueryOptions): AsyncGenerator<EventEntry> {
  for (const file of files) {
    const fileStream = createReadStream(file, "utf-8")
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      if (!line.trim()) continue

      try {
        const entry: EventEntry = JSON.parse(line)
        const t = entryTimeMs(entry)

        // Apply filters
        if (options.start) {
          if (Number.isNaN(t)) continue
          if (t < options.start.getTime()) continue
        }
        if (options.end) {
          if (Number.isNaN(t)) continue
          if (t > options.end.getTime()) continue
        }
        if (options.type && !matchPattern(entry.type, options.type)) continue
        if (options.sessionID && entry.sessionID !== options.sessionID) continue

        yield entry
      } catch (error) {
        // Skip malformed entries
        console.error(`Failed to parse log entry: ${line}`)
      }
    }

    rl.close()
    fileStream.destroy()
  }
}

/**
 * Display event statistics
 */
async function showStats(files: string[], options: QueryOptions): Promise<void> {
  const stats: EventStats = {
    totalEvents: 0,
    eventTypes: new Map(),
    sessions: new Set(),
    errors: 0,
    timeRange: { start: Infinity, end: 0 },
  }

  for await (const event of readEvents(files, options)) {
    stats.totalEvents++
    
    stats.eventTypes.set(
      event.type,
      (stats.eventTypes.get(event.type) || 0) + 1,
    )

    if (event.sessionID) {
      stats.sessions.add(event.sessionID)
    }

    if (event.type.includes("error")) {
      stats.errors++
    }

    const t = entryTimeMs(event)
    if (!Number.isNaN(t)) {
      stats.timeRange.start = Math.min(stats.timeRange.start, t)
      stats.timeRange.end = Math.max(stats.timeRange.end, t)
    }
  }

  console.log("\n=== Event Log Statistics ===\n")
  console.log(`Total Events: ${stats.totalEvents}`)
  console.log(`Unique Sessions: ${stats.sessions.size}`)
  console.log(`Errors: ${stats.errors}`)
  
  if (stats.timeRange.start !== Infinity) {
    console.log(`Time Range:`)
    console.log(`  Start: ${new Date(stats.timeRange.start).toISOString()}`)
    console.log(`  End: ${new Date(stats.timeRange.end).toISOString()}`)
  }

  console.log("\nEvent Types (Top 10):")
  const sortedTypes = Array.from(stats.eventTypes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  for (const [type, count] of sortedTypes) {
    console.log(`  ${type}: ${count}`)
  }
  console.log()
}

/**
 * Display events
 */
async function showEvents(files: string[], options: QueryOptions): Promise<void> {
  const events: EventEntry[] = []
  const tail = options.tail || 20

  for await (const event of readEvents(files, options)) {
    events.push(event)
    if (events.length > tail * 2) {
      events.shift()
    }
  }

  const displayEvents = events.slice(-tail)

  console.log(`\n=== Last ${displayEvents.length} Events ===\n`)

  for (const event of displayEvents) {
    const timestamp =
      typeof event.timestamp === "string" ? event.timestamp : new Date(event.timestamp).toISOString()
    console.log(`[${timestamp}] ${event.type}`)
    if (event.sessionID) {
      console.log(`  Session: ${event.sessionID}`)
    }
    console.log(`  Properties: ${JSON.stringify(event.properties)}`)
    console.log()
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const options = parseArgs(args)

  if (options.help) {
    showHelp()
    process.exit(0)
  }

  try {
    const logDir = DEFAULT_LOG_DIR
    const files = await getLogFiles(logDir, options.start, options.end)

    if (files.length === 0) {
      console.log("No log files found.")
      process.exit(0)
    }

    if (options.stats) {
      await showStats(files, options)
    } else {
      await showEvents(files, options)
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

// Export for programmatic use
export { readEvents, getLogFiles, showStats, showEvents }
export type { EventEntry, EventStats }

// Run if executed directly
if (import.meta.main) {
  main()
}