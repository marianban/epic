import { executeManualReviewAction } from './dashboard/manual-review-actions.ts'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  approvePlan,
  resumeEpic,
  reviewPlan,
  startEpic,
  epicStatus,
  approvePrerequisites,
  approveTask,
  reviseTask,
  approveRecovery,
  repairTaskCommand,
} from './epic.ts'
import {
  EPIC_STATUS_REFRESH_INTERVAL_MS,
  type EpicStatusWidgetLifecycle,
  registerEpicStatusWidget,
} from './dashboard/widget-lifecycle.ts'
import { EPIC_COMMANDS } from './commands.ts'
import type { DashboardAction } from './dashboard/types.ts'

export async function executeEpicDashboardAction(
  action: DashboardAction,
  ctx: ExtensionContext,
  lifecycle: EpicStatusWidgetLifecycle
): Promise<void> {
  if (action.disabled) throw new Error('This action is disabled.')
  if (action.manualReview) {
    await executeManualReviewAction(action, ctx)
    return
  }
  switch (action.id) {
    case EPIC_COMMANDS.approvePlan:
      await approvePlan(ctx)
      return
    case EPIC_COMMANDS.approvePrerequisites:
      await approvePrerequisites(ctx)
      return
    case EPIC_COMMANDS.approveTask:
      await approveTask(ctx)
      return
    case EPIC_COMMANDS.repairTask:
      await repairTaskCommand(ctx, '')
      return
    case EPIC_COMMANDS.resume:
      await resumeEpic(ctx)
      lifecycle.show(ctx)
      return
    case EPIC_COMMANDS.approveRecovery:
      await approveRecovery(ctx)
      return
    case EPIC_COMMANDS.exit:
      lifecycle.hide(ctx)
      return
    default:
      throw new Error(`Unsupported dashboard action: ${action.id}`)
  }
}

export default function epicExtension(pi: ExtensionAPI): void {
  const widgetLifecycle = registerEpicStatusWidget(
    pi,
    EPIC_STATUS_REFRESH_INTERVAL_MS,
    (action, ctx) => executeEpicDashboardAction(action, ctx, widgetLifecycle)
  )

  pi.registerCommand(EPIC_COMMANDS.start, {
    description: 'Start a deterministic human-gated epic',
    handler: async (args, ctx) => startEpic(args, ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.status, {
    description: 'Show active epic state',
    handler: async (_args, ctx) => epicStatus(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.resume, {
    description: 'Resume the persisted epic',
    handler: async (_args, ctx) => {
      await resumeEpic(ctx)
      widgetLifecycle.show(ctx)
    },
  })
  pi.registerCommand(EPIC_COMMANDS.approveRecovery, {
    description: 'Approve the proposed recovery and continue the epic',
    handler: async (_args, ctx) => approveRecovery(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.approvePrerequisites, {
    description: 'Approve and apply detected repository prerequisites',
    handler: async (_args, ctx) => approvePrerequisites(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.exit, {
    description: 'Hide the Epic widgets without changing Epic state',
    handler: async (_args, ctx) => {
      widgetLifecycle.hide(ctx)
    },
  })
  pi.registerCommand(EPIC_COMMANDS.approveTask, {
    description: 'Continue task planning review, or approve only after automated and manual review pass',
    handler: async (_args, ctx) => approveTask(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.repairTask, {
    description: 'Repair current automated issues or failed manual steps (one attempt, five additional minutes; no arguments)',
    handler: async (args, ctx) => repairTaskCommand(ctx, args),
  })
  pi.registerCommand(EPIC_COMMANDS.reviewTask, {
    description: 'Fix R: findings from the current task review',
    handler: async (_args, ctx) => reviseTask(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.reviewPlan, {
    description: 'Revise plan.md from R: comments',
    handler: async (_args, ctx) => reviewPlan(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.approvePlan, {
    description: 'Continue plan review or approve plan.md',
    handler: async (_args, ctx) => approvePlan(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.revisePlan, {
    description: 'Force another Planner revision',
    handler: async (_args, ctx) => reviewPlan(ctx, true),
  })
}
