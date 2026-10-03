import { assign, fromCallback, fromPromise, setup } from 'xstate'
import type {
  BrowserSmokeResult,
  CheckSuiteResult,
  DevServerDiagnostics,
  ReviewResult,
  EpicDomainState,
  RepairAttempts,
} from '../types.ts'
import type { EpicServices } from '../services.ts'

interface TaskExecutionContext {
  domain: EpicDomainState
  failureReason?: string
  fast?: CheckSuiteResult
  full?: CheckSuiteResult
  browserSmoke?: BrowserSmokeResult
  server?: DevServerDiagnostics
  serverFailure?: string
  review?: ReviewResult
  repairs: RepairAttempts
  revalidate?: boolean
}
interface TaskExecutionInput {
  domain: EpicDomainState
  mode?: 'normal' | 'revalidate'
}
export type TaskExecutionEvent =
  | { type: 'TASK.APPROVE' }
  | { type: 'TASK.REVIEW' }
  | { type: 'TASK.REVISE' }
  | { type: 'EPIC.RESUME' }
  | { type: 'DEV_SERVER.READY'; diagnostics: DevServerDiagnostics }
  | {
      type: 'DEV_SERVER.FAILED'
      diagnostics: DevServerDiagnostics
      reason: string
    }
interface CompletedTaskExecutionResult {
  kind: 'completed'
  domain: EpicDomainState
  repairs: RepairAttempts
  reason?: never
}
interface EscalatedTaskExecutionResult {
  kind: 'escalated'
  domain: EpicDomainState
  repairs: RepairAttempts
  reason: string
}
export type TaskExecutionResult =
  CompletedTaskExecutionResult | EscalatedTaskExecutionResult

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

type RepairKind =
  | 'fast checks'
  | 'full checks'
  | 'browser smoke'
  | 'semantic review'

function repairLimitReason(kind: RepairKind): string {
  return `${kind} repair limit exhausted.`
}

export function createTaskExecutionMachine(services: EpicServices) {
  const implementation = fromPromise<
    EpicDomainState,
    { context: TaskExecutionContext; feedback?: string }
  >(({ input }) => services.implement(input.context.domain, input.feedback))
  const checks = fromPromise<
    { state: EpicDomainState; result: CheckSuiteResult },
    { context: TaskExecutionContext; suite: 'fast' | 'full' }
  >(({ input }) => services.checks(input.context.domain, input.suite))
  const review = fromPromise<
    { state: EpicDomainState; result: ReviewResult },
    { context: TaskExecutionContext }
  >(({ input }) => {
    if (!input.context.full) throw new Error('Full check result is missing.')
    return services.review(
      input.context.domain,
      {
        full: input.context.full,
        ...(input.context.browserSmoke
          ? { browserSmoke: input.context.browserSmoke }
          : {}),
      },
      input.context.repairs.semantic
    )
  })
  const server = fromCallback<
    TaskExecutionEvent,
    { context: TaskExecutionContext }
  >(({ input, sendBack }) => {
    try {
      return services.serve(input.context.domain, {
        ready: (diagnostics) =>
          sendBack({ type: 'DEV_SERVER.READY', diagnostics }),
        failed: (error, diagnostics) =>
          sendBack({
            type: 'DEV_SERVER.FAILED',
            diagnostics,
            reason: error.message,
          }),
      })
    } catch (error) {
      queueMicrotask(() =>
        sendBack({
          type: 'DEV_SERVER.FAILED',
          diagnostics: {
            command: input.context.domain.devServer?.command ?? '(missing)',
            args: input.context.domain.devServer?.args ?? [],
            url: input.context.domain.devServer?.url ?? '(missing)',
            stdoutPreview: '',
            stderrPreview: '',
            outputTruncated: false,
          },
          reason: formatActorError(error),
        })
      )
      return () => undefined
    }
  })
  const browserSmoke = fromPromise<
    { state: EpicDomainState; result: BrowserSmokeResult },
    { context: TaskExecutionContext }
  >(({ input, signal }) => {
    if (!input.context.server)
      throw new Error('Development server diagnostics are missing.')
    return services.browserSmoke(
      input.context.domain,
      input.context.server,
      input.context.serverFailure,
      signal
    )
  })
  const revise = fromPromise<
    EpicDomainState,
    { context: TaskExecutionContext }
  >(({ input }) => services.reviseTask(input.context.domain))
  return setup({
    types: {
      context: {} as TaskExecutionContext,
      input: {} as TaskExecutionInput,
      events: {} as TaskExecutionEvent,
    },
    actors: { implementation, checks, review, revise, server, browserSmoke },
    guards: {
      fastRepairAvailable: ({ context }) =>
        context.repairs.fast < context.domain.maxFastRepairs,
      fullRepairAvailable: ({ context }) =>
        context.repairs.full < context.domain.maxFullRepairs,
      semanticRepairAvailable: ({ context }) =>
        context.repairs.semantic < context.domain.maxSemanticRepairs,
      browserSmokeRequired: ({ context }) =>
        context.domain.tasks?.[
          context.domain.currentTaskIndex
        ]?.requiredChecks.includes('browser-smoke') === true,
    },
    actions: {
      captureFailureReason: assign({
        failureReason: ({ event }) =>
          formatActorError((event as { error?: unknown }).error),
      }),
      markFastRepairEscalation: assign(({ context }) => {
        const failureReason = repairLimitReason('fast checks')
        return {
          failureReason,
          domain: { ...context.domain, failureReason },
        }
      }),
      markFullRepairEscalation: assign(({ context }) => {
        const failureReason = repairLimitReason('full checks')
        return {
          failureReason,
          domain: { ...context.domain, failureReason },
        }
      }),
      markSemanticRepairEscalation: assign(({ context }) => {
        const failureReason = repairLimitReason('semantic review')
        return {
          failureReason,
          domain: { ...context.domain, failureReason },
        }
      }),
      markBrowserRepairEscalation: assign(({ context }) => {
        const failureReason = repairLimitReason('browser smoke')
        return {
          failureReason,
          domain: { ...context.domain, failureReason },
        }
      }),
      markTaskApproved: assign({
        domain: ({ context }) => ({
          ...context.domain,
          taskApproved: true,
          taskApprovedAt: services.now(),
        }),
      }),
    },
  }).createMachine({
    id: 'taskExecution',
    initial: 'routing',
    // Final-state output belongs to the compound machine actor. Without
    // forwarding the nested final state's output here, an invoking parent
    // receives xstate.done.actor.task-execution with event.output undefined.
    output: ({ event }) => event.output as TaskExecutionResult,
    context: ({ input }) => ({
      domain: input.domain,
      repairs: { fast: 0, full: 0, semantic: 0 },
      revalidate: input.mode === 'revalidate',
    }),
    states: {
      routing: {
        always: [
          { guard: ({ context }) => context.revalidate === true, target: 'fastChecks' },
          { target: 'awaitingApproval' },
        ],
      },
      awaitingApproval: {
        tags: ['awaiting-human', 'awaiting-task-approval'],
        on: {
          'TASK.APPROVE': {
            target: 'implementing',
            actions: 'markTaskApproved',
          },
          'TASK.REVIEW': 'revisingTask',
        },
      },
      revisingTask: {
        invoke: {
          src: 'revise',
          input: ({ context }) => ({ context }),
          onDone: {
            target: 'awaitingApproval',
            actions: assign({ domain: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
      },
      implementing: {
        invoke: {
          src: 'implementation',
          input: ({ context }) => ({ context }),
          onDone: {
            target: 'fastChecks',
            actions: assign({ domain: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
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
                domain: ({ event }) => event.output.state,
                fast: ({ event }) => event.output.result,
              }),
            },
            {
              target: 'repairingFast',
              actions: assign({
                domain: ({ event }) => event.output.state,
                fast: ({ event }) => event.output.result,
              }),
            },
          ],
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
      },
      repairingFast: {
        tags: ['active', 'repairing'],
        always: [
          {
            guard: 'fastRepairAvailable',
            target: 'repairingFastInvoke',
            actions: assign({
              repairs: ({ context }) => ({
                ...context.repairs,
                fast: context.repairs.fast + 1,
              }),
            }),
          },
          { target: 'escalating', actions: 'markFastRepairEscalation' },
        ],
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
            actions: assign({ domain: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
      },
      fullChecks: {
        invoke: {
          src: 'checks',
          input: ({ context }) => ({ context, suite: 'full' as const }),
          onDone: [
            {
              guard: ({ event }) => event.output.result.passed,
              target: 'routeAfterFullChecks',
              actions: assign({
                domain: ({ event }) => event.output.state,
                full: ({ event }) => event.output.result,
              }),
            },
            {
              target: 'repairingFull',
              actions: assign({
                domain: ({ event }) => event.output.state,
                full: ({ event }) => event.output.result,
              }),
            },
          ],
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
      },
      routeAfterFullChecks: {
        always: [
          { guard: 'browserSmokeRequired', target: 'browserVerification' },
          { target: 'reviewing' },
        ],
      },
      browserVerification: {
        tags: ['active', 'browser-verification'],
        invoke: {
          id: 'dev-server',
          src: 'server',
          input: ({ context }) => ({ context }),
        },
        initial: 'startingDevServer',
        on: {
          'DEV_SERVER.READY': {
            actions: assign({
              server: ({ event }) => event.diagnostics,
              serverFailure: undefined,
            }),
          },
          'DEV_SERVER.FAILED': {
            target: '.recordingServerFailure',
            actions: assign({
              server: ({ event }) => event.diagnostics,
              serverFailure: ({ event }) => event.reason,
            }),
          },
        },
        states: {
          startingDevServer: {
            on: {
              'DEV_SERVER.READY': {
                target: 'runningSmoke',
                actions: assign({
                  server: ({ event }) => event.diagnostics,
                  serverFailure: undefined,
                }),
              },
            },
          },
          runningSmoke: {
            invoke: {
              src: 'browserSmoke',
              input: ({ context }) => ({ context }),
              onDone: [
                {
                  guard: ({ event }) => event.output.result.passed,
                  target: '#taskExecution.reviewing',
                  actions: assign({
                    domain: ({ event }) => event.output.state,
                    browserSmoke: ({ event }) => event.output.result,
                  }),
                },
                {
                  target: '#taskExecution.repairingBrowserSmoke',
                  actions: assign({
                    domain: ({ event }) => event.output.state,
                    browserSmoke: ({ event }) => event.output.result,
                  }),
                },
              ],
              onError: {
                target: '#taskExecution.failed',
                actions: 'captureFailureReason',
              },
            },
          },
          recordingServerFailure: {
            invoke: {
              src: 'browserSmoke',
              input: ({ context }) => ({ context }),
              onDone: {
                target: '#taskExecution.repairingBrowserSmoke',
                actions: assign({
                  domain: ({ event }) => event.output.state,
                  browserSmoke: ({ event }) => event.output.result,
                }),
              },
              onError: {
                target: '#taskExecution.failed',
                actions: 'captureFailureReason',
              },
            },
          },
        },
      },
      repairingBrowserSmoke: {
        tags: ['active', 'repairing'],
        always: [
          {
            guard: 'fullRepairAvailable',
            target: 'repairingBrowserSmokeInvoke',
            actions: assign({
              repairs: ({ context }) => ({
                ...context.repairs,
                full: context.repairs.full + 1,
              }),
            }),
          },
          { target: 'escalating', actions: 'markBrowserRepairEscalation' },
        ],
      },
      repairingBrowserSmokeInvoke: {
        invoke: {
          src: 'implementation',
          input: ({ context }) => ({
            context,
            feedback: JSON.stringify(context.browserSmoke),
          }),
          onDone: {
            target: 'fastChecks',
            actions: assign({
              domain: ({ event }) => event.output,
              server: undefined,
              serverFailure: undefined,
              browserSmoke: undefined,
            }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
      },
      repairingFull: {
        tags: ['active', 'repairing'],
        always: [
          {
            guard: 'fullRepairAvailable',
            target: 'repairingFullInvoke',
            actions: assign({
              repairs: ({ context }) => ({
                ...context.repairs,
                full: context.repairs.full + 1,
              }),
            }),
          },
          { target: 'escalating', actions: 'markFullRepairEscalation' },
        ],
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
            actions: assign({ domain: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
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
                domain: ({ event }) => event.output.state,
                review: ({ event }) => event.output.result,
              }),
            },
            {
              target: 'repairingReview',
              actions: assign({
                domain: ({ event }) => event.output.state,
                review: ({ event }) => event.output.result,
              }),
            },
          ],
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
      },
      repairingReview: {
        tags: ['active', 'repairing'],
        always: [
          {
            guard: 'semanticRepairAvailable',
            target: 'repairingReviewInvoke',
            actions: assign({
              repairs: ({ context }) => ({
                ...context.repairs,
                semantic: context.repairs.semantic + 1,
              }),
            }),
          },
          { target: 'escalating', actions: 'markSemanticRepairEscalation' },
        ],
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
            actions: assign({ domain: ({ event }) => event.output }),
          },
          onError: { target: 'failed', actions: 'captureFailureReason' },
        },
      },
      awaitingReview: {
        tags: ['awaiting-human', 'awaiting-task-review'],
        on: {
          'TASK.APPROVE': { target: 'done', actions: 'markTaskApproved' },
          'TASK.REVIEW': 'repairingReviewInvoke',
          'TASK.REVISE': 'revisingTask',
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
        },
      },
      done: {
        type: 'final',
        output: ({ context }) =>
          ({
            kind: 'completed',
            domain: context.domain,
            repairs: context.repairs,
          }) as TaskExecutionResult,
      },
      failed: {
        type: 'final',
        output: ({ context }) =>
          ({
            kind: 'escalated',
            domain: context.domain,
            repairs: context.repairs,
            reason: context.failureReason ?? 'Task actor failed.',
          }) as TaskExecutionResult,
      },
    },
  })
}
