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
  WorkflowConfig,
  WorkflowState,
} from './types.ts'
import { assertRepositoryPath, readConfig, redactSecrets } from './tools.ts'
import { logWorkflow } from './logger.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 20_000

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

async function resolveCheckDefinitions(
  root: string,
  suite: CheckSuiteName
): Promise<CheckDefinition[]> {
  const config = (await readConfig(root)) as WorkflowConfig
  const scripts = await packageScripts(root)
  const configured = config.checks?.[suite]
  if (configured?.length)
    return configured.map((command, index) => ({
      name: /\bfallow\b/i.test(command) ? 'fallow' : `${suite}-${index + 1}`,
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
      config.checks?.focusedTests ??
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
    if (config.checks?.fallow)
      definitions.push({
        name: 'fallow',
        command: config.checks.fallow,
        required: true,
      })
  }
  return definitions
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
  state: WorkflowState
): Promise<CheckSuiteResult> {
  const config = (await readConfig(state.repositoryRoot)) as WorkflowConfig
  const definitions = await resolveCheckDefinitions(state.repositoryRoot, suite)
  const timeoutMs = config.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const checks: CheckResult[] = []
  for (const definition of definitions) {
    await logWorkflow(state, 'info', 'Check started', {
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
    if (definition.name === 'fallow' && config.checks?.fallowBaseline) {
      try {
        const baselinePath = assertRepositoryPath(
          state.repositoryRoot,
          config.checks.fallowBaseline,
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
    await logWorkflow(
      state,
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
  }
}
