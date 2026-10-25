import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** Loaded only into the verifier subprocess; the parent retains resource ownership. */
export default function verifierTools(pi: ExtensionAPI): void {
  const url = process.env.PI_EPIC_BROWSER_URL
  const token = process.env.PI_EPIC_BROWSER_TOKEN
  if (!url || !token)
    throw new Error(
      'Verifier browser tools require an explicit runtime bridge.'
    )
  pi.registerTool({
    name: 'browser_verify',
    label: 'Verify browser behavior',
    description:
      'Run bounded interactions in an isolated runtime-owned browser context. Returns criterion-linked observations and evidence. Each call starts from a fresh page. Steps may be adjusted to verify the same expected behavior. Use observe with an expression to read diagnostic values without asserting success; inspect must return true to assert success. After a probe error, inspect actual values and retry a corrected equivalent check. Tools record every attempt; the latest result per obligation is used. Do not start a development server or browser yourself.',
    parameters: {
      type: 'object',
      properties: {
        obligationId: { type: 'string' },
        steps: { type: 'array', items: {}, minItems: 1, maxItems: 100 },
      },
      required: ['obligationId', 'steps'],
      additionalProperties: false,
    },
    async execute(_id, parameters, signal) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(parameters),
        signal,
      })
      const body = await response.text()
      if (!response.ok) throw new Error(`Browser verification failed: ${body}`)
      return {
        content: [{ type: 'text', text: body }],
        details: JSON.parse(body) as unknown,
      }
    },
  })
}
