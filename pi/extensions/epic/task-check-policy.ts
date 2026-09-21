import { stableCheckNamesForVerification } from './checks.ts'
import type { EpicTask } from './types.ts'

export interface TaskCheckPolicyValidation {
  valid: boolean
  errors: string[]
}

function formatAvailable(checks: ReadonlySet<string>): string {
  const names = [...checks].sort()
  return names.length ? names.join(', ') : '(none)'
}

function providedChecks(task: EpicTask): Set<string> {
  return new Set(task.verification.flatMap(stableCheckNamesForVerification))
}

export function validateTaskCheckPolicies(
  tasks: readonly EpicTask[],
  initiallyAvailable: readonly string[],
  finallyAvailableInitially: readonly string[] = initiallyAvailable
): TaskCheckPolicyValidation {
  const available = new Set(initiallyAvailable)
  const provided = tasks.map(providedChecks)
  const finallyAvailable = new Set(finallyAvailableInitially)
  for (const checks of provided)
    for (const check of checks) finallyAvailable.add(check)

  const errors: string[] = []
  tasks.forEach((task, index) => {
    for (const check of provided[index] ?? []) available.add(check)
    for (const check of task.requiredChecks) {
      if (available.has(check)) continue
      errors.push(
        `Task ${task.id} requires ${check}, but no executable command provides it by this task. ` +
          `Manual review steps do not define automated checks. Available checks: ${formatAvailable(available)}.`
      )
    }
    for (const check of task.deferredChecks) {
      if (finallyAvailable.has(check)) continue
      errors.push(
        `Task ${task.id} defers ${check}, but no executable command provides it anywhere in the task plan. ` +
          'Manual review steps do not define automated checks.'
      )
    }
  })
  return { valid: errors.length === 0, errors }
}
