import type { VerificationPlan } from './verification-types.ts'

export function browserVerificationPrompt(
  plan: VerificationPlan,
  errors: string[]
): string {
  return `Verify agent_browser obligations using browser_verify. The approved criteria, obligation IDs, methods, and expected behaviors are fixed. Planned steps are optional starting suggestions, not mandatory commands or assertions.
Read each expectation, explore the running app, and choose interactions and assertions that establish that behavior. You may change selectors, expressions, and equivalent checks without changing the expectation or weakening the criterion. Check all parts of the expectation; a trivial true assertion or unrelated observation is not evidence.
When a probe fails, distinguish an application defect from a faulty probe. Use observe steps to inspect actual DOM/computed values, then retry a corrected equivalent assertion within this invocation before reporting an application failure. For example, CSS margin: 0 is commonly serialized as 0px; compare computed values semantically. Do not change application code to satisfy a mistaken probe. Do not retry a real application defect until it happens to pass or discard runtime errors.
Each browser_verify call starts in a fresh isolated page, so include required setup and interactions on every call. Supported steps: click/press/text/visible use selector and value; pointer uses x and y; observe/inspect/fixture use expression. observe records values but cannot establish a pass; inspect must return true. Fixtures may establish state but must not bypass the behavior under test.
Tools own and record evidence, including failed probes. The latest tool result for each obligation is used for acceptance; finish with an assertion that establishes the complete expectation, or leave an honest fail/unverified result if it cannot be established. Do not fabricate results.
Verification plan: ${JSON.stringify(plan)}
Prior validation errors: ${JSON.stringify(errors)}
Finish with a concise summary explaining any corrected probes and remaining defects or evidence gaps.`
}
