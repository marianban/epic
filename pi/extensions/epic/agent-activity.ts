export interface ActiveAgentRun {
  readonly repositoryRoot: string
  readonly epicId: string
  readonly startedAtMs: number
  readonly taskId?: string
  readonly role?: string
}

const activeRuns = new Map<string, ActiveAgentRun>()

export function startAgentRun(
  runId: string,
  repositoryRoot: string,
  epicId: string,
  startedAtMs: number,
  taskId: string | undefined,
  role: string
): void {
  if (activeRuns.has(runId)) {
    throw new Error(`Agent run ${runId} is already active.`)
  }
  activeRuns.set(runId, {
    repositoryRoot,
    epicId,
    startedAtMs,
    ...(taskId === undefined ? {} : { taskId }),
    role,
  })
}

export function finishAgentRun(runId: string): void {
  activeRuns.delete(runId)
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
