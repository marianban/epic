import type { Component, TUI } from '@earendil-works/pi-tui'

function childComponents(component: Component): readonly Component[] {
  const children = (component as Component & { children?: Component[] }).children
  return Array.isArray(children) ? children : []
}

/** Find the widget without rendering it, which would recursively measure itself. */
function findPath(component: Component, widget: Component): Component[] | undefined {
  if (component === widget) return [component]
  for (const child of childComponents(component)) {
    const path = findPath(child, widget)
    if (path !== undefined) return [component, ...path]
  }
  return undefined
}

/** Pi 1.4 mounts the transcript first, followed by the input dock containers. */
export function availableDashboardHeight(tui: TUI, widget: Component, width: number): number {
  const dock = tui.children.slice(1)
  const path = dock.map((component) => findPath(component, widget))
    .find((candidate) => candidate !== undefined)
  if (path === undefined) {
    throw new Error('Epic dashboard is not mounted in the Pi fullscreen input dock')
  }

  // Measure siblings at every level, including the above-editor widget spacer.
  // The transcript retains the one-row minimum required by Pi's layout.
  let reserved = 1
  let siblings: readonly Component[] = dock
  for (const component of path) {
    reserved += siblings.filter((sibling) => sibling !== component)
      .reduce((height, sibling) => height + sibling.render(width).length, 0)
    siblings = childComponents(component)
  }
  return Math.max(1, tui.terminal.rows - reserved)
}
