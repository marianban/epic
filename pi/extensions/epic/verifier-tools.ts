import type { BrowserProbeResponse } from './browser-evidence-types.ts'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** Loaded only into the verifier subprocess; the parent retains resource ownership. */
export default function verifierTools(pi: ExtensionAPI): void {
  const url = process.env.PI_EPIC_BROWSER_URL
  const token = process.env.PI_EPIC_BROWSER_TOKEN
  if (!url || !token)
    throw new Error(
      'Verifier browser tools require an explicit runtime bridge.'
    )
  const checkVision = (model: { input: readonly string[] } | undefined) => {
    if (!model || !model.input.includes('image'))
      throw new Error(
        'Browser verification requires a known image-capable verifier model. Configure agents.verifier provider/model; no model substitution was applied.'
      )
  }
  const request = async (
    endpoint: string,
    parameters: unknown,
    signal: AbortSignal | undefined
  ) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(parameters),
      signal,
    })
    if (!response.ok)
      throw new Error(`Browser verification failed: ${await response.text()}`)
    return response.json() as Promise<unknown>
  }
  pi.registerTool({
    name: 'browser_verify',
    executionMode: 'sequential',
    label: 'Verify browser behavior',
    description:
      'Run a probe on a FRESH isolated page; all page state is lost after this call. Repeat setup on every new probe. Choose steps freely to measure the approved expectation. Returns recorded observations with evidence IDs and requested screenshots as actual images. This tool does NOT establish a pass. Use browser_conclude afterward to explain and cite the evidence. Actions: click/press/text/visible (selector,value), pointer(x,y), key_down/key_up(key), wait(durationMs, at most 10000), observe/inspect/fixture(expression), capture(count,intervalMs,optional selector). Capture at chosen points; at most 12 frames and 10000ms total sequence intervals per call. Fixture results cannot prove behavior. inspect must return true but inspect:true and visibility alone cannot prove the expectation. Prefer observe for arbitrary JSON measurements. For motion, capture or measure at least twice within this call. Do not start a browser/server.',
    parameters: {
      type: 'object',
      properties: {
        obligationId: { type: 'string' },
        steps: { type: 'array', items: {}, minItems: 1, maxItems: 100 },
      },
      required: ['obligationId', 'steps'],
      additionalProperties: false,
    },
    async execute(_id, parameters, signal, _update, ctx) {
      checkVision(ctx.model)
      const result = (await request(
        url,
        parameters,
        signal
      )) as BrowserProbeResponse
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result.probe) },
          ...result.images.flatMap((frame) => [
            { type: 'text' as const, text: `Image evidence ID: ${frame.id}` },
            {
              type: 'image' as const,
              mimeType: frame.mimeType,
              data: frame.data,
            },
          ]),
        ],
        details: result.probe,
      }
    },
  })
  pi.registerTool({
    name: 'browser_conclude',
    executionMode: 'sequential',
    label: 'Conclude browser verification',
    description:
      'Conclude one obligation using recorded evidence IDs from this invocation. Explain why observations establish the expectation, and list limitations honestly. Pass/fail/likely-fail needs cited evidence; inconclusive needs gap. Use likely-fail for an observed contradiction with a specific uncertainty, and provide suspectedFailure containing contradiction, uncertainty, and confirmationCheck. Use inconclusive when evidence cannot judge behavior. basis is observations, visual (cite images), or motion (cite two timed records in one probe and explain temporalComparison). When combining independent fresh-page probes, explain separateExecutions. Runtime errors prevent pass. Invalid conclusions return feedback; correct them or report inconclusive. Prose outside this tool cannot establish acceptance.',
    parameters: {
      type: 'object',
      properties: {
        obligationId: { type: 'string' },
        outcome: { type: 'string', enum: ['pass', 'fail', 'likely-fail', 'inconclusive'] },
        gap: {
          type: 'string',
          enum: ['blocked', 'not_attempted', 'inconclusive'],
        },
        evidenceIds: { type: 'array', items: { type: 'string' } },
        explanation: { type: 'string' },
        suspectedFailure: {
          type: 'object',
          properties: {
            contradiction: { type: 'string' },
            uncertainty: { type: 'string' },
            confirmationCheck: { type: 'string' },
          },
          required: ['contradiction', 'uncertainty', 'confirmationCheck'],
          additionalProperties: false,
        },
        limitations: { type: 'array', items: { type: 'string' } },
        basis: { type: 'string', enum: ['observations', 'visual', 'motion'] },
        separateExecutions: { type: 'string' },
        temporalComparison: { type: 'string' },
      },
      required: [
        'obligationId',
        'outcome',
        'evidenceIds',
        'explanation',
        'limitations',
        'basis',
      ],
      additionalProperties: false,
    },
    async execute(_id, parameters, signal, _update, ctx) {
      checkVision(ctx.model)
      const result = await request(
        new URL('/conclude', url).href,
        {
          obligationId: parameters.obligationId,
          conclusion: parameters,
        },
        signal
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      }
    },
  })
}
