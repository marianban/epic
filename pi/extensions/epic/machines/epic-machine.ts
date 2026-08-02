import { assign, fromPromise, sendTo, setup } from 'xstate'
import type {
  PlannerContextRequest,
  ScoutReport,
  EpicDomainState,
  TaskFailureDiagnostics,
} from '../types.ts'
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
}
export type EpicMachineEvent =
  | { type: 'EPIC.START' }
  | { type: 'EPIC.RESUME' }
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
      task,
    },
    actions: {
      acceptResume: () => undefined,
      forwardTask: sendTo(
        'task-execution',
        ({ event }) => event as unknown as TaskExecutionEvent
      ),
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
          onError: 'terminal.failed',
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
              onError: '#epic.terminal.failed',
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
              onError: '#epic.terminal.failed',
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
              onError: '#epic.terminal.failed',
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
              onError: '#epic.terminal.failed',
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
          onError: 'terminal.failed',
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
              onError: '#epic.terminal.failed',
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
              onError: '#epic.terminal.failed',
            },
          },
        },
      },
      taskExecution: {
        tags: ['active', 'task-execution'],
        invoke: {
          id: 'task-execution',
          src: 'task',
          input: ({ context }) => ({ domain: context.state }),
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
              target: 'taskExecution',
              actions: assign({
                state: ({ event }) => ({
                  ...validateTaskExecutionResult(event.output).domain,
                  currentTaskIndex:
                    validateTaskExecutionResult(event.output).domain
                      .currentTaskIndex + 1,
                  taskApproved: false,
                }),
              }),
              reenter: true,
            },
            {
              guard: ({ event }) =>
                validateTaskExecutionResult(event.output).kind === 'completed',
              target: 'finalVerification',
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
              target: 'terminal.failed',
              actions: assign({
                state: ({ event }) => ({
                  ...event.output.state,
                  failureReason: 'Final verification failed.',
                }),
              }),
            },
          ],
          onError: 'terminal.failed',
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
