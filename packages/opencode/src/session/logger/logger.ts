import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Context, Ref, Scope, Stream, Schedule } from "effect"
import { SessionLoggerSchema } from "./logger-schema"
import { SessionLoggerSink } from "./logger-sink"

const log = Log.create({ service: "session.logger" })
const bufferSize = 100
const flushInterval = "5 seconds"

type BusEvent = {
  id: string
  type: string
  properties: unknown
}

type State = {
  enabled: boolean
  buffer: Ref.Ref<SessionLoggerSchema.Envelope[]>
  sink?: SessionLoggerSink.Sink
  start: Effect.Effect<void>
}

function decodeEnvelope(event: BusEvent) {
  const sessionID =
    typeof event.properties === "object" &&
    event.properties !== null &&
    "sessionID" in event.properties &&
    typeof event.properties.sessionID === "string"
      ? event.properties.sessionID
      : undefined
  return {
    id: event.id,
    time: Date.now(),
    sessionID,
    eventType: event.type,
    source: "sync-bus",
    schemaVersion: 1,
    payload: event.properties,
  } satisfies SessionLoggerSchema.Envelope
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLogger") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    const state = yield* InstanceState.make<State>(
      Effect.fn("SessionLogger.state")(function* (ctx) {
        const cfg = yield* config.get()
        const loggerConfig = cfg.experimental?.session_logger
        const enabled = loggerConfig?.enabled !== false
        const outputDir = loggerConfig?.directory
          ? path.resolve(ctx.directory, loggerConfig.directory)
          : path.join(Global.Path.data, "logs", "session")
        const sink = enabled
          ? yield* SessionLoggerSink.makeJsonlSink({
              directory: outputDir,
            }).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => log.error("failed to initialize sink", { error, directory: outputDir })),
              ),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined
        const buffer = yield* Ref.make<SessionLoggerSchema.Envelope[]>([])
        const flush = Effect.fn("SessionLogger.flush")(function* () {
          if (!sink) return
          const batch = yield* Ref.get(buffer)
          if (batch.length === 0) return
          yield* Ref.set(buffer, [])
          yield* sink.write(batch).pipe(
            Effect.catch((error) => Effect.sync(() => log.error("failed to write session log batch", { error }))),
          )
          yield* sink.flush().pipe(
            Effect.catch((error) => Effect.sync(() => log.error("failed to flush session log sink", { error }))),
          )
        })
        const record = Effect.fn("SessionLogger.record")(function* (event: BusEvent) {
          if (!sink) return
          const envelope = decodeEnvelope(event)
          yield* Ref.update(buffer, (items) => [...items, envelope])
          const size = yield* Ref.get(buffer).pipe(Effect.map((items) => items.length))
          if (size < bufferSize) return
          yield* flush()
        })
        const start = yield* Effect.cached(
          Effect.gen(function* () {
            if (!sink) return
            yield* bus.subscribeAll().pipe(Stream.runForEach(record), Effect.forkIn(scope))
            yield* flush().pipe(Effect.repeat(Schedule.spaced(flushInterval)), Effect.forkIn(scope), Effect.asVoid)
          }),
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* flush().pipe(Effect.ignore)
            if (!sink) return
            yield* sink.close().pipe(Effect.ignore)
          }),
        )

        return { enabled, sink, buffer, start }
      }),
    )

    const init = Effect.fn("SessionLogger.init")(function* () {
      const current = yield* InstanceState.get(state)
      if (!current.enabled) return
      yield* current.start.pipe(
        Effect.catch((error) => Effect.sync(() => log.error("failed to start session logger", { error }))),
      )
    })

    return Service.of({ init })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Config.defaultLayer))

export * as SessionLogger from "./logger"
