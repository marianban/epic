import type { Theme } from '@earendil-works/pi-coding-agent'
import { ScrollView, truncateToWidth } from '@earendil-works/pi-tui'

export interface DashboardDocument {
  lines: string[]
  focusRow: number | undefined
}

/** Adapts ScrollView state to pi's line-rendered inline widget container. */
export class DashboardScrollViewport {
  private readonly scroll: ScrollView
  private readonly requestRender: () => void
  private readonly theme: Theme
  private revealFocus = true

  constructor(requestRender: () => void, theme: Theme) {
    this.requestRender = requestRender
    this.theme = theme
    this.scroll = new ScrollView(
      { render: () => [], invalidate: () => undefined },
      { follow: 'none', primary: false, overscroll: 'contain', scrollbar: 'hidden' }
    )
  }

  revealFocusedControl(): void {
    this.revealFocus = true
  }

  handleKey(key: string | undefined): boolean {
    switch (key) {
      case 'alt+pageUp':
        this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1))
        break
      case 'alt+pageDown':
        this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1))
        break
      case 'alt+home':
        this.scroll.scrollToStart()
        break
      case 'alt+end':
        this.scroll.scrollToEnd()
        break
      default:
        return false
    }
    this.revealFocus = false
    return true
  }

  scrollBy(lines: number): void {
    this.revealFocus = false
    this.scroll.scrollBy(lines)
  }

  render(
    width: number,
    maxHeight: number,
    renderDocument: (width: number) => DashboardDocument
  ): string[] {
    if (width <= 0 || maxHeight <= 0) return []
    const contentWidth = Math.max(1, width - 1)
    const { lines, focusRow } = renderDocument(contentWidth)
    const overflow = lines.length > maxHeight
    const height = overflow ? Math.max(1, maxHeight - 1) : maxHeight
    this.scroll.updateLayout(lines.length, height, this.requestRender)
    if (this.revealFocus && focusRow !== undefined) {
      if (focusRow < this.scroll.scrollTop) this.scroll.scrollTo(focusRow)
      else if (focusRow >= this.scroll.scrollTop + height) {
        this.scroll.scrollTo(focusRow - height + 1)
      }
    }
    this.revealFocus = false
    const start = this.scroll.scrollTop
    const visible = lines.slice(start, start + height)
    if (!overflow) return [...visible, ...Array<string>(height - visible.length).fill('')]

    const thumbSize = Math.max(1, Math.floor(height * height / lines.length))
    const thumbStart = Math.round(
      start / Math.max(1, lines.length - height) * (height - thumbSize)
    )
    const result = visible.map((line, index) => {
      if (width === 1) return truncateToWidth(line, width, '', true)
      const track = index >= thumbStart && index < thumbStart + thumbSize ? '┃' : '│'
      return `${truncateToWidth(line, contentWidth, '', true)}${this.theme.fg('muted', track)}`
    })
    if (maxHeight > 1) {
      result.push(truncateToWidth(
        this.theme.fg('muted', `${start + 1}–${start + visible.length}/${lines.length} · Wheel / Alt+PgUp/PgDn · Alt+Home/End`),
        width, '…', true
      ))
    }
    return result
  }
}
