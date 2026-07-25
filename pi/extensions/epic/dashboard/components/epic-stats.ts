import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { DashboardState } from '../state.ts'
import type { EpicDashboardState, ProgressMetric } from '../types.ts'

const COMPACT_BREAKPOINT = 80
const WIDE_BAR_WIDTH = 20
const COMPACT_BAR_WIDTH = 10

type Color = (text: string) => string

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(
      `Duration must be a finite non-negative number: ${durationMs}`
    )
  }
  const totalSeconds = Math.floor(durationMs / 1_000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return hours === 0
    ? `${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`Tokens must be a finite non-negative number: ${total}`)
  }
  if (total < 1_000) return String(total)
  if (total < 1_000_000) {
    const value = total / 1_000
    return `${value.toFixed(value < 100 ? 1 : 0).replace(/\.0$/, '')}k`
  }
  const value = total / 1_000_000
  return `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '')}M`
}

function statusColor(
  status: EpicDashboardState['status'],
  theme: Theme
): Color {
  switch (status) {
    case 'completed':
      return (text) => theme.fg('success', text)
    case 'failed':
      return (text) => theme.fg('error', text)
    case 'escalating':
    case 'review':
    case 'refinement':
      return (text) => theme.fg('warning', text)
    default:
      return (text) => theme.fg('accent', text)
  }
}

function progressBar(
  metric: ProgressMetric,
  length: number,
  theme: Theme
): string {
  if (length === 0) return ''
  const filled = Math.round((metric.percent / 100) * length)
  const completed = theme.fg('success', '█'.repeat(filled))
  const remaining = theme.fg('dim', '░'.repeat(length - filled))
  return completed + remaining
}

function progressRow(
  label: string,
  metric: ProgressMetric,
  width: number,
  preferredBarWidth: number,
  theme: Theme,
  suffix = ''
): string {
  const count = `${metric.completed} / ${metric.total}`
  const percent = `${Math.round(metric.percent)}%`
  const prefix = `${label} ${count}`
  const tail = `${percent}${suffix ? ` ${suffix}` : ''}`
  const availableBarWidth = Math.max(
    0,
    width - visibleWidth(prefix) - visibleWidth(tail) - 2
  )
  const barWidth = Math.min(preferredBarWidth, availableBarWidth)
  const bar = progressBar(metric, barWidth, theme)
  return [theme.fg('muted', prefix), bar, theme.fg('text', tail)]
    .filter((part) => part.length > 0)
    .join(' ')
}

function framedLine(content: string, width: number, theme: Theme): string {
  if (width <= 0) return ''
  if (width < 5) return truncateToWidth(content, width, '…', true)
  const innerWidth = width - 4
  return (
    theme.fg('border', '│') +
    ' ' +
    truncateToWidth(content, innerWidth, '…', true) +
    ' ' +
    theme.fg('border', '│')
  )
}

function framedTop(width: number, theme: Theme): string {
  if (width <= 0) return ''
  if (width < 3) return truncateToWidth('╭─ EPIC', width, '…', true)
  const innerWidth = width - 2
  const title = '─ EPIC '
  const line = title + '─'.repeat(Math.max(0, innerWidth - visibleWidth(title)))
  return theme.fg('border', `╭${line}╮`)
}

function framedBottom(width: number, theme: Theme): string {
  if (width <= 0) return ''
  if (width < 3) return truncateToWidth('╰─', width, '…', true)
  return theme.fg('border', `╰${'─'.repeat(width - 2)}╯`)
}

function titleLine(
  epic: EpicDashboardState,
  width: number,
  theme: Theme
): string {
  const color = statusColor(epic.status, theme)
  const status = `${epic.status === 'escalating' ? '⚠ ' : ''}${epic.status.toUpperCase()}`
  const suffix = ` ${status}`
  const nameWidth = Math.max(0, width - visibleWidth(suffix))
  const name = truncateToWidth(epic.name, nameWidth, '…')
  return theme.bold(theme.fg('text', name)) + color(suffix)
}

function attemptsLine(epic: EpicDashboardState, theme: Theme): string {
  return [
    theme.fg('muted', 'Tokens'),
    theme.fg('text', formatTokens(epic.tokens.total)),
    theme.fg('muted', 'Attempts'),
    theme.fg(
      'text',
      `${epic.attempts.implementation} impl / ${epic.attempts.repair} fix`
    ),
  ].join(' ')
}

/** Renders the epic summary shown above or below a Pi TUI view. */
export class EpicStats implements Component {
  private state: DashboardState
  private readonly theme: Theme
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(state: DashboardState, theme: Theme) {
    this.state = state
    this.theme = theme
  }

  setState(state: DashboardState): void {
    this.state = state
    this.invalidate()
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  render(width: number): string[] {
    if (width <= 0) return []
    if (this.cachedWidth === width && this.cachedLines !== undefined) {
      return this.cachedLines
    }

    const epic = this.state.epic
    const innerWidth = Math.max(0, width - 4)
    const compact = width < COMPACT_BREAKPOINT
    const lines = compact
      ? this.renderCompact(epic, innerWidth, width)
      : this.renderWide(epic, innerWidth, width)
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  private renderWide(
    epic: EpicDashboardState,
    innerWidth: number,
    width: number
  ): string[] {
    const theme = this.theme
    return [
      framedTop(width, theme),
      framedLine(titleLine(epic, innerWidth, theme), width, theme),
      framedLine(theme.fg('dim', epic.id), width, theme),
      framedLine('', width, theme),
      framedLine(
        progressRow(
          'Tasks',
          epic.tasks,
          innerWidth,
          WIDE_BAR_WIDTH,
          theme
        ),
        width,
        theme
      ),
      framedLine(
        progressRow(
          'Criteria',
          epic.criteria,
          innerWidth,
          WIDE_BAR_WIDTH,
          theme,
          `Agent time ${formatDuration(epic.agentTimeMs)}`
        ),
        width,
        theme
      ),
      framedLine(
        progressRow(
          'Checks',
          epic.checks,
          innerWidth,
          WIDE_BAR_WIDTH,
          theme
        ),
        width,
        theme
      ),
      framedLine(attemptsLine(epic, theme), width, theme),
      framedBottom(width, theme),
    ]
  }

  private renderCompact(
    epic: EpicDashboardState,
    innerWidth: number,
    width: number
  ): string[] {
    const theme = this.theme
    return [
      framedTop(width, theme),
      framedLine(titleLine(epic, innerWidth, theme), width, theme),
      framedLine(theme.fg('dim', epic.id), width, theme),
      framedLine('', width, theme),
      framedLine(
        progressRow('Tasks', epic.tasks, innerWidth, COMPACT_BAR_WIDTH, theme),
        width,
        theme
      ),
      framedLine(
        progressRow(
          'Criteria',
          epic.criteria,
          innerWidth,
          COMPACT_BAR_WIDTH,
          theme
        ),
        width,
        theme
      ),
      framedLine(
        progressRow(
          'Checks',
          epic.checks,
          innerWidth,
          COMPACT_BAR_WIDTH,
          theme
        ),
        width,
        theme
      ),
      framedLine(
        theme.fg(
          'muted',
          `Agent time ${formatDuration(epic.agentTimeMs)}`
        ),
        width,
        theme
      ),
      framedLine(attemptsLine(epic, theme), width, theme),
      framedBottom(width, theme),
    ]
  }
}
