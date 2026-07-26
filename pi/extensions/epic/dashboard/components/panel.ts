import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'

export function framedLine(content: string, width: number, theme: Theme): string {
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

export function framedTop(
  width: number,
  title: string,
  theme: Theme
): string {
  if (width <= 0) return ''
  if (width < 3) return truncateToWidth(`╭─ ${title}`, width, '…', true)
  const innerWidth = width - 2
  const heading = `─ ${title} `
  const line = heading + '─'.repeat(Math.max(0, innerWidth - visibleWidth(heading)))
  return theme.fg('border', `╭${line}╮`)
}

export function framedBottom(width: number, theme: Theme): string {
  if (width <= 0) return ''
  if (width < 3) return truncateToWidth('╰─', width, '…', true)
  return theme.fg('border', `╰${'─'.repeat(width - 2)}╯`)
}
