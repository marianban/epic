import type {
  TaskVerificationRecord,
  VerificationCycle,
  VerificationPlan,
  VerificationWorkItem,
} from './verification-types.ts'

export function hasBlockedPrerequisites(cycle: VerificationCycle): boolean {
  for (const suite of [cycle.fast, cycle.full]) {
    if (!suite) return true
    if (
      !suite.passed &&
      (suite.checks.some(
        (c) => c.required && !c.passed && [124, 127].includes(c.exitCode)
      ) ||
        !suite.checks.some((c) => c.required && !c.passed))
    )
      return true
    // A confirmed failure intentionally gates the subsequent suite.
    if (!suite.passed) return false
  }
  return false
}

/** Queue progress is provisional; only a full cycle establishes acceptance. */
function cycleWork(
  cycle: VerificationCycle,
  plan: VerificationPlan
): VerificationWorkItem[] {
  const work: VerificationWorkItem[] = []
  for (const suite of [cycle.fast, cycle.full]) {
    for (const check of suite?.checks ?? []) {
      if (
        check.required &&
        !check.passed &&
        ![124, 127].includes(check.exitCode)
      )
        work.push({
          id: `check:${check.name}`,
          kind: 'check',
          action: 'repair',
          feedback: JSON.stringify(check),
        })
    }
  }
  if (cycle.smoke?.findings.some((f) => f.category !== 'infrastructure'))
    work.push({
      id: 'check:browser-smoke',
      kind: 'smoke',
      action: 'repair',
      feedback: JSON.stringify(cycle.smoke),
    })
  // Do not manufacture missing acceptance results when a prerequisite blocked execution.
  if (!cycle.fast?.passed || !cycle.full?.passed) return work
  for (const criterion of plan.criteria) {
    const obligations = plan.obligations.filter(
      (o) => o.criterionId === criterion.id && o.method !== 'human_only'
    )
    if (!obligations.length) continue
    const evidence = cycle.evidence.filter(
      (e) => e.criterionId === criterion.id
    )
    const failed = evidence.some((e) => e.outcome === 'fail' || e.outcome === 'likely-fail')
    const pending = obligations.some(
      (o) =>
        !evidence.some((e) => e.obligationId === o.id && e.outcome === 'pass')
    )
    if (pending)
      work.push({
        id: criterion.id,
        criterionId: criterion.id,
        kind: 'criterion',
        action: failed ? 'repair' : 'verify',
        feedback: JSON.stringify({
          criterion,
          evidence,
          problems: cycle.problems,
        }),
      })
  }
  return work
}

export function selectedPlan(
  plan: VerificationPlan,
  item: VerificationWorkItem
): VerificationPlan {
  return {
    ...plan,
    criteria: plan.criteria.filter((c) => c.id === item.criterionId),
    obligations: plan.obligations.filter(
      (o) => o.criterionId === item.criterionId
    ),
  }
}

export function deferExhaustedRepair(record: TaskVerificationRecord, target: VerificationWorkItem): void {
  const schedule = record.schedule
  if (schedule.queue[0]?.id !== target.id || target.action !== 'repair')
    throw new Error('Exhausted repair does not match the persisted queue.')
  schedule.queue.shift()
  const blocked = target.kind === 'check'
    ? schedule.queue.filter(item => item.kind === 'criterion' && item.action === 'verify')
    : []
  const deferred = new Map([target, ...blocked].map(item => [item.id, item]))
  schedule.queue = schedule.queue.filter(item => !deferred.has(item.id))
  schedule.deferred = schedule.deferred.filter(item => !deferred.has(item.id))
  schedule.deferred.push(...deferred.values())
  schedule.phase = schedule.queue.length ? 'targeted' : schedule.finalRequired ? 'final_full' : 'done'
}

export function processVerificationCycle(
  record: TaskVerificationRecord,
  cycle: VerificationCycle
): void {
  if (!record.plan)
    throw new Error('Cannot schedule verification without an approved plan.')
  if (!cycle.completed)
    throw new Error('Cannot schedule an incomplete verification cycle.')
  const schedule = record.schedule
  const work = cycleWork(cycle, cycle.plan ?? record.plan)
  if (cycle.kind !== 'targeted') {
    schedule.queue =
      cycle.kind === 'final_full'
        ? work.filter((w) => w.action === 'repair')
        : work
    schedule.deferred =
      cycle.kind === 'final_full'
        ? work.filter((w) => w.action === 'verify')
        : []
    if (cycle.kind === 'final_full') schedule.finalRequired = false
  } else {
    const target = cycle.target
    if (!target || schedule.queue[0]?.id !== target.id)
      throw new Error(
        'Targeted verification does not match the persisted queue.'
      )
    if (target.kind !== 'semantic') schedule.queue.shift()
    if (
      (!cycle.fast?.passed || !cycle.full?.passed) &&
      target.kind === 'criterion'
    ) {
      // The criterion was never reached. Repair the prerequisite, then verify the existing fix.
      schedule.queue.unshift({ ...target, action: 'verify' })
    }
    const remaining = work.filter(
      (w) => !schedule.queue.some((q) => q.id === w.id)
    )
    for (const item of remaining) {
      // One evidence-only attempt per gap per round. Observed contradictions enter repair.
      if (item.action === 'verify') {
        schedule.deferred = schedule.deferred.filter((d) => d.id !== item.id)
        schedule.deferred.push(item)
      } else schedule.queue.push(item)
    }
    schedule.queue.sort(
      (a, b) => Number(b.kind === 'check') - Number(a.kind === 'check')
    )
  }
  // Semantic work is authoritative in the registry, not the wording of this cycle's review.
  const active = record.findings.filter(f => f.status === 'open' && f.feedback.severity !== 'suggestion')
  const semantic = new Map(active.map(f => [`review:${f.id}`, {
    id: `review:${f.id}`, kind: 'semantic' as const, action: 'repair' as const, feedback: JSON.stringify(f.feedback),
  }]))
  schedule.queue = schedule.queue.flatMap(item => {
    if (item.kind !== 'semantic') return [item]
    const updated = semantic.get(item.id)
    semantic.delete(item.id)
    return updated ? [updated] : []
  })
  schedule.queue.push(...semantic.values())
  delete schedule.repairInvocationId
  schedule.processedCycleId = cycle.id
  schedule.phase = schedule.queue.length
    ? 'targeted'
    : schedule.finalRequired
      ? 'final_full'
      : 'done'
}

export function repairInstructions(item: VerificationWorkItem): string {
  return `Repair only this work item: ${item.id} (${item.kind}). Related changes necessary for this fix are allowed. Do not repair other criteria or weaken acceptance requirements. Investigate the application and probe using the expected result, contradiction, reproduction steps, and artifacts below. An inconclusive result requires investigation, but does not establish a code defect. Before changing application code, identify a concrete defect and explain how it accounts for the observed result. Fix established defects and demonstrate the expected behavior. If no defect is established, report what you checked and what evidence is still missing; do not change code solely to resolve uncertainty or claim the behavior is verified. An infrastructure explanation requires concrete evidence of a tool or delivery failure.\n${item.feedback}`
}
