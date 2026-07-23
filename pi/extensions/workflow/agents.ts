import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type {
  AgentProfile,
  AgentRole,
  PlannerContextRequest,
  WorkflowConfig,
  WorkflowTask,
} from './types.ts'
import { readConfig, redactSecrets } from './tools.ts'

const DEFAULT_AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
  orchestrator: {
    role: 'orchestrator',
    systemPromptPath: '.pi/agents/orchestrator.md',
    tools: [],
    readOnly: true,
  },
  scout: {
    role: 'scout',
    systemPromptPath: '.pi/agents/scout.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'low',
  },
  planner: {
    role: 'planner',
    systemPromptPath: '.pi/agents/planner.md',
    tools: ['read', 'grep', 'find', 'ls'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'high',
  },
  'plan-reviewer': {
    role: 'plan-reviewer',
    systemPromptPath: '.pi/agents/plan-reviewer.md',
    tools: ['read', 'grep', 'find', 'ls'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'low',
  },
  'task-reviewer': {
    role: 'task-reviewer',
    systemPromptPath: '.pi/agents/task-reviewer.md',
    tools: ['read', 'grep', 'find', 'ls'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'low',
  },
  implementer: {
    role: 'implementer',
    systemPromptPath: '.pi/agents/implementer.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
    readOnly: false,
    temperature: 0.1,
    thinking: 'high',
  },
  reviewer: {
    role: 'reviewer',
    systemPromptPath: '.pi/agents/reviewer.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'high',
  },
}

async function getAgentProfile(
  root: string,
  role: AgentRole
): Promise<AgentProfile> {
  const config = (await readConfig(root)) as WorkflowConfig
  const override = config.agents?.[role] ?? {}
  const base = DEFAULT_AGENT_PROFILES[role]
  return {
    ...base,
    ...override,
    role,
    systemPromptPath: override.systemPromptPath ?? base.systemPromptPath,
    tools: override.tools ?? base.tools,
    readOnly: override.readOnly ?? base.readOnly,
  }
}

export interface AgentRunResult {
  role: AgentRole
  exitCode: number
  output: string
  stderr: string
  usage?: Record<string, unknown>
}
export interface AgentRunOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/**
 * Resolve the Pi executable the same way Pi's bundled subagent extension does.
 * This keeps packaged/runtime-launched extensions on the same CLI version and
 * uses PATH only when the extension is running under a generic node/bun host.
 */
function getPiInvocation(args: string[]): {
  command: string
  args: string[]
} {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
  if (currentScript && !isBunVirtualScript && existsSync(currentScript))
    return { command: process.execPath, args: [currentScript, ...args] }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) return { command: process.execPath, args }
  return { command: 'pi', args }
}

async function readPrompt(root: string, relativePath: string): Promise<string> {
  const candidates = [
    path.isAbsolute(relativePath)
      ? relativePath
      : path.resolve(root, relativePath),
  ]

  // Project-local prompts override the bundled prompts. This matters when the
  // extension is loaded with `pi -e` from a different repository.
  if (!path.isAbsolute(relativePath)) {
    const bundledAgentsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../agents'
    )
    candidates.push(path.join(bundledAgentsDir, path.basename(relativePath)))
  }

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  throw new Error(`Agent prompt not found. Checked: ${candidates.join(', ')}`)
}

export async function runAgent(
  root: string,
  role: AgentRole,
  task: string,
  options: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const profile = await getAgentProfile(root, role)
  const prompt = await readPrompt(root, profile.systemPromptPath)
  // The guard belongs to the loaded extension package, not necessarily to the
  // target repository. This allows `pi -e /path/to/workflow/index.ts` to run
  // against an otherwise empty repository.
  const guard = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'tools.ts'
  )
  const args = [
    '--mode',
    'json',
    '-p',
    '--no-session',
    '--no-approve',
    '--no-context-files',
    '--no-extensions',
    '-e',
    guard,
    '--tools',
    profile.tools.join(','),
  ]
  if (profile.provider) args.push('--provider', profile.provider)
  if (profile.model) args.push('--model', profile.model)
  if (profile.thinking) args.push('--thinking', profile.thinking)
  const promptDir = await fs.mkdtemp(path.join(tmpdir(), 'pi-workflow-'))
  const promptPath = path.join(promptDir, `${role}.md`)
  await fs.writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 })
  args.push('--append-system-prompt', promptPath, task)
  const config = (await readConfig(root)) as WorkflowConfig
  const timeoutMs = profile.timeoutMs ?? config.agentTimeoutMs ?? 300_000
  const invocation = getPiInvocation(args)
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_WORKFLOW_ROLE: role },
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let progressNotified = false
    let stderrNotified = false
    const heartbeat = setInterval(
      () => options.onProgress?.(`${role} is still running...`),
      15_000
    )
    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      void fs.rm(promptDir, { recursive: true, force: true })
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (!progressNotified) {
        progressNotified = true
        options.onProgress?.(`${role} started producing output.`)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      if (!stderrNotified && text.trim()) {
        stderrNotified = true
        options.onProgress?.(
          `${role}: ${redactSecrets(text).trim().replace(/\s+/g, ' ').slice(0, 500)}`
        )
      }
    })
    child.on('spawn', () => {
      options.onProgress?.(
        `${role} child started (pid ${child.pid ?? 'unknown'}, cwd ${root}).`
      )
    })
    const timer = setTimeout(() => {
      options.onProgress?.(
        `${role} exceeded its ${timeoutMs}ms timeout; terminating child.`
      )
      child.kill('SIGTERM')
      fail(new Error(`${role} agent timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (error) => fail(error))
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      cleanup()
      const parsed = stdout.split(/\r?\n/).flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        } catch {
          return []
        }
      })
      const assistantMessages = parsed.filter(
        (event) =>
          event.type === 'message_end' &&
          (event.message as Record<string, unknown> | undefined)?.role ===
            'assistant'
      )
      const message = assistantMessages[assistantMessages.length - 1]
      const content =
        (
          message?.message as
            { content?: { type: string; text?: string }[] } | undefined
        )?.content ?? []
      const output = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()
      const agentEnd = [...parsed]
        .reverse()
        .find((event) => event.type === 'agent_end')
      resolve({
        role,
        exitCode: exitCode ?? 1,
        output: output || redactSecrets(stdout).slice(-100_000),
        stderr: redactSecrets(stderr).slice(-20_000),
        usage: agentEnd?.usage as Record<string, unknown> | undefined,
      })
    })
  })
}

export function parseJsonResponse<T>(output: string, role: AgentRole): T {
  const trimmed = output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed) as T
  } catch (error) {
    throw new Error(
      `${role} returned invalid JSON: ${String(error)}\n${trimmed.slice(0, 2_000)}`,
      { cause: error }
    )
  }
}

export function parseMarkdownResponse(output: string, role: AgentRole): string {
  const trimmed = output
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
  if (!trimmed.startsWith('# Implementation Plan'))
    throw new Error(
      `${role} did not return a plan beginning with '# Implementation Plan'.`
    )
  return trimmed
}

export function parsePlannerResponse(
  output: string
): string | PlannerContextRequest {
  const trimmed = output
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(trimmed) as Partial<PlannerContextRequest>
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter(
          (item): item is { question: string; reason: string } =>
            Boolean(
              item &&
              typeof item.question === 'string' &&
              typeof item.reason === 'string'
            )
        )
      : []
    if (parsed.status === 'needs_more_context' && questions.length > 0) {
      return {
        status: 'needs_more_context',
        questions,
      }
    }
  } catch {
    // A normal planner response is Markdown, not JSON.
  }
  return parseMarkdownResponse(trimmed, 'planner')
}

export function parseTaskDecomposition(output: string): WorkflowTask[] {
  const parsed = parseJsonResponse<{ tasks?: WorkflowTask[] }>(
    output,
    'planner'
  )
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0)
    throw new Error('Planner returned no implementation tasks.')
  for (const task of parsed.tasks) {
    if (
      !task ||
      typeof task.id !== 'string' ||
      typeof task.title !== 'string' ||
      typeof task.objective !== 'string' ||
      !Array.isArray(task.implementation) ||
      !Array.isArray(task.acceptanceCriteria) ||
      !Array.isArray(task.verification) ||
      !Array.isArray(task.manualReviewSteps)
    )
      throw new Error('Planner returned an invalid task.')
    if (
      task.acceptanceCriteria.length === 0 ||
      task.manualReviewSteps.length === 0
    )
      throw new Error(
        `Task ${task.id} must include acceptance criteria and manual review steps.`
      )
  }
  return parsed.tasks
}
