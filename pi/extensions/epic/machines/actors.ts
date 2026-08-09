import { createActor, fromPromise } from 'xstate'
import { runAgent, type AgentRunResult } from '../agents.ts'
import type { AgentProfile, AgentRole } from '../types.ts'

interface AgentActorInput {
  repositoryRoot: string
  agentRunDirectory: string
  role: Exclude<AgentRole, 'orchestrator'>
  prompt: string
  profile: AgentProfile
  timeoutMs: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
  writablePaths?: string[]
}

const agentActor = fromPromise<AgentRunResult, AgentActorInput>(({ input }) =>
  runAgent(input.repositoryRoot, input.role, input.prompt, {
    agentRunDirectory: input.agentRunDirectory,
    signal: input.signal,
    onProgress: input.onProgress,
    writablePaths: input.writablePaths,
    timeoutMs: input.timeoutMs,
  }, input.profile)
)

/** One Pi role invocation is a one-shot XState promise actor. */
export async function runAgentActor(
  input: AgentActorInput
): Promise<AgentRunResult> {
  const actor = createActor(agentActor, { input })
  return new Promise<AgentRunResult>((resolve, reject) => {
    actor.subscribe({
      complete: () => actor.stop(),
      error: (error) => {
        actor.stop()
        reject(error)
      },
    })
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') {
        resolve(snapshot.output)
        actor.stop()
      }
    })
    actor.start()
  })
}
