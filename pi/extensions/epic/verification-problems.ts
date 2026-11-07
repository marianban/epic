import type {
  VerificationCycle,
  VerificationPlan,
  VerificationProblem,
} from './verification-types.ts'

/** Attach validation diagnostics to their obligations at the validation boundary. */
export function obligationProblems(
  messages: string[],
  plan: VerificationPlan
): VerificationProblem[] {
  return messages.map((message) => ({
    stage: 'obligation',
    obligationIds: plan.obligations
      .filter((o) => message.startsWith(`${o.id}:`))
      .map((o) => o.id),
    message,
  }))
}

function resolvedIds(
  cycle: VerificationCycle,
  stage: VerificationProblem['stage']
): string[] {
  if (stage === 'obligation' || stage === 'browser_exploration')
    return cycle.evidence
      .filter(
        (e) =>
          e.outcome !== 'inconclusive' &&
          (stage !== 'browser_exploration' || e.method === 'agent_browser')
      )
      .map((e) => e.obligationId)
  if (stage === 'evidence_review')
    return cycle.evidenceReviews.flatMap((r) => r.obligationIds)
  return []
}

function resolvedStage(
  cycle: VerificationCycle,
  stage: VerificationProblem['stage']
): boolean {
  switch (stage) {
    case 'fast':
      return cycle.fast?.passed === true
    case 'full':
      return cycle.full?.passed === true
    case 'browser_setup':
      return cycle.browserOpened === true
    case 'browser_smoke':
      return cycle.smoke?.passed === true
    case 'semantic_review':
      return cycle.review !== undefined
    case 'interruption':
      return cycle.completed
    default:
      return false
  }
}

/** Supersede only observations actually rechecked; original cycles remain immutable. */
export function currentVerificationProblems(
  cycles: VerificationCycle[]
): VerificationProblem[] {
  let problems: VerificationProblem[] = []
  for (const cycle of cycles) {
    problems = problems.flatMap((problem) => {
      if (resolvedStage(cycle, problem.stage)) return []
      const resolved = resolvedIds(cycle, problem.stage)
      const obligationIds = problem.obligationIds.filter(
        (id) => !resolved.includes(id)
      )
      if (problem.obligationIds.length && !obligationIds.length) return []
      return [{ ...problem, obligationIds }]
    })
    problems.push(...cycle.problems)
  }
  return problems
}
