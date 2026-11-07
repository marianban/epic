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
      'Run a probe on a FRESH isolated page; all page state is lost after this call. Repeat setup on every new probe. Choose steps freely to measure the approved expectation. Returns recorded observations with evidence IDs and requested screenshots as actual images. This tool does NOT establish a pass. Use browser_conclude afterward to explain and cite the evidence. Actions: click/press/text/visible (selector,value), pointer(x,y), mouse_down/mouse_up(button: left/middle/right), click_at(x,y,button), hold(keys,durationMs, at most 10000), resize(width,height), playwright(code), key_down/key_up(key), wait(durationMs, at most 10000), observe/inspect/fixture(expression), capture(count,intervalMs,optional selector). Mouse coordinates are viewport CSS pixels. hold presses keys together and releases them afterward, including on failure/cancellation; use separate key_down/key_up steps to capture while keys remain held. Capture at chosen points; at most 12 frames and 10000ms total sequence intervals per call. Fixture results cannot prove behavior. inspect must return true but inspect:true and visibility alone cannot prove the expectation. Prefer observe for arbitrary JSON measurements. resize changes the actual viewport and records before/after dimensions; do not use window.resizeTo. playwright runs an async JavaScript body with page (runtime-owned Playwright Page) and timeoutMs (remaining budget); use it when no predefined action fits, await all work, and return JSON-serializable measurements. Its return is an observation, never an automatic pass. Use capture for image evidence. Do not create or close pages/contexts/browsers or start a server. For motion, capture or measure at least twice within this call.',
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
      'Conclude one obligation using recorded evidence IDs from this invocation. Supply structured observations identifying the target, its distinguishing identity, evidenceId, property, and observed value for every cited measurement/image. Record an explicit selfCheck: alternativeExplanation, counterEvidence, wouldPassIfBroken, reasoning. A pass requires wouldPassIfBroken=false. Motion observations must track the same target identity/property at different times in one probe. Explain why observations establish the expectation, and list limitations honestly. Pass/fail/likely-fail needs cited evidence; inconclusive needs gap. Use likely-fail for an observed contradiction with a specific uncertainty, and provide suspectedFailure containing contradiction, uncertainty, and confirmationCheck. Both fail and likely-fail trigger repair. A completed interaction with visibly incorrect behavior requires repair; investigate the application first rather than speculate about automation. An infrastructure explanation requires concrete evidence of a tool or delivery failure. Use inconclusive when evidence cannot judge behavior, not for an observed contradiction with an uncertain cause. basis is observations, visual (cite images), or motion (cite two timed records in one probe and explain temporalComparison). When combining independent fresh-page probes, explain separateExecutions. Runtime errors prevent pass. Invalid conclusions return feedback; correct them or report inconclusive. Prose outside this tool cannot establish acceptance.',
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
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              targetIdentity: { type: 'string' },
              evidenceId: { type: 'string' },
              property: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['target', 'targetIdentity', 'evidenceId', 'property', 'value'],
            additionalProperties: false,
          },
        },
        selfCheck: {
          type: 'object',
          properties: {
            alternativeExplanation: { type: 'string' },
            counterEvidence: { type: 'string' },
            wouldPassIfBroken: { type: 'boolean' },
            reasoning: { type: 'string' },
          },
          required: ['alternativeExplanation', 'counterEvidence', 'wouldPassIfBroken', 'reasoning'],
          additionalProperties: false,
        },
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
        'observations',
        'selfCheck',
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
