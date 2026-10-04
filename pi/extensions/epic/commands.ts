export const EPIC_COMMANDS = {
  start: 'epic',
  status: 'epic-status',
  resume: 'epic-resume',
  approveRecovery: 'epic-approve-recovery',
  exit: 'epic-exit',
  approvePrerequisites: 'epic-approve-prerequisites',
  approveTask: 'task-approve',
  confirmTask: 'task-confirm',
  acceptUnresolvedTask: 'task-accept-unresolved',
  repairTask: 'task-repair',
  deferTask: 'task-defer',
  reviseCriteria: 'task-revise-criteria',
  reviewTask: 'task-review',
  reviewPlan: 'plan-review',
  approvePlan: 'plan-approve',
  revisePlan: 'plan-revise',
} as const

export type EpicCommandName = (typeof EPIC_COMMANDS)[keyof typeof EPIC_COMMANDS]

export function slashCommand(command: EpicCommandName): `/${EpicCommandName}` {
  return `/${command}`
}
