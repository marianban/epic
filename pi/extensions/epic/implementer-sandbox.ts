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

export function isImplementerSandboxSupported(
  platform = process.platform
): boolean {
  return platform === 'darwin' || platform === 'linux'
}

function implementerSandboxConfig(root: string): SandboxRuntimeConfig {
  const repositoryRoot = path.resolve(root)
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
      // The implementer works in the repository as a whole. Task paths still
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
    return 'Implementer sandbox requires ripgrep (rg) on macOS.'
  return 'Implementer sandbox requires ripgrep (rg), bubblewrap (bwrap), and socat on Linux.'
}

async function initializeImplementerSandbox(root: string): Promise<void> {
  if (!isImplementerSandboxSupported()) {
    throw new Error(
      `Implementer sandbox is only supported on macOS and Linux; native ${process.platform} is unsupported. Run Pi from WSL on Windows.`
    )
  }

  if (
    initializedRoot === path.resolve(root) &&
    SandboxManager.isSandboxingEnabled()
  )
    return

  if (!SandboxManager.checkDependencies({ command: 'rg' }))
    throw new Error(missingDependencyMessage())

  if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset()
  await SandboxManager.initialize(implementerSandboxConfig(root))
  initializedRoot = path.resolve(root)
}

export async function wrapImplementerInvocation(
  root: string,
  command: string,
  args: string[],
  signal?: AbortSignal
): Promise<string> {
  await initializeImplementerSandbox(root)
  return SandboxManager.wrapWithSandbox(
    quoteProcessInvocation(command, args),
    undefined,
    undefined,
    signal
  )
}
