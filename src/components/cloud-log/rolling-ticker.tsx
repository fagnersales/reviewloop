import { cn } from "../../lib/cn"
import { fmtClock, kindMeta, windowLines } from "./shared"
import { type CloudLogProps } from "./types"

const DOT: Record<string, string> = {
  done: "bg-emerald-400",
  warn: "bg-amber-400",
  error: "bg-red-400",
  info: "bg-zinc-600",
}

// Rolling Ticker — a departure-board / odometer view of the live review log.
// Rows roll up one notch as each new line lands (the entering row expands from
// zero height while the rows above slide out of the clipped window).
//
// Big blocks of text are handled per surface:
//   • compact window  — clamped to 2 lines, so the odometer keeps its rhythm.
//   • fullscreen ("full") — wrapped to full text, so the whole finding is readable.
export function RollingTicker({ lines, maxVisible = Infinity, streaming = true }: CloudLogProps) {
  const { visible, full } = windowLines(lines, maxVisible)

  return (
    <div
      className={cn(
        "font-mono",
        // compact: a fixed, clipped window the rows roll within — borderless, so
        // the surrounding card is the only frame (no card-in-a-card).
        // full: its own bordered surface, natural height so the parent scrolls.
        full ? "rounded-lg border border-zinc-800 bg-zinc-950/80 p-1" : "relative h-full overflow-hidden",
      )}
    >
      {/* Top fade: the oldest row dissolves into history at the top edge instead
          of a hard cut (the Vercel/v0 log look). Compact window only. */}
      {!full && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-zinc-950 to-transparent" />
      )}
      <div className={cn("flex flex-col", !full && "h-full justify-end")}>
        {visible.map((line, i) => {
          const depth = visible.length - 1 - i // 0 = newest
          const active = depth === 0 && streaming && !full
          const dot = DOT[active ? "info" : (line.kind ?? "info")]
          const { color } = kindMeta(line.kind, false)
          return (
            <div
              key={line.id}
              className={cn(
                "flex min-h-7 shrink-0 items-start gap-2.5 overflow-hidden border-b border-zinc-900/80 px-2.5 py-1 last:border-b-0",
                !full && depth === 0 && "cl-roll",
              )}
            >
              {/* Timestamp + dot are boxed to the first line's height (h-5 ==
                  leading-5) and centred within it, so on a wrapped row they pin
                  to the first line (top) rather than the middle of the block. */}
              <span className="flex h-5 shrink-0 select-none items-center tabular-nums text-[10px] text-zinc-600">
                {fmtClock(line.at)}
              </span>
              <span className="flex h-5 shrink-0 items-center">
                <span className={cn("size-1.5 rounded-full", active ? "pulse-dot bg-sky-400" : dot)} />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 break-words text-[12px] leading-5",
                  full ? "" : "line-clamp-2",
                  // Colour lives on the outer span for plain rows. For the active
                  // row the colour comes from the shimmer gradient on the inner
                  // span — keeping `line-clamp` (-webkit-box) and `background-clip:
                  // text` on separate elements avoids the WebKit combo that can
                  // render clipped+shimmered text invisible.
                  !active && (line.kind && line.kind !== "info" ? color : "text-zinc-400"),
                )}
              >
                {active ? <span className="cl-shimmer font-medium">{line.text}</span> : line.text}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
