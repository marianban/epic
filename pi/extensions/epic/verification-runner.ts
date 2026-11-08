import { dismissedRepairItemIds } from './failure-review.ts'
import { canRepairItem } from './repair-allowance.ts'
import type { BrowserProbeLimits } from './browser-evidence-types.ts'
import { appendEvent } from './persistence.ts'
import { executeVerificationCycle } from './verification-cycle.ts'
import {
  processVerificationCycle,
  selectedPlan,
  repairInstructions,
  deferExhaustedRepair,
} from './verification-schedule.ts'
import { randomUUID } from 'node:crypto'
import type {
  EpicClock,
  EpicTimer,
  EpicDomainState,
  CheckSuiteResult,
  ReviewResult,
} from './types.ts'
import type {
  VerificationOperation,
  VerificationCycle,
  VerificationPlan,
  FindingReviewContext,
} from './verification-types.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from './verification-store.ts'
import { finalizeReviewReport } from './verification-report.ts'

export interface VerificationDependencies {
  createFindingId(): string
  clock: EpicClock
  timer: EpicTimer
  executablePath: string | undefined
  maxOutputBytes: number
  browserProbeLimits: BrowserProbeLimits
  checks(
    state: EpicDomainState,
    suite: 'fast' | 'full',
    operation: VerificationOperation
  ): Promise<{ state: EpicDomainState; result: CheckSuiteResult }>
  review(
    state: EpicDomainState,
    cycle: VerificationCycle,
    operation: VerificationOperation,
    context: FindingReviewContext
  ): Promise<{ state: EpicDomainState; result: ReviewResult }>
  reviewEvidence(
    state: EpicDomainState,
    cycle: VerificationCycle,
    operation: VerificationOperation,
    context: FindingReviewContext
  ): Promise<{ state: EpicDomainState; result: ReviewResult; inspectedObligationIds: string[]; limitations: string[] }>
  repair(
    state: EpicDomainState,
    feedback: string,
    operation: VerificationOperation
  ): Promise<EpicDomainState>
  explore(
    state: EpicDomainState,
    plan: VerificationPlan,
    operation: VerificationOperation,
    errors: string[]
  ): Promise<void>
}

export async function runTaskVerification(
  initial: EpicDomainState,
  externalSignal: AbortSignal,
  dependencies: VerificationDependencies
): Promise<EpicDomainState> {
  let state = initial
  const store = new VerificationStore(
    taskVerificationPath(state),
    dependencies.clock
  )
  const record = await store.read()
  // Keep accepted findings out of automatic repairs while other work continues.
  const dismissedRepairs = record.report ? dismissedRepairItemIds(record) : new Set<string>()
  const interruptedRepair = [...record.invocations]
    .reverse()
    .find((i) => i.kind === 'repair')
  const repairAfterInterruptionGranted =
    !interruptedRepair ||
    interruptedRepair.completed ||
    record.grants.some((g) => g.afterInvocationId === interruptedRepair.id)
  await store.start(record)
  const controller = new AbortController()
  const signal = AbortSignal.any([externalSignal, controller.signal])
  const operation: VerificationOperation = {
    signal,
    remainingMs: () => {
      signal.throwIfAborted()
      const remaining = store.remaining(record)
      if (remaining <= 0)
        throw new Error('Task verification deadline exhausted.')
      return remaining
    },
  }
  const timer = dependencies.timer.setTimeout(
    () => controller.abort(new Error('Task verification deadline exhausted.')),
    Math.max(1, store.remaining(record))
  )
  let identity = record.cycles.at(-1)?.identity ?? randomUUID()
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error)
  const retry = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      operation.remainingMs()
      return await work()
    } catch (error) {
      signal.throwIfAborted()
      if (
        store.remaining(record) <= 0 ||
        record.invocations.filter((i) => i.kind === 'infrastructure').length >=
          record.infrastructureLimit
      )
        throw error
      const id = await store.charge(record, 'infrastructure', errorText(error), undefined)
      const result = await work()
      const invocation = record.invocations.find((i) => i.id === id)
      if (!invocation)
        throw new Error('Charged infrastructure invocation disappeared.', {
          cause: error,
        })
      invocation.completed = true
      await store.write(record)
      return result
    }
  }
  try {
    if (!record.plan)
      throw new Error(
        'Acceptance verification blocked: no independently validated scenario plan.'
      )
    const plan = record.plan
    const schedule = record.schedule
    const latest = record.cycles.at(-1)
    const previouslyFinished = schedule.phase === 'done'
    if (
      state.taskRevalidationRequired ||
      (latest?.plan?.criterionVersion !== undefined &&
        (latest.plan.criterionVersion !== plan.criterionVersion ||
          latest.plan.version !== plan.version))
    ) {
      schedule.phase = 'initial_full'
      schedule.queue = []
      schedule.deferred = []
      schedule.finalRequired = false
      delete schedule.repairInvocationId
      schedule.processedCycleId = latest?.id
    } else if (latest?.completed && schedule.processedCycleId !== latest.id) {
      processVerificationCycle(record, latest)
    }
    // An explicit resume from a completed report performs fresh verification.
    if (previouslyFinished && schedule.phase === 'done')
      schedule.phase = record.invocations.some((i) => i.kind === 'repair')
        ? 'final_full'
        : 'initial_full'
    const pending = record.humanRepairRequests.find(
      (r) => !r.completed && !r.invocationId
    )
    if (pending) {
      if (!repairAfterInterruptionGranted)
        throw new Error(
          'Interrupted repair requires an explicit additional grant.'
        )
      schedule.finalRequired = true
      schedule.phase = 'final_full'
      schedule.queue = []
      const invocationId = await store.charge(
        record,
        'repair',
        pending.feedback,
        'human:requested',
        pending
      )
      state = await dependencies.repair(state, pending.feedback, operation)
      record.state = state
      const invocation = record.invocations.find((i) => i.id === invocationId)
      if (!invocation)
        throw new Error('Charged human repair invocation disappeared.')
      invocation.completed = true
      pending.completed = true
      schedule.finalRequired = true
      schedule.phase = 'final_full'
      schedule.queue = []
      await store.write(record)
    }
    while (store.remaining(record) > 0 && !signal.aborted) {
      const phase = record.schedule.phase
      if (phase === 'done') break
      const target =
        schedule.phase === 'targeted' ? schedule.queue[0] : undefined
      if (schedule.phase === 'targeted' && !target)
        throw new Error('Targeted verification requires a queued item.')
      if (target?.action === 'repair') {
        if (dismissedRepairs.has(target.id)) {
          schedule.deferred.push(...schedule.queue.splice(0, 1))
          schedule.phase = schedule.queue.length ? 'targeted' : schedule.finalRequired ? 'final_full' : 'done'
          delete schedule.repairInvocationId
          await store.write(record)
          continue
        }
        if (!repairAfterInterruptionGranted) {
          if (schedule.finalRequired) {
            schedule.deferred.push(...schedule.queue)
            schedule.queue = []
            schedule.phase = 'final_full'
            delete schedule.repairInvocationId
            await store.write(record)
            continue
          }
          break
        }
        if (!schedule.repairInvocationId) {
          if (!canRepairItem(record, target.id)) {
            deferExhaustedRepair(record, target)
            await store.write(record)
            continue
          }
          const id = await store.charge(
            record,
            'repair',
            repairInstructions(target),
            target.id
          )
          schedule.repairInvocationId = id
          schedule.finalRequired = true
          await store.write(record)
        }
        const invocation = record.invocations.find(
          (i) => i.id === schedule.repairInvocationId
        )
        if (!invocation)
          throw new Error('Scheduled repair invocation disappeared.')
        if (!invocation.completed && repairAfterInterruptionGranted) {
          // A resumed interrupted invocation needs a fresh charged attempt.
          if (interruptedRepair?.id === invocation.id) {
            schedule.repairInvocationId = await store.charge(
              record,
              'repair',
              repairInstructions(target),
              target.id
            )
            await store.write(record)
          }
          const charged = record.invocations.find(
            (i) => i.id === schedule.repairInvocationId
          )
          if (!charged)
            throw new Error('Charged repair invocation disappeared.')
          state = await dependencies.repair(state, charged.reason, operation)
          record.state = state
          charged.completed = true
          await store.write(record)
        }
      }
      identity = randomUUID()
      const cycle: VerificationCycle = {
        id: randomUUID(),
        identity,
        attempt: record.cycles.length + 1,
        kind: phase,
        target,
        repairInvocationId: schedule.repairInvocationId,
        candidateRevision: record.invocations.filter((i) => i.kind === 'repair')
          .length,
        completed: false,
        evidence: [],
        evidenceReviews: [],
        problems: [],
        artifacts: [
          ...record.plans.map((p) => p.artifact),
          ...(state.lastDiffPath ? [state.lastDiffPath] : []),
        ],
        state,
        plan: target ? selectedPlan(plan, target) : plan,
      }
      record.cycles.push(cycle)
      await store.write(record)
      await appendEvent(
        state,
        'verifying_acceptance',
        dependencies.clock.now(),
        'verification_cycle_started',
        {
          cycleId: cycle.id,
          kind: cycle.kind,
          target: target?.id,
          remainingItems: schedule.queue.map((item) => item.id),
          finalRequired: schedule.finalRequired,
        }
      )
      state = await executeVerificationCycle(
        state,
        cycle,
        record,
        store,
        dependencies,
        operation,
        retry
      )
      if (!cycle.completed) break
      processVerificationCycle(record, cycle)
      await store.write(record)
      await appendEvent(
        state,
        'verifying_acceptance',
        dependencies.clock.now(),
        'verification_cycle_completed',
        {
          cycleId: cycle.id,
          kind: cycle.kind,
          target: target?.id,
          remainingItems: schedule.queue.map((item) => item.id),
          deferredItems: schedule.deferred.map((item) => item.id),
          nextPhase: schedule.phase,
          finalRequired: schedule.finalRequired,
        }
      )
    }
  } catch (error) {
    const cycle = record.cycles.at(-1)
    if (cycle) cycle.problems.push({ stage: 'interruption', obligationIds: [], message: errorText(error) })
    else
      record.cycles.push({
        id: randomUUID(),
        identity,
        attempt: 1,
        kind: 'initial_full',
        completed: false,
        candidateRevision: record.invocations.filter((i) => i.kind === 'repair')
          .length,
        evidence: [],
        evidenceReviews: [],
        problems: [{ stage: 'interruption', obligationIds: [], message: errorText(error) }],
        artifacts: [],
        state,
      })
  } finally {
    dependencies.timer.clearTimeout(timer)
  }
  // Cleanup and local report construction may finish after the allowance. No agent work here.
  return finalizeReviewReport(state, record, identity, store)
}
