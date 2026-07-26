import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
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
  registerEpicStatusWidget,
} from './dashboard/widget-lifecycle.ts'
import { EPIC_COMMANDS } from './commands.ts'

export default function epicExtension(pi: ExtensionAPI): void {
  registerEpicStatusWidget(pi, EPIC_STATUS_REFRESH_INTERVAL_MS)

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
