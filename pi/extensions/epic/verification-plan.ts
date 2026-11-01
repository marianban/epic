import type {
  ApprovedCriterion,
  VerificationPlan,
  BrowserStep,
  VerificationMethod,
} from './verification-types.ts'

export interface PlanValidationIssue {
  path: string
  code: string
  message: string
}

export class PlanValidationError extends Error {
  readonly issues: PlanValidationIssue[]
  constructor(issues: PlanValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
    this.name = 'PlanValidationError'
    this.issues = issues
  }
}

function reject(
  path: string,
  code: string,
  expected: string,
  received: unknown
): never {
  throw new PlanValidationError([
    {
      path,
      code,
      message: `expected ${expected}; received ${JSON.stringify(received) ?? 'undefined'}`,
    },
  ])
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    reject(path, 'invalid_string', 'a non-empty string', value)
}

export function parseVerificationPlan(output: string): unknown {
  try {
    return JSON.parse(output.trim()) as unknown
  } catch (error) {
    throw new PlanValidationError([
      {
        path: '$',
        code: 'invalid_json',
        message: `expected a single JSON object; received invalid JSON (${error instanceof Error ? error.message : String(error)}). Output: ${output.slice(0, 2_000)}`,
      },
    ])
  }
}

export function validateVerificationPlan(
  value: unknown,
  criteria: ApprovedCriterion[],
  criterionVersion: number
): VerificationPlan {
  if (!object(value))
    reject('$', 'invalid_object', 'a scenario plan object', value)
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1)
    reject(
      'version',
      'invalid_version',
      'a positive safe integer',
      value.version
    )
  if (value.criterionVersion !== criterionVersion)
    reject(
      'criterionVersion',
      'changed_criteria',
      `frozen criterion version ${criterionVersion}`,
      value.criterionVersion
    )
  if (JSON.stringify(value.criteria) !== JSON.stringify(criteria))
    reject(
      'criteria',
      'changed_criteria',
      `unchanged frozen criteria ${JSON.stringify(criteria)}`,
      value.criteria
    )
  if (!Array.isArray(value.obligations))
    reject(
      'obligations',
      'invalid_array',
      'an array of obligations',
      value.obligations
    )
  const ids = new Set<string>()
  const covered = new Set<string>()
  value.obligations.forEach((obligation: unknown, index: number) => {
    const prefix = `obligations[${index}]`
    if (!object(obligation))
      reject(prefix, 'invalid_object', 'an obligation object', obligation)
    nonEmptyString(obligation.id, `${prefix}.id`)
    if (ids.has(obligation.id))
      reject(
        `${prefix}.id`,
        'duplicate_id',
        'a unique obligation ID',
        obligation.id
      )
    ids.add(obligation.id)
    if (!criteria.some((criterion) => criterion.id === obligation.criterionId))
      reject(
        `${prefix}.criterionId`,
        'unknown_criterion',
        'an approved criterion ID',
        obligation.criterionId
      )
    covered.add(obligation.criterionId as string)
    nonEmptyString(obligation.expected, `${prefix}.expected`)
    if (!verificationMethods.includes(obligation.method as VerificationMethod))
      reject(
        `${prefix}.method`,
        'unknown_method',
        'automated, agent_browser, static, or human_only',
        obligation.method
      )
    if (obligation.command !== undefined)
      nonEmptyString(obligation.command, `${prefix}.command`)
    if (obligation.steps !== undefined) {
      if (!Array.isArray(obligation.steps) || !obligation.steps.length)
        reject(
          `${prefix}.steps`,
          'missing_steps',
          'a non-empty browser steps array',
          obligation.steps
        )
      obligation.steps.forEach((step: unknown, stepIndex: number) =>
        validateBrowserStep(step, `${prefix}.steps[${stepIndex}]`)
      )
      if (
        obligation.method !== 'agent_browser' &&
        !obligation.steps.some((step: BrowserStep) =>
          ['text', 'visible', 'inspect'].includes(step.action)
        )
      )
        reject(
          `${prefix}.steps`,
          'missing_assertion',
          'an observation/assertion (text, visible, or inspect)',
          obligation.steps
        )
    }
    if (
      obligation.method === 'automated' &&
      !obligation.command &&
      !obligation.steps
    )
      reject(
        prefix,
        'missing_execution',
        'a command or browser scenario for an automated obligation',
        obligation
      )
    if (obligation.method === 'static' && !obligation.command)
      reject(
        `${prefix}.command`,
        'missing_execution',
        'a command for independently executed static evidence',
        obligation.command
      )
    if (obligation.method === 'human_only')
      nonEmptyString(obligation.reason, `${prefix}.reason`)
  })
  for (const criterion of criteria)
    if (!covered.has(criterion.id))
      reject(
        'obligations',
        'omitted_criterion',
        `coverage of omitted approved criterion ${criterion.id}`,
        value.obligations
      )
  return value as unknown as VerificationPlan
}

export function validateBrowserStep(
  value: unknown,
  path: string
): asserts value is BrowserStep {
  if (!object(value))
    reject(path, 'invalid_object', 'a browser step object', value)
  const action = value.action
  if (['click', 'press', 'text', 'visible'].includes(action as string)) {
    nonEmptyString(value.selector, `${path}.selector`)
    if (typeof value.value !== 'string')
      reject(`${path}.value`, 'invalid_string', 'a string', value.value)
  } else if (action === 'pointer' || action === 'click_at') {
    for (const axis of ['x', 'y'])
      if (!Number.isFinite(value[axis]))
        reject(
          `${path}.${axis}`,
          'invalid_coordinate',
          'a finite coordinate',
          value[axis]
        )
    if (action === 'click_at' && !['left', 'middle', 'right'].includes(value.button as string))
      reject(`${path}.button`, 'invalid_button', 'left, middle, or right', value.button)
  } else if (action === 'mouse_down' || action === 'mouse_up') {
    if (!['left', 'middle', 'right'].includes(value.button as string))
      reject(`${path}.button`, 'invalid_button', 'left, middle, or right', value.button)
  } else if (action === 'resize') {
    for (const dimension of ['width', 'height'])
      if (!Number.isSafeInteger(value[dimension]) || (value[dimension] as number) < 1)
        reject(`${path}.${dimension}`, 'invalid_dimension', 'a positive integer', value[dimension])
  } else if (action === 'playwright') {
    nonEmptyString(value.code, `${path}.code`)
  } else if (action === 'inspect' || action === 'observe' || action === 'fixture') {
    nonEmptyString(value.expression, `${path}.expression`)
  } else if (action === 'key_down' || action === 'key_up') {
    nonEmptyString(value.key, `${path}.key`)
  } else if (action === 'wait' || action === 'hold') {
    if (action === 'hold') {
      if (!Array.isArray(value.keys) || !value.keys.length)
        reject(`${path}.keys`, 'invalid_keys', 'a non-empty array of unique key strings', value.keys)
      value.keys.forEach((key, index) => nonEmptyString(key, `${path}.keys[${index}]`))
      if (new Set(value.keys).size !== value.keys.length)
        reject(`${path}.keys`, 'duplicate_keys', 'unique key strings', value.keys)
    }
    if (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 0)
      reject(`${path}.durationMs`, 'invalid_duration', 'a non-negative integer', value.durationMs)
  } else if (action === 'capture') {
    if (value.selector !== undefined) nonEmptyString(value.selector, `${path}.selector`)
    if (!Number.isSafeInteger(value.count) || (value.count as number) < 1)
      reject(`${path}.count`, 'invalid_count', 'a positive integer', value.count)
    if (!Number.isSafeInteger(value.intervalMs) || (value.intervalMs as number) < 0 || ((value.count as number) > 1 && value.intervalMs === 0))
      reject(`${path}.intervalMs`, 'invalid_interval', 'a positive interval for sequences, or zero for a single frame', value.intervalMs)
  } else
    reject(
      `${path}.action`,
      'unknown_action',
      'a supported action (click, press, text, visible, pointer, mouse_down, mouse_up, click_at, hold, resize, playwright, inspect, observe, fixture, key_down, key_up, wait, capture)',
      action
    )
}

export function scenarioPlanningPrompt(
  criteria: ApprovedCriterion[],
  criterionVersion: number,
  scenarioVersion: number
): string {
  const example: VerificationPlan = {
    version: 1,
    criterionVersion: 1,
    criteria: [
      { id: 'example:AC1', text: 'The counter increments when clicked.' },
    ],
    obligations: [
      {
        id: 'example:AC1:O1',
        criterionId: 'example:AC1',
        expected: 'Counter shows 1 after one click.',
        method: 'automated',
        steps: [
          { action: 'click', selector: '#increment', value: '' },
          { action: 'text', selector: '#count', value: '1' },
        ],
      },
    ],
  }
  const methods = [
    {
      id: 'example:AC1:O1',
      criterionId: 'example:AC1',
      expected: 'Build succeeds.',
      method: 'automated',
      command: 'npm run build',
    },
    {
      id: 'example:AC1:O2',
      criterionId: 'example:AC1',
      expected: 'The counter increments.',
      method: 'agent_browser',
    },
    {
      id: 'example:AC1:O3',
      criterionId: 'example:AC1',
      expected: 'Package declares a build script.',
      method: 'static',
      command: `node -e "if(!require('./package.json').scripts.build)process.exit(1)"`,
    },
    {
      id: 'example:AC1:O4',
      criterionId: 'example:AC1',
      expected: 'Appearance matches the subjective design.',
      method: 'human_only',
      reason: 'Requires human aesthetic judgment.',
    },
  ]
  const steps: BrowserStep[] = [
    { action: 'click', selector: '#increment', value: '' },
    { action: 'press', selector: '#input', value: 'Enter' },
    { action: 'text', selector: '#count', value: '1' },
    { action: 'visible', selector: '#counter', value: 'true' },
    { action: 'pointer', x: 100, y: 120 },
    { action: 'mouse_down', button: 'left' },
    { action: 'mouse_up', button: 'left' },
    { action: 'click_at', x: 100, y: 120, button: 'left' },
    { action: 'hold', keys: ['ArrowRight', 'Space'], durationMs: 300 },
    { action: 'resize', width: 900, height: 900 },
    { action: 'playwright', code: 'await page.mouse.wheel(0, 300); return await page.evaluate(() => ({ scrollY }));' },
    {
      action: 'inspect',
      expression: "document.querySelector('#game-container') !== null",
    },
    { action: 'fixture', expression: 'window.testFixture.reset()' },
    { action: 'observe', expression: 'getComputedStyle(document.body).margin' },
  ]
  return `Derive independently checkable obligations from frozen approved criteria BEFORE implementation. Read relevant code and dependency contracts, but derive expectations from criteria. Do not change their meaning or invent passing evidence. Do not start a server/browser.
Verify the resulting state rather than repeating setup actions. For dependency installation criteria, check that node_modules and the applicable lockfile are present (for npm: test -d node_modules && test -f package-lock.json). Do not plan npm install, npm ci, or other dependency installation commands; installation belongs to implementation.
Return exactly ONE valid JSON object, without Markdown fences, prose, or trailing characters. Required fields: version=${scenarioVersion}, criterionVersion=${criterionVersion}, criteria=${JSON.stringify(criteria)}, obligations. Each obligation requires a unique non-empty id, an approved criterionId, expected, and method. Optional fields: command, steps, reason. Represent EVERY criterion; separate combined obligations.
Complete example (illustrative only; use the actual frozen criteria and versions above): ${JSON.stringify(example)}
Method examples (illustrative obligations): ${JSON.stringify(methods)}
Automated obligations require command or steps. Prefer agent_browser for behavior that requires browser exploration or interpretation. For agent_browser, expected defines the required observable behavior; omit steps unless a useful starting suggestion is known. Any supplied steps are suggestions the verifier may adjust, not frozen assertions. Do not encode incidental representation details such as computed CSS serialization as requirements. Static evidence requires a command independently executed by the verifier. Human-only requires a genuine subjective/access reason.
Browser step examples (use these exact field names): ${JSON.stringify(steps)}
mouse_down/mouse_up require an explicit button (left, middle, or right) at the current pointer position. click_at uses viewport CSS pixel coordinates and an explicit button. hold presses a non-empty list of unique keys together for durationMs, then releases them even on failure/cancellation. Do not overlap hold keys with keys already held by key_down; use key_down/key_up when measurements must occur during a hold. Holds share the per-wait duration cap and remaining deadline. resize changes the actual viewport on the same page. For interactions without a predefined action, playwright runs an async JavaScript body with page (the runtime-owned Playwright Page) and timeoutMs (remaining budget); return JSON-serializable measurements. Use the supplied page only, await all work, and do not launch/close browsers, contexts, or pages. Use capture steps for image evidence. Page expressions run inside the webpage and cannot access Playwright; do not use window.resizeTo or synthetic resize events to test viewport resizing.
Automated browser scenarios require an assertion: text asserts exact text; visible asserts visibility; inspect must return true. observe returns diagnostic values without asserting success. The agent_browser verifier chooses assertions at execution time and may inspect observations and correct probes while preserving expected behavior. Fixtures may establish state, never bypass the interaction under test. {"inspect":"..."} is INVALID; use {"action":"inspect","expression":"..."}.`
}

export const verificationMethods: readonly VerificationMethod[] = [
  'automated',
  'agent_browser',
  'static',
  'human_only',
]
