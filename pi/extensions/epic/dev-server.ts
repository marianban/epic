import { spawn, type ChildProcess } from 'node:child_process'
import type {
  DevServerDiagnostics,
  DevServerLaunchSpec,
} from './types.ts'

interface DevServerCallbacks {
  ready(diagnostics: DevServerDiagnostics): void
  failed(error: Error, diagnostics: DevServerDiagnostics): void
}

export interface DevServerOptions {
  startupTimeoutMs: number
  maxOutputBytes: number
  fetch?: typeof globalThis.fetch
  spawn?: typeof spawn
}

export function validateDevServerLaunchSpec(
  value: unknown,
  required: boolean
): DevServerLaunchSpec | undefined {
  if (value === undefined) {
    if (required)
      throw new Error(
        'Implementer result requires devServer because the task requires browser-smoke.'
      )
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Implementer result devServer must be an object.')
  const item = value as Record<string, unknown>
  if (typeof item.command !== 'string' || !item.command.trim())
    throw new Error('Implementer result devServer.command must be non-empty.')
  if (
    !Array.isArray(item.args) ||
    item.args.some((argument) => typeof argument !== 'string' || !argument.trim())
  )
    throw new Error('Implementer result devServer.args must contain non-empty strings.')
  if (typeof item.readySelector !== 'string' || !item.readySelector.trim())
    throw new Error(
      'Implementer result devServer.readySelector must be non-empty.'
    )
  if (typeof item.url !== 'string')
    throw new Error('Implementer result devServer.url must be a string.')
  let url: URL
  try {
    url = new URL(item.url)
  } catch {
    throw new Error('Implementer result devServer.url must be a valid URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Implementer result devServer.url must use HTTP or HTTPS.')
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname))
    throw new Error('Implementer result devServer.url must target loopback.')
  return {
    command: item.command,
    args: item.args as string[],
    url: url.href,
    readySelector: item.readySelector,
  }
}

function terminate(child: ChildProcess): void {
  const pid = child.pid
  const signal = (value: NodeJS.Signals) => {
    // The detached process group can outlive its launcher.
    if (pid && process.platform !== 'win32') {
      try {
        process.kill(-pid, value)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        throw error
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill(value)
  }
  signal('SIGTERM')
  const timer = setTimeout(() => signal('SIGKILL'), 2_000)
  timer.unref()
}

export function startDevServer(
  root: string,
  spec: DevServerLaunchSpec,
  callbacks: DevServerCallbacks,
  options: DevServerOptions
): () => void {
  const spawnProcess = options.spawn ?? spawn
  const request = options.fetch ?? globalThis.fetch
  const child = spawnProcess(spec.command, spec.args, {
    cwd: root,
    env: { ...process.env, CI: '1' },
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // The smoke result retains this object until persistence, so keep collecting
  // output after readiness rather than handing it a startup-only snapshot.
  const diagnostics: DevServerDiagnostics = {
    command: spec.command,
    args: [...spec.args],
    url: spec.url,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdoutPreview: '',
    stderrPreview: '',
    outputTruncated: false,
  }
  let settled = false
  let disposed = false
  let failureReported = false

  const collect = (target: 'stdoutPreview' | 'stderrPreview') => (chunk: Buffer) => {
    const next = diagnostics[target] + chunk.toString()
    diagnostics[target] = next.slice(0, options.maxOutputBytes)
    if (next.length > options.maxOutputBytes) diagnostics.outputTruncated = true
  }
  child.stdout?.on('data', collect('stdoutPreview'))
  child.stderr?.on('data', collect('stderrPreview'))

  const fail = (error: Error) => {
    if (disposed || failureReported) return
    failureReported = true
    clearTimeout(timer)
    controller.abort()
    callbacks.failed(error, diagnostics)
  }
  child.once('error', (error) => fail(error))
  child.once('exit', (code, signal) => {
    if (disposed) return
    fail(
      new Error(
        `Development server exited ${code === null ? `with signal ${signal ?? 'unknown'}` : `with code ${code}`}.`
      )
    )
  })

  const controller = new AbortController()
  const timer = setTimeout(() => {
    if (settled || disposed) return
    controller.abort()
    fail(
      new Error(
        `Development server did not become ready within ${options.startupTimeoutMs}ms.`
      )
    )
  }, options.startupTimeoutMs)
  timer.unref()

  void (async () => {
    while (!settled && !disposed) {
      try {
        const response = await request(spec.url, {
          signal: controller.signal,
          redirect: 'manual',
        })
        if (response.status < 500) {
          settled = true
          clearTimeout(timer)
          callbacks.ready(diagnostics)
          return
        }
      } catch {
        if (controller.signal.aborted) return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })()

  return () => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    controller.abort()
    terminate(child)
  }
}
