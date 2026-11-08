export const EPIC_COMMANDS = {
  start: 'epic',
  status: 'epic-status',
  resume: 'epic-resume',
  approveRecovery: 'epic-approve-recovery',
  exit: 'epic-exit',
  approvePrerequisites: 'epic-approve-prerequisites',
  approveTask: 'task-approve',
  reviewTask: 'task-review',
  reviewPlan: 'plan-review',
  approvePlan: 'plan-approve',
  revisePlan: 'plan-revise',
} as const

export type EpicCommandName = (typeof EPIC_COMMANDS)[keyof typeof EPIC_COMMANDS]

export function slashCommand(command: EpicCommandName): `/${EpicCommandName}` {
  return `/${command}`
}
