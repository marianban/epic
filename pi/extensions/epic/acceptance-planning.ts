import { randomUUID } from 'node:crypto'
import type { AgentRunResult } from './agents.ts'
import type { EpicClock, EpicDomainState } from './types.ts'
import type {
  TaskVerificationRecord,
  VerificationPlan,
} from './verification-types.ts'
import {
  PlanValidationError,
  parseVerificationPlan,
  scenarioPlanningPrompt,
  validateVerificationPlan,
  type PlanValidationIssue,
} from './verification-plan.ts'

export type PlanningFailureCategory =
  'invalid_output' | 'invocation' | 'storage' | 'criteria' | 'interrupted'

export class AcceptancePlanningError extends Error {
  readonly category: PlanningFailureCategory
  readonly attempts: number
  readonly issues: PlanValidationIssue[]
  constructor(
    category: PlanningFailureCategory,
    attempts: number,
    reason: string,
    issues: PlanValidationIssue[]
  ) {
    super(`Acceptance planning failed after ${attempts} attempt(s): ${reason}`)
    this.name = 'AcceptancePlanningError'
    this.category = category
    this.attempts = attempts
    this.issues = issues
  }
}

export interface AcceptancePlanningDependencies {
  clock: EpicClock
  repairLimit: number
  initialize(): Promise<TaskVerificationRecord>
  write(record: TaskVerificationRecord): Promise<void>
  persistPlan(plan: VerificationPlan): Promise<string>
  run(prompt: string, invocationId: string): Promise<AgentRunResult>
  event(
    type: string,
    timestamp: string,
    payload: Record<string, unknown>
  ): Promise<void>
}

/** Plan corrections have their own bounded batch, independent of verification allowances. */
export async function prepareAcceptancePlan(
  state: EpicDomainState,
  dependencies: AcceptancePlanningDependencies
): Promise<EpicDomainState> {
  const { clock, repairLimit } = dependencies
  if (!Number.isSafeInteger(repairLimit) || repairLimit < 0)
    throw new Error(
      'Acceptance planning repair limit must be a non-negative safe integer.'
    )
  const batchId = randomUUID()
  const task = state.tasks?.[state.currentTaskIndex]
  if (!task)
    throw new AcceptancePlanningError(
      'criteria',
      0,
      'Current task is missing.',
      []
    )
  let attempts = 0
  let category: PlanningFailureCategory = 'storage'
  let reference: Record<string, unknown> = {}
  const emit = (type: string, payload: Record<string, unknown>) =>
    dependencies.event(type, clock.now(), {
      batchId,
      taskId: task.id,
      attempt: attempts,
      ...reference,
      ...payload,
    })
  try {
    const record = await dependencies.initialize()
    category = 'criteria'
    if (
      record.taskId !== task.id ||
      JSON.stringify(task.acceptanceCriteria) !==
        JSON.stringify(record.criteria.map((criterion) => criterion.text))
    )
      throw new Error(
        'Approved task criteria changed. Explicitly approve a criterion revision before implementation.'
      )
    if (record.plan) {
      validateVerificationPlan(
        record.plan,
        record.criteria,
        record.criterionVersion
      )
      if (
        record.plan.version !== record.plans.length ||
        JSON.stringify(record.plans.at(-1)?.plan) !==
          JSON.stringify(record.plan)
      )
        throw new Error(
          'Persisted acceptance plan does not match its version history.'
        )
    } else {
      let issues: PlanValidationIssue[] = []
      for (let attempt = 0; attempt <= repairLimit; attempt++) {
        attempts = attempt + 1
        const invocationId = randomUUID()
        reference = { invocationId }
        category = 'storage'
        await emit('acceptance_plan_attempt_started', { repairLimit })
        category = 'invocation'
        const run = await dependencies.run(
          `${scenarioPlanningPrompt(record.criteria, record.criterionVersion, record.plans.length + 1)}\nPrevious validation issues: ${JSON.stringify(issues)}`,
          invocationId
        )
        reference = { invocationId, stdoutLogPath: run.stdoutLogPath }
        if (run.exitCode !== 0)
          throw new Error(
            `Verifier invocation failed: ${run.failureReason ?? (run.stderr || `exit code ${run.exitCode}`)}`
          )
        let plan: VerificationPlan
        try {
          plan = validateVerificationPlan(
            parseVerificationPlan(run.output),
            record.criteria,
            record.criterionVersion
          )
          if (plan.version !== record.plans.length + 1)
            throw new PlanValidationError([
              {
                path: 'version',
                code: 'unexpected_version',
                message: `expected scenario version ${record.plans.length + 1}; received ${plan.version}`,
              },
            ])
        } catch (error) {
          if (!(error instanceof PlanValidationError)) throw error
          issues = error.issues
          category = 'storage'
          await emit('acceptance_plan_attempt_rejected', {
            category: 'invalid_output',
            issues,
          })
          if (attempt === repairLimit)
            throw new AcceptancePlanningError(
              'invalid_output',
              attempts,
              error.message,
              issues
            )
          continue
        }
        category = 'storage'
        const artifact = await dependencies.persistPlan(plan)
        record.plan = plan
        record.plans.push({ plan, artifact })
        await dependencies.write(record)
        await emit('acceptance_plan_accepted', {
          artifact,
          scenarioVersion: plan.version,
        })
        break
      }
    }
    return {
      ...state,
      failureReason: undefined,
      lastVerificationReportPath: undefined,
      verificationReadiness: undefined,
    }
  } catch (error) {
    const failure =
      error instanceof AcceptancePlanningError
        ? error
        : new AcceptancePlanningError(
            category,
            attempts,
            error instanceof Error ? error.message : String(error),
            error instanceof PlanValidationError ? error.issues : []
          )
    try {
      await emit('acceptance_plan_failed', {
        category: failure.category,
        issues: failure.issues,
        reason: failure.message,
        exhausted: failure.category === 'invalid_output',
      })
    } catch (persistenceError) {
      throw new AcceptancePlanningError(
        'storage',
        attempts,
        `${failure.message}; could not persist planning failure: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
        failure.issues
      )
    }
    throw failure
  }
}
