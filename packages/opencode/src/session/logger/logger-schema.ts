export type Envelope = {
  id: string
  time: number
  sessionID?: string
  eventType: string
  source: "sync-bus"
  schemaVersion: 1
  payload: unknown
}

export * as SessionLoggerSchema from "./logger-schema"
