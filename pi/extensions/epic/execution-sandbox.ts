import * as path from 'node:path'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'

let initializedRoot: string | undefined

export function canonicalTemporaryPaths(
  platform = process.platform,
  processTemporaryDirectory = tmpdir()
): string[] {
  const candidates = new Set([processTemporaryDirectory, '/tmp', '/var/tmp'])
  if (platform === 'darwin') {
    candidates.add('/private/tmp')
    candidates.add('/private/var/tmp')
  }

  const paths = new Set<string>()
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    paths.add(resolved)
    try {
      paths.add(realpathSync(resolved))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return [...paths]
}

export function isExecutionSandboxSupported(
  platform = process.platform
): boolean {
  return platform === 'darwin' || platform === 'linux'
}

function executionSandboxConfig(root: string): SandboxRuntimeConfig {
  const repositoryRoot = realpathSync(root)
  return {
    // sandbox-runtime treats an omitted allowedDomains field as filesystem-only
    // isolation. Its public type currently requires the allowlist fields even
    // though the runtime supports unrestricted network access in this mode.
    network: {} as SandboxRuntimeConfig['network'],
    filesystem: {
      denyRead: [
        '~/.ssh',
        '~/.aws',
        '~/.gnupg',
        path.join(repositoryRoot, '.env'),
        path.join(repositoryRoot, '.env.*'),
        path.join(repositoryRoot, '**', '*.pem'),
        path.join(repositoryRoot, '**', '*.key'),
      ],
      // Agents and verification commands work in the repository as a whole. Task paths still
      // describe the intended change and are validated after the run, but
      // they cannot be the sandbox's filesystem boundary because normal
      // workflows create derived files and directories such as node_modules.
      allowWrite: [
        repositoryRoot,
        ...canonicalTemporaryPaths(),
        getAgentDir(),
      ],
      denyWrite: [
        path.join(repositoryRoot, '.git'),
        path.join(repositoryRoot, '.pi', 'epics'),
        path.join(repositoryRoot, '.env'),
        path.join(repositoryRoot, '.env.*'),
        path.join(repositoryRoot, '**', '*.pem'),
        path.join(repositoryRoot, '**', '*.key'),
      ],
      allowGitConfig: false,
    },
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function quoteProcessInvocation(
  command: string,
  args: string[]
): string {
  return [command, ...args].map(shellQuote).join(' ')
}

function missingDependencyMessage(): string {
  if (process.platform === 'darwin')
    return 'Execution sandbox requires ripgrep (rg) on macOS.'
  return 'Execution sandbox requires ripgrep (rg), bubblewrap (bwrap), and socat on Linux.'
}

async function initializeExecutionSandbox(root: string): Promise<void> {
  const repositoryRoot = realpathSync(root)
  if (!isExecutionSandboxSupported()) {
    throw new Error(
      `Execution sandbox is only supported on macOS and Linux; native ${process.platform} is unsupported. Run Pi from WSL on Windows.`
    )
  }

  if (
    initializedRoot === repositoryRoot &&
    SandboxManager.isSandboxingEnabled()
  )
    return

  const dependencies = SandboxManager.checkDependencies({ command: 'rg' })
  if (dependencies.errors.length)
    throw new Error(`${missingDependencyMessage()} ${dependencies.errors.join('; ')}`)

  if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset()
  await SandboxManager.initialize(executionSandboxConfig(repositoryRoot))
  initializedRoot = repositoryRoot
}

export async function wrapSandboxedInvocation(
  root: string,
  command: string,
  args: string[],
  signal: AbortSignal | undefined
): Promise<string> {
  await initializeExecutionSandbox(root)
  return SandboxManager.wrapWithSandbox(
    quoteProcessInvocation(command, args),
    undefined,
    undefined,
    signal
  )
}
