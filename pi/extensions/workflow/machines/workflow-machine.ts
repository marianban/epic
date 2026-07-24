import { assign, fromPromise, sendTo, setup } from 'xstate'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type {
  PlannerContextRequest,
  ScoutReport,
  WorkflowStage,
  WorkflowState,
} from '../types.ts'
import {
  createTaskExecutionMachine,
  type TaskExecutionEvent,
  type TaskExecutionResult,
} from './task-execution-machine.ts'
// fallow-ignore-next-line circular-dependency -- canonical machine bootstrap is required for persisted snapshots
import { createWorkflowServices, type WorkflowServices } from '../services.ts'

export const WORKFLOW_SCHEMA_VERSION = 2
export const WORKFLOW_MACHINE_VERSION = 4
export interface WorkflowMachineContext {
  state: WorkflowState
  report?: ScoutReport
  focusedQuestions?: string[]
}
export type WorkflowMachineEvent =
  | { type: 'WORKFLOW.START' }
  | { type: 'WORKFLOW.RESUME' }
  | { type: 'WORKFLOW.CANCEL' }
  | { type: 'PLAN.REVIEW'; force?: boolean }
  | { type: 'PLAN.APPROVE' }
  | { type: 'PLAN.REVISE' }
  | { type: 'PREREQUISITES.APPROVE' }
  | { type: 'TASK.APPROVE' }
  | { type: 'TASK.REVIEW' }
  | { type: 'TASK.REVISE' }

const taskStage = (value: unknown): WorkflowStage =>
  (
    ({
      awaitingApproval: 'awaiting_task_approval',
      revisingTask: 'revising_task',
      implementing: 'implementing',
      fastChecks: 'running_fast_checks',
      repairingFast: 'repairing_fast_checks',
      repairingFastInvoke: 'repairing_fast_checks',
      fullChecks: 'running_full_checks',
      repairingFull: 'repairing_full_checks',
      repairingFullInvoke: 'repairing_full_checks',
      reviewing: 'reviewing',
      repairingReview: 'repairing_review',
      repairingReviewInvoke: 'repairing_review',
      awaitingReview: 'awaiting_task_review',
      escalating: 'escalating',
      done: 'final_verification',
      cancelled: 'cancelled',
      failed: 'failed',
    }) as Record<string, WorkflowStage>
  )[String(value)] ?? 'implementing'

export function createWorkflowMachine(services: WorkflowServices) {
  const task = createTaskExecutionMachine(services)
  const classify = fromPromise<WorkflowState, { state: WorkflowState }>(
    ({ input }) => Promise.resolve(services.classify(input.state))
  )
  const scout = fromPromise<
    { state: WorkflowState; report: ScoutReport },
    { state: WorkflowState; questions?: string[] }
  >(({ input }) => services.scout(input.state, input.questions))
  const plan = fromPromise<
    { state: WorkflowState; result: string | PlannerContextRequest },
    { state: WorkflowState; report: ScoutReport }
  >(({ input }) => services.plan(input.state, input.report))
  const planReview = fromPromise<
    { state: WorkflowState; revised: boolean },
    { state: WorkflowState; force: boolean }
  >(({ input }) => services.reviewPlan(input.state, input.force))
  const approvePlan = fromPromise<WorkflowState, { state: WorkflowState }>(
    ({ input }) => services.approvePlan(input.state)
  )
  const decompose = fromPromise<WorkflowState, { state: WorkflowState }>(
    ({ input }) => services.decompose(input.state)
  )
  const prerequisites = fromPromise<WorkflowState, { state: WorkflowState }>(
    ({ input }) => services.prerequisites(input.state)
  )
  const prepare = fromPromise<WorkflowState, { state: WorkflowState }>(
    ({ input }) => services.preparePrerequisites(input.state)
  )
  const finalChecks = fromPromise<
    { state: WorkflowState; result: { passed: boolean } },
    { state: WorkflowState }
  >(({ input }) => services.checks(input.state, 'final'))
  return setup({
    types: {
      context: {} as WorkflowMachineContext,
      input: {} as { state: WorkflowState },
      events: {} as WorkflowMachineEvent,
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
      forwardTask: sendTo(
        'task-execution',
        ({ event }) => event as unknown as TaskExecutionEvent
      ),
    },
  }).createMachine({
    id: 'workflow',
    initial: 'idle',
    context: ({ input }) => ({
      state: { ...input.state, machineSnapshot: undefined },
    }),
    states: {
      idle: { on: { 'WORKFLOW.START': 'classifying' } },
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
        on: { 'WORKFLOW.CANCEL': 'terminal.cancelled' },
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
              onError: '#workflow.terminal.failed',
            },
            on: { 'WORKFLOW.CANCEL': '#workflow.terminal.cancelled' },
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
                  actions: assign({ state: ({ event }) => event.output.state }),
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
              onError: '#workflow.terminal.failed',
            },
            on: { 'WORKFLOW.CANCEL': '#workflow.terminal.cancelled' },
          },
          awaitingReview: {
            tags: ['awaiting-human', 'awaiting-plan-review'],
            on: {
              'PLAN.REVIEW': 'revising',
              'PLAN.REVISE': 'revising',
              'PLAN.APPROVE': 'approving',
              'WORKFLOW.CANCEL': '#workflow.terminal.cancelled',
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
                actions: assign({ state: ({ event }) => event.output.state }),
              },
              onError: '#workflow.terminal.failed',
            },
            on: { 'WORKFLOW.CANCEL': '#workflow.terminal.cancelled' },
          },
          awaitingApproval: {
            tags: ['awaiting-human', 'awaiting-plan-approval'],
            on: {
              'PLAN.REVIEW': 'revising',
              'PLAN.REVISE': 'revising',
              'PLAN.APPROVE': 'approving',
              'WORKFLOW.CANCEL': '#workflow.terminal.cancelled',
            },
          },
          approving: {
            invoke: {
              src: 'approvePlan',
              input: ({ context }) => ({ state: context.state }),
              onDone: {
                target: '#workflow.decomposingTasks',
                actions: assign({ state: ({ event }) => event.output }),
              },
              onError: '#workflow.terminal.failed',
            },
            on: { 'WORKFLOW.CANCEL': '#workflow.terminal.cancelled' },
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
        on: { 'WORKFLOW.CANCEL': 'terminal.cancelled' },
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
                  target: '#workflow.taskExecution',
                  actions: assign({
                    state: ({ event }) => ({
                      ...event.output,
                      pendingHumanAction: 'review_task',
                    }),
                  }),
                },
                {
                  target: 'awaitingApproval',
                  actions: assign({
                    state: ({ event }) => ({
                      ...event.output,
                      pendingHumanAction: 'approve_prerequisites',
                    }),
                  }),
                },
              ],
              onError: '#workflow.terminal.failed',
            },
            on: { 'WORKFLOW.CANCEL': '#workflow.terminal.cancelled' },
          },
          awaitingApproval: {
            tags: ['awaiting-human', 'awaiting-prerequisite-approval'],
            on: {
              'PREREQUISITES.APPROVE': 'preparing',
              'WORKFLOW.CANCEL': '#workflow.terminal.cancelled',
            },
          },
          preparing: {
            invoke: {
              src: 'prepare',
              input: ({ context }) => ({ state: context.state }),
              onDone: {
                target: '#workflow.taskExecution',
                actions: assign({
                  state: ({ event }) => ({
                    ...event.output,
                    pendingHumanAction: 'review_task',
                  }),
                }),
              },
              onError: '#workflow.terminal.failed',
            },
            on: { 'WORKFLOW.CANCEL': '#workflow.terminal.cancelled' },
          },
        },
      },
      taskExecution: {
        tags: ['active', 'task-execution'],
        invoke: {
          id: 'task-execution',
          src: 'task',
          input: ({ context }) => ({ state: context.state }),
          onSnapshot: {
            actions: assign({
              state: ({ context, event }) => ({
                ...context.state,
                stage: taskStage(
                  (event as { snapshot: { value: unknown } }).snapshot.value
                ),
                pendingHumanAction: [
                  'awaitingApproval',
                  'awaitingReview',
                  'escalating',
                ].includes(
                  String(
                    (event as { snapshot: { value: unknown } }).snapshot.value
                  )
                )
                  ? 'review_task'
                  : context.state.pendingHumanAction,
              }),
            }),
          },
          onDone: [
            {
              guard: ({ event }) =>
                (event.output as TaskExecutionResult).kind === 'cancelled',
              target: 'terminal.cancelled',
              actions: assign({
                state: ({ event }) =>
                  (event.output as TaskExecutionResult).state,
              }),
            },
            {
              guard: ({ event }) =>
                (event.output as TaskExecutionResult).kind === 'completed' &&
                (event.output as TaskExecutionResult).state.currentTaskIndex +
                  1 <
                  ((event.output as TaskExecutionResult).state.tasks?.length ??
                    0),
              target: 'taskExecution',
              actions: assign({
                state: ({ event }) => ({
                  ...(event.output as TaskExecutionResult).state,
                  currentTaskIndex:
                    (event.output as TaskExecutionResult).state
                      .currentTaskIndex + 1,
                  taskApproved: false,
                  pendingHumanAction: 'review_task',
                }),
              }),
              reenter: true,
            },
            {
              guard: ({ event }) =>
                (event.output as TaskExecutionResult).kind === 'completed',
              target: 'finalVerification',
              actions: assign({
                state: ({ event }) =>
                  (event.output as TaskExecutionResult).state,
              }),
            },
            { target: 'escalating' },
          ],
        },
        on: {
          'TASK.APPROVE': { actions: 'forwardTask' },
          'TASK.REVIEW': { actions: 'forwardTask' },
          'TASK.REVISE': { actions: 'forwardTask' },
          'WORKFLOW.RESUME': { actions: 'forwardTask' },
          'WORKFLOW.CANCEL': { actions: 'forwardTask' },
        },
      },
      escalating: {
        tags: ['awaiting-human', 'escalated'],
        on: {
          'WORKFLOW.RESUME': 'taskExecution',
          'WORKFLOW.CANCEL': 'terminal.cancelled',
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
                state: ({ event }) => ({
                  ...event.output.state,
                  stage: 'completed',
                }),
              }),
            },
            {
              target: 'terminal.failed',
              actions: assign({
                state: ({ event }) => ({
                  ...event.output.state,
                  stage: 'failed',
                  failureReason: 'Final verification failed.',
                }),
              }),
            },
          ],
          onError: 'terminal.failed',
        },
        on: { 'WORKFLOW.CANCEL': 'terminal.cancelled' },
      },
      terminal: {
        initial: 'completed',
        states: {
          completed: { type: 'final', tags: ['terminal', 'completed'] },
          failed: { type: 'final', tags: ['terminal', 'failed'] },
          cancelled: { type: 'final', tags: ['terminal', 'cancelled'] },
        },
      },
    },
  })
}

export function machineStage(snapshot: {
  value?: unknown
  context: WorkflowMachineContext
}): WorkflowStage {
  const value = snapshot.value
  if (value === 'classifying') return 'classifying'
  if (value === 'decomposingTasks') return 'decomposing_tasks'
  if (value === 'taskExecution') {
    // `taskExecution` is a parent state whose invoked child owns the actual
    // task lifecycle. The child reports its stage into durable context via
    // `onSnapshot`; returning a hard-coded approval stage here makes settle()
    // stop immediately after every task event and persists/stops the child
    // while implementation or checks are still running.
    const childStage = snapshot.context.state.stage
    if (
      [
        'awaiting_task_approval',
        'awaiting_task_review',
        'revising_task',
        'implementing',
        'running_fast_checks',
        'repairing_fast_checks',
        'running_full_checks',
        'repairing_full_checks',
        'reviewing',
        'repairing_review',
        'escalating',
      ].includes(childStage)
    )
      return childStage
    return 'awaiting_task_approval'
  }
  if (value === 'escalating') return 'escalating'
  if (value === 'finalVerification') return 'final_verification'
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.planning === 'string')
      return (
        (
          {
            scouting: 'scouting',
            generating: 'planning',
            awaitingReview: 'awaiting_plan_review',
            revising: 'revising_plan',
            awaitingApproval: 'awaiting_plan_approval',
          } as Record<string, WorkflowStage>
        )[record.planning] ?? snapshot.context.state.stage
      )
    if (typeof record.prerequisites === 'string')
      return (
        (
          {
            checking: 'checking_prerequisites',
            awaitingApproval: 'awaiting_prerequisite_approval',
            preparing: 'preparing_prerequisites',
          } as Record<string, WorkflowStage>
        )[record.prerequisites] ?? snapshot.context.state.stage
      )
    if (typeof record.terminal === 'string')
      return record.terminal as WorkflowStage
  }
  return snapshot.context.state.stage
}
export function createServices(ctx: ExtensionCommandContext): WorkflowServices {
  return createWorkflowServices(ctx)
}

const unavailable = async (): Promise<never> => {
  throw new Error(
    'Workflow services are unavailable during snapshot initialization.'
  )
}
export const workflowMachine = createWorkflowMachine({
  ctx: undefined as never,
  notify: () => undefined,
  classify: (state) => state,
  scout: unavailable,
  plan: unavailable,
  reviewPlan: unavailable,
  decompose: unavailable,
  approvePlan: unavailable,
  prerequisites: unavailable,
  preparePrerequisites: unavailable,
  implement: unavailable,
  checks: unavailable,
  review: unavailable,
  reviseTask: unavailable,
})
