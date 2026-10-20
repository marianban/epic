import { stripVTControlCharacters } from 'node:util'
import type { Finding } from './types.ts'

export function normalizeFindings(
  source: string,
  stdout: string,
  stderr: string,
  exitCode: number
): Finding[] {
  const combined = stripVTControlCharacters(`${stdout}\n${stderr}`).trim()
  if (!combined && exitCode === 0) return []
  const findings: Finding[] = []
  for (const rawLine of combined.split(/\r?\n/).filter(Boolean)) {
    // Successful tools commonly print progress or structured data. Only explicit
    // diagnostics are findings; complete output stays in the check artifact.
    if (
      exitCode === 0 &&
      !/\b(?:warn(?:ing)?s?|errors?)\b(?:\s*[:(]|\s+\S)|^\s*(?:npm\s+)?(?:WARN|ERROR)\b|^\s*\(!\)/i.test(
        rawLine
      )
    )
      continue
    const match = rawLine.match(/^(.*?)(?::(\d+)(?::(\d+))?)?\s*[-:]\s*(.+)$/)
    findings.push({
      source,
      severity:
        exitCode === 0 && !/\berror\b/i.test(rawLine) ? 'warning' : 'error',
      file: match?.[1]?.trim() || undefined,
      line: match?.[2] ? Number(match[2]) : undefined,
      column: match?.[3] ? Number(match[3]) : undefined,
      message: match?.[4]?.trim() || rawLine.trim(),
      raw: rawLine.trim(),
    })
  }
  return findings
}
