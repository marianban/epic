import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { concludeBrowserProbe } from './browser-conclusion.ts'
import { browserProbeResponse } from './browser-image-transport.ts'
import type {
  BrowserProbe,
  BrowserProbeLimits,
  BrowserConclusion,
} from './browser-evidence-types.ts'
import type { BrowserExecution } from './browser-execution.ts'
import type {
  VerificationPlan,
  BrowserStep,
  AcceptanceEvidence,
} from './verification-types.ts'

export async function openBrowserBridge(
  scope: BrowserExecution,
  plan: VerificationPlan,
  options: {
    invocationId: string
    probes: BrowserProbe[]
    limits: BrowserProbeLimits
  }
): Promise<{
  url: string
  token: string
  evidence: AcceptanceEvidence[]
  close(): Promise<void>
}> {
  const token = randomBytes(32).toString('hex')
  const evidence: AcceptanceEvidence[] = []
  let busy = false
  const server = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      !['/scenario', '/conclude'].includes(request.url ?? '') ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(403).end()
      return
    }
    if (busy) {
      response.writeHead(409).end('Browser operation already active.')
      return
    }
    busy = true
    try {
      let body = ''
      for await (const chunk of request) {
        body += String(chunk)
        if (body.length > 64_000) throw new Error('Browser request too large.')
      }
      const input = JSON.parse(body) as {
        obligationId: string
        steps: BrowserStep[]
        conclusion?: BrowserConclusion
      }
      const obligation = plan.obligations.find(
        (o) => o.id === input.obligationId && o.method === 'agent_browser'
      )
      if (!obligation) throw new Error('Unknown browser obligation.')
      scope.input.operation.remainingMs()
      if (request.url === '/conclude') {
        if (
          !input.conclusion ||
          input.conclusion.obligationId !== obligation.id
        )
          throw new Error('Conclusion must identify the requested obligation.')
        const result = await concludeBrowserProbe({
          conclusion: input.conclusion,
          obligation,
          probes: options.probes,
          invocationId: options.invocationId,
          identity: scope.input.identity,
          attempt: scope.input.attempt,
          artifactRoot: scope.input.artifactRoot,
          nowMs: scope.input.nowMs,
        })
        const prior = evidence.findIndex(
          (e) => e.obligationId === result.obligationId
        )
        if (prior >= 0) evidence.splice(prior, 1)
        evidence.push(result)
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(result))
      } else {
        const probe = await scope.probe(
          obligation,
          input.steps,
          options.invocationId,
          options.limits
        )
        options.probes.push(probe)
        // A new probe invalidates a prior conclusion for this obligation until explicitly concluded again.
        const prior = evidence.findIndex(
          (e) => e.obligationId === obligation.id
        )
        if (prior >= 0) evidence.splice(prior, 1)
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(await browserProbeResponse(probe)))
      }
    } catch (error) {
      response.writeHead(400).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      busy = false
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Browser bridge has no loopback address.')
  return {
    url: `http://127.0.0.1:${address.port}/scenario`,
    token,
    evidence,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
