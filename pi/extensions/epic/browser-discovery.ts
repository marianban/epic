import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { BrowserIdentity } from './types.ts'

const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const PATH_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
]

async function executable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function pathCandidates(pathValue: string | undefined): string[] {
  if (!pathValue) return []
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => PATH_NAMES.map((name) => path.join(directory, name)))
}

export function browserExecutableCandidates(
  platform: NodeJS.Platform,
  pathValue: string | undefined,
  configuredPath?: string
): string[] {
  const known =
    platform === 'darwin'
      ? MACOS_CANDIDATES
      : platform === 'linux'
        ? LINUX_CANDIDATES
        : []
  return [
    ...(configuredPath ? [path.resolve(configuredPath)] : []),
    ...known,
    ...pathCandidates(pathValue),
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index)
}

export async function resolveBrowserIdentity(
  configuredPath?: string,
  platform: NodeJS.Platform = process.platform,
  pathValue: string | undefined = process.env.PATH
): Promise<BrowserIdentity> {
  const candidates = browserExecutableCandidates(
    platform,
    pathValue,
    configuredPath
  )
  for (const candidate of candidates) {
    if (!(await executable(candidate))) continue
    const version = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    if (version.error || version.status !== 0) continue
    const text = `${version.stdout}\n${version.stderr}`.trim()
    if (!text) continue
    return { executablePath: candidate, version: text.split(/\r?\n/, 1)[0] ?? text }
  }
  const detail = configuredPath
    ? ` Configured path: ${path.resolve(configuredPath)}.`
    : ''
  throw new Error(
    `Browser smoke requires an executable Chrome or Chromium installation.${detail} Set checks.browserSmoke.executablePath in .pi/epic.config.json.`
  )
}
