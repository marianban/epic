import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  CheckDefinition,
  CheckResult,
  CheckSuiteName,
  CheckSuiteResult,
  FallowDelta,
  Finding,
  EpicDomainState,
  ResolvedEpicConfiguration,
} from './types.ts'
import { packageInstallCommand } from './prerequisites.ts'
import { assertRepositoryPath, redactSecrets } from './tools.ts'
import { logEpic } from './logger.ts'


interface PackageJson {
  scripts?: Record<string, string>
}

async function packageScripts(root: string): Promise<Record<string, string>> {
  try {
    return (
      (
        JSON.parse(
          await fs.readFile(path.join(root, 'package.json'), 'utf8')
        ) as PackageJson
      ).scripts ?? {}
    )
  } catch {
    return {}
  }
}

function commandForScript(
  scripts: Record<string, string>,
  name: string,
  suffix = ''
): string | undefined {
  return scripts[name] ? `npm run ${name}${suffix}` : undefined
}

function checkNameForCommand(
  suite: CheckSuiteName,
  command: string,
  index: number
): string {
  const normalized = command.trim()
  if (/^git\s+diff\s+--check$/i.test(normalized)) return 'diff-check'
  if (
    /\b(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install)\b/i.test(
      normalized
    )
  )
    return 'install'
  if (/\bnpm\s+run\s+typecheck\b/i.test(normalized)) return 'typecheck'
  if (/\bnpm\s+run\s+lint\b/i.test(normalized)) return 'lint'
  if (/\bnpm\s+(?:run\s+)?test\b/i.test(normalized))
    return suite === 'fast' ? 'focused-tests' : 'tests'
  if (/\bnpm\s+run\s+build\b/i.test(normalized)) return 'build'
  if (/\bfallow\b/i.test(normalized)) return 'fallow'
  return `${suite}-${index + 1}`
}

function looksLikeExecutableVerification(command: string): boolean {
  return /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:git|npm|pnpm|yarn|fallow|npx\s+fallow)\b/i.test(
    command.trim()
  )
}

export function stableCheckNamesForVerification(command: string): string[] {
  if (!looksLikeExecutableVerification(command)) return []
  const names = new Set<string>()
  for (const suite of ['fast', 'full'] as const) {
    const name = checkNameForCommand(suite, command, 0)
    if (name !== `${suite}-1`) names.add(name)
  }
  return [...names]
}

async function hasPackageManifest(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, 'package.json'))
    return true
  } catch {
    return false
  }
}

async function packageInstallCheck(
  root: string
): Promise<CheckDefinition | undefined> {
  if (!(await hasPackageManifest(root))) return undefined
  return {
    name: 'install',
    command: await packageInstallCommand(root),
    required: true,
  }
}

async function resolveCheckDefinitions(
  root: string,
  suite: CheckSuiteName,
  configuration: ResolvedEpicConfiguration
): Promise<CheckDefinition[]> {
  const scripts = await packageScripts(root)
  const configured = configuration.checks[suite]
  if (configured?.length)
    return configured.map((command, index) => ({
      name: checkNameForCommand(suite, command, index),
      command,
      required: true,
    }))
  const definitions: CheckDefinition[] = []
  if (suite === 'fast' || suite === 'final')
    definitions.push({
      name: 'diff-check',
      command: 'git diff --check',
      required: true,
    })
  if (suite === 'fast') {
    const typecheck = commandForScript(scripts, 'typecheck')
    const lint = commandForScript(scripts, 'lint')
    const focused =
      configuration.checks.focusedTests ??
      commandForScript(scripts, 'test', ' -- --run')
    if (typecheck)
      definitions.push({
        name: 'typecheck',
        command: typecheck,
        required: true,
      })
    if (lint) definitions.push({ name: 'lint', command: lint, required: true })
    if (focused)
      definitions.push({
        name: 'focused-tests',
        command: focused,
        required: true,
      })
  }
  if (suite === 'full' || suite === 'final') {
    const tests = commandForScript(scripts, 'test', ' -- --run')
    const build = commandForScript(scripts, 'build')
    if (tests)
      definitions.push({ name: 'tests', command: tests, required: true })
    if (build)
      definitions.push({ name: 'build', command: build, required: true })
    if (configuration.checks.fallow)
      definitions.push({
        name: 'fallow',
        command: configuration.checks.fallow,
        required: true,
      })
  }
  if (suite === 'fast' || suite === 'full') {
    const install = await packageInstallCheck(root)
    if (install) definitions.push(install)
  }
  return definitions
}

export async function resolveAvailableCheckNames(
  root: string,
  configuration: ResolvedEpicConfiguration,
  suites: readonly CheckSuiteName[] = ['fast', 'full']
): Promise<string[]> {
  const definitions = (
    await Promise.all(
      suites.map((suite) =>
        resolveCheckDefinitions(root, suite, configuration)
      )
    )
  ).flat()
  return [...new Set(definitions.map((definition) => definition.name))].sort()
}

async function resolveFinalCheckDefinitions(
  root: string,
  state: EpicDomainState,
  configuration: ResolvedEpicConfiguration
): Promise<CheckDefinition[]> {
  const definitions = await resolveCheckDefinitions(root, 'final', configuration)
  const deferredNames = new Set(
    state.tasks?.flatMap((task) => task.deferredChecks) ?? []
  )
  if (!deferredNames.size) return definitions

  const candidates = [
    ...(await resolveCheckDefinitions(root, 'fast', configuration)),
    ...(await resolveCheckDefinitions(root, 'full', configuration)),
  ]
  for (const name of deferredNames) {
    if (definitions.some((definition) => definition.name === name)) continue
    const candidate = candidates.find((definition) => definition.name === name)
    if (!candidate)
      throw new Error(
        `Deferred check ${name} is unavailable during final verification.`
      )
    definitions.push({ ...candidate, required: true })
  }
  return definitions
}

function taskCheckPolicy(
  state: EpicDomainState,
  suite: CheckSuiteName
): EpicTaskCheckPolicy | undefined {
  if (suite === 'final') return undefined
  const task = state.tasks?.[state.currentTaskIndex]
  if (!task) return undefined
  return {
    requiredChecks: task.requiredChecks,
    deferredChecks: task.deferredChecks,
    reason: task.reason,
  }
}

interface EpicTaskCheckPolicy {
  requiredChecks: string[]
  deferredChecks: string[]
  reason: string
}

function normalizeFindings(
  source: string,
  stdout: string,
  stderr: string,
  exitCode: number
): Finding[] {
  const combined = `${stdout}\n${stderr}`.trim()
  if (!combined && exitCode === 0) return []
  const findings: Finding[] = []
  for (const rawLine of combined.split(/\r?\n/).filter(Boolean)) {
    const match = rawLine.match(/^(.*?)(?::(\d+)(?::(\d+))?)?\s*[-:]\s*(.+)$/)
    findings.push({
      source,
      severity: exitCode === 0 ? 'warning' : 'error',
      file: match?.[1]?.trim() || undefined,
      line: match?.[2] ? Number(match[2]) : undefined,
      column: match?.[3] ? Number(match[3]) : undefined,
      message: match?.[4]?.trim() || rawLine.trim(),
      raw: rawLine.trim(),
    })
  }
  return findings
}

function findingKey(finding: Finding): string {
  return [
    finding.rule ?? '',
    finding.file ?? '',
    finding.line ?? '',
    finding.column ?? '',
    finding.message,
  ]
    .join('|')
    .toLowerCase()
}

function splitFindingsByBaseline(
  findings: Finding[],
  baseline: Finding[]
): { introduced: Finding[]; preExisting: Finding[] } {
  const baselineKeys = new Set(baseline.map(findingKey))
  const preExisting = findings
    .filter((finding) => baselineKeys.has(findingKey(finding)))
    .map((finding) => ({ ...finding, introduced: false }))
  const introduced = findings
    .filter((finding) => !baselineKeys.has(findingKey(finding)))
    .map((finding) => ({ ...finding, introduced: true }))
  return { introduced, preExisting }
}

export function normalizeFallowDelta(
  output: string,
  baseline: Finding[] = []
): FallowDelta {
  try {
    const parsed = JSON.parse(output) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const toFindings = (
        value: unknown,
        severity: Finding['severity']
      ): Finding[] =>
        Array.isArray(value)
          ? value.map((item) => ({
              source: 'fallow',
              severity,
              message: typeof item === 'string' ? item : JSON.stringify(item),
            }))
          : []
      const introduced = toFindings(record.introduced, 'error')
      const preExisting = toFindings(record.preExisting, 'warning')
      const resolved = toFindings(record.resolved, 'info')
      if (introduced.length || preExisting.length || resolved.length)
        return { introduced, preExisting, resolved }
    }
  } catch {
    /* fall back to line normalization */
  }
  const findings = normalizeFindings(
    'fallow',
    output,
    '',
    output.trim() ? 1 : 0
  )
  const split = splitFindingsByBaseline(findings, baseline)
  return {
    introduced: split.introduced,
    preExisting: split.preExisting,
    resolved: [],
  }
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, CI: '1' },
    })
    let stdout = ''
    let stderr = ''
    let outputTruncated = false
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString()
      const current = target === 'stdout' ? stdout : stderr
      if (current.length < maxOutputBytes) {
        const next = current + text
        if (target === 'stdout') stdout = next.slice(0, maxOutputBytes)
        else stderr = next.slice(0, maxOutputBytes)
        if (next.length > maxOutputBytes) outputTruncated = true
      } else outputTruncated = true
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    let finished = false
    const finish = (exitCode: number, timedOut = false) => {
      if (finished) return
      finished = true
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut: timedOut || outputTruncated,
      })
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(124, true)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      finish(127)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code ?? 1)
    })
  })
}

export async function runCheckSuite(
  suite: CheckSuiteName,
  state: EpicDomainState,
  timestamp: string,
  configuration: ResolvedEpicConfiguration
): Promise<CheckSuiteResult> {
  const policy = taskCheckPolicy(state, suite)
  const resolvedDefinitions =
    suite === 'final'
      ? await resolveFinalCheckDefinitions(state.repositoryRoot, state, configuration)
      : await resolveCheckDefinitions(state.repositoryRoot, suite, configuration)
  if (policy) {
    const otherSuite = suite === 'fast' ? 'full' : 'fast'
    const otherDefinitions = await resolveCheckDefinitions(
      state.repositoryRoot,
      otherSuite, configuration
    )
    const availableNames = new Set(
      [...resolvedDefinitions, ...otherDefinitions].map(
        (definition) => definition.name
      )
    )
    const missingRequired = policy.requiredChecks.filter(
      (name) => !availableNames.has(name)
    )
    if (missingRequired.length)
      throw new Error(
        `Task ${state.tasks?.[state.currentTaskIndex]?.id ?? state.currentTaskIndex} requires unavailable check(s): ${missingRequired.join(', ')}.`
      )
  }
  const definitions = resolvedDefinitions.map((definition) => {
    if (!policy) return definition
    const required = policy.requiredChecks.includes(definition.name)
    const deferred = policy.deferredChecks.includes(definition.name)
    const skipped = !required
    return {
      ...definition,
      required,
      skipped,
      skipReason: skipped
        ? deferred
          ? policy.reason
          : 'Not required by task check policy.'
        : undefined,
    }
  })
  const timeoutMs = configuration.commandTimeoutMs
  const maxOutputBytes = configuration.maxOutputBytes
  const checks: CheckResult[] = []
  for (const definition of definitions) {
    if (definition.skipped) {
      const check: CheckResult = {
        name: definition.name,
        command: definition.command,
        passed: true,
        required: false,
        exitCode: 0,
        durationMs: 0,
        stdoutPreview: '',
        stderrPreview: '',
        findings: [],
        outputTruncated: false,
        skipped: true,
        skipReason: definition.skipReason,
      }
      checks.push(check)
      await logEpic(state, timestamp, 'info', 'Check skipped', {
        suite,
        ...check,
      })
      continue
    }
    await logEpic(state, timestamp, 'info', 'Check started', {
      suite,
      name: definition.name,
      command: definition.command,
    })
    const result = await runShell(
      definition.command,
      state.repositoryRoot,
      definition.timeoutMs ?? timeoutMs,
      maxOutputBytes
    )
    const baseline: Finding[] = []
    if (definition.name === 'fallow' && configuration.checks.fallowBaseline) {
      try {
        const baselinePath = assertRepositoryPath(
          state.repositoryRoot,
          configuration.checks.fallowBaseline,
          true
        )
        baseline.push(
          ...(JSON.parse(await fs.readFile(baselinePath, 'utf8')) as Finding[])
        )
      } catch {
        /* baseline is optional */
      }
    }
    const fallow =
      definition.name === 'fallow'
        ? normalizeFallowDelta(result.stdout, baseline)
        : undefined
    const findings = fallow
      ? [...fallow.introduced, ...fallow.preExisting]
      : normalizeFindings(
          definition.name,
          result.stdout,
          result.stderr,
          result.exitCode
        )
    const check = {
      name: definition.name,
      command: definition.command,
      passed:
        result.exitCode === 0 && (!fallow || fallow.introduced.length === 0),
      required: definition.required,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutPreview: redactSecrets(result.stdout),
      stderrPreview: redactSecrets(result.stderr),
      findings,
      outputTruncated: result.timedOut,
    }
    checks.push(check)
    await logEpic(
      state,
      timestamp,
      check.passed ? 'info' : 'error',
      'Check finished',
      { suite, ...check }
    )
  }
  const allFindings = checks.flatMap((check) => check.findings)
  const requiredChecks = checks.filter((check) => check.required)
  return {
    suite,
    passed: requiredChecks.every((check) => check.passed),
    checks,
    introducedFindings: allFindings.filter(
      (finding) => finding.introduced !== false
    ),
    preExistingFindings: allFindings.filter(
      (finding) => finding.introduced === false
    ),
    deferredChecks: policy
      ? checks
          .filter(
            (check) =>
              check.skipped && policy.deferredChecks.includes(check.name)
          )
          .map((check) => check.name)
      : [],
  }
}
