import { assign, fromPromise, setup } from 'xstate'
import type { EpicDomainState, RepairAttempts } from '../types.ts'
import type { TaskDecisionRequest } from '../verification-types.ts'
import type { EpicServices } from '../services.ts'

interface TaskExecutionContext {
  domain: EpicDomainState
  repairs: RepairAttempts
  revalidate: boolean
  failureReason?: string
  decision?: TaskDecisionRequest
}
export type TaskExecutionEvent =
  | { type: 'TASK.APPROVE' }
  | { type: 'TASK.REVIEW' }
  | { type: 'TASK.REVISE' }
  | { type: 'TASK.DECIDE'; request: TaskDecisionRequest }
  | { type: 'TASK.CANCEL' }
  | { type: 'EPIC.RESUME' }
export type TaskExecutionResult =
  | {
      kind: 'completed'
      domain: EpicDomainState
      repairs: RepairAttempts
      reason?: never
    }
  | {
      kind: 'escalated'
      domain: EpicDomainState
      repairs: RepairAttempts
      reason: string
    }

export function createTaskExecutionMachine(services: EpicServices) {
  const operation = (
    work: (
      state: EpicDomainState,
      signal: AbortSignal
    ) => Promise<EpicDomainState>
  ) =>
    fromPromise<EpicDomainState, { context: TaskExecutionContext }>(
      ({ input, signal }) => work(input.context.domain, signal)
    )
  return setup({
    types: {
      context: {} as TaskExecutionContext,
      input: {} as { domain: EpicDomainState; mode?: 'normal' | 'revalidate' },
      events: {} as TaskExecutionEvent,
    },
    actors: {
      prepare: operation((state) => services.prepareVerification(state)),
      implement: operation((state) => services.implement(state)),
      verify: operation((state, signal) => services.verifyTask(state, signal)),
      revise: operation((state) => services.reviseTask(state)),
      finalize: fromPromise<EpicDomainState, { context: TaskExecutionContext }>(
        ({ input }) =>
          services.finalizeTask(
            input.context.domain,
            input.context.failureReason ?? 'Task operation interrupted.'
          )
      ),
      decide: fromPromise<EpicDomainState, { context: TaskExecutionContext }>(
        ({ input }) => {
          if (!input.context.decision)
            throw new Error('Task decision is missing.')
          return services.taskDecision(
            input.context.domain,
            input.context.decision
          )
        }
      ),
    },
    actions: {
      captureState: assign({
        domain: ({ event }) =>
          (event as unknown as { output: EpicDomainState }).output,
        failureReason: undefined,
      }),
      captureError: assign(({ context, event }) => {
        const error = (event as unknown as { error: unknown }).error
        const failureReason =
          error instanceof Error ? error.message : String(error)
        return { failureReason, domain: { ...context.domain, failureReason } }
      }),
    },
  }).createMachine({
    id: 'taskExecution',
    initial: 'routing',
    context: ({ input }) => ({
      domain: input.domain,
      revalidate: input.mode === 'revalidate',
      repairs: { fast: 0, full: 0, semantic: 0 },
    }),
    output: ({ event }) => event.output as TaskExecutionResult,
    states: {
      routing: {
        always: [
          { guard: ({ context }) => context.revalidate, target: 'verifying' },
          { target: 'awaitingApproval' },
        ],
      },
      awaitingApproval: {
        tags: ['awaiting-human', 'awaiting-task-approval'],
        on: {
          'TASK.APPROVE': {
            target: 'planningAcceptance',
            actions: assign({
              domain: ({ context }) => ({
                ...context.domain,
                taskApproved: true,
                taskApprovedAt: services.now(),
              }),
            }),
          },
          'TASK.REVIEW': 'revisingTask',
        },
      },
      revisingTask: {
        invoke: {
          src: 'revise',
          input: ({ context }) => ({ context }),
          onDone: { target: 'awaitingApproval', actions: 'captureState' },
          onError: { target: 'finalizing', actions: 'captureError' },
        },
      },
      revisingCompletedTask: {
        invoke: {
          src: 'revise',
          input: ({ context }) => ({ context }),
          onDone: { target: 'awaitingReview', actions: 'captureState' },
          onError: { target: 'finalizing', actions: 'captureError' },
        },
      },
      planningAcceptance: {
        invoke: {
          src: 'prepare',
          input: ({ context }) => ({ context }),
          onDone: { target: 'implementing', actions: 'captureState' },
          onError: { target: 'acceptancePlanningFailed', actions: 'captureError' },
        },
      },
      acceptancePlanningFailed: {
        tags: ['awaiting-human', 'acceptance-planning-failed'],
        on: { 'EPIC.RESUME': 'planningAcceptance' },
      },
      replanningAcceptance: {
        invoke: {
          src: 'prepare',
          input: ({ context }) => ({ context }),
          onDone: { target: 'verifying', actions: 'captureState' },
          onError: { target: 'acceptanceReplanningFailed', actions: 'captureError' },
        },
      },
      acceptanceReplanningFailed: {
        tags: ['awaiting-human', 'acceptance-planning-failed'],
        on: { 'EPIC.RESUME': 'replanningAcceptance' },
      },
      implementing: {
        on: { 'TASK.CANCEL': 'interrupted' },
        invoke: {
          src: 'implement',
          input: ({ context }) => ({ context }),
          onDone: { target: 'verifying', actions: 'captureState' },
          onError: { target: 'finalizing', actions: 'captureError' },
        },
      },
      verifying: {
        tags: ['active', 'verification'],
        on: { 'TASK.CANCEL': 'interrupted' },
        invoke: {
          src: 'verify',
          input: ({ context }) => ({ context }),
          onDone: { target: 'awaitingReview', actions: 'captureState' },
          onError: { target: 'finalizing', actions: 'captureError' },
        },
      },
      interrupted: {
        entry: assign({
          failureReason:
            'Task interrupted; explicit resume verifies within the remaining allowance and does not repeat repairs.',
        }),
        always: 'finalizing',
      },
      finalizing: {
        invoke: {
          src: 'finalize',
          input: ({ context }) => ({ context }),
          onDone: { target: 'awaitingReview', actions: 'captureState' },
          onError: { target: 'awaitingReview', actions: 'captureError' },
        },
      },
      awaitingReview: {
        tags: ['awaiting-human', 'awaiting-task-review'],
        on: {
          'TASK.APPROVE': {
            target: 'deciding',
            actions: assign({ decision: { kind: 'approve' } }),
          },
          'TASK.DECIDE': {
            target: 'deciding',
            actions: assign({ decision: ({ event }) => event.request }),
          },
          'TASK.REVIEW': {
            target: 'awaitingReview',
            actions: assign({
              failureReason:
                'Use /task-repair without arguments to grant one additional repair attempt and five additional minutes for the latest issues.',
            }),
          },
          'TASK.REVISE': 'revisingCompletedTask',
          'EPIC.RESUME': 'verifying',
        },
      },
      deciding: {
        invoke: {
          src: 'decide',
          input: ({ context }) => ({ context }),
          onDone: [
            {
              guard: ({ context }) =>
                context.decision?.kind === 'approve',
              target: 'done',
              actions: 'captureState',
            },
            {
              guard: ({ context }) => context.decision?.kind === 'grant',
              target: 'verifying',
              actions: 'captureState',
            },
            {
              guard: ({ context }) =>
                context.decision?.kind === 'revise_criteria',
              target: 'replanningAcceptance',
              actions: 'captureState',
            },
            { target: 'awaitingReview', actions: 'captureState' },
          ],
          onError: { target: 'awaitingReview', actions: 'captureError' },
        },
      },
      done: {
        type: 'final',
        output: ({ context }) =>
          ({
            kind: 'completed',
            domain: context.domain,
            repairs: context.repairs,
          }) satisfies TaskExecutionResult,
      },
    },
  })
}
