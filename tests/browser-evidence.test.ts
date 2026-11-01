import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { concludeBrowserProbe } from '../pi/extensions/epic/browser-conclusion.ts'
import { validateCaptureBudget } from '../pi/extensions/epic/browser-capture.ts'
import { validateBrowserStep } from '../pi/extensions/epic/verification-plan.ts'
import { validateAcceptanceEvidence } from '../pi/extensions/epic/acceptance-validation.ts'
import type {
  BrowserConclusion,
  BrowserProbe,
} from '../pi/extensions/epic/browser-evidence-types.ts'
import type { VerificationObligation } from '../pi/extensions/epic/verification-types.ts'
import verifierTools from '../pi/extensions/epic/verifier-tools.ts'
import type {
  ExtensionAPI,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-evidence-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const obligation: VerificationObligation = {
    id: 'movement',
    criterionId: 'AC1',
    expected: 'Right moves the paddle',
    method: 'agent_browser',
  }
  const probe: BrowserProbe = {
    id: 'probe',
    obligationId: obligation.id,
    criterionId: obligation.criterionId,
    identity: 'cycle',
    attempt: 1,
    invocationId: 'invocation',
    startedAt: 10,
    completedAt: 30,
    steps: [
      { action: 'observe', expression: 'window.paddle.x' },
      { action: 'observe', expression: 'window.paddle.x' },
    ],
    observations: [
      {
        id: 'before',
        stepIndex: 0,
        timestamp: 10,
        kind: 'observation',
        value: 40,
      },
      {
        id: 'after',
        stepIndex: 1,
        timestamp: 30,
        kind: 'observation',
        value: 80,
      },
    ],
    images: [],
    runtimeErrors: [],
    probeErrors: [],
    artifact: path.join(root, 'probe.json'),
    trace: '',
  }
  await fs.writeFile(probe.artifact, JSON.stringify(probe))
  const conclusion: BrowserConclusion = {
    obligationId: obligation.id,
    outcome: 'pass',
    basis: 'motion',
    evidenceIds: ['before', 'after'],
    explanation: 'After Right, paddle x increased from 40 to 80.',
    temporalComparison: 'The same page was measured before and after Right.',
    limitations: [],
  }
  const options = {
    obligation,
    probes: [probe],
    invocationId: 'invocation',
    identity: 'cycle',
    attempt: 1,
    artifactRoot: root,
    nowMs: () => 40,
  }
  return {
    root,
    probe,
    conclusion,
    options,
    conclude: (c: BrowserConclusion) =>
      concludeBrowserProbe({ ...options, conclusion: c }),
  }
}

test('conclusions preserve runtime evidence and reject altered persisted interpretations', async (t) => {
  const f = await fixture(t)
  const result = await f.conclude(f.conclusion)
  const plan = {
    version: 1,
    criterionVersion: 1,
    criteria: [{ id: 'AC1', text: f.options.obligation.expected }],
    obligations: [f.options.obligation],
  }
  assert.equal(
    (await validateAcceptanceEvidence([result], plan, 'cycle', 1, f.root))
      .problems.length,
    0
  )
  assert.ok(result.conclusion)
  const altered = {
    ...result,
    conclusion: {
      ...result.conclusion,
      explanation: 'Unsupported changed claim',
    },
  }
  assert.match(
    (
      await validateAcceptanceEvidence([altered], plan, 'cycle', 1, f.root)
    ).problems.join(' '),
    /Conclusion differs/
  )
  assert.match(
    (
      await validateAcceptanceEvidence(
        [{ ...result, conclusion: undefined }],
        plan,
        'cycle',
        1,
        f.root
      )
    ).problems.join(' '),
    /explicit recorded conclusion/
  )
})

test('foreign/stale IDs and motion from separate executions cannot establish acceptance', async (t) => {
  const f = await fixture(t)
  for (const evidenceIds of [['unknown'], ['probe']]) {
    await assert.rejects(
      f.conclude({ ...f.conclusion, evidenceIds }),
      /unknown|timed|measured/
    )
  }
  for (const [field, value] of [
    ['invocationId', 'old'],
    ['identity', 'old'],
    ['attempt', 2],
    ['obligationId', 'other'],
  ] as const) {
    const other = { ...f.probe, [field]: value }
    await assert.rejects(
      concludeBrowserProbe({
        ...f.options,
        probes: [other],
        conclusion: f.conclusion,
      }),
      /foreign|stale/
    )
  }
  const second = {
    ...f.probe,
    id: 'second',
    observations: [{ ...f.probe.observations[1], id: 'other-after' }],
  }
  await assert.rejects(
    concludeBrowserProbe({
      ...f.options,
      probes: [f.probe, second],
      conclusion: { ...f.conclusion, evidenceIds: ['before', 'other-after'] },
    }),
    /separateExecutions/
  )
  await assert.rejects(
    concludeBrowserProbe({
      ...f.options,
      probes: [f.probe, second],
      conclusion: {
        ...f.conclusion,
        evidenceIds: ['before', 'other-after'],
        separateExecutions: 'Independent fresh pages.',
      },
    }),
    /same probe/
  )
  await assert.rejects(
    f.conclude({ ...f.conclusion, basis: 'visual' }),
    /image IDs/
  )
})

test('probe success, fixtures, visibility and unconditional assertions alone never pass', async (t) => {
  const f = await fixture(t)
  for (const step of [
    { action: 'inspect' as const, expression: 'true' },
    { action: 'visible' as const, selector: 'canvas', value: 'true' },
    { action: 'fixture' as const, expression: 'true' },
  ]) {
    f.probe.steps = [step]
    f.probe.observations = [
      {
        id: 'trivial',
        stepIndex: 0,
        timestamp: 10,
        kind: step.action === 'fixture' ? 'fixture' : 'assertion',
        value: true,
        passed: true,
      },
    ]
    await assert.rejects(
      f.conclude({
        ...f.conclusion,
        basis: 'observations',
        evidenceIds: ['trivial'],
      }),
      /measured/
    )
  }
})

test('runtime errors survive corrected probes while probe failures can be corrected', async (t) => {
  const f = await fixture(t)
  const previous = {
    ...f.probe,
    invocationId: 'previous',
    runtimeErrors: ['Uncaught game exception'],
  }
  await assert.rejects(
    concludeBrowserProbe({
      ...f.options,
      probes: [previous, f.probe],
      conclusion: f.conclusion,
    }),
    /runtime errors/
  )
  await assert.rejects(
    concludeBrowserProbe({
      ...f.options,
      probes: [{ ...f.probe, probeErrors: ['Wrong selector'] }],
      conclusion: f.conclusion,
    }),
    /probe has errors/
  )
  assert.equal(
    (
      await concludeBrowserProbe({
        ...f.options,
        probes: [
          { ...previous, runtimeErrors: [], probeErrors: ['Wrong selector'] },
          f.probe,
        ],
        conclusion: f.conclusion,
      })
    ).outcome,
    'pass'
  )
  const unresolved = await f.conclude({
    ...f.conclusion,
    outcome: 'inconclusive',
    evidenceIds: [],
    gap: 'inconclusive',
    limitations: ['Trajectory not measurable.'],
  })
  assert.equal(unresolved.gap, 'inconclusive')
  await assert.rejects(
    f.conclude({ ...f.conclusion, outcome: 'inconclusive' }),
    /gap/
  )
})

test('capture counts, intervals and held-key/wait steps are validated', () => {
  const limits = { maxFrames: 12, maxCaptureDurationMs: 10_000 }
  for (const step of [
    { action: 'capture', count: 0, intervalMs: 0 },
    { action: 'capture', count: 2, intervalMs: 0 },
    { action: 'wait', durationMs: -1 },
    { action: 'key_down', key: '' },
  ])
    assert.throws(() => validateBrowserStep(step, 'step'))
  assert.throws(
    () =>
      validateCaptureBudget(
        [{ action: 'capture', count: 13, intervalMs: 1 }],
        limits
      ),
    /budget/
  )
  assert.throws(
    () =>
      validateCaptureBudget(
        [{ action: 'capture', count: 3, intervalMs: 6000 }],
        limits
      ),
    /budget/
  )
  assert.throws(
    () =>
      validateCaptureBudget([{ action: 'wait', durationMs: 10001 }], limits),
    /wait/
  )
  validateCaptureBudget(
    [{ action: 'capture', count: 12, intervalMs: 900 }],
    limits
  )
})

test('all browser tools are sequential and reject unknown/text-only models before making requests', async () => {
  const oldUrl = process.env.PI_EPIC_BROWSER_URL
  const oldToken = process.env.PI_EPIC_BROWSER_TOKEN
  process.env.PI_EPIC_BROWSER_URL = 'http://127.0.0.1:1/scenario'
  process.env.PI_EPIC_BROWSER_TOKEN = 'test'
  const tools: ToolDefinition[] = []
  try {
    verifierTools({
      registerTool: (tool) => {
        tools.push(tool as unknown as ToolDefinition)
      },
    } as ExtensionAPI)
    assert.deepEqual(
      tools.map((t) => t.name),
      ['browser_verify', 'browser_conclude']
    )
    for (const tool of tools) {
      assert.equal(tool.executionMode, 'sequential')
      for (const model of [undefined, { input: ['text'] }])
        await assert.rejects(
          tool.execute('call', {} as never, undefined, undefined, {
            model,
          } as never),
          /image-capable verifier model/
        )
    }
  } finally {
    if (oldUrl === undefined) delete process.env.PI_EPIC_BROWSER_URL
    else process.env.PI_EPIC_BROWSER_URL = oldUrl
    if (oldToken === undefined) delete process.env.PI_EPIC_BROWSER_TOKEN
    else process.env.PI_EPIC_BROWSER_TOKEN = oldToken
  }
})


test('likely failures require cited contradictions, uncertainty and a confirmation check', async t => {
  const f = await fixture(t)
  const suspectedFailure = {
    contradiction: 'Paddle stayed centered after repeated held arrow inputs.',
    uncertainty: 'Keyboard delivery to Phaser could not be confirmed.',
    confirmationCheck: 'Focus the canvas and record key state and paddle x before and after a held Right key.',
  }
  const conclusion: BrowserConclusion = {
    ...f.conclusion,
    outcome: 'likely-fail',
    explanation: suspectedFailure.contradiction,
    suspectedFailure,
    limitations: [suspectedFailure.uncertainty],
  }
  for (const field of ['contradiction', 'uncertainty', 'confirmationCheck'] as const) {
    await assert.rejects(f.conclude({ ...conclusion, suspectedFailure: { ...suspectedFailure, [field]: ' ' } }), /Likely-fail requires/)
  }
  await assert.rejects(f.conclude({ ...conclusion, suspectedFailure: undefined }), /Likely-fail requires/)
  await assert.rejects(f.conclude({ ...conclusion, evidenceIds: [] }), /recorded evidence/)
  await assert.rejects(f.conclude({ ...conclusion, basis: 'observations', evidenceIds: ['probe'] }), /measured observations/)
  await assert.rejects(f.conclude({ ...conclusion, gap: 'inconclusive' }), /Only inconclusive/)
  await assert.rejects(f.conclude({ ...conclusion, outcome: 'pass' }), /Only likely-fail/)
  const result = await f.conclude(conclusion)
  const plan = { version: 1, criterionVersion: 1, criteria: [{ id: 'AC1', text: f.options.obligation.expected }], obligations: [f.options.obligation] }
  assert.equal(result.outcome, 'likely-fail')
  assert.deepEqual(result.suspectedFailure, suspectedFailure)
  assert.deepEqual((await validateAcceptanceEvidence([result], plan, 'cycle', 1, f.root)).problems, [])
  const altered = { ...result, suspectedFailure: { ...suspectedFailure, confirmationCheck: 'Changed claim' } }
  assert.match((await validateAcceptanceEvidence([altered], plan, 'cycle', 1, f.root)).problems.join(' '), /Artifact does not establish/)
})
