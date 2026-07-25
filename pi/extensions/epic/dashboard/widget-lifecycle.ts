import type {
  ExtensionAPI,
  Theme,
} from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { truncateToWidth } from '@earendil-works/pi-tui'
import { EpicStats } from './components/epic-stats.ts'
import { loadActiveDashboardState } from './data.ts'
import type { DashboardState } from './state.ts'

export const EPIC_STATUS_WIDGET_KEY = 'epicstatus'
export const EPIC_STATUS_REFRESH_INTERVAL_MS = 1_000

type DashboardLoader = (
  repositoryRoot: string,
  now: string
) => Promise<DashboardState | undefined>

export class EpicStatusWidget implements Component {
  private readonly repositoryRoot: string
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly load: DashboardLoader
  private readonly notify: (message: string) => void
  private stats: EpicStats | undefined
  private errorMessage: string | undefined
  private notifiedError: string | undefined
  private refreshInFlight = false
  private disposed = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    repositoryRoot: string,
    tui: TUI,
    theme: Theme,
    load: DashboardLoader,
    notify: (message: string) => void,
    refreshIntervalMs: number
  ) {
    this.repositoryRoot = repositoryRoot
    this.tui = tui
    this.theme = theme
    this.load = load
    this.notify = notify
    if (!Number.isInteger(refreshIntervalMs) || refreshIntervalMs <= 0) {
      throw new Error(
        `Epic status refresh interval must be a positive integer: ${refreshIntervalMs}`
      )
    }
    this.timer = setInterval(() => {
      void this.refresh()
    }, refreshIntervalMs)
    void this.refresh()
  }

  render(width: number): string[] {
    if (this.stats !== undefined) return this.stats.render(width)
    if (width <= 0) return []

    const message =
      this.errorMessage === undefined
        ? this.theme.fg('muted', 'No active epic.')
        : this.theme.fg('error', `Epic status unavailable: ${this.errorMessage}`)
    return [truncateToWidth(message, width, '…', true)]
  }

  invalidate(): void {
    this.stats?.invalidate()
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.refreshInFlight) return
    this.refreshInFlight = true
    try {
      const next = await this.load(
        this.repositoryRoot,
        new Date().toISOString()
      )
      if (this.disposed) return

      this.errorMessage = undefined
      this.notifiedError = undefined
      if (next === undefined) {
        this.stats = undefined
      } else if (this.stats === undefined) {
        this.stats = new EpicStats(next, this.theme)
      } else {
        this.stats.setState(next)
      }
      this.invalidate()
      this.tui.requestRender()
    } catch (error) {
      if (this.disposed) return
      this.stats = undefined
      this.errorMessage = error instanceof Error ? error.message : String(error)
      if (this.notifiedError !== this.errorMessage) {
        this.notifiedError = this.errorMessage
        this.notify(`Epic status unavailable: ${this.errorMessage}`)
      }
      this.invalidate()
      this.tui.requestRender()
    } finally {
      this.refreshInFlight = false
    }
  }
}

export function registerEpicStatusWidget(
  pi: ExtensionAPI,
  refreshIntervalMs: number
): void {
  let installed = false

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return
    installed = true
    ctx.ui.setWidget(EPIC_STATUS_WIDGET_KEY, (tui, theme) =>
      new EpicStatusWidget(
        ctx.cwd,
        tui,
        theme,
        loadActiveDashboardState,
        (message) => ctx.ui.notify(message, 'error'),
        refreshIntervalMs
      )
    )
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (!installed || ctx.mode !== 'tui') return
    installed = false
    ctx.ui.setWidget(EPIC_STATUS_WIDGET_KEY, undefined)
  })
}
