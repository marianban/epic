export const EPIC_COMMANDS = {
  start: 'epic',
  status: 'epic-status',
  resume: 'epic-resume',
  approvePrerequisites: 'epic-approve-prerequisites',
  cancel: 'epic-cancel',
  approveTask: 'task-approve',
  reviewTask: 'task-review',
  reviewPlan: 'plan-review',
  approvePlan: 'plan-approve',
  revisePlan: 'plan-revise',
} as const

export type EpicCommandName =
  (typeof EPIC_COMMANDS)[keyof typeof EPIC_COMMANDS]

export function slashCommand(command: EpicCommandName): `/${EpicCommandName}` {
  return `/${command}`
}
