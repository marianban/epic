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

function progressGrid(
  rows: readonly { label: string; metric: ProgressMetric }[],
  width: number,
  preferredBarWidth: number,
  theme: Theme,
  agentTime?: string
): string[] {
  const labelWidth = Math.max(...rows.map(({ label }) => visibleWidth(label)))
  const countWidth = Math.max(
    ...rows.map(({ metric }) =>
      visibleWidth(`${metric.completed} / ${metric.total}`)
    )
  )
  const percentWidth = Math.max(
    ...rows.map(({ metric }) => visibleWidth(`${Math.round(metric.percent)}%`))
  )
  const agentTimeWidth = agentTime === undefined ? 0 : visibleWidth(agentTime)
  const fixedWidth = labelWidth + countWidth + percentWidth + 3
  const reservedAgentTimeWidth =
    agentTime === undefined ? 0 : agentTimeWidth + 1
  const barWidth = Math.min(
    preferredBarWidth,
    Math.max(0, width - fixedWidth - reservedAgentTimeWidth)
  )

  return rows.map(({ label, metric }, index) => {
    const count = `${metric.completed} / ${metric.total}`
    const percent = `${Math.round(metric.percent)}%`
    const row = [
      theme.fg('muted', label.padEnd(labelWidth)),
      theme.fg('muted', count.padStart(countWidth)),
      progressBar(metric, barWidth, theme),
      theme.fg('text', percent.padStart(percentWidth)),
    ].join(' ')

    if (index !== 0 || agentTime === undefined) return row

    const gap = Math.max(1, width - visibleWidth(row) - agentTimeWidth)
    return `${row}${' '.repeat(gap)}${theme.fg('muted', agentTime)}`
  })
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
    const progressRows = progressGrid(
      [
        { label: 'Tasks', metric: epic.tasks },
        { label: 'Criteria', metric: epic.criteria },
      ],
      innerWidth,
      WIDE_BAR_WIDTH,
      theme,
      `Agent time ${formatDuration(epic.agentTimeMs)}`
    )
    return [
      framedTop(width, theme),
      framedLine(titleLine(epic, innerWidth, theme), width, theme),
      framedLine(theme.fg('dim', epic.id), width, theme),
      framedLine('', width, theme),
      ...progressRows.map((row) => framedLine(row, width, theme)),
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
    const progressRows = progressGrid(
      [
        { label: 'Tasks', metric: epic.tasks },
        { label: 'Criteria', metric: epic.criteria },
      ],
      innerWidth,
      COMPACT_BAR_WIDTH,
      theme,
      `Agent time ${formatDuration(epic.agentTimeMs)}`
    )
    return [
      framedTop(width, theme),
      framedLine(titleLine(epic, innerWidth, theme), width, theme),
      framedLine(theme.fg('dim', epic.id), width, theme),
      framedLine('', width, theme),
      ...progressRows.map((row) => framedLine(row, width, theme)),
      framedLine(attemptsLine(epic, theme), width, theme),
      framedBottom(width, theme),
    ]
  }
}
