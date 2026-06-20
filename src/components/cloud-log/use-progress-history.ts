import { useEffect, useRef, useState } from "react"
import { type CloudLogLine } from "./types"

// Bridge from the backend's single live `progress` string to a line history.
//
// Today a `reviews` row only carries the *latest* progress line (see
// convex/schema.ts → `progress?: string`). This hook accumulates each distinct
// value the client observes over a review into an ordered `CloudLogLine[]`, so
// the cloud-log variants have a stream to animate without any backend change.
// (A future enhancement could persist the full history server-side; the variants
// don't care where the lines come from.)
export function useProgressHistory(
  progress: string | undefined | null,
  opts?: { max?: number },
): CloudLogLine[] {
  const max = opts?.max ?? 200
  const [lines, setLines] = useState<CloudLogLine[]>([])
  const seq = useRef(0)

  useEffect(() => {
    const text = (progress ?? "").trim()
    if (!text) return
    setLines((prev) => {
      // Collapse consecutive duplicates — Convex re-delivers the row on any
      // field change, not just when `progress` actually advances.
      if (prev.length > 0 && prev[prev.length - 1].text === text) return prev
      const next: CloudLogLine[] = [...prev, { id: `p${seq.current++}`, text, at: Date.now() }]
      return next.length > max ? next.slice(next.length - max) : next
    })
  }, [progress, max])

  return lines
}
