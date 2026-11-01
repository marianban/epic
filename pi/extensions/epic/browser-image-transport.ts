import * as fs from 'node:fs/promises'
import type {
  BrowserProbe,
  BrowserProbeResponse,
} from './browser-evidence-types.ts'

/** Only runtime-owned image paths are read. No model-provided paths cross the bridge. */
export async function browserProbeResponse(
  probe: BrowserProbe
): Promise<BrowserProbeResponse> {
  const images = await Promise.all(
    probe.images.map(async (frame) => ({
      id: frame.id,
      mimeType: 'image/png' as const,
      data: (await fs.readFile(frame.path)).toString('base64'),
    }))
  )
  return { probe, images }
}
