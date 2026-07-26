import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type { Prerequisite } from './types.ts'

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function packageInstallCommand(
  root: string
): Promise<Prerequisite['command']> {
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm install'
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn install'
  if (await exists(path.join(root, 'package-lock.json'))) return 'npm ci'
  return 'npm install'
}

async function hasMissingPackageDependencies(root: string): Promise<boolean> {
  let packageJson: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  try {
    packageJson = JSON.parse(
      await fs.readFile(path.join(root, 'package.json'), 'utf8')
    ) as typeof packageJson
  } catch {
    return false
  }
  const packages = Object.keys({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  })
  const installed = await Promise.all(
    packages.map((name) => exists(path.join(root, 'node_modules', name)))
  )
  return installed.some((value) => !value)
}

export async function discoverPrerequisites(
  root: string
): Promise<Prerequisite[]> {
  const prerequisites: Prerequisite[] = []
  if (!(await exists(path.join(root, '.git')))) {
    prerequisites.push({
      kind: 'git',
      command: 'git init',
      reason:
        'The epic uses Git diff checks and this directory is not a Git repository.',
    })
  }

  if (
    (await exists(path.join(root, 'package.json'))) &&
    (!(await exists(path.join(root, 'node_modules'))) ||
      (await hasMissingPackageDependencies(root)))
  ) {
    prerequisites.push({
      kind: 'node_dependencies',
      command: await packageInstallCommand(root),
      reason:
        'package.json exists but installed Node dependencies were not found.',
    })
  }
  return prerequisites
}

function runCommand(
  root: string,
  command: Prerequisite['command'],
  timeoutMs: number
): Promise<void> {
  const [executable, ...args] = command.split(' ')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit' })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Prerequisite command timed out: ${command}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(
        new Error(
          `Prerequisite command failed to start (${command}): ${error.message}`
        )
      )
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `Prerequisite command failed with exit code ${code}: ${command}`
          )
        )
    })
  })
}

export async function applyPrerequisites(
  root: string,
  prerequisites: Prerequisite[],
  timeoutMs = 120_000
): Promise<void> {
  for (const prerequisite of prerequisites)
    await runCommand(root, prerequisite.command, timeoutMs)
}
