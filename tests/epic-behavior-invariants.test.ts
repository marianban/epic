import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { normalizeFallowDelta } from '../pi/extensions/epic/checks.ts'
import { slashCommand, EPIC_COMMANDS } from '../pi/extensions/epic/commands.ts'
import { parseEpicDomainState } from '../pi/extensions/epic/domain-validation.ts'
import { AgentOutputCollector, parseTaskDecomposition } from '../pi/extensions/epic/agents.ts'
import { formatEscalationMessage } from '../pi/extensions/epic/epic.ts'
import { validateTaskExecutionResult } from '../pi/extensions/epic/machines/epic-machine.ts'
import {
  parsePersistedEpicEnvelope,
  persistImmutableJsonArtifact,
} from '../pi/extensions/epic/persistence.ts'
import { parseRepairAttempts } from '../pi/extensions/epic/machines/actor-system-projection.ts'
import { activeAgentRuns, finishAgentRun, startAgentRun } from '../pi/extensions/epic/agent-activity.ts'
import { resolveAgentProfile, resolveAgentProfiles } from '../pi/extensions/epic/agent-profiles.ts'
import {
  checkResultArtifactPath,
  currentTaskArtifactPath,
  implementationDiffArtifactPath,
  reviewResultArtifactPath,
} from '../pi/extensions/epic/artifact-paths.ts'
import { isImplementerSandboxSupported, quoteProcessInvocation } from '../pi/extensions/epic/implementer-sandbox.ts'
import { formatDuration } from '../pi/extensions/epic/dashboard/formatting.ts'
import { extractReviewInstructions, hashPlan, validatePlanCompleteness } from '../pi/extensions/epic/plan-review.ts'
import { humanContinuation } from '../pi/extensions/epic/human-actions.ts'
import { discoverPrerequisites, packageInstallCommand } from '../pi/extensions/epic/prerequisites.ts'
import { assertRepositoryPath, isSafeReadOnlyCommand, redactSecrets } from '../pi/extensions/epic/tools.ts'
import type { AgentRole, EpicDomainState, ResolvedEpicConfiguration } from '../pi/extensions/epic/types.ts'

function domain(root: string): EpicDomainState {
  return { epicId: 'run', epic: 'test', repositoryRoot: root, epicComplexity: 'moderate', scoutRound: 0, maxScoutRounds: 3, planPath: path.join(root, '.pi', 'epics', 'runs', 'run', 'plan.md'), planRevision: 0, planApproved: false, currentTaskIndex: 0, taskApproved: false, implementationAttempt: 0, maxFastRepairs: 2, maxFullRepairs: 1, maxSemanticRepairs: 2 }
}

test('review instructions retain line numbers across Windows line endings', () => {
  assert.deepEqual(extractReviewInstructions('line\r\nR: tighten scope\r\nnext'), [{ lineNumber: 2, text: 'tighten scope', rawLine: 'R: tighten scope' }])
})

test('plan hashing is deterministic', () => {
  assert.equal(hashPlan('same plan'), hashPlan('same plan'))
  assert.notEqual(hashPlan('first'), hashPlan('second'))
})

test('Fallow normalization separates baseline findings from new findings', () => {
  const baseline = [{ source: 'fallow', severity: 'error' as const, message: 'old' }]
  const result = normalizeFallowDelta('old\nnew', baseline)
  assert.equal(result.preExisting.length, 1)
  assert.equal(result.introduced.length, 1)
})

test('path guards reject escapes, secrets, and epic managed paths', () => {
  assert.throws(() => assertRepositoryPath('/repo', '../outside'))
  assert.throws(() => assertRepositoryPath('/repo', '.env'))
  assert.throws(() => assertRepositoryPath('/repo', '.pi/epics/state.json'))
  assert.equal(assertRepositoryPath('/repo', 'src/file.ts'), '/repo/src/file.ts')
})

test('read-only command guard blocks mutations and secret redaction removes tokens', () => {
  assert.equal(isSafeReadOnlyCommand('git status'), true)
  assert.equal(isSafeReadOnlyCommand('git commit -m x'), false)
  assert.equal(redactSecrets('token=abc123 ghp_abcdefghijk'), 'token=[REDACTED] [REDACTED]')
})

test('registered commands are rendered as slash commands', () => {
  assert.equal(slashCommand(EPIC_COMMANDS.approveTask), '/task-approve')
})

test('prerequisites discover Git and lockfile-aware Node installation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-prereqs-'))
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { x: '1' } }))
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}')
    assert.equal(await packageInstallCommand(root), 'npm ci')
    assert.deepEqual((await discoverPrerequisites(root)).map((item) => item.kind), ['git', 'node_dependencies'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('domain parser rejects malformed nested tasks, indexes, and limits', () => {
  const current = domain('/repo')
  assert.equal(parseEpicDomainState(current, 'test').epicId, 'run')
  assert.throws(() => parseEpicDomainState({ ...current, currentTaskIndex: -1 }, 'test'), /currentTaskIndex/)
  assert.throws(() => parseEpicDomainState({ ...current, maxFastRepairs: 1.5 }, 'test'), /maxFastRepairs/)
  assert.throws(() => parseEpicDomainState({ ...current, tasks: [{}] }, 'test'), /tasks\[0\]/)
})

test('agent output collector retains the latest assistant output and aggregates usage', () => {
  const collector = new AgentOutputCollector()
  collector.append(Buffer.from(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } })}\n`))
  collector.append(Buffer.from(`${JSON.stringify({ type: 'agent_end', messages: [{ usage: { input: 2, output: 3 } }] })}\n`))
  collector.append(Buffer.from(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } })}\n`))
  const result = collector.finish()
  assert.equal(result.output, 'final')
  assert.deepEqual(result.usage, { input: 2, output: 3 })
  assert.equal(result.failureReason, undefined)
})

test('agent output collector reports protocol failures independently of process exit', () => {
  const collector = new AgentOutputCollector()
  collector.append(Buffer.from(`${JSON.stringify({ type: 'agent_end', errorMessage: 'provider unavailable' })}\n`))
  assert.equal(collector.finish().failureReason, 'provider unavailable')
})

test('agent profiles merge defaults and partial overrides into a complete canonical collection', () => {
  const configuration = {
    agents: { scout: { model: 'scout-model' } },
  } as ResolvedEpicConfiguration
  assert.equal(resolveAgentProfile('scout', configuration).thinking, 'low')
  assert.equal(resolveAgentProfile('scout', configuration).model, 'scout-model')
  assert.equal(resolveAgentProfile('planner', configuration).systemPromptPath, '.pi/agents/planner.md')
  assert.equal(resolveAgentProfile('task-planner', configuration).systemPromptPath, '.pi/agents/task-planner.md')
  assert.equal(resolveAgentProfile('task-planner', configuration).thinking, 'high')
  const roles = resolveAgentProfiles(configuration).map((profile) => profile.role)
  const expected: AgentRole[] = [
    'scout',
    'planner',
    'task-planner',
    'implementer',
    'reviewer',
    'plan-reviewer',
    'task-reviewer',
  ]
  assert.deepEqual(roles, expected)
})

test('agent output collector captures Pi identity and rejects identity changes', () => {
  const collector = new AgentOutputCollector()
  collector.append(Buffer.from(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'openai', model: 'model-a', content: [{ type: 'text', text: 'done' }] } })}\n`))
  const result = collector.finish()
  assert.equal(result.provider, 'openai')
  assert.equal(result.model, 'model-a')

  const inconsistent = new AgentOutputCollector()
  inconsistent.append(Buffer.from('{"type":"message_end","message":{"role":"assistant","provider":"openai","model":"model-a","content":[]}}\n'))
  assert.throws(() => inconsistent.append(Buffer.from('{"type":"message_end","message":{"role":"assistant","provider":"openai","model":"model-b","content":[]}}\n')), /inconsistent model identity/)
})

test('task decomposition parser requires independently reviewable task fields', () => {
  assert.throws(() => parseTaskDecomposition(JSON.stringify([{ id: 'T1' }])), /Task Planner returned no implementation tasks/)
  assert.throws(() => parseTaskDecomposition('not-json'), /task-planner returned invalid JSON/)
})

test('escalation formatting retains the durable failure reason', () => {
  assert.equal(formatEscalationMessage({ domain: { ...domain('/repo'), failureReason: 'task failed' }, boundary: { stage: 'escalating', wait: 'awaiting-human' } }, 'resume'), 'task failed resume')
  assert.equal(formatEscalationMessage({ domain: domain('/repo'), boundary: { stage: 'escalating', wait: 'awaiting-human', failureDiagnostics: { reason: 'child task failed', repairs: { fast: 0, full: 0, semantic: 1 } } } }, 'resume'), 'child task failed resume')
})

test('task completion validation rejects malformed domains and repair counters before parent use', () => {
  const valid = { kind: 'completed' as const, domain: domain('/repo'), repairs: { fast: 0, full: 0, semantic: 0 } }
  assert.equal(validateTaskExecutionResult(valid).kind, 'completed')
  assert.throws(() => validateTaskExecutionResult({ ...valid, domain: {} }), /epicComplexity/)
  assert.throws(() => validateTaskExecutionResult({ ...valid, repairs: { fast: '0', full: 0, semantic: 0 } }), /repair attempts/)
  assert.throws(() => validateTaskExecutionResult({ ...valid, kind: 'escalated' }), /failure reason/)
})

test('persisted envelope parser rejects extra fields, identity mismatches, and incomplete domains', () => {
  const state = domain('/repo')
  const envelope = { schemaVersion: 6 as const, machineVersion: 10 as const, epicId: 'run', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', snapshot: { value: 'idle', context: { state } } }
  assert.equal(parsePersistedEpicEnvelope(envelope).epicId, 'run')
  assert.throws(() => parsePersistedEpicEnvelope({ ...envelope, legacyDomain: state }), /unsupported fields/)
  assert.throws(() => parsePersistedEpicEnvelope({ ...envelope, epicId: 'other' }), /does not match/)
  assert.throws(() => parsePersistedEpicEnvelope({ ...envelope, snapshot: { value: 'idle', context: { state: { epicId: 'run' } } } }), /epicComplexity/)
})

test('repair projection accepts only exact non-negative integer counters', () => {
  assert.deepEqual(parseRepairAttempts({ fast: 0, full: 1, semantic: 2 }), { fast: 0, full: 1, semantic: 2 })
  for (const repairs of [{}, { fast: 0, full: 1 }, { fast: -1, full: 0, semantic: 0 }, { fast: 1.5, full: 0, semantic: 0 }, { fast: '0', full: 0, semantic: 0 }])
    assert.throws(() => parseRepairAttempts(repairs))
})

test('active agent runs filter by epic and ignore future starts', () => {
  startAgentRun('invariant-run', '/repo', 'run', 100, 'T1', 'implementer')
  try {
    assert.equal(activeAgentRuns('/repo', 'run', 99).length, 0)
    assert.equal(activeAgentRuns('/repo', 'run', 100).length, 1)
    assert.equal(activeAgentRuns('/repo', 'other', 100).length, 0)
  } finally { finishAgentRun('invariant-run') }
})

test('agent activity rejects invalid clocks and duplicate run ids', () => {
  assert.throws(() => activeAgentRuns('/repo', 'run', -1), /non-negative/)
  startAgentRun('invariant-duplicate', '/repo', 'run', 0, undefined, 'scout')
  try { assert.throws(() => startAgentRun('invariant-duplicate', '/repo', 'run', 0, undefined, 'scout'), /already active/) }
  finally { finishAgentRun('invariant-duplicate') }
})

test('task artifact paths use one-based zero-padded task indexes', () => {
  assert.match(currentTaskArtifactPath({ ...domain('/repo'), currentTaskIndex: 4 }), /tasks\/task-005\.md$/)
})

test('generated result artifact paths include task, attempt, and unique identity', () => {
  const state = { ...domain('/repo'), currentTaskIndex: 1 }
  assert.equal(
    implementationDiffArtifactPath(state, 3, 'diff-id'),
    path.join('diffs', 'task-002-implementation-003-diff-id.json')
  )
  assert.equal(
    checkResultArtifactPath(state, 'full', 'check-id'),
    path.join('checks', 'task-002-full-check-id.json')
  )
  assert.equal(
    reviewResultArtifactPath(state, 0, 'review-id'),
    path.join('reviews', 'task-002-review-001-review-id.json')
  )
  assert.throws(
    () => reviewResultArtifactPath(state, 0, '../escape'),
    /Invalid review artifact token/
  )
})

test('immutable artifacts fail instead of overwriting an existing result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-artifact-'))
  const state = domain(root)
  try {
    const relativePath = path.join('reviews', 'task-001-review-001-id.json')
    const filePath = await persistImmutableJsonArtifact(state, relativePath, {
      version: 1,
    })
    await assert.rejects(
      persistImmutableJsonArtifact(state, relativePath, { version: 2 }),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST'
    )
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
      version: 1,
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandbox capability is platform-specific and invocation quoting is shell-safe', () => {
  assert.equal(isImplementerSandboxSupported('win32'), false)
  assert.equal(isImplementerSandboxSupported('linux'), true)
  assert.equal(quoteProcessInvocation('pi', ['a b', "x'y"]), "'pi' 'a b' 'x'\\''y'")
})

test('duration formatting is stable at representative boundaries', () => {
  assert.equal(formatDuration(0), '00:00')
  assert.equal(formatDuration(61_000), '01:01')
})

test('review instructions appended to plan lines request refinement', () => {
  assert.equal(humanContinuation('Implement the service. R: include rollback'), 'review')
})

test('plans missing required sections fail completeness validation', () => {
  assert.equal(validatePlanCompleteness('# Implementation Plan').valid, false)
})

test('plans with unresolved R comments fail completeness validation', () => {
  assert.equal(validatePlanCompleteness('R: clarify risk').errors.some((error) => error.includes('unresolved R')), true)
})

test('agent output collector clears transient provider failures after a successful response', () => {
  const collector = new AgentOutputCollector()
  collector.append(Buffer.from('{"type":"agent_end","errorMessage":"temporary"}\n'))
  collector.append(Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"recovered"}]}}\n'))
  assert.equal(collector.finish().failureReason, undefined)
})

test('agent output collector ignores malformed JSONL safely', () => {
  const collector = new AgentOutputCollector()
  collector.append(Buffer.from('not-json\n'))
  assert.equal(collector.finish().output, '')
})

test('task parser rejects duplicated required checks', () => {
  const task = { id: 'T1', title: 'T', objective: 'O', files: { context: [], expectedChanges: [] }, implementation: [], acceptanceCriteria: ['done'], verification: [], manualReviewSteps: ['review'], requiredChecks: ['test', 'test'], deferredChecks: [], reason: 'needed' }
  assert.throws(() => parseTaskDecomposition(JSON.stringify({ tasks: [task] })), /duplicate required checks/)
})

test('task parser rejects checks that are both required and deferred', () => {
  const task = { id: 'T1', title: 'T', objective: 'O', files: { context: [], expectedChanges: [] }, implementation: [], acceptanceCriteria: ['done'], verification: [], manualReviewSteps: ['review'], requiredChecks: ['test'], deferredChecks: ['test'], reason: 'needed' }
  assert.throws(() => parseTaskDecomposition(JSON.stringify({ tasks: [task] })), /cannot require and defer/)
})

test('package installation prefers pnpm then yarn lockfiles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-lock-'))
  try {
    await fs.writeFile(path.join(root, 'yarn.lock'), '')
    assert.equal(await packageInstallCommand(root), 'yarn install')
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '')
    assert.equal(await packageInstallCommand(root), 'pnpm install')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('duration formatter rejects negative and non-finite values', () => {
  assert.throws(() => formatDuration(-1), /finite non-negative/)
  assert.throws(() => formatDuration(Number.NaN), /finite non-negative/)
})

test('domain parser preserves optional durable fields', () => {
  const result = parseEpicDomainState({ ...domain('/repo'), scoutReportPath: '/repo/report', approvedPlanHash: 'hash', failureReason: 'failed' }, 'test')
  assert.equal(result.failureReason, 'failed')
})

test('domain parser rejects invalid optional scalar fields', () => {
  assert.throws(() => parseEpicDomainState({ ...domain('/repo'), planApprovedAt: 1 }, 'test'), /planApprovedAt/)
})

test('repair parser rejects unsupported counter keys', () => {
  assert.throws(() => parseRepairAttempts({ fast: 0, full: 0, semantic: 0, other: 1 }), /unsupported/)
})

test('Fallow JSON output preserves explicit introduced and resolved groups', () => {
  const result = normalizeFallowDelta(JSON.stringify({ introduced: ['new'], preExisting: ['old'], resolved: ['gone'] }))
  assert.deepEqual([result.introduced.length, result.preExisting.length, result.resolved.length], [1, 1, 1])
})

test('plan validation reports broad-scope language as a warning', () => {
  assert.equal(validatePlanCompleteness('refactor as needed').warnings.length, 1)
})

test('task parser requires acceptance criteria and manual review steps', () => {
  const task = { id: 'T1', title: 'T', objective: 'O', files: { context: [], expectedChanges: [] }, implementation: [], acceptanceCriteria: [], verification: [], manualReviewSteps: [], requiredChecks: [], deferredChecks: [], reason: 'needed' }
  assert.throws(() => parseTaskDecomposition(JSON.stringify({ tasks: [task] })), /acceptance criteria and manual review/)
})

test('task parser rejects the legacy scope shape', () => {
  const task = { id: 'T1', title: 'T', objective: 'O', scope: { read: [], modify: [], create: [], delete: [] }, implementation: [], acceptanceCriteria: ['done'], verification: [], manualReviewSteps: ['review'], requiredChecks: [], deferredChecks: [], reason: 'needed' }
  assert.throws(() => parseTaskDecomposition(JSON.stringify({ tasks: [task] })), /invalid task/)
})

test('task parser requires string arrays for advisory file metadata', () => {
  const task = { id: 'T1', title: 'T', objective: 'O', implementation: [], acceptanceCriteria: ['done'], verification: [], manualReviewSteps: ['review'], requiredChecks: [], deferredChecks: [], reason: 'needed' }
  assert.throws(() => parseTaskDecomposition(JSON.stringify({ tasks: [task] })), /invalid task/)
  assert.throws(() => parseTaskDecomposition(JSON.stringify({ tasks: [{ ...task, files: { context: ['src/main.ts'], expectedChanges: [1] } }] })), /invalid task/)
})

test('prerequisite discovery is empty for an initialized non-Node repository', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-empty-'))
  try {
    await fs.mkdir(path.join(root, '.git'))
    assert.deepEqual(await discoverPrerequisites(root), [])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('finishing an agent run removes it from active activity', () => {
  startAgentRun('invariant-finish', '/repo', 'run', 0, undefined, 'scout')
  finishAgentRun('invariant-finish')
  assert.equal(activeAgentRuns('/repo', 'run', 0).some((run) => run.role === 'scout'), false)
})

test('task artifact path starts with task one at index zero', () => {
  assert.match(currentTaskArtifactPath(domain('/repo')), /task-001\.md$/)
})

test('sandbox support includes macOS', () => {
  assert.equal(isImplementerSandboxSupported('darwin'), true)
})

test('read-only command guard accepts a simple test command', () => {
  assert.equal(isSafeReadOnlyCommand('npm test'), true)
})

test('secret redaction handles password assignments', () => {
  assert.equal(redactSecrets('password: hunter2'), 'password=[REDACTED]')
})

test('format duration includes hours after the hour boundary', () => {
  assert.equal(formatDuration(3_661_000), '01:01:01')
})

test('human continuation approves artifacts without review instructions', () => {
  assert.equal(humanContinuation('ready'), 'approve')
})
