import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  cancelEpic,
  approvePlan,
  resumeEpic,
  reviewPlan,
  startEpic,
  epicStatus,
  approvePrerequisites,
  approveTask,
  reviseTask,
} from './epic.ts'
import {
  EPIC_STATUS_REFRESH_INTERVAL_MS,
  type EpicStatusActionExecutor,
  registerEpicStatusWidget,
} from './dashboard/widget-lifecycle.ts'
import { EPIC_COMMANDS } from './commands.ts'
import type { DashboardAction } from './dashboard/types.ts'

export const executeEpicDashboardAction: EpicStatusActionExecutor = async (
  action: DashboardAction,
  ctx: ExtensionContext
): Promise<void> => {
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
    case EPIC_COMMANDS.cancel:
      await cancelEpic(ctx)
      return
    case EPIC_COMMANDS.resume:
      await resumeEpic(ctx)
      return
    default:
      throw new Error(`Unsupported dashboard action: ${action.id}`)
  }
}

export default function epicExtension(pi: ExtensionAPI): void {
  registerEpicStatusWidget(
    pi,
    EPIC_STATUS_REFRESH_INTERVAL_MS,
    executeEpicDashboardAction
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
    handler: async (_args, ctx) => resumeEpic(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.approvePrerequisites, {
    description: 'Approve and apply detected repository prerequisites',
    handler: async (_args, ctx) => approvePrerequisites(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.cancel, {
    description: 'Cancel without reverting repository changes',
    handler: async (_args, ctx) => cancelEpic(ctx),
  })
  pi.registerCommand(EPIC_COMMANDS.approveTask, {
    description: 'Continue the current task review or approve it',
    handler: async (_args, ctx) => approveTask(ctx),
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
