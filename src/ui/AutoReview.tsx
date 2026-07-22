// The inbox auto-review control, on the nav rail beside the reviewer picker
// (admin build only — the read-only console hides it). A sparkles button whose
// popover grows sideways out of the rail (width-expand, not fade) and holds the
// whole control: an Auto-review row with the on/off switch, and a 2×2 model
// grid. Deliberately prose-free. Both write straight to Convex; the worker's
// toTriage subscription turns on/off with the switch and reads the model per
// judgment spawn. The model is pickable while off — enabling sweeps the
// untriaged backlog immediately, so pick-before-enable matters — and a model
// pick alone never enables (setAutoTriage patches only what it's sent). The
// green icon + corner dot broadcast "on" even with the popover closed.
import { useEffect, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { Check, Sparkles } from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { useReadOnly } from "../read-only"

type TriageModel = "fable" | "opus" | "sonnet" | "haiku"

// The values are the Claude CLI's own model aliases (mirrored by the
// reviewerModel validator in convex/schema.ts — keep the two lists in sync).
const MODELS: { value: TriageModel; label: string; hint: string }[] = [
  { value: "fable", label: "Fable 5", hint: "most capable" },
  { value: "opus", label: "Opus 4.8", hint: "thorough" },
  { value: "sonnet", label: "Sonnet 5", hint: "balanced" },
  { value: "haiku", label: "Haiku 4.5", hint: "fastest" },
]

// What the grid shows before any pick — mirrors the worker's TRIAGE_MODEL
// fallback in worker/index.mjs.
const FALLBACK_MODEL: TriageModel = "sonnet"

export function AutoReview() {
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(false)
  const state = useQuery(api.suggestedIssues.autoTriage)
  const save = useMutation(api.suggestedIssues.setAutoTriage)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  if (readOnly) return null

  const loading = state === undefined
  const enabled = state?.enabled ?? false
  const model = state?.model ?? FALLBACK_MODEL

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={enabled ? `Auto-review on · ${model}` : "Auto-review off"}
        aria-label="Auto-review"
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-edge2 bg-railsel text-zinc-100"
            : enabled
              ? "border-transparent text-[#86efac] hover:bg-railsel/60"
              : "border-transparent text-zinc-500 hover:bg-railsel/60 hover:text-zinc-300",
        )}
      >
        <Sparkles className="size-[18px]" />
        {enabled && <span className="absolute right-2 top-1.5 size-[5px] rounded-full bg-[#86efac]" />}
      </button>

      {open && <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />}
      {/* Always mounted so the width transition runs both ways. The fixed-width
          inner layer keeps the content from reflowing while the width animates. */}
      <div
        className={cn(
          "absolute bottom-0 left-[calc(100%+12px)] z-50 overflow-hidden rounded-[9px] border bg-elevated py-3 shadow-[0_18px_44px_rgba(0,0,0,0.6)] transition-[width,opacity,padding] duration-200 ease-out motion-reduce:transition-none",
          open
            ? "w-[232px] border-edge2 px-3 opacity-100"
            : "pointer-events-none w-0 border-transparent px-0 opacity-0",
        )}
      >
        <div className="w-[206px]">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-zinc-400" />
              <span className="font-mono text-[10.5px] text-zinc-400">Auto-review</span>
            </span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void save({ enabled: !enabled })}
              role="switch"
              aria-checked={enabled}
              aria-label="Enable auto-review"
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
                enabled ? "bg-accent-strong" : "bg-edge",
              )}
            >
              <span
                className={cn(
                  "absolute left-0.5 top-0.5 size-4 rounded-full transition-transform",
                  enabled ? "translate-x-4 bg-zinc-100" : "bg-zinc-500",
                )}
              />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {MODELS.map((m) => {
              const active = model === m.value
              return (
                <button
                  key={m.value}
                  type="button"
                  disabled={loading}
                  onClick={() => void save({ model: m.value })}
                  className={cn(
                    "relative rounded-[6px] border bg-inset px-2.5 py-2 text-left transition-colors disabled:opacity-50",
                    active ? "border-accent/40" : "border-edge hover:border-edge2",
                  )}
                >
                  {active && (
                    <Check className="absolute right-1.5 top-1.5 size-[11px] text-[#86efac]" strokeWidth={2.6} />
                  )}
                  <div className={cn("font-mono text-[11px]", active ? "text-[#86efac]" : "text-zinc-300")}>
                    {m.label}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-tight text-zinc-600">{m.hint}</div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
