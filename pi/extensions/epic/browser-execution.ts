import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolveBrowserIdentity } from './browser-discovery.ts'
import { startDevServer } from './dev-server.ts'
import type {
  BrowserStep,
  VerificationOperation,
  VerificationObligation,
  AcceptanceEvidence,
} from './verification-types.ts'
import type {
  EpicDomainState,
  BrowserSmokeResult,
  DevServerDiagnostics,
} from './types.ts'
import { validateBrowserStep } from './verification-plan.ts'
import { executeBrowserStep } from './browser-steps.ts'
import { runBrowserProbe } from './browser-probe.ts'
import type { BrowserProbeLimits } from './browser-evidence-types.ts'

export interface BrowserExecutionInput {
  state: EpicDomainState
  operation: VerificationOperation
  executablePath: string | undefined
  maxOutputBytes: number
  artifactRoot: string
  identity: string
  attempt: number
  nowMs(): number
}
export class BrowserExecution {
  readonly input: BrowserExecutionInput
  readonly browser: Browser
  readonly server: DevServerDiagnostics
  readonly stopServer: (() => void) & { closed: Promise<void> }
  readonly browserIdentity: Awaited<ReturnType<typeof resolveBrowserIdentity>>
  readonly serverFailure: () => string | undefined
  private constructor(
    input: BrowserExecutionInput,
    browser: Browser,
    server: DevServerDiagnostics,
    stopServer: (() => void) & { closed: Promise<void> },
    browserIdentity: Awaited<ReturnType<typeof resolveBrowserIdentity>>,
    serverFailure: () => string | undefined
  ) {
    this.input = input
    this.browser = browser
    this.server = server
    this.stopServer = stopServer
    this.browserIdentity = browserIdentity
    this.serverFailure = serverFailure
  }
  static async open(input: BrowserExecutionInput): Promise<BrowserExecution> {
    const spec = input.state.devServer
    if (!spec)
      throw new Error(
        'Browser verification blocked: no approved development-server specification.'
      )
    input.operation.signal.throwIfAborted()
    let failure: string | undefined
    let stop: ((() => void) & { closed: Promise<void> }) | undefined
    let browser: Browser | undefined
    try {
      const server = await new Promise<DevServerDiagnostics>(
        (resolve, reject) => {
          const abort = () => reject(input.operation.signal.reason)
          input.operation.signal.addEventListener('abort', abort, {
            once: true,
          })
          stop = startDevServer(
            input.state.repositoryRoot,
            spec,
            {
              ready: (d) => {
                input.operation.signal.removeEventListener('abort', abort)
                resolve(d)
              },
              failed: (error) => {
                failure = error.message
                input.operation.signal.removeEventListener('abort', abort)
                reject(error)
              },
            },
            {
              startupTimeoutMs: input.operation.remainingMs(),
              maxOutputBytes: input.maxOutputBytes,
            }
          )
        }
      )
      const identity = await resolveBrowserIdentity(input.executablePath)
      browser = await chromium.launch({
        executablePath: identity.executablePath,
        headless: true,
        timeout: input.operation.remainingMs(),
      })
      if (!stop) throw new Error('Browser scope has no server disposer.')
      const scope = new BrowserExecution(
        input,
        browser,
        server,
        stop,
        identity,
        () => failure
      )
      input.operation.signal.addEventListener('abort', scope.abort, {
        once: true,
      })
      input.operation.signal.throwIfAborted()
      return scope
    } catch (error) {
      await browser?.close()
      stop?.()
      await stop?.closed
      throw error
    }
  }
  private readonly abort = () => {
    this.stopServer()
    void this.browser.close().catch((error) => {
      this.cleanupError =
        error instanceof Error ? error : new Error(String(error))
    })
  }
  private cleanupError?: Error
  async close(): Promise<void> {
    this.input.operation.signal.removeEventListener('abort', this.abort)
    try {
      await this.browser.close()
      if (this.cleanupError) throw this.cleanupError
    } finally {
      this.stopServer()
      await this.stopServer.closed
    }
  }
  private get spec() {
    const spec = this.input.state.devServer
    if (!spec) throw new Error('Development-server specification disappeared.')
    return spec
  }
  private monitor(page: Page, errors: string[]): void {
    const origin = new URL(this.spec.url).origin
    page.on('pageerror', (e) => errors.push(`Uncaught exception: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`Console error: ${m.text()}`)
    })
    page.on('crash', () => errors.push('Page crashed.'))
    page.on('requestfailed', (r) => {
      if (new URL(r.url()).origin === origin)
        errors.push(`Failed request: ${r.url()} ${r.failure()?.errorText}`)
    })
    page.on('response', (r) => {
      if (new URL(r.url()).origin === origin && r.status() >= 400)
        errors.push(`HTTP ${r.status()}: ${r.url()}`)
    })
  }
  private async ready(page: Page): Promise<void> {
    this.input.operation.signal.throwIfAborted()
    if (this.serverFailure()) throw new Error(this.serverFailure())
    const spec = this.spec
    await page.goto(spec.url, {
      waitUntil: 'domcontentloaded',
      timeout: this.input.operation.remainingMs(),
    })
    await page.locator(spec.readySelector).waitFor({
      state: 'visible',
      timeout: this.input.operation.remainingMs(),
    })
  }
  async smoke(): Promise<BrowserSmokeResult> {
    const start = this.input.nowMs()
    const context = await this.browser.newContext()
    const errors: string[] = []
    let screenshotPath: string | undefined
    let infrastructureError: string | undefined
    try {
      const page = await context.newPage()
      this.monitor(page, errors)
      await this.ready(page)
      screenshotPath = path.join(
        this.input.artifactRoot,
        `${randomUUID()}-smoke.png`
      )
      await page.screenshot({
        path: screenshotPath,
        timeout: this.input.operation.remainingMs(),
      })
    } catch (error) {
      this.input.operation.signal.throwIfAborted()
      infrastructureError =
        error instanceof Error ? error.message : String(error)
    } finally {
      await context.close()
    }
    return {
      passed: !errors.length && !infrastructureError,
      url: this.spec.url,
      readySelector: this.spec.readySelector,
      durationMs: this.input.nowMs() - start,
      browser: this.browserIdentity,
      server: this.server,
      screenshotPath,
      findings: [
        ...errors.map((message) => ({
          source: 'browser-smoke',
          severity: 'error' as const,
          introduced: true,
          message,
        })),
        ...(infrastructureError
          ? [
              {
                source: 'browser-smoke',
                severity: 'error' as const,
                category: 'infrastructure',
                message: infrastructureError,
              },
            ]
          : []),
      ],
    }
  }
  probe(obligation: VerificationObligation, steps: BrowserStep[], invocationId: string, limits: BrowserProbeLimits) {
    return runBrowserProbe({ browser: this.browser, execution: this.input, obligation, steps, invocationId, limits,
      ready: (page) => this.ready(page), monitor: (page, errors) => this.monitor(page, errors) })
  }
  async scenario(
    obligation: VerificationObligation,
    steps: BrowserStep[]
  ): Promise<AcceptanceEvidence> {
    if (!Array.isArray(steps) || !steps.length || steps.length > 100)
      throw new Error('A browser scenario requires 1–100 steps.')
    steps.forEach((step, index) => validateBrowserStep(step, `steps[${index}]`))
    const context = await this.browser.newContext()
    const errors: string[] = []
    const observations: unknown[] = []
    let asserted = false
    let gap: 'blocked' | 'inconclusive' | undefined
    let screenshot: string | undefined
    const trace = path.join(
      this.input.artifactRoot,
      `${randomUUID()}-trace.zip`
    )
    try {
      await context.tracing.start({ screenshots: true, snapshots: true })
      const page = await context.newPage()
      this.monitor(page, errors)
      await this.ready(page)
      for (const step of steps) {
        this.input.operation.signal.throwIfAborted()
        if (step.action === 'capture')
          throw new Error('Adaptive image capture belongs to agent_browser probes.')
        const observation = await executeBrowserStep(page, step, this.input.operation)
        if (observation) {
          observations.push(observation.value)
          if (observation.passed === false)
            errors.push(`Inspection assertion expected true, returned ${JSON.stringify(observation.value)}.`)
          if (observation.passed === true) asserted = true
        }
        // Surface interaction exceptions before waiting on an impossible outcome.
        if (errors.length) break
      }
      screenshot = path.join(
        this.input.artifactRoot,
        `${randomUUID()}-scenario.png`
      )
      await page.screenshot({
        path: screenshot,
        timeout: this.input.operation.remainingMs(),
      })
    } catch (error) {
      if (!errors.length) {
        gap =
          error instanceof Error && error.name === 'TimeoutError'
            ? 'inconclusive'
            : 'blocked'
        observations.push(
          error instanceof Error ? error.message : String(error)
        )
      }
    } finally {
      try {
        await context.tracing.stop({ path: trace })
      } finally {
        await context.close()
      }
    }
    const outcome = errors.length
      ? 'fail'
      : asserted && !gap
        ? 'pass'
        : 'inconclusive'
    const result: AcceptanceEvidence = {
      obligationId: obligation.id,
      criterionId: obligation.criterionId,
      expected: obligation.expected,
      actual: errors.length
        ? errors.join('\n')
        : outcome === 'pass'
          ? `Assertions passed: ${JSON.stringify(observations)}`
          : `Expected outcome not established: ${JSON.stringify(observations)}`,
      outcome,
      ...(outcome === 'inconclusive'
        ? { gap: gap ?? ('inconclusive' as const) }
        : {}),
      method: obligation.method,
      artifacts: [],
      attachments: [...(screenshot ? [screenshot] : []), trace],
      attempt: this.input.attempt,
      identity: this.input.identity,
      reproduction: JSON.stringify(steps),
    }
    const artifact = path.join(
      this.input.artifactRoot,
      `${randomUUID()}-observation.json`
    )
    await fs.writeFile(
      artifact,
      JSON.stringify(
        { ...result, steps, observations, errors, screenshot, trace },
        null,
        2
      ),
      { flag: 'wx' }
    )
    result.artifacts.push(artifact)
    return result
  }
}
