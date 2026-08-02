export function formatDuration(durationMs: number): string {
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
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours === 0
    ? `${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}
