import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser } from 'playwright-core'
import { resolveBrowserIdentity } from './browser-discovery.ts'
import type {
  BrowserSmokeResult,
  DevServerDiagnostics,
  DevServerLaunchSpec,
  EpicDomainState,
  Finding,
  ResolvedEpicConfiguration,
} from './types.ts'

const NAVIGATION_RETRY_INTERVAL_MS = 100

export interface BrowserSmokeInput {
  state: EpicDomainState
  spec: DevServerLaunchSpec
  server: DevServerDiagnostics
  configuration: ResolvedEpicConfiguration['checks']['browserSmoke']
  signal?: AbortSignal
}

export async function runBrowserSmoke(
  input: BrowserSmokeInput
): Promise<BrowserSmokeResult> {
  const started = Date.now()
  const findings: Finding[] = []
  const identity = await resolveBrowserIdentity(
    input.configuration.executablePath
  )
  const screenshotPath = path.join(
    input.state.repositoryRoot,
    '.pi',
    'epics',
    'runs',
    input.state.epicId,
    'checks',
    `task-${String(input.state.currentTaskIndex + 1).padStart(3, '0')}-browser-smoke-${randomUUID()}.png`
  )
  const expectedOrigin = new URL(input.spec.url).origin
  const addFinding = (message: string, raw?: string) => {
    findings.push({
      source: 'browser-smoke',
      severity: 'error',
      message,
      ...(raw ? { raw } : {}),
      introduced: true,
    })
  }
  const sameOrigin = (url: string) => {
    try {
      return new URL(url).origin === expectedOrigin
    } catch {
      return false
    }
  }

  let browser: Browser | undefined
  const abort = () => {
    void browser?.close()
  }
  let screenshotCreated = false
  try {
    browser = await chromium.launch({
      executablePath: identity.executablePath,
      headless: true,
    })
    if (input.signal?.aborted) abort()
    else input.signal?.addEventListener('abort', abort, { once: true })
    const page = await browser.newPage()
    page.on('pageerror', (error) =>
      addFinding(`Uncaught page error: ${error.message}`, error.stack)
    )
    page.on('console', (message) => {
      if (message.type() === 'error')
        addFinding(`Console error: ${message.text()}`)
    })
    page.on('requestfailed', (request) => {
      if (sameOrigin(request.url()))
        addFinding(
          `Failed request: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown error'})`
        )
    })
    page.on('response', (response) => {
      if (sameOrigin(response.url()) && response.status() >= 400)
        addFinding(
          `HTTP ${response.status()} response: ${response.request().method()} ${response.url()}`
        )
    })
    page.on('crash', () => addFinding('Browser page crashed.'))

    try {
      const navigationDeadline =
        Date.now() + input.configuration.navigationTimeoutMs
      let navigationError: unknown
      while (Date.now() < navigationDeadline) {
        try {
          await page.goto(input.spec.url, {
            waitUntil: 'domcontentloaded',
            timeout: Math.max(1, navigationDeadline - Date.now()),
          })
          navigationError = undefined
          break
        } catch (error) {
          navigationError = error
          if (input.signal?.aborted) throw error
          await new Promise((resolve) =>
            setTimeout(resolve, NAVIGATION_RETRY_INTERVAL_MS)
          )
        }
      }
      if (navigationError) throw navigationError
      await page.locator(input.spec.readySelector).waitFor({
        state: 'visible',
        timeout: input.configuration.selectorTimeoutMs,
      })
      await page.waitForTimeout(input.configuration.settleTimeoutMs)
    } catch (error) {
      if (input.signal?.aborted)
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error('Browser smoke was cancelled.')
      addFinding(
        `Browser smoke execution failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    try {
      await page.screenshot({ path: screenshotPath, fullPage: true })
      screenshotCreated = true
    } catch (error) {
      if (input.signal?.aborted)
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error('Browser smoke was cancelled.')
      addFinding(
        `Browser smoke screenshot failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  } catch (error) {
    if (input.signal?.aborted)
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error('Browser smoke was cancelled.')
    addFinding(
      `Browser smoke execution failed: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    input.signal?.removeEventListener('abort', abort)
    await browser?.close().catch(() => undefined)
  }

  return {
    passed: findings.length === 0,
    url: input.spec.url,
    readySelector: input.spec.readySelector,
    durationMs: Date.now() - started,
    browser: identity,
    ...(screenshotCreated ? { screenshotPath } : {}),
    findings,
    server: input.server,
  }
}
