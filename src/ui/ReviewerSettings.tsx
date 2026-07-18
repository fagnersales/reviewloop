// The reviewer model + effort picker at the foot of the nav rail (admin build
// only — the read-only console hides it). One popover, two option groups: which
// Claude model the review worker runs (`claude --model`) and at what reasoning
// effort (`--effort`). A pick writes straight to Convex (settings.set); the
// worker subscribes and applies it to the next review it starts. Until the
// first pick, the worker uses its own config default — the popover says so
// instead of pretending a value was chosen.
import { useEffect, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { Check, Cpu } from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { useReadOnly } from "../read-only"

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
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"]

// What the picker shows before any row exists — mirrors the worker's shipped
// config.json default ("opus") and the CLI's default effort for it.
const FALLBACK = { model: "opus" as Model, effort: "high" as Effort }

export function ReviewerSettings() {
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(false)
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

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Reviewer model & effort"
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

      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className="absolute bottom-0 left-[calc(100%+12px)] z-50 w-[268px] rounded-[9px] border border-edge2 bg-elevated p-4 shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
            <div className="mb-1 flex items-center gap-2">
              <Cpu className="size-3.5 text-accent" />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
                Reviewer
              </span>
            </div>
            <p className="m-0 mb-3 text-[11.5px] leading-relaxed text-zinc-500">
              Model and effort the worker runs reviews with. Applies from the next review.
            </p>

            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">Model</div>
            <div className="flex flex-col gap-0.5">
              {MODELS.map((m) => {
                const active = current.model === m.value
                return (
                  <button
                    key={m.value}
                    type="button"
                    disabled={loading}
                    onClick={() => pick({ model: m.value })}
                    className={cn(
                      "flex w-full items-center gap-[9px] rounded-[5px] px-[9px] py-[7px] text-left font-mono text-xs transition-colors disabled:opacity-50",
                      active ? "bg-railsel text-zinc-100" : "text-zinc-400 hover:text-zinc-200",
                    )}
                  >
                    <span className="flex w-3.5 justify-center text-accent">
                      {active && <Check className="size-3" strokeWidth={2.4} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    <span className="text-[10px] text-zinc-600">{m.hint}</span>
                  </button>
                )
              })}
            </div>

            <div className="mb-1.5 mt-3.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
              Effort
            </div>
            <div className="grid grid-cols-5 gap-1">
              {EFFORTS.map((e) => {
                const active = current.effort === e
                return (
                  <button
                    key={e}
                    type="button"
                    disabled={loading}
                    onClick={() => pick({ effort: e })}
                    className={cn(
                      "rounded-[5px] border px-0 py-[6px] text-center font-mono text-[10px] transition-colors disabled:opacity-50",
                      active
                        ? "border-edgehi bg-railsel text-zinc-100"
                        : "border-edge bg-inset text-zinc-500 hover:border-edge2 hover:text-zinc-300",
                    )}
                  >
                    {e}
                  </button>
                )
              })}
            </div>

            {settings === null && (
              <p className="m-0 mt-3 text-[10.5px] leading-relaxed text-zinc-600">
                Nothing picked yet — the worker is using its config default. Your first pick takes over.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
