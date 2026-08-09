import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'

let initializedRoot: string | undefined
let initializedWritablePaths = ''

export function isImplementerSandboxSupported(
  platform = process.platform
): boolean {
  return platform === 'darwin' || platform === 'linux'
}

function implementerSandboxConfig(root: string, writablePaths: readonly string[]): SandboxRuntimeConfig {
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
      allowWrite: [repositoryRoot, ...writablePaths.map((file) => path.resolve(repositoryRoot, file)), tmpdir(), getAgentDir()],
      denyWrite: [
        path.join(repositoryRoot, '.git'),
        path.join(repositoryRoot, 'plan.md'),
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

async function initializeImplementerSandbox(root: string, writablePaths: readonly string[]): Promise<void> {
  if (!isImplementerSandboxSupported()) {
    throw new Error(
      `Implementer sandbox is only supported on macOS and Linux; native ${process.platform} is unsupported. Run Pi from WSL on Windows.`
    )
  }

  if (
    initializedRoot === path.resolve(root) &&
    initializedWritablePaths === writablePaths.slice().sort().join('\0') &&
    SandboxManager.isSandboxingEnabled()
  )
    return

  if (!SandboxManager.checkDependencies({ command: 'rg' }))
    throw new Error(missingDependencyMessage())

  if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset()
  await SandboxManager.initialize(implementerSandboxConfig(root, writablePaths))
  initializedRoot = path.resolve(root)
  initializedWritablePaths = writablePaths.slice().sort().join('\0')
}

export async function wrapImplementerInvocation(
  root: string,
  command: string,
  args: string[],
  signal?: AbortSignal,
  writablePaths: readonly string[] = []
): Promise<string> {
  await initializeImplementerSandbox(root, writablePaths)
  return SandboxManager.wrapWithSandbox(
    quoteProcessInvocation(command, args),
    undefined,
    undefined,
    signal
  )
}
