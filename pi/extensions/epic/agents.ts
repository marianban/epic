import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type {
  AgentProfile,
  AgentRole,
  PlannerContextRequest,
  EpicTask,
} from './types.ts'
import { createAgentRunStdoutLog } from './agent-runs.ts'
import { redactSecrets } from './tools.ts'
import { wrapSandboxedInvocation } from './execution-sandbox.ts'
import { stripProtocolImageData } from './agent-image-log.ts'

export interface AgentRunResult {
  role: AgentRole
  exitCode: number
  output: string
  stderr: string
  stdoutLogPath: string
  failureReason?: string
  usage?: Record<string, unknown>
  provider?: string
  model?: string
}
export interface AgentRunOptions {
  agentRunDirectory: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
  bridge?: { url: string; token: string }
  timeoutMs: number
}

const MAX_STDOUT_DIAGNOSTIC_CHARS = 100_000
const MAX_STDERR_CHARS = 20_000

function appendTail(
  current: string,
  incoming: string,
  maxChars: number
): string {
  if (incoming.length >= maxChars) return incoming.slice(-maxChars)
  const overflow = current.length + incoming.length - maxChars
  if (overflow <= 0) return current + incoming
  return current.slice(overflow) + incoming
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeUsage(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  if (current === undefined) return { ...incoming }

  const merged = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key]
    if (typeof existing === 'number' && typeof value === 'number') {
      merged[key] = existing + value
    } else if (!(key in merged)) {
      merged[key] = value
    }
  }
  return merged
}

function usageRecords(
  event: Record<string, unknown>
): Record<string, unknown>[] {
  if (isRecord(event.usage)) return [event.usage]
  if (event.type !== 'agent_end' || !Array.isArray(event.messages)) return []

  return event.messages.flatMap((message) =>
    isRecord(message) && isRecord(message.usage) ? [message.usage] : []
  )
}

function assistantText(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'message_end' || !isRecord(event.message)) return undefined
  if (event.message.role !== 'assistant') return undefined
  if (!Array.isArray(event.message.content)) return undefined

  const output = event.message.content
    .filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim()
  return output || undefined
}

interface AssistantIdentity {
  readonly provider?: string
  readonly model?: string
}

function assistantIdentity(
  message: Record<string, unknown>
): AssistantIdentity | undefined {
  if (message.role !== 'assistant') return undefined
  const provider = message.provider
  const model = message.model
  if (provider === undefined && model === undefined) return undefined
  if (
    (provider !== undefined &&
      (typeof provider !== 'string' || provider.length === 0)) ||
    (model !== undefined &&
      (typeof model !== 'string' || model.length === 0))
  ) {
    throw new Error('Assistant message has invalid provider/model metadata.')
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

function assistantMessages(event: Record<string, unknown>): Record<string, unknown>[] {
  if (event.type === 'message_end' && isRecord(event.message)) {
    return [event.message]
  }
  if (event.type === 'agent_end' && Array.isArray(event.messages)) {
    return event.messages.filter(isRecord)
  }
  return []
}

export interface AgentOutputSummary {
  output: string
  diagnosticTail: string
  failureReason?: string
  usage?: Record<string, unknown>
  provider?: string
  model?: string
}

function protocolFailureReason(
  event: Record<string, unknown>
): string | undefined {
  if (typeof event.errorMessage === 'string' && event.errorMessage.trim())
    return event.errorMessage.trim()

  if (!isRecord(event.message)) return undefined
  if (
    typeof event.message.errorMessage === 'string' &&
    event.message.errorMessage.trim()
  )
    return event.message.errorMessage.trim()
  if (event.message.stopReason === 'error') return 'Agent reported an error.'
  return undefined
}

/**
 * Extracts the small part of Pi's JSONL stream needed by the parent process.
 * A filtered diagnostic stream is persisted by createAgentRunStdoutLog.
 */
export class AgentOutputCollector {
  private readonly decoder = new StringDecoder('utf8')
  private pendingLine = ''
  private latestAssistantText = ''
  private diagnosticTail = ''
  private failureReason: string | undefined
  private usage: Record<string, unknown> | undefined
  private provider: string | undefined
  private model: string | undefined

  append(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk))
  }

  finish(): AgentOutputSummary {
    this.consume(this.decoder.end())
    if (this.pendingLine) {
      this.processLine(this.pendingLine)
      this.pendingLine = ''
    }
    return {
      output: this.latestAssistantText,
      diagnosticTail: this.diagnosticTail,
      failureReason: this.failureReason,
      usage: this.usage,
      provider: this.provider,
      model: this.model,
    }
  }

  private consume(text: string): void {
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      if (newline === -1) {
        this.pendingLine += text.slice(offset)
        return
      }
      const line = `${this.pendingLine}${text.slice(offset, newline)}`.replace(
        /\r$/,
        ''
      )
      this.pendingLine = ''
      this.processLine(line)
      offset = newline + 1
    }
  }

  private processLine(line: string): void {
    this.diagnosticTail = appendTail(this.diagnosticTail, `${stripProtocolImageData(line)}\n`, MAX_STDOUT_DIAGNOSTIC_CHARS)
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(event)) return

    const failureReason = protocolFailureReason(event)
    if (failureReason) this.failureReason = failureReason

    const output = assistantText(event)
    if (output) {
      this.latestAssistantText = output
      // A later successful retry supersedes an earlier provider error.
      this.failureReason = undefined
    }
    for (const usage of usageRecords(event))
      this.usage = mergeUsage(this.usage, usage)

    for (const message of assistantMessages(event)) {
      const identity = assistantIdentity(message)
      if (identity === undefined) continue
      if (
        this.provider !== undefined &&
        identity.provider !== undefined &&
        this.provider !== identity.provider
      ) {
        throw new Error(
          `Agent reported inconsistent provider identity: ${this.provider} and ${identity.provider}.`
        )
      }
      if (
        this.model !== undefined &&
        identity.model !== undefined &&
        this.model !== identity.model
      ) {
        throw new Error(
          `Agent reported inconsistent model identity: ${this.model} and ${identity.model}.`
        )
      }
      this.provider ??= identity.provider
      this.model ??= identity.model
    }
  }
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
  userPrompt: string,
  options: AgentRunOptions,
  profile: AgentProfile
): Promise<AgentRunResult> {
  if (profile.role !== role) {
    throw new Error(
      `Agent profile role ${profile.role} does not match invocation role ${role}.`
    )
  }
  const systemPrompt = await readPrompt(root, profile.systemPromptPath)
  // The guard belongs to the loaded extension package, not necessarily to the
  // target repository. This allows `pi -e /path/to/epic/index.ts` to run
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
    [...profile.tools, ...(options.bridge ? ['browser_verify', 'browser_conclude'] : [])].join(','),
  ]
  if (options.bridge) args.push('-e', path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'verifier-tools.ts'))
  if (profile.provider) args.push('--provider', profile.provider)
  if (profile.model) args.push('--model', profile.model)
  if (profile.thinking) args.push('--thinking', profile.thinking)
  const promptDir = await fs.mkdtemp(path.join(tmpdir(), 'pi-epic-'))
  const promptPath = path.join(promptDir, `${role}.md`)
  await fs.writeFile(promptPath, systemPrompt, {
    encoding: 'utf8',
    mode: 0o600,
  })
  args.push('--append-system-prompt', promptPath, userPrompt)
  const timeoutMs = options.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Agent timeout must be a positive integer: ${timeoutMs}`)
  }
  const invocation = getPiInvocation(args)
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_EPIC_ROLE: role }
  if (options.bridge) { childEnv.PI_EPIC_BROWSER_URL = options.bridge.url; childEnv.PI_EPIC_BROWSER_TOKEN = options.bridge.token }
  let sandboxedInvocation: string
  try {
    sandboxedInvocation = await wrapSandboxedInvocation(
      root,
      invocation.command,
      invocation.args,
      options.signal
    )
    childEnv.PI_EPIC_SANDBOX = '1'
    childEnv.npm_config_cache = path.join(promptDir, 'npm-cache')
  } catch (error) {
    await fs.rm(promptDir, { recursive: true, force: true })
    throw error
  }
  const stdoutLog = createAgentRunStdoutLog(options.agentRunDirectory, role)
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', sandboxedInvocation], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      signal: options.signal,
    })
    const outputCollector = new AgentOutputCollector()
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
      stdoutLog.close()
      void fs.rm(promptDir, { recursive: true, force: true })
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        stdoutLog.append(chunk)
        outputCollector.append(chunk)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        child.kill('SIGTERM')
        return
      }
      if (!progressNotified) {
        progressNotified = true
        options.onProgress?.(`${role} started producing output.`)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = appendTail(stderr, text, MAX_STDERR_CHARS)
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
      let output: AgentOutputSummary
      try {
        output = outputCollector.finish()
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      cleanup()
      const failureReason = output.failureReason
      resolve({
        role,
        exitCode: failureReason ? 1 : (exitCode ?? 1),
        output: output.output || redactSecrets(output.diagnosticTail),
        stderr: redactSecrets(stderr),
        stdoutLogPath: stdoutLog.filePath,
        failureReason: failureReason ? redactSecrets(failureReason) : undefined,
        usage: output.usage,
        provider: output.provider,
        model: output.model,
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

export function parseTaskDecomposition(output: string): EpicTask[] {
  const parsed = parseJsonResponse<{ tasks?: EpicTask[] }>(output, 'task-planner')
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0)
    throw new Error('Task Planner returned no implementation tasks.')
  for (const task of parsed.tasks) {
    if (
      !task ||
      typeof task.id !== 'string' ||
      typeof task.title !== 'string' ||
      typeof task.objective !== 'string' ||
      !task.files ||
      !Array.isArray(task.files.context) ||
      !task.files.context.every((file) => typeof file === 'string') ||
      !Array.isArray(task.files.expectedChanges) ||
      !task.files.expectedChanges.every((file) => typeof file === 'string') ||
      'scope' in task ||
      !Array.isArray(task.implementation) ||
      !Array.isArray(task.acceptanceCriteria) ||
      !Array.isArray(task.verification) ||
      !Array.isArray(task.manualReviewSteps) ||
      !Array.isArray(task.requiredChecks) ||
      !Array.isArray(task.deferredChecks) ||
      typeof task.reason !== 'string' ||
      task.reason.trim().length === 0
    )
      throw new Error('Task Planner returned an invalid task.')
    if (
      task.acceptanceCriteria.length === 0 ||
      task.manualReviewSteps.length === 0
    )
      throw new Error(
        `Task ${task.id} must include acceptance criteria and manual review steps.`
      )
    if (
      !task.requiredChecks.every((check) => typeof check === 'string') ||
      !task.deferredChecks.every((check) => typeof check === 'string')
    )
      throw new Error(`Task ${task.id} contains invalid check names.`)
    const required = new Set(task.requiredChecks)
    if (required.size !== task.requiredChecks.length)
      throw new Error(`Task ${task.id} contains duplicate required checks.`)
    const deferred = new Set(task.deferredChecks)
    if (deferred.size !== task.deferredChecks.length)
      throw new Error(`Task ${task.id} contains duplicate deferred checks.`)
    if (task.deferredChecks.some((check) => required.has(check)))
      throw new Error(
        `Task ${task.id} cannot require and defer the same check.`
      )
  }
  return parsed.tasks
}
