import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { chromium, type Browser } from 'playwright-core'
import {
  runBrowserSmoke,
  type BrowserSmokeInput,
} from '../pi/extensions/epic/browser-smoke.ts'

function input(signal?: AbortSignal): BrowserSmokeInput {
  return {
    state: {
      epicId: 'run-1',
      epic: 'Browser smoke',
      repositoryRoot: '/repo',
      epicComplexity: 'moderate',
      scoutRound: 0,
      maxScoutRounds: 3,
      planPath: '/repo/plan.md',
      planRevision: 0,
      planApproved: true,
      currentTaskIndex: 0,
      taskApproved: true,
      implementationAttempt: 0,
      maxTaskRepairs: 1,
      maxAcceptancePlanRepairs: 2,
      maxTaskInfrastructureRetries: 1,
      taskVerificationTimeoutMs: 1,
    },
    spec: {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      readySelector: 'main',
    },
    server: {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      stdoutPreview: '',
      stderrPreview: '',
      outputTruncated: false,
    },
    configuration: {
      executablePath: process.execPath,
      startupTimeoutMs: 100,
      navigationTimeoutMs: 100,
      selectorTimeoutMs: 100,
      settleTimeoutMs: 1,
    },
    signal,
  }
}

function smokePage() {
  return Object.assign(new EventEmitter(), {
    goto: async () => undefined,
    locator: () => ({ waitFor: async () => undefined }),
    waitForTimeout: async () => undefined,
    screenshot: async () => undefined,
  })
}

test('browser events produce actionable error findings and retain the screenshot', async (t) => {
  const page = smokePage()
  const pageError = new Error('render failed')
  page.waitForTimeout = async () => {
    page.emit('pageerror', pageError)
    page.emit('console', { type: () => 'error', text: () => 'asset missing' })
    for (const errorText of ['net::ERR_CONNECTION_RESET', undefined]) {
      page.emit('requestfailed', {
        url: () => 'http://127.0.0.1:4173/api/data',
        method: () => 'POST',
        failure: () => (errorText ? { errorText } : null),
      })
    }
    for (const status of [400, 503]) {
      page.emit('response', {
        url: () => 'http://127.0.0.1:4173/api/data',
        status: () => status,
        request: () => ({ method: () => 'GET' }),
      })
    }
    page.emit('crash')
  }
  const close = t.mock.fn(async () => undefined)
  t.mock.method(
    chromium,
    'launch',
    async () =>
      ({
        newPage: async () => page,
        close,
      }) as unknown as Browser
  )

  const result = await runBrowserSmoke(input())

  assert.equal(result.passed, false)
  assert.deepEqual(
    result.findings,
    [
      { message: 'Uncaught page error: render failed', raw: pageError.stack },
      { message: 'Console error: asset missing' },
      {
        message:
          'Failed request: POST http://127.0.0.1:4173/api/data (net::ERR_CONNECTION_RESET)',
      },
      {
        message:
          'Failed request: POST http://127.0.0.1:4173/api/data (unknown error)',
      },
      { message: 'HTTP 400 response: GET http://127.0.0.1:4173/api/data' },
      { message: 'HTTP 503 response: GET http://127.0.0.1:4173/api/data' },
      { message: 'Browser page crashed.' },
    ].map((finding) => ({
      source: 'browser-smoke',
      severity: 'error',
      introduced: true,
      ...finding,
    }))
  )
  assert.ok(result.screenshotPath)
  assert.equal(close.mock.callCount(), 1)
})

test('browser smoke ignores non-error console messages and unrelated network errors', async (t) => {
  const page = smokePage()
  page.waitForTimeout = async () => {
    for (const type of ['log', 'info', 'warning', 'debug']) {
      page.emit('console', { type: () => type, text: () => 'diagnostic' })
    }
    for (const url of [
      'https://example.com/api',
      'http://127.0.0.1:4174/api',
      'https://127.0.0.1:4173/api',
      'not a URL',
    ]) {
      page.emit('requestfailed', {
        url: () => url,
        method: () => 'GET',
        failure: () => ({ errorText: 'connection failed' }),
      })
      page.emit('response', {
        url: () => url,
        status: () => 500,
        request: () => ({ method: () => 'GET' }),
      })
    }
    for (const status of [200, 302, 399]) {
      page.emit('response', {
        url: () => 'http://127.0.0.1:4173/api',
        status: () => status,
        request: () => ({ method: () => 'GET' }),
      })
    }
  }
  t.mock.method(
    chromium,
    'launch',
    async () =>
      ({
        newPage: async () => page,
        close: async () => undefined,
      }) as unknown as Browser
  )

  const result = await runBrowserSmoke(input())

  assert.equal(result.passed, true)
  assert.deepEqual(result.findings, [])
})

test('browser smoke retries navigation and completes readiness after recovery', async (t) => {
  const page = smokePage()
  const calls: string[] = []
  page.goto = async () => {
    calls.push('navigation')
    if (calls.length === 1) throw new Error('server still starting')
  }
  page.locator = () => ({
    waitFor: async () => {
      calls.push('readiness')
    },
  })
  page.waitForTimeout = async () => {
    calls.push('settling')
  }
  page.screenshot = async () => {
    calls.push('screenshot')
  }
  t.mock.method(
    chromium,
    'launch',
    async () =>
      ({
        newPage: async () => page,
        close: async () => {
          calls.push('close')
        },
      }) as unknown as Browser
  )
  const smokeInput = input()
  smokeInput.configuration.navigationTimeoutMs = 5_000

  const result = await runBrowserSmoke(smokeInput)

  assert.equal(result.passed, true)
  assert.deepEqual(result.findings, [])
  assert.deepEqual(calls, [
    'navigation',
    'navigation',
    'readiness',
    'settling',
    'screenshot',
    'close',
  ])
})

test('page creation failure closes the launched browser and returns diagnostics', async (t) => {
  const close = t.mock.fn(async () => undefined)
  t.mock.method(
    chromium,
    'launch',
    async () =>
      ({
        newPage: async () => {
          throw new Error('page creation failed')
        },
        close,
      }) as unknown as Browser
  )

  const result = await runBrowserSmoke(input())

  assert.equal(result.passed, false)
  assert.equal('screenshotPath' in result, false)
  assert.equal(result.findings.length, 1)
  assert.equal(
    result.findings[0]?.message,
    'Browser smoke execution failed: page creation failed'
  )
  assert.equal(close.mock.callCount(), 1)
})

test('browser launch failure preserves the resolved identity and diagnostics', async (t) => {
  t.mock.method(chromium, 'launch', async () => {
    throw new Error('browser launch failed')
  })

  const smokeInput = input()
  const result = await runBrowserSmoke(smokeInput)
  assert.equal(result.passed, false)
  assert.deepEqual(result.browser, {
    executablePath: process.execPath,
    version: process.version,
  })
  assert.equal(result.url, smokeInput.spec.url)
  assert.equal(result.readySelector, smokeInput.spec.readySelector)
  assert.equal(result.server, smokeInput.server)
  assert.ok(result.durationMs >= 0)
  assert.equal('screenshotPath' in result, false)
  assert.equal(
    result.findings[0]?.message,
    'Browser smoke execution failed: browser launch failed'
  )
})

test('browser launch cancellation propagates the caller reason', async (t) => {
  const controller = new AbortController()
  const cancelled = new Error('cancelled during launch')
  t.mock.method(chromium, 'launch', async () => {
    controller.abort(cancelled)
    throw new Error('browser launch interrupted')
  })

  await assert.rejects(
    runBrowserSmoke(input(controller.signal)),
    (error) => error === cancelled
  )
})

for (const failure of [
  'none',
  'navigation',
  'readiness',
  'settling',
  'screenshot',
  'readiness-and-screenshot',
  'cancellation',
] as const) {
  test(`browser smoke captures diagnostics for ${failure}`, async (t) => {
    const calls: string[] = []
    let capturedPath: string | undefined
    const controller = new AbortController()
    const cancelled = new Error('cancelled by caller')
    const page = {
      on: () => undefined,
      goto: async () => {
        calls.push('navigation')
        if (failure === 'cancellation') {
          controller.abort(cancelled)
          throw new Error('page closed')
        }
        if (failure === 'navigation') throw new Error('navigation failed')
      },
      locator: () => ({
        waitFor: async () => {
          calls.push('readiness')
          if (failure === 'readiness' || failure === 'readiness-and-screenshot')
            throw new Error('selector timed out')
        },
      }),
      waitForTimeout: async () => {
        calls.push('settling')
        if (failure === 'settling') throw new Error('settling failed')
      },
      screenshot: async (options: { path: string; fullPage: boolean }) => {
        calls.push('screenshot')
        assert.equal(options.fullPage, true)
        if (failure === 'screenshot' || failure === 'readiness-and-screenshot')
          throw new Error('page unavailable')
        capturedPath = options.path
      },
    }
    t.mock.method(
      chromium,
      'launch',
      async () =>
        ({
          newPage: async () => page,
          close: async () => {
            calls.push('close')
          },
        }) as unknown as Browser
    )

    if (failure === 'cancellation') {
      await assert.rejects(
        runBrowserSmoke(input(controller.signal)),
        (error) => error === cancelled
      )
      assert.equal(calls.includes('screenshot'), false)
    } else {
      const result = await runBrowserSmoke(input())
      assert.equal(result.passed, failure === 'none')
      assert.equal(calls.filter((call) => call === 'screenshot').length, 1)
      assert.equal(result.screenshotPath, capturedPath)
      if (failure === 'screenshot' || failure === 'readiness-and-screenshot') {
        assert.equal('screenshotPath' in result, false)
        assert.ok(
          result.findings.some(
            (finding) =>
              finding.message ===
              'Browser smoke screenshot failed: page unavailable'
          )
        )
      } else {
        assert.match(
          result.screenshotPath ?? '',
          /task-001-browser-smoke-.*\.png$/
        )
      }
      if (failure === 'readiness' || failure === 'readiness-and-screenshot') {
        assert.equal(
          result.findings[0]?.message,
          'Browser smoke execution failed: selector timed out'
        )
        assert.equal(calls.includes('settling'), false)
      }
      if (failure === 'navigation' || failure === 'settling') {
        assert.equal(
          result.findings[0]?.message,
          `Browser smoke execution failed: ${failure} failed`
        )
      }
    }
    assert.equal(calls.at(-1), 'close')
  })
}
