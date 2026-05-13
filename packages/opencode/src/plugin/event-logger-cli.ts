#!/usr/bin/env node
import fs from "fs/promises"
import path from "path"
import { createReadStream } from "fs"
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
  timestamp: number
  type: string
  properties: unknown
  sessionID?: string
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
 * Get log files in date range
 */
async function getLogFiles(logDir: string, start?: Date, end?: Date): Promise<string[]> {
  const files = await fs.readdir(logDir)
  
  return files
    .filter((f) => f.startsWith("llm-event-logger-") && f.endsWith(".jsonl"))
    .map((f) => path.join(logDir, f))
    .filter((f) => {
      const match = f.match(/llm-event-logger-(\d{4}-\d{2}-\d{2})\.jsonl$/)
      if (!match) return false

      const fileDate = new Date(match[1])
      
      if (start && fileDate < start) return false
      if (end && fileDate > end) return false
      
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

        // Apply filters
        if (options.start && entry.timestamp < options.start.getTime()) continue
        if (options.end && entry.timestamp > options.end.getTime()) continue
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

    stats.timeRange.start = Math.min(stats.timeRange.start, event.timestamp)
    stats.timeRange.end = Math.max(stats.timeRange.end, event.timestamp)
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
    const timestamp = new Date(event.timestamp).toISOString()
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