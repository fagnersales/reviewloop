import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, XCircle, type LucideIcon } from "lucide-react"
import { type CloudLogKind, type CloudLogLine } from "./types"

/** Slice the stream down to the rendered window. `Infinity` -> the whole log. */
export function windowLines(lines: CloudLogLine[], maxVisible: number | undefined) {
  const max = maxVisible ?? Infinity
  const full = !Number.isFinite(max)
  const visible = full ? lines : lines.slice(-Math.max(1, Math.floor(max)))
  return { visible, full }
}

/** Icon + accent colour for a line's glyph. The active (newest, streaming) line
 *  always shows a spinner regardless of its kind. */
export function kindMeta(kind: CloudLogKind | undefined, active: boolean): { Icon: LucideIcon; color: string } {
  if (active) return { Icon: Loader2, color: "text-sky-300" }
  switch (kind) {
    case "done":
      return { Icon: CheckCircle2, color: "text-emerald-300" }
    case "warn":
      return { Icon: AlertTriangle, color: "text-amber-300" }
    case "error":
      return { Icon: XCircle, color: "text-red-300" }
    default:
      return { Icon: ChevronRight, color: "text-zinc-600" }
  }
}

/** "14:09:42" — a stable, tabular wall-clock stamp for a line. */
export function fmtClock(at: number | undefined): string {
  if (!at) return ""
  const d = new Date(at)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
