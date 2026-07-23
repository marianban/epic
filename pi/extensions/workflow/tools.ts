import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const SECRET_PATHS = [
  /(^|[/\\])\.env(?:\.|$)/i,
  /(?:id_rsa|id_ed25519|known_hosts|credentials|token|secret)/i,
  /[/\\]\.ssh([/\\]|$)/i,
]
const DESTRUCTIVE_COMMANDS =
  /\b(rm|mv|cp|mkdir|touch|chmod|chown|git\s+(add|commit|push|reset|checkout|branch|stash|merge|rebase)|npm\s+(install|publish)|pnpm\s+(add|install)|yarn\s+(add|install)|sudo|kill|shutdown)\b/i

export function isSecretPath(filePath: string): boolean {
  return SECRET_PATHS.some((pattern) => pattern.test(filePath))
}
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

export function assertRepositoryPath(
  root: string,
  candidate: string,
  allowPlan = false
): string {
  const resolved = path.resolve(root, candidate)
  if (!isInside(root, resolved))
    throw new Error(`Path is outside repository: ${candidate}`)
  if (isSecretPath(resolved))
    throw new Error(`Access to sensitive path is blocked: ${candidate}`)
  if (
    !allowPlan &&
    (resolved === path.join(root, 'plan.md') ||
      resolved.startsWith(path.join(root, '.pi', 'workflows')))
  ) {
    throw new Error(`Workflow-managed path is protected: ${candidate}`)
  }
  return resolved
}

export async function readConfig(
  root: string
): Promise<Record<string, unknown>> {
  const candidates = [
    path.join(root, '.pi', 'workflow.config.json'),
    path.join(root, '.pi', 'workflow.config.local.json'),
  ]
  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8')) as Record<
        string,
        unknown
      >
    } catch {
      /* optional */
    }
  }
  return {}
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+/gi,
      '$1=[REDACTED]'
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,})\b/g, '[REDACTED]')
}

export function isSafeReadOnlyCommand(command: string): boolean {
  return (
    !DESTRUCTIVE_COMMANDS.test(command) &&
    !/[;&|`]\s*(?:rm|mv|cp|npm\s+install|git\s+(?:commit|push|reset))/i.test(
      command
    )
  )
}

/** Guard extension loaded into each role's child Pi process. */
export default function workflowToolGuard(pi: ExtensionAPI): void {
  const root = process.cwd()
  const role = process.env.PI_WORKFLOW_ROLE ?? 'unknown'
  pi.on('tool_call', (event) => {
    const input = event.input as Record<string, unknown>
    const candidate = String(input.file_path ?? input.path ?? '')
    if (
      event.toolName === 'read' ||
      event.toolName === 'grep' ||
      event.toolName === 'find' ||
      event.toolName === 'ls'
    ) {
      if (candidate && isSecretPath(candidate))
        return {
          block: true,
          reason: 'Workflow guard: sensitive paths are blocked.',
        }
    }
    if (event.toolName === 'edit' || event.toolName === 'write') {
      if (role !== 'implementer')
        return { block: true, reason: `${role} is read-only.` }
      if (candidate) {
        try {
          assertRepositoryPath(root, candidate)
        } catch (error) {
          return { block: true, reason: String(error) }
        }
      }
    }
    if (event.toolName === 'bash') {
      const command = String(input.command ?? '')
      if (!isSafeReadOnlyCommand(command))
        return {
          block: true,
          reason: `${role} may only run read-only commands.`,
        }
      if (/plan\.md|\.pi[/\\]workflows/i.test(command))
        return {
          block: true,
          reason: 'Workflow-managed files cannot be changed by an agent.',
        }
    }
  })
}
