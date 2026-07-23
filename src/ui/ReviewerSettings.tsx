// The reviewer model + effort picker at the foot of the nav rail (admin build
// only — the read-only console hides it). One popover that grows sideways out
// of the rail (width-expand, like AutoReview). The model is a segmented
// control with a sliding thumb; capability hints surface only as a floating
// tag above the hovered segment. The effort is a 4-notch drag-and-snap slider
// (low → xhigh; "max" is no longer offered — a stored "max" renders at the
// top notch until the next pick overwrites it). A pick writes straight to
// Convex (settings.set); the worker subscribes and applies it to the next
// review it starts. Until the first pick, the worker uses its own config
// default — the popover says so instead of pretending a value was chosen.
import { useEffect, useRef, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { Cpu } from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { useReadOnly } from "../read-only"
import { tip } from "./Tooltip"

type Model = "fable" | "opus" | "sonnet" | "haiku"
type Effort = "low" | "medium" | "high" | "xhigh" | "max"

// The values are the Claude CLI's own model aliases (mirrored by the Convex
// validators in convex/schema.ts — keep the two lists in sync).
const MODELS: { value: Model; label: string; hint: string }[] = [
  { value: "fable", label: "Fable 5", hint: "most capable" },
  { value: "opus", label: "Opus 4.8", hint: "thorough" },
  { value: "sonnet", label: "Sonnet 5", hint: "balanced" },
  { value: "haiku", label: "Haiku 4.5", hint: "fastest" },
]
// The picker's effort scale. "max" stays valid in the schema but is not
// offered anymore — the scale tops out at xhigh.
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"]

// What the picker shows before any row exists — mirrors the worker's shipped
// config.json default ("opus") and the CLI's default effort for it.
const FALLBACK = { model: "opus" as Model, effort: "high" as Effort }

const pct = (i: number) => (i / (EFFORTS.length - 1)) * 100
// Springy snap-settle, same curve as the mock.
const SPRING = "cubic-bezier(0.34,1.56,0.64,1)"

export function ReviewerSettings() {
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(false)
  const [hintIdx, setHintIdx] = useState<number | null>(null)
  // Free-follow ratio (0..1) while the effort thumb is being dragged.
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const settings = useQuery(api.settings.get)
  const save = useMutation(api.settings.set)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  if (readOnly) return null

  const loading = settings === undefined
  const current = settings ?? FALLBACK
  const pick = (patch: Partial<{ model: Model; effort: Effort }>) => {
    if (loading) return
    void save({ model: patch.model ?? current.model, effort: patch.effort ?? current.effort })
  }

  const modelIdx = Math.max(
    0,
    MODELS.findIndex((m) => m.value === current.model),
  )
  // A legacy "max" sits at the top notch.
  const storedIdx = EFFORTS.indexOf(current.effort)
  const effortIdx = storedIdx === -1 ? EFFORTS.length - 1 : storedIdx
  // While dragging, the fill/notches track the pointer, not the saved value.
  const nearIdx = dragRatio === null ? effortIdx : Math.round(dragRatio * (EFFORTS.length - 1))
  const thumbPct = dragRatio === null ? pct(effortIdx) : dragRatio * 100

  const ratioFromEvent = (e: React.PointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const onTrackDown = (e: React.PointerEvent) => {
    if (loading) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragRatio(ratioFromEvent(e))
  }
  const onTrackMove = (e: React.PointerEvent) => {
    if (dragRatio === null) return
    setDragRatio(ratioFromEvent(e))
  }
  const onTrackUp = (e: React.PointerEvent) => {
    if (dragRatio === null) return
    const idx = Math.round(ratioFromEvent(e) * (EFFORTS.length - 1))
    setDragRatio(null)
    pick({ effort: EFFORTS[idx] })
  }
  const onThumbKey = (e: React.KeyboardEvent) => {
    const step = (d: number) => {
      e.preventDefault()
      pick({ effort: EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, effortIdx + d))] })
    }
    if (e.key === "ArrowRight" || e.key === "ArrowUp") step(1)
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") step(-1)
    else if (e.key === "Home") step(-effortIdx)
    else if (e.key === "End") step(EFFORTS.length - 1 - effortIdx)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        {...tip("Reviewer model & effort", { place: "right" })}
        aria-label="Reviewer model & effort"
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-edge2 bg-railsel text-zinc-100"
            : "border-transparent text-zinc-500 hover:bg-railsel/60 hover:text-zinc-300",
        )}
      >
        <Cpu className="size-[18px]" />
      </button>

      {open && <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />}
      {/* Always mounted so the width transition runs both ways. The fixed-width
          inner layer keeps the content from reflowing while the width animates. */}
      <div
        className={cn(
          "absolute bottom-0 left-[calc(100%+12px)] z-50 overflow-hidden rounded-[9px] border bg-elevated py-4 shadow-[0_18px_44px_rgba(0,0,0,0.6)] transition-[width,opacity,padding] duration-200 ease-out motion-reduce:transition-none",
          open
            ? "w-[308px] border-edge2 px-4 opacity-100"
            : "pointer-events-none w-0 border-transparent px-0 opacity-0",
        )}
      >
        <div className="w-[276px]">
          <div className="mb-1 flex items-center gap-2">
            <Cpu className="size-3.5 text-accent" />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
              Reviewer
            </span>
          </div>
          <p className="m-0 mb-3 text-[11.5px] leading-relaxed text-zinc-500">
            Model and effort the worker runs reviews with. Applies from the next review.
          </p>

          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">Model</div>
          <div className="relative flex rounded-[8px] border border-edge2 bg-inset p-[3px]">
            {/* Sliding thumb — equal segments, so pure CSS math positions it. */}
            <div
              className="pointer-events-none absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/4)] rounded-[6px] border border-edgehi bg-railsel shadow-[0_1px_0_rgba(255,255,255,0.03),0_2px_8px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-[cubic-bezier(0.2,0.8,0.3,1)] motion-reduce:transition-none"
              style={{ transform: `translateX(${modelIdx * 100}%)` }}
            />
            {/* Floating capability hint above the hovered segment. */}
            <div
              role="status"
              className={cn(
                "pointer-events-none absolute bottom-[calc(100%+7px)] z-10 -translate-x-1/2 whitespace-nowrap rounded-[5px] border border-edge2 bg-inset px-2 py-[3px] font-mono text-[9.5px] tracking-[0.05em] text-zinc-500 shadow-[0_6px_16px_rgba(0,0,0,0.45)] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                hintIdx !== null
                  ? "translate-y-0 scale-100 opacity-100"
                  : "translate-y-1 scale-90 opacity-0",
              )}
              style={{ left: `calc((100% - 6px) / 4 * ${(hintIdx ?? 0) + 0.5} + 3px)` }}
            >
              {hintIdx !== null && MODELS[hintIdx].hint}
              <span className="absolute left-1/2 top-full -mt-[3px] size-[6px] -translate-x-1/2 rotate-45 border-b border-r border-edge2 bg-inset" />
            </div>
            {MODELS.map((m, i) => {
              const active = current.model === m.value
              return (
                <button
                  key={m.value}
                  type="button"
                  disabled={loading}
                  aria-label={`${m.label} — ${m.hint}`}
                  aria-pressed={active}
                  onClick={() => pick({ model: m.value })}
                  onMouseEnter={() => setHintIdx(i)}
                  onMouseLeave={() => setHintIdx(null)}
                  onFocus={() => setHintIdx(i)}
                  onBlur={() => setHintIdx(null)}
                  className={cn(
                    "relative z-[1] min-w-0 flex-1 whitespace-nowrap rounded-[6px] px-1 py-2 font-mono text-[10.5px] transition-colors disabled:opacity-50",
                    active ? "text-accent" : "text-zinc-400 hover:text-zinc-300",
                  )}
                >
                  {m.label}
                </button>
              )
            })}
          </div>

          <div className="mb-2 mt-3.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
            Effort
          </div>
          <div className="select-none px-0.5 pb-1 pt-1.5">
            <div
              ref={trackRef}
              onPointerDown={onTrackDown}
              onPointerMove={onTrackMove}
              onPointerUp={onTrackUp}
              className="relative h-[6px] cursor-pointer touch-none rounded-[3px] border border-edge2 bg-inset"
            >
              <div
                className={cn(
                  "absolute inset-y-0 left-0 rounded-[3px] bg-gradient-to-r from-accent-strong to-accent motion-reduce:transition-none",
                  dragRatio === null && "transition-[width] duration-[220ms]",
                )}
                style={{ width: `${thumbPct}%`, transitionTimingFunction: SPRING }}
              />
              {EFFORTS.map((e, i) => (
                <span
                  key={e}
                  className={cn(
                    "absolute top-1/2 z-[1] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors",
                    i <= nearIdx
                      ? "border-accent bg-accent shadow-[0_0_6px_rgba(63,185,80,0.5)]"
                      : "border-edgehi bg-inset",
                  )}
                  style={{ left: `${pct(i)}%` }}
                />
              ))}
              <div
                role="slider"
                tabIndex={loading ? -1 : 0}
                aria-label="Effort"
                aria-valuemin={1}
                aria-valuemax={EFFORTS.length}
                aria-valuenow={effortIdx + 1}
                aria-valuetext={EFFORTS[effortIdx]}
                onKeyDown={onThumbKey}
                className={cn(
                  "absolute top-1/2 z-[2] size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-zinc-100 shadow-[0_2px_8px_rgba(0,0,0,0.5)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong motion-reduce:transition-none",
                  dragRatio === null ? "cursor-grab transition-[left] duration-[220ms]" : "cursor-grabbing",
                )}
                style={{ left: `${thumbPct}%`, transitionTimingFunction: SPRING }}
              />
            </div>
            {/* Hybrid labels: MEDIUM and HIGH centered on their notch dots,
                LOW and XHIGH edge-aligned to the track's ends. */}
            <div className="relative mt-[11px] h-[13px]">
              {EFFORTS.map((e, i) => {
                const last = i === EFFORTS.length - 1
                return (
                  <button
                    key={e}
                    type="button"
                    disabled={loading}
                    onClick={() => pick({ effort: e })}
                    className={cn(
                      "absolute top-0 whitespace-nowrap font-mono text-[9.5px] uppercase tracking-[0.08em] transition-colors disabled:opacity-50",
                      i === nearIdx
                        ? "text-accent"
                        : i < nearIdx
                          ? "text-zinc-300 hover:text-zinc-200"
                          : "text-zinc-600 hover:text-zinc-400",
                    )}
                    style={
                      i === 0
                        ? { left: 0 }
                        : last
                          ? { right: 0 }
                          : { left: `${pct(i)}%`, transform: "translateX(-50%)" }
                    }
                  >
                    {e}
                  </button>
                )
              })}
            </div>
          </div>

          {settings === null && (
            <p className="m-0 mt-3 text-[10.5px] leading-relaxed text-zinc-600">
              Nothing picked yet — the worker is using its config default. Your first pick takes over.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
