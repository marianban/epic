import type { AgentProfile } from './types.ts'

export interface ActiveAgentRun {
  readonly repositoryRoot: string
  readonly epicId: string
  readonly invocationId: string
  readonly startedAtMs: number
  readonly role: string
  readonly action: string
  readonly taskId?: string
  readonly provider?: string
  readonly model?: string
  readonly thinking?: NonNullable<AgentProfile['thinking']>
}

const activeRuns = new Map<string, ActiveAgentRun>()

export function startAgentRun(
  invocationId: string,
  repositoryRoot: string,
  epicId: string,
  startedAtMs: number,
  taskId: string | undefined,
  role: string,
  action = 'unknown',
  metadata: {
    readonly provider?: string
    readonly model?: string
    readonly thinking?: NonNullable<AgentProfile['thinking']>
  } = {}
): void {
  if (activeRuns.has(invocationId)) {
    throw new Error(`Agent run ${invocationId} is already active.`)
  }
  activeRuns.set(invocationId, {
    repositoryRoot,
    epicId,
    invocationId,
    startedAtMs,
    ...(taskId === undefined ? {} : { taskId }),
    role,
    action,
    ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
    ...(metadata.model === undefined ? {} : { model: metadata.model }),
    ...(metadata.thinking === undefined ? {} : { thinking: metadata.thinking }),
  })
}

export function finishAgentRun(invocationId: string): void {
  activeRuns.delete(invocationId)
}

export function activeAgentRuns(
  repositoryRoot: string,
  epicId: string,
  nowMs: number
): readonly ActiveAgentRun[] {
  if (!Number.isInteger(nowMs) || nowMs < 0) {
    throw new Error(
      `Agent activity time must be a non-negative integer: ${nowMs}`
    )
  }
  return [...activeRuns.values()].filter(
    (run) =>
      run.repositoryRoot === repositoryRoot &&
      run.epicId === epicId &&
      run.startedAtMs <= nowMs
  )
}
