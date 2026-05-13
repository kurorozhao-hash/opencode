import path from "path"
import fs from "fs/promises"
import type { Envelope } from "./logger-schema"
import { Effect } from "effect"

export interface Sink {
  readonly write: (batch: ReadonlyArray<Envelope>) => Effect.Effect<void, Error>
  readonly flush: () => Effect.Effect<void, Error>
  readonly close: () => Effect.Effect<void, Error>
}

export type JsonlSinkOptions = {
  directory: string
  filePrefix?: string
}

export const makeJsonlSink = (input: JsonlSinkOptions): Effect.Effect<Sink, Error> =>
  Effect.gen(function* () {
    const filePrefix = input.filePrefix ?? "session-event"
    yield* Effect.tryPromise({
      try: () => fs.mkdir(input.directory, { recursive: true }),
      catch: () => new Error("failed to create session logger directory"),
    })

    const write: Sink["write"] = (batch) =>
      Effect.gen(function* () {
        if (batch.length === 0) return
        const byFile = batch.reduce((acc, item) => {
          const day = new Date(item.time).toISOString().slice(0, 10)
          const target = path.join(input.directory, `${filePrefix}-${day}.jsonl`)
          const lines = acc.get(target)
          if (lines) return acc.set(target, [...lines, JSON.stringify(item)])
          return acc.set(target, [JSON.stringify(item)])
        }, new Map<string, string[]>())
        yield* Effect.forEach(
          Array.from(byFile.entries()),
          ([target, lines]) =>
            Effect.tryPromise({
              try: () => fs.appendFile(target, lines.join("\n") + "\n", "utf-8"),
              catch: () => new Error("failed to append session logger entries"),
            }),
          { concurrency: "unbounded", discard: true },
        )
      })

    return {
      write,
      flush: () => Effect.void,
      close: () => Effect.void,
    } satisfies Sink
  })

export * as SessionLoggerSink from "./logger-sink"
