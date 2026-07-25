import { assign, fromPromise, setup } from 'xstate'
import type { CheckSuiteResult, ReviewResult, EpicState } from '../types.ts'
import type { EpicServices } from '../services.ts'

interface TaskExecutionContext {
  state: EpicState
  failureReason?: string
  fast?: CheckSuiteResult
  full?: CheckSuiteResult
  review?: ReviewResult
  fastRepairAttempt: number
  fullRepairAttempt: number
  semanticRepairAttempt: number
}
interface TaskExecutionInput {
  state: EpicState
}
export type TaskExecutionEvent =
  | { type: 'TASK.APPROVE' }
  | { type: 'TASK.REVIEW' }
  | { type: 'TASK.REVISE' }
  | { type: 'EPIC.RESUME' }
  | { type: 'EPIC.CANCEL' }
export interface TaskExecutionResult {
  kind: 'completed' | 'escalated' | 'cancelled'
  state: EpicState
  reason?: string
}

function formatActorError(error: unknown): string {
  if (error == null) return 'Task actor failed.'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return String(error)
}

export function createTaskExecutionMachine(services: EpicServices) {
  const implementation = fromPromise<
    EpicState,
    { context: TaskExecutionContext; feedback?: string }
  >(({ input }) => services.implement(input.context.state, input.feedback))
  const checks = fromPromise<
    { state: EpicState; result: CheckSuiteResult },
    { context: TaskExecutionContext; suite: 'fast' | 'full' }
  >(({ input }) => services.checks(input.context.state, input.suite))
  const review = fromPromise<
    { state: EpicState; result: ReviewResult },
    { context: TaskExecutionContext }
  >(({ input }) => {
    if (!input.context.full) throw new Error('Full check result is missing.')
    return services.review(input.context.state, input.context.full)
  })
  const revise = fromPromise<EpicState, { context: TaskExecutionContext }>(
    ({ input }) => services.reviseTask(input.context.state)
  )
  return setup({
    types: {
      context: {} as TaskExecutionContext,
      input: {} as TaskExecutionInput,
      events: {} as TaskExecutionEvent,
    },
    actors: { implementation, checks, review, revise },
    guards: {
      fastRepairAvailable: ({ context }) =>
        context.fastRepairAttempt < context.state.maxFastRepairs,
      fullRepairAvailable: ({ context }) =>
        context.fullRepairAttempt < context.state.maxFullRepairs,
      semanticRepairAvailable: ({ context }) =>
        context.semanticRepairAttempt < context.state.maxSemanticRepairs,
    },
    actions: {
      captureFailureReason: assign({
        failureReason: ({ event }) =>
          formatActorError((event as { error?: unknown }).error),
      }),
      markTaskApproved: assign({
        state: ({ context }) => ({
          ...context.state,
          taskApproved: true,
          taskApprovedAt: new Date().toISOString(),
          pendingHumanAction: 'none',
        }),
      }),
    },
  }).createMachine({
    id: 'taskExecution',
    initial: 'awaitingApproval',
    // Final-state output belongs to the compound machine actor. Without
    // forwarding the nested final state's output here, an invoking parent
    // receives xstate.done.actor.task-execution with event.output undefined.
    output: ({ event }) => event.output as TaskExecutionResult,
    context: ({ input }) => ({
      state: input.state,
      fastRepairAttempt: input.state.fastRepairAttempt,
      fullRepairAttempt: input.state.fullRepairAttempt,
      semanticRepairAttempt: input.state.semanticRepairAttempt,
    }),
    states: {
      awaitingApproval: {
        tags: ['awaiting-human', 'awaiting-task-approval'],
        on: {
          'TASK.APPROVE': {
            target: 'implementing',
            actions: 'markTaskApproved',
          },
          'TASK.REVIEW': 'revisingTask',
          'EPIC.CANCEL': 'cancelled',
        },
      },
      revisingTask: {
        invoke: {
          src: 'revise',
          input: ({ context }) => ({ context }),
          onDone: {
            target: 'awaitingApproval',
            actions: assign({ state: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      implementing: {
        invoke: {
          src: 'implementation',
          input: ({ context }) => ({ context }),
          onDone: {
            target: 'fastChecks',
            actions: assign({ state: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      fastChecks: {
        invoke: {
          src: 'checks',
          input: ({ context }) => ({ context, suite: 'fast' as const }),
          onDone: [
            {
              guard: ({ event }) => event.output.result.passed,
              target: 'fullChecks',
              actions: assign({
                state: ({ event }) => event.output.state,
                fast: ({ event }) => event.output.result,
              }),
            },
            {
              target: 'repairingFast',
              actions: assign({
                state: ({ event }) => event.output.state,
                fast: ({ event }) => event.output.result,
              }),
            },
          ],
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      repairingFast: {
        tags: ['active', 'repairing'],
        always: [
          {
            guard: 'fastRepairAvailable',
            target: 'repairingFastInvoke',
            actions: assign({
              fastRepairAttempt: ({ context }) => context.fastRepairAttempt + 1,
            }),
          },
          { target: 'escalating' },
        ],
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      repairingFastInvoke: {
        invoke: {
          src: 'implementation',
          input: ({ context }) => ({
            context,
            feedback: JSON.stringify(context.fast),
          }),
          onDone: {
            target: 'fastChecks',
            actions: assign({ state: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      fullChecks: {
        invoke: {
          src: 'checks',
          input: ({ context }) => ({ context, suite: 'full' as const }),
          onDone: [
            {
              guard: ({ event }) => event.output.result.passed,
              target: 'reviewing',
              actions: assign({
                state: ({ event }) => event.output.state,
                full: ({ event }) => event.output.result,
              }),
            },
            {
              target: 'repairingFull',
              actions: assign({
                state: ({ event }) => event.output.state,
                full: ({ event }) => event.output.result,
              }),
            },
          ],
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      repairingFull: {
        tags: ['active', 'repairing'],
        always: [
          {
            guard: 'fullRepairAvailable',
            target: 'repairingFullInvoke',
            actions: assign({
              fullRepairAttempt: ({ context }) => context.fullRepairAttempt + 1,
            }),
          },
          { target: 'escalating' },
        ],
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      repairingFullInvoke: {
        invoke: {
          src: 'implementation',
          input: ({ context }) => ({
            context,
            feedback: JSON.stringify(context.full),
          }),
          onDone: {
            target: 'fullChecks',
            actions: assign({ state: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      reviewing: {
        invoke: {
          src: 'review',
          input: ({ context }) => ({ context }),
          onDone: [
            {
              guard: ({ event }) => event.output.result.passed,
              target: 'awaitingReview',
              actions: assign({
                state: ({ event }) => event.output.state,
                review: ({ event }) => event.output.result,
              }),
            },
            {
              target: 'repairingReview',
              actions: assign({
                state: ({ event }) => event.output.state,
                review: ({ event }) => event.output.result,
              }),
            },
          ],
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      repairingReview: {
        tags: ['active', 'repairing'],
        always: [
          {
            guard: 'semanticRepairAvailable',
            target: 'repairingReviewInvoke',
            actions: assign({
              semanticRepairAttempt: ({ context }) =>
                context.semanticRepairAttempt + 1,
            }),
          },
          { target: 'escalating' },
        ],
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      repairingReviewInvoke: {
        invoke: {
          src: 'implementation',
          input: ({ context }) => ({
            context,
            feedback: JSON.stringify(context.review),
          }),
          onDone: {
            target: 'fastChecks',
            actions: assign({ state: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
        on: { 'EPIC.CANCEL': 'cancelled' },
      },
      awaitingReview: {
        tags: ['awaiting-human', 'awaiting-task-review'],
        on: {
          'TASK.APPROVE': { target: 'done', actions: 'markTaskApproved' },
          'TASK.REVIEW': 'repairingReviewInvoke',
          'TASK.REVISE': 'revisingTask',
          'EPIC.CANCEL': 'cancelled',
        },
      },
      escalating: {
        tags: ['awaiting-human', 'escalated'],
        on: {
          'EPIC.RESUME': 'implementing',
          'TASK.APPROVE': {
            target: 'implementing',
            actions: 'markTaskApproved',
          },
          'EPIC.CANCEL': 'cancelled',
        },
      },
      done: {
        type: 'final',
        output: ({ context }) =>
          ({ kind: 'completed', state: context.state }) as TaskExecutionResult,
      },
      cancelled: {
        type: 'final',
        output: ({ context }) =>
          ({ kind: 'cancelled', state: context.state }) as TaskExecutionResult,
      },
      failed: {
        type: 'final',
        output: ({ context }) =>
          ({
            kind: 'escalated',
            state: context.state,
            reason: context.failureReason ?? 'Task actor failed.',
          }) as TaskExecutionResult,
      },
    },
  })
}
