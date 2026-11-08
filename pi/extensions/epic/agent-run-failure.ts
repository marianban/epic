export interface AgentFailureTelemetry {
  readonly stdoutLogPath: string
  readonly usage?: Record<string, unknown>
  readonly provider?: string
  readonly model?: string
}

/** Preserve the original failure semantics alongside measurements already received. */
export class AgentRunFailure extends Error {
  readonly telemetry: AgentFailureTelemetry

  constructor(error: Error, telemetry: AgentFailureTelemetry) {
    super(error.message, { cause: error.cause })
    this.name = error.name
    this.telemetry = telemetry
  }
}
