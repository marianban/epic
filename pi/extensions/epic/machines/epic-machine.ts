import { assign, fromPromise, sendTo, setup } from 'xstate'
import type {
  PlannerContextRequest,
  ScoutReport,
  EpicDomainState,
  TaskFailureDiagnostics,
  RecoveryDiagnostics,
  RecoveryOperation,
} from '../types.ts'
import { RecoverableRepositoryError } from '../git-checkpoints.ts'
import { parseEpicDomainState } from '../domain-validation.ts'
import {
  createTaskExecutionMachine,
  type TaskExecutionEvent,
  type TaskExecutionResult,
} from './task-execution-machine.ts'
import type { EpicServices } from '../services.ts'
export { EPIC_MACHINE_VERSION, EPIC_SCHEMA_VERSION } from '../persistence-version.ts'

interface EpicMachineContext {
  state: EpicDomainState
  report?: ScoutReport
  focusedQuestions?: string[]
  failureDiagnostics?: TaskFailureDiagnostics
  recovery?: RecoveryDiagnostics
}
export type EpicMachineEvent =
  | { type: 'EPIC.START' }
  | { type: 'EPIC.RESUME' }
  | { type: 'RECOVERY.APPROVE' }
  | { type: 'PLAN.REVIEW'; force?: boolean }
  | { type: 'PLAN.APPROVE' }
  | { type: 'PLAN.REVISE' }
  | { type: 'PREREQUISITES.APPROVE' }
  | { type: 'TASK.APPROVE' }
  | { type: 'TASK.REVIEW' }
  | { type: 'TASK.REVISE' }

export function validateTaskExecutionResult(
  output: unknown
): TaskExecutionResult {
  if (!output || typeof output !== 'object')
    throw new Error('Task actor completed without an output.')
  const result = output as Partial<TaskExecutionResult>
  if ((result.kind !== 'completed' && result.kind !== 'escalated') || !result.repairs)
    throw new Error('Task actor completed with a malformed output.')
  const repairs = result.repairs
  if (
    ![repairs.fast, repairs.full, repairs.semantic].every(
      (attempt) => Number.isInteger(attempt) && attempt >= 0
    )
  )
    throw new Error('Task actor completed with malformed repair attempts.')
  if (
    result.kind === 'escalated' &&
    (!result.reason || typeof result.reason !== 'string')
  )
    throw new Error('Task actor escalation requires a failure reason.')
  const domain = parseEpicDomainState(result.domain, 'task execution result.domain')
  return { ...result, domain, repairs: { fast: repairs.fast, full: repairs.full, semantic: repairs.semantic } } as TaskExecutionResult
}

export function createEpicMachine(services: EpicServices) {
  const recovery = (operation: RecoveryOperation, error: unknown): RecoveryDiagnostics => {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof RecoverableRepositoryError) {
      return {
        operation, reason, action: error.action,
        baselineSha: error.baselineSha,
        candidateHeadSha: error.candidateHeadSha,
        changedPaths: [...error.changedPaths],
        requiresRevalidation: error.requiresRevalidation,
      }
    }
    return { operation, reason, action: 'retry', changedPaths: [], requiresRevalidation: false }
  }
  const task = createTaskExecutionMachine(services)
  const classify = fromPromise<EpicDomainState, { state: EpicDomainState }>(
    ({ input }) => Promise.resolve(services.classify(input.state))
  )
  const scout = fromPromise<
    { state: EpicDomainState; report: ScoutReport },
    { state: EpicDomainState; questions?: string[] }
  >(({ input }) => services.scout(input.state, input.questions))
  const plan = fromPromise<
    { state: EpicDomainState; result: string | PlannerContextRequest },
    { state: EpicDomainState; report: ScoutReport }
  >(({ input }) => services.plan(input.state, input.report))
  const planReview = fromPromise<
    { state: EpicDomainState; revised: boolean },
    { state: EpicDomainState; force: boolean }
  >(({ input }) => services.reviewPlan(input.state, input.force))
  const approvePlan = fromPromise<EpicDomainState, { state: EpicDomainState }>(
    ({ input }) => services.approvePlan(input.state)
  )
  const decompose = fromPromise<EpicDomainState, { state: EpicDomainState }>(
    ({ input }) => services.decompose(input.state)
  )
  const prerequisites = fromPromise<
    EpicDomainState,
    { state: EpicDomainState }
  >(({ input }) => services.prerequisites(input.state))
  const prepare = fromPromise<EpicDomainState, { state: EpicDomainState }>(
    ({ input }) => services.preparePrerequisites(input.state)
  )
  const finalChecks = fromPromise<
    { state: EpicDomainState; result: { passed: boolean } },
    { state: EpicDomainState }
  >(({ input }) => services.checks(input.state, 'final'))
  const checkpoint = fromPromise<EpicDomainState, { state: EpicDomainState }>(
    ({ input }) => services.checkpointTask(input.state)
  )
  const recordRecovery = fromPromise<EpicDomainState, { state: EpicDomainState; recovery: RecoveryDiagnostics }>(
    ({ input }) => services.recordRecovery(input.state, input.recovery)
  )
  const approveRecovery = fromPromise<EpicDomainState, { state: EpicDomainState; recovery: RecoveryDiagnostics }>(
    ({ input }) => services.approveRecovery(input.state, input.recovery)
  )
  return setup({
    types: {
      context: {} as EpicMachineContext,
      input: {} as { state: EpicDomainState },
      events: {} as EpicMachineEvent,
    },
    actors: {
      classify,
      scout,
      plan,
      planReview,
      approvePlan,
      decompose,
      prerequisites,
      prepare,
      finalChecks,
      checkpoint,
      recordRecovery,
      approveRecovery,
      task,
    },
    actions: {
      acceptResume: () => undefined,
      forwardTask: sendTo(
        'task-execution',
        ({ event }) => event as unknown as TaskExecutionEvent
      ),
      clearRecovery: assign({ recovery: undefined }),
    },
  }).createMachine({
    id: 'epic',
    initial: 'idle',
    context: ({ input }) => ({
      state: input.state,
    }),
    // Exiting the dashboard is UI-only. Keep resume available after an exit
    // from every persisted workflow state; states with an explicit resume
    // transition below retain their state-specific behavior.
    on: {
      'EPIC.RESUME': { actions: 'acceptResume' },
    },
    states: {
      idle: { on: { 'EPIC.START': 'classifying' } },
      classifying: {
        tags: ['active', 'classifying'],
        invoke: {
          src: 'classify',
          input: ({ context }) => ({ state: context.state }),
          onDone: {
            target: 'planning.scouting',
            actions: assign({ state: ({ event }) => event.output }),
          },
          onError: { target: 'recovering', actions: assign({ recovery: ({ event }) => recovery('classify', event.error) }) },
        },
      },
      planning: {
        initial: 'scouting',
        states: {
          scouting: {
            tags: ['active', 'scouting'],
            invoke: {
              src: 'scout',
              input: ({ context }) => ({
                state: context.state,
                questions: context.focusedQuestions,
              }),
              onDone: {
                target: 'generating',
                actions: assign({
                  state: ({ event }) => event.output.state,
                  report: ({ event }) => event.output.report,
                  focusedQuestions: undefined,
                }),
              },
              onError: { target: '#epic.recovering', actions: assign({ recovery: ({ event }) => recovery('scout', event.error) }) },
            },
          },
          generating: {
            tags: ['active', 'planning'],
            invoke: {
              src: 'plan',
              input: ({ context }) => {
                if (!context.report) throw new Error('Scout report is missing.')
                return { state: context.state, report: context.report }
              },
              onDone: [
                {
                  guard: ({ event }) => typeof event.output.result === 'string',
                  target: 'awaitingReview',
                  actions: assign({
                    state: ({ event }) => event.output.state,
                  }),
                },
                {
                  target: 'scouting',
                  actions: assign({
                    state: ({ event }) => event.output.state,
                    focusedQuestions: ({ event }) =>
                      (
                        (event.output.result as PlannerContextRequest)
                          .questions ?? []
                      ).map(
                        (q: { question: string; reason: string }) =>
                          `${q.question} (${q.reason})`
                      ),
                  }),
                },
              ],
              onError: { target: '#epic.recovering', actions: assign({ recovery: ({ event }) => recovery('plan', event.error) }) },
            },
          },
          awaitingReview: {
            tags: ['awaiting-human', 'awaiting-plan-review'],
            on: {
              'PLAN.REVIEW': 'revising',
              'PLAN.REVISE': 'revising',
              'PLAN.APPROVE': 'approving',
            },
          },
          revising: {
            invoke: {
              src: 'planReview',
              input: ({ context, event }) => ({
                state: context.state,
                force:
                  event.type === 'PLAN.REVISE' ||
                  (event as { force?: boolean }).force === true,
              }),
              onDone: {
                target: 'awaitingReview',
                actions: assign({
                  state: ({ event }) => event.output.state,
                }),
              },
              onError: { target: '#epic.recovering', actions: assign({ recovery: ({ event }) => recovery('review-plan', event.error) }) },
            },
          },
          awaitingApproval: {
            tags: ['awaiting-human', 'awaiting-plan-approval'],
            on: {
              'PLAN.REVIEW': 'revising',
              'PLAN.REVISE': 'revising',
              'PLAN.APPROVE': 'approving',
            },
          },
          approving: {
            invoke: {
              src: 'approvePlan',
              input: ({ context }) => ({ state: context.state }),
              onDone: {
                target: '#epic.decomposingTasks',
                actions: assign({ state: ({ event }) => event.output }),
              },
              onError: { target: '#epic.recovering', actions: assign({ recovery: ({ event }) => recovery('approve-plan', event.error) }) },
            },
          },
        },
      },
      decomposingTasks: {
        tags: ['active', 'task-decomposition'],
        invoke: {
          src: 'decompose',
          input: ({ context }) => ({ state: context.state }),
          onDone: {
            target: 'prerequisites.checking',
            actions: assign({ state: ({ event }) => event.output }),
          },
          onError: { target: 'recovering', actions: assign({ recovery: ({ event }) => recovery('decompose', event.error) }) },
        },
      },
      prerequisites: {
        initial: 'checking',
        states: {
          checking: {
            tags: ['active', 'prerequisites'],
            invoke: {
              src: 'prerequisites',
              input: ({ context }) => ({ state: context.state }),
              onDone: [
                {
                  guard: ({ event }) =>
                    event.output.prerequisites?.length === 0,
                  target: '#epic.taskExecution',
                  actions: assign({
                    state: ({ event }) => event.output,
                  }),
                },
                {
                  target: 'awaitingApproval',
                  actions: assign({
                    state: ({ event }) => event.output,
                  }),
                },
              ],
              onError: { target: '#epic.recovering', actions: assign({ recovery: ({ event }) => recovery('check-prerequisites', event.error) }) },
            },
          },
          awaitingApproval: {
            tags: ['awaiting-human', 'awaiting-prerequisite-approval'],
            on: {
              'PREREQUISITES.APPROVE': 'preparing',
            },
          },
          preparing: {
            invoke: {
              src: 'prepare',
              input: ({ context }) => ({ state: context.state }),
              onDone: {
                target: '#epic.taskExecution',
                actions: assign({
                  state: ({ event }) => event.output,
                }),
              },
              onError: { target: '#epic.recovering', actions: assign({ recovery: ({ event }) => recovery('prepare-prerequisites', event.error) }) },
            },
          },
        },
      },
      taskExecution: {
        tags: ['active', 'task-execution'],
        invoke: {
          id: 'task-execution',
          src: 'task',
          input: ({ context }) => ({
            domain: context.state,
            mode: context.state.taskRevalidationRequired ? 'revalidate' as const : 'normal' as const,
          }),
          onDone: [
            {
              guard: ({ event }) =>
                validateTaskExecutionResult(event.output).kind ===
                  'completed' &&
                validateTaskExecutionResult(event.output).domain
                  .currentTaskIndex +
                  1 <
                  (validateTaskExecutionResult(event.output).domain.tasks
                    ?.length ?? 0),
              target: 'checkpointing',
              actions: assign({
                state: ({ event }) => validateTaskExecutionResult(event.output).domain,
              }),
            },
            {
              guard: ({ event }) =>
                validateTaskExecutionResult(event.output).kind === 'completed',
              target: 'checkpointing',
              actions: assign({
                state: ({ event }) =>
                  validateTaskExecutionResult(event.output).domain,
              }),
            },
            {
              target: 'escalating',
              actions: assign({
                state: ({ event }) => {
                  const result = validateTaskExecutionResult(event.output)
                  return {
                    ...result.domain,
                    failureReason:
                      result.reason ??
                      result.domain.failureReason ??
                      'Task actor failed.',
                  }
                },
                failureDiagnostics: ({ event }) => {
                  const result = validateTaskExecutionResult(event.output)
                  return { reason: result.reason ?? 'Task actor failed.', repairs: result.repairs }
                },
              }),
            },
          ],
        },
        on: {
          'TASK.APPROVE': { actions: 'forwardTask' },
          'TASK.REVIEW': { actions: 'forwardTask' },
          'TASK.REVISE': { actions: 'forwardTask' },
          'EPIC.RESUME': { actions: 'forwardTask' },
        },
      },
      checkpointing: {
        tags: ['active', 'checkpointing'],
        invoke: {
          src: 'checkpoint',
          input: ({ context }) => ({ state: context.state }),
          onDone: [
            {
              guard: ({ event }) => event.output.currentTaskIndex + 1 < (event.output.tasks?.length ?? 0),
              target: 'taskExecution',
              actions: assign({
                state: ({ event }) => ({ ...event.output, currentTaskIndex: event.output.currentTaskIndex + 1, taskApproved: false, taskApprovedAt: undefined, taskBaselineSha: undefined }),
              }),
            },
            { target: 'finalVerification', actions: assign({ state: ({ event }) => event.output }) },
          ],
          onError: { target: 'recovering', actions: assign({ recovery: ({ event }) => recovery('checkpoint-task', event.error) }) },
        },
      },
      recovering: {
        initial: 'recording',
        states: {
          recording: {
            invoke: {
              src: 'recordRecovery',
              input: ({ context }) => {
                if (!context.recovery) throw new Error('Recovery diagnostics are missing.')
                return { state: context.state, recovery: context.recovery }
              },
              onDone: {
                target: 'awaitingApproval',
                actions: assign({ state: ({ event }) => event.output }),
              },
              onError: {
                target: '#epic.terminal.failed',
                actions: assign({
                  state: ({ context, event }) => ({
                    ...context.state,
                    failureReason: event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                  }),
                }),
              },
            },
          },
          awaitingApproval: {
            tags: ['awaiting-human', 'awaiting-recovery-approval'],
            on: { 'RECOVERY.APPROVE': 'approving' },
          },
          approving: {
            invoke: {
              src: 'approveRecovery',
              input: ({ context }) => {
                if (!context.recovery) throw new Error('Recovery diagnostics are missing.')
                return { state: context.state, recovery: context.recovery }
              },
              onDone: [
                { guard: ({ context }) => context.recovery?.operation === 'classify', target: '#epic.classifying', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'scout', target: '#epic.planning.scouting', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'plan', target: '#epic.planning.generating', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'review-plan', target: '#epic.planning.revising', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'approve-plan', target: '#epic.planning.approving', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'decompose', target: '#epic.decomposingTasks', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'check-prerequisites', target: '#epic.prerequisites.checking', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'prepare-prerequisites', target: '#epic.prerequisites.preparing', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'task-execution', target: '#epic.taskExecution', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context, event }) => context.recovery?.operation === 'checkpoint-task' && event.output.taskRevalidationRequired === true, target: '#epic.taskExecution', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'checkpoint-task', target: '#epic.checkpointing', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
                { guard: ({ context }) => context.recovery?.operation === 'final-verification', target: '#epic.finalVerification', actions: assign({ state: ({ event }) => event.output, recovery: undefined }) },
              ],
              onError: {
                target: 'recording',
                actions: assign({
                  recovery: ({ context, event }) => recovery(context.recovery?.operation ?? 'checkpoint-task', event.error),
                }),
              },
            },
          },
        },
      },
      escalating: {
        tags: ['awaiting-human', 'escalated'],
        on: {
          'EPIC.RESUME': { target: 'taskExecution', actions: assign({ failureDiagnostics: undefined }) },
        },
      },
      finalVerification: {
        tags: ['active', 'final-verification'],
        invoke: {
          src: 'finalChecks',
          input: ({ context }) => ({ state: context.state }),
          onDone: [
            {
              guard: ({ event }) => event.output.result.passed,
              target: 'terminal.completed',
              actions: assign({
                state: ({ event }) => event.output.state,
              }),
            },
            {
              target: 'recovering',
              actions: assign({
                state: ({ event }) => ({
                  ...event.output.state,
                  failureReason: 'Final verification failed.',
                }),
                recovery: () => ({ operation: 'final-verification', reason: 'Final verification failed.', action: 'retry', changedPaths: [], requiresRevalidation: false }),
              }),
            },
          ],
          onError: { target: 'recovering', actions: assign({ recovery: ({ event }) => recovery('final-verification', event.error) }) },
        },
      },
      terminal: {
        initial: 'completed',
        states: {
          completed: { type: 'final', tags: ['terminal', 'completed'] },
          failed: { type: 'final', tags: ['terminal', 'failed'] },
        },
      },
    },
  })
}
