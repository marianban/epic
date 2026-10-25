import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { browserExecutableCandidates } from '../pi/extensions/epic/browser-discovery.ts'
import {
  startDevServer,
  validateDevServerLaunchSpec,
} from '../pi/extensions/epic/dev-server.ts'
import { validateImplementerResult } from '../pi/extensions/epic/implementer-result.ts'
import type { DevServerDiagnostics } from '../pi/extensions/epic/types.ts'

test('implementer result requires a loopback launch contract for browser smoke', () => {
  assert.throws(
    () => validateImplementerResult({ summary: 'done', checks: [] }, true),
    /requires devServer/
  )
  assert.throws(
    () =>
      validateImplementerResult(
        {
          summary: 'done',
          checks: [],
          devServer: {
            command: 'npm',
            args: ['run', 'dev'],
            url: 'https://example.com',
            readySelector: 'main',
          },
        },
        true
      ),
    /loopback/
  )
  assert.deepEqual(
    validateImplementerResult(
      {
        summary: 'done',
        checks: ['npm run build'],
        devServer: {
          command: 'npm',
          args: ['run', 'dev'],
          url: 'http://127.0.0.1:4173',
          readySelector: 'canvas',
        },
      },
      true
    ).devServer,
    {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      readySelector: 'canvas',
    }
  )
})

test('implementer chooses the server command without a planner command allowlist', () => {
  const devServer = {
    command: 'npm',
    args: ['run', 'preview', '--', '--host', '127.0.0.1'],
    url: 'http://127.0.0.1:4173/',
    readySelector: 'main',
  }
  assert.deepEqual(
    validateImplementerResult(
      { summary: 'Built the application for preview', checks: ['npm run build'], devServer },
      true
    ).devServer,
    devServer
  )
})

test('launch validation rejects shell-shaped and malformed fields', () => {
  for (const value of [
    { command: '', args: [], url: 'http://localhost', readySelector: 'main' },
    { command: 'npm', args: [''], url: 'http://localhost', readySelector: 'main' },
    { command: 'npm', args: [], url: 'file:///tmp/app', readySelector: 'main' },
    { command: 'npm', args: [], url: 'http://localhost', readySelector: '' },
  ]) {
    assert.throws(() => validateDevServerLaunchSpec(value, true))
  }
})

test('browser discovery candidates prefer the explicit path and remain unique', () => {
  const candidates = browserExecutableCandidates(
    'linux',
    '/custom/bin:/usr/bin',
    '/pinned/chrome'
  )
  assert.equal(candidates[0], '/pinned/chrome')
  assert.equal(new Set(candidates).size, candidates.length)
  assert.ok(candidates.includes('/custom/bin/chromium'))
})

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    pid?: number
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill(signal?: NodeJS.Signals): boolean
    killedWith?: NodeJS.Signals
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = (signal = 'SIGTERM') => {
    child.killedWith = signal
    child.signalCode = signal
    return true
  }
  return child
}

test('server supervisor reports readiness and terminates its owned process', async () => {
  const child = fakeChild()
  let ready = false
  const stop = startDevServer(
    '/repo',
    {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      readySelector: 'main',
    },
    {
      ready: () => {
        ready = true
      },
      failed: (error) => assert.fail(error),
    },
    {
      startupTimeoutMs: 100,
      maxOutputBytes: 100,
      spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
      fetch: async () => new Response('', { status: 200 }),
    }
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(ready, true)
  stop()
  assert.equal(child.killedWith, 'SIGTERM')
})

test('server result serialization includes bounded output emitted after readiness', async (t) => {
  const child = fakeChild()
  let server: DevServerDiagnostics | undefined
  const stop = startDevServer(
    '/repo',
    {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      readySelector: 'main',
    },
    {
      ready: (diagnostics) => { server = diagnostics },
      failed: (error) => assert.fail(error),
    },
    {
      startupTimeoutMs: 100,
      maxOutputBytes: 20,
      spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
      fetch: async () => new Response('', { status: 200 }),
    }
  )
  t.after(stop)
  child.stdout.write('startup\n')
  await Promise.resolve()
  assert.ok(server)
  assert.equal(server.stdoutPreview, 'startup\n')
  const result = { server }

  child.stdout.write('request\n')
  child.stderr.write('runtime warning\n')
  const persisted = JSON.parse(JSON.stringify(result))
  assert.equal(persisted.server.stdoutPreview, 'startup\nrequest\n')
  assert.equal(persisted.server.stderrPreview, 'runtime warning\n')
  assert.equal(persisted.server.outputTruncated, false)

  child.stdout.write('more output')
  child.stderr.write('more warnings')
  const truncated = JSON.parse(JSON.stringify(result))
  assert.equal(truncated.server.stdoutPreview, 'startup\nrequest\nmore')
  assert.equal(truncated.server.stderrPreview, 'runtime warning\nmore')
  assert.equal(truncated.server.outputTruncated, true)
})

test('server supervisor reports early exit and startup timeout once', async () => {
  const exited = fakeChild()
  const exitFailures: string[] = []
  startDevServer(
    '/repo',
    {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      readySelector: 'main',
    },
    {
      ready: () => assert.fail('server should not become ready'),
      failed: (error) => exitFailures.push(error.message),
    },
    {
      startupTimeoutMs: 100,
      maxOutputBytes: 100,
      spawn: (() => exited) as unknown as typeof import('node:child_process').spawn,
      fetch: async () => {
        throw new Error('not ready')
      },
    }
  )
  exited.emit('exit', 2, null)
  exited.emit('error', new Error('duplicate'))
  assert.deepEqual(exitFailures, ['Development server exited with code 2.'])

  const timedOut = fakeChild()
  const timeoutFailures: string[] = []
  const stop = startDevServer(
    '/repo',
    {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      readySelector: 'main',
    },
    {
      ready: () => assert.fail('server should not become ready'),
      failed: (error) => timeoutFailures.push(error.message),
    },
    {
      startupTimeoutMs: 10,
      maxOutputBytes: 100,
      spawn: (() => timedOut) as unknown as typeof import('node:child_process').spawn,
      fetch: async () => {
        throw new Error('not ready')
      },
    }
  )
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.match(timeoutFailures[0] ?? '', /did not become ready/)
  stop()
})

for (const exitTiming of ['before cleanup', 'after SIGTERM'] as const) {
  test(`server cleanup signals descendants when the launcher exits ${exitTiming}`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const child = fakeChild()
    child.pid = 12345
    const signals: [number, NodeJS.Signals | number | undefined][] = []
    let ready = false
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      signals.push([pid, signal])
      return true
    })
    const stop = startDevServer(
      '/repo',
      {
        command: 'npm',
        args: ['run', 'dev'],
        url: 'http://127.0.0.1:4173/',
        readySelector: 'main',
      },
      {
        ready: () => { ready = true },
        failed: (error) => assert.fail(error),
      },
      {
        startupTimeoutMs: 100,
        maxOutputBytes: 100,
        spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
        fetch: async () => new Response('', { status: 200 }),
      }
    )
    await Promise.resolve()
    assert.equal(ready, true)
    if (exitTiming === 'before cleanup') child.exitCode = 0
    stop()
    child.exitCode = 0
    child.emit('exit', 0, null)
    stop()
    t.mock.timers.tick(2_000)
    assert.deepEqual(signals, [
      [-12345, 'SIGTERM'],
      [-12345, 'SIGKILL'],
    ])
    assert.equal(child.killedWith, undefined)
  })
}
