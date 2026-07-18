// The house-rules editor at the foot of the nav rail (admin build only — the
// read-only console hides it). Operator taste the reviewer enforces on every
// PR, e.g. "no code comments": each rule is a sentence plus a level — block
// (violations post at P1, a merge blocker) or warn (P2, a note). Writes go
// straight to Convex (rules.add / setLevel / remove); the worker subscribes and
// injects the rules into the next review's brief.
import { useEffect, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { Gavel, X } from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { useReadOnly } from "../read-only"

type Level = "block" | "warn"

const LEVELS: { value: Level; hint: string }[] = [
  { value: "block", hint: "P1 · blocks merge" },
  { value: "warn", hint: "P2 · noted" },
]

// Level badge tones, matching the console's severity palette (block reads like
// FAILED-red, warn like AWAITING-amber).
const LEVEL_TONE: Record<Level, string> = {
  block: "border-[#f85149]/30 bg-[#f85149]/10 text-[#fca5a5]",
  warn: "border-[#e3b341]/30 bg-[#e3b341]/10 text-[#fcd34d]",
}

export function HouseRules() {
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [draftLevel, setDraftLevel] = useState<Level>("block")
  const [notice, setNotice] = useState<string | null>(null)
  const rules = useQuery(api.rules.list)
  const add = useMutation(api.rules.add)
  const setLevel = useMutation(api.rules.setLevel)
  const remove = useMutation(api.rules.remove)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  if (readOnly) return null

  const count = rules?.length ?? 0

  const submit = async () => {
    const text = draft.trim()
    if (!text) return
    const result = await add({ text, level: draftLevel })
    if (result === "added") {
      setDraft("")
      setNotice(null)
    } else {
      setNotice(
        result === "exists"
          ? "Already a rule."
          : result === "full"
            ? "Rule list is full."
            : "Rule is too long.",
      )
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="House rules"
        aria-label="House rules"
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-edge2 bg-railsel text-zinc-100"
            : "border-transparent text-zinc-500 hover:bg-railsel/60 hover:text-zinc-300",
        )}
      >
        <Gavel className="size-[18px]" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-railsel px-0.5 font-mono text-[8px] text-zinc-400">
            {count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className="absolute bottom-0 left-[calc(100%+12px)] z-50 w-[320px] rounded-[9px] border border-edge2 bg-elevated p-4 shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
            <div className="mb-1 flex items-center gap-2">
              <Gavel className="size-3.5 text-accent" />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
                House rules
              </span>
            </div>
            <p className="m-0 mb-3 text-[11.5px] leading-relaxed text-zinc-500">
              Taste the reviewer enforces on every PR. <span className="text-[#fca5a5]">block</span> violations
              post at P1 (merge blocker), <span className="text-[#fcd34d]">warn</span> at P2. Applies from the
              next review; click a badge to switch its level.
            </p>

            {rules === undefined ? (
              <p className="m-0 text-[11px] text-zinc-600">Loading…</p>
            ) : rules.length === 0 ? (
              <p className="m-0 text-[11px] leading-relaxed text-zinc-600">
                No rules yet — reviews run on the standard brief alone.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {rules.map((r) => (
                  <li key={r.id} className="group flex items-start gap-2 rounded-[5px] px-1 py-[3px]">
                    <button
                      type="button"
                      onClick={() => void setLevel({ id: r.id, level: r.level === "block" ? "warn" : "block" })}
                      title={`Switch to ${r.level === "block" ? "warn" : "block"}`}
                      className={cn(
                        "mt-px shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-[0.08em] transition-colors",
                        LEVEL_TONE[r.level],
                      )}
                    >
                      {r.level}
                    </button>
                    <span className="min-w-0 flex-1 break-words text-[11.5px] leading-snug text-zinc-300">
                      {r.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove({ id: r.id })}
                      title="Remove rule"
                      aria-label={`Remove rule: ${r.text}`}
                      className="mt-px shrink-0 text-zinc-700 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 border-t border-edge pt-3">
              <input
                type="text"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setNotice(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit()
                }}
                placeholder='Add a rule, e.g. "no code comments"'
                className="w-full rounded-[5px] border border-edge bg-inset px-2 py-[6px] font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-edge2 focus:outline-none"
              />
              <div className="mt-1.5 flex items-center gap-1">
                {LEVELS.map((l) => (
                  <button
                    key={l.value}
                    type="button"
                    onClick={() => setDraftLevel(l.value)}
                    title={l.hint}
                    className={cn(
                      "rounded border px-1.5 py-[3px] font-mono text-[9px] uppercase tracking-[0.08em] transition-colors",
                      draftLevel === l.value
                        ? LEVEL_TONE[l.value]
                        : "border-edge bg-inset text-zinc-600 hover:text-zinc-400",
                    )}
                  >
                    {l.value}
                  </button>
                ))}
                <span className="flex-1" />
                <button
                  type="button"
                  disabled={!draft.trim()}
                  onClick={() => void submit()}
                  className="rounded-[5px] border border-edge bg-inset px-2 py-[3px] font-mono text-[10px] text-zinc-400 transition-colors hover:border-edge2 hover:text-zinc-200 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
              {notice && <p className="m-0 mt-1.5 text-[10.5px] text-[#fca5a5]">{notice}</p>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
