import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeFindings } from '../pi/extensions/epic/check-findings.ts'
import { summarizeVerificationCycle } from '../pi/extensions/epic/verification-summary.ts'
import type { VerificationCycle } from '../pi/extensions/epic/verification-types.ts'
import type { CheckSuiteResult } from '../pi/extensions/epic/types.ts'

test('successful dependency JSON and build progress do not become findings', () => {
  assert.deepEqual(
    normalizeFindings(
      'install',
      JSON.stringify(
        {
          name: 'fixture',
          dependencies: { vite: { version: '7.3.7' } },
        },
        null,
        2
      ),
      '',
      0
    ),
    []
  )
  assert.deepEqual(
    normalizeFindings(
      'build',
      '> vite build\ntransforming...\n✓ 8 modules transformed.\ndist/index.html 0.42 kB\n✓ built in 1.43s',
      '',
      0
    ),
    []
  )
})

test('successful checks retain explicit warnings and errors without ANSI noise', () => {
  const findings = normalizeFindings(
    'build',
    '✓ built\nWarning: deprecated API',
    '\u001b[33m(!) Some chunks are larger than 500 kB\u001b[39m\nnpm WARN deprecated package\nerror: invalid configuration',
    0
  )
  assert.equal(findings.length, 4)
  assert.deepEqual(
    findings.map((f) => f.severity),
    ['warning', 'warning', 'warning', 'error']
  )
  assert.ok(findings.every((f) => !f.raw?.includes('\u001b')))
})

test('successful linters retain diagnostics with whitespace separators', () => {
  const findings = normalizeFindings(
    'lint',
    'src/game.ts\n  4:2  warning  unused value',
    '',
    0
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.severity, 'warning')
})

test('failed checks preserve diagnostics even without explicit error labels', () => {
  const findings = normalizeFindings(
    'test',
    'Expected 2, received 3',
    'at src/game.ts:12',
    1
  )
  assert.equal(findings.length, 2)
  assert.ok(findings.every((f) => f.severity === 'error'))
})

test('agent summaries omit duplicated logs and domain state while retaining failures and artifact references', () => {
  const output = 'dependency output\n'.repeat(10_000)
  const suite: CheckSuiteResult = {
    suite: 'full',
    passed: false,
    deferredChecks: [],
    checks: [true, false].map((passed) => ({
      name: passed ? 'install' : 'build',
      command: passed ? 'npm ls' : 'npm run build',
      passed,
      required: true,
      exitCode: passed ? 0 : 1,
      durationMs: 10,
      stdoutPreview: output,
      stderrPreview: passed ? '' : 'Build failed',
      findings: passed
        ? []
        : [
            {
              source: 'build',
              severity: 'error',
              message: 'Build failed',
              raw: 'Build failed',
            },
          ],
      outputTruncated: false,
    })),
    introducedFindings: [],
    preExistingFindings: [],
  }
  const cycle: VerificationCycle = {
    id: 'cycle',
    identity: 'attempt',
    attempt: 1,
    full: suite,
    state: { tasks: output } as never,
    evidence: [
      {
        obligationId: 'AC1:O1',
        criterionId: 'AC1',
        expected: 'build succeeds',
        actual: output,
        outcome: 'pass',
        method: 'automated',
        artifacts: ['evidence.json'],
        attempt: 1,
        identity: 'attempt',
        reproduction: 'npm run build',
      },
    ],
    problems: ['Another check is blocked'],
    artifacts: ['checks.json'],
  }
  const summary = summarizeVerificationCycle(cycle)
  const serialized = JSON.stringify(summary)
  assert.ok(serialized.length < 3500)
  assert.equal('state' in summary, false)
  const checks = summary.checks[0]?.checks
  const install = checks?.[0]
  const build = checks?.[1]
  assert.ok(install)
  assert.ok(build)
  assert.equal('stdoutPreview' in install, false)
  assert.equal(build.stderrPreview, 'Build failed')
  assert.match(build.stdoutPreview ?? '', /truncated; see evidence artifact/)
  assert.equal(summary.evidence[0]?.artifacts[0], 'evidence.json')
  assert.deepEqual(summary.problems, cycle.problems)
  assert.equal(cycle.full?.checks[0]?.stdoutPreview, output)
  assert.equal(cycle.evidence[0]?.actual, output)
})
