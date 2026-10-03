import * as path from 'node:path'
import type { CheckSuiteName, EpicDomainState } from './types.ts'

function artifactToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label} artifact token: ${value}`)
  }
  return value
}

function taskOrdinal(state: EpicDomainState): string {
  return String(state.currentTaskIndex + 1).padStart(3, '0')
}

export function currentTaskArtifactPath(state: EpicDomainState): string {
  return path.join(
    state.repositoryRoot,
    '.pi',
    'epics',
    'runs',
    state.epicId,
    'tasks',
    `task-${taskOrdinal(state)}.md`
  )
}

export function implementationDiffArtifactPath(
  state: EpicDomainState,
  implementationAttempt: number,
  artifactId: string
): string {
  return path.join(
    'diffs',
    `task-${taskOrdinal(state)}-implementation-${String(implementationAttempt).padStart(3, '0')}-${artifactToken(artifactId, 'diff')}.json`
  )
}

export function checkResultArtifactPath(
  state: EpicDomainState,
  suite: CheckSuiteName,
  artifactId: string
): string {
  return path.join(
    'checks',
    `task-${taskOrdinal(state)}-${suite}-${artifactToken(artifactId, 'check')}.json`
  )
}

export function reviewResultArtifactPath(
  state: EpicDomainState,
  semanticAttempt: number,
  artifactId: string
): string {
  return path.join(
    'reviews',
    `task-${taskOrdinal(state)}-review-${String(semanticAttempt + 1).padStart(3, '0')}-${artifactToken(artifactId, 'review')}.json`
  )
}

export function browserSmokeResultArtifactPath(
  state: EpicDomainState,
  artifactId: string
): string {
  return path.join(
    'checks',
    `task-${taskOrdinal(state)}-browser-smoke-${artifactToken(artifactId, 'browser smoke')}.json`
  )
}
