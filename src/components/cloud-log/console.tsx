import { useEffect, useRef, useState } from "react"
import { Maximize2, X } from "lucide-react"
import { cn } from "../../lib/cn"
import { RollingTicker } from "./rolling-ticker"
import { type CloudLogLine } from "./types"

// The shell the rolling-ticker plugs into: a compact "last N" animated window
// with a header, plus an expand-to-fullscreen overlay that scrolls the whole log
// in the same ticker style. This is the component intended for production use.
export function CloudLogConsole({
  lines,
  title = "Cloud review",
  streaming = true,
  maxVisible = 5,
  bodyClassName,
  className,
}: {
  lines: CloudLogLine[]
  title?: string
  streaming?: boolean
  maxVisible?: number
  /** Sizing for the compact body — defaults to a fixed five-row viewport. */
  bodyClassName?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70",
        className,
      )}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("size-1.5 shrink-0 rounded-full", streaming ? "pulse-dot bg-sky-400" : "bg-zinc-600")} />
          <span className="truncate text-xs font-medium text-zinc-300">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="tabular-nums text-[10px] text-zinc-600">{lines.length} lines</span>
          <button
            type="button"
            title="Open full log"
            aria-label="Open full log"
            onClick={() => setOpen(true)}
            className="rounded p-0.5 text-zinc-500 transition hover:text-zinc-200"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </header>

      <div className={cn("p-3", bodyClassName ?? "h-[170px]")}>
        <RollingTicker lines={lines} maxVisible={maxVisible} streaming={streaming} />
      </div>

      {open && (
        <CloudLogFullscreen title={title} lines={lines} streaming={streaming} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

function CloudLogFullscreen({
  title,
  lines,
  streaming,
  onClose,
}: {
  title: string
  lines: CloudLogLine[]
  streaming: boolean
  onClose: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Esc closes; lock background scroll while the overlay is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  // Keep the newest line in view as the log grows.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("size-1.5 shrink-0 rounded-full", streaming ? "pulse-dot bg-sky-400" : "bg-zinc-600")} />
            <span className="truncate text-sm font-medium text-zinc-200">{title}</span>
            <span className="tabular-nums text-[11px] text-zinc-600">· {lines.length} lines</span>
          </div>
          <button
            type="button"
            title="Close"
            aria-label="Close full log"
            onClick={onClose}
            className="rounded-md border border-zinc-800 p-1 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-100"
          >
            <X className="size-4" />
          </button>
        </header>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          <RollingTicker lines={lines} maxVisible={Infinity} streaming={streaming} />
        </div>
      </div>
    </div>
  )
}
