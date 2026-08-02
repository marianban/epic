import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'

export interface PanelStyle {
  readonly borderColor?: 'border' | 'borderAccent' | 'borderMuted'
  readonly backgroundColor?:
    | 'selectedBg'
    | 'userMessageBg'
    | 'customMessageBg'
    | 'toolPendingBg'
    | 'toolSuccessBg'
    | 'toolErrorBg'
}

function styleLine(line: string, theme: Theme, style: PanelStyle): string {
  return style.backgroundColor === undefined
    ? line
    : theme.bg(style.backgroundColor, line)
}

function border(text: string, theme: Theme, style: PanelStyle): string {
  return theme.fg(style.borderColor ?? 'border', text)
}

export function framedLine(
  content: string,
  width: number,
  theme: Theme,
  style: PanelStyle = {}
): string {
  if (width <= 0) return ''
  if (width < 5) return truncateToWidth(content, width, '…', true)
  const innerWidth = width - 4
  return styleLine(
    border('│', theme, style) +
    ' ' +
    truncateToWidth(content, innerWidth, '…', true) +
    ' ' +
    border('│', theme, style),
    theme,
    style
  )
}

export function framedTop(
  width: number,
  title: string,
  theme: Theme,
  style: PanelStyle = {}
): string {
  if (width <= 0) return ''
  if (width < 3) return truncateToWidth(`╭─ ${title}`, width, '…', true)
  const innerWidth = width - 2
  const heading = `─ ${title} `
  const line =
    heading + '─'.repeat(Math.max(0, innerWidth - visibleWidth(heading)))
  return styleLine(
    theme.fg(style.borderColor ?? 'border', `╭${line}╮`),
    theme,
    style
  )
}

export function framedBottom(
  width: number,
  theme: Theme,
  style: PanelStyle = {}
): string {
  if (width <= 0) return ''
  if (width < 3) return truncateToWidth('╰─', width, '…', true)
  return styleLine(
    theme.fg(
      style.borderColor ?? 'border',
      `╰${'─'.repeat(width - 2)}╯`
    ),
    theme,
    style
  )
}
