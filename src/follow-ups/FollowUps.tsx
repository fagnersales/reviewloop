// The PR-follow-ups inbox (desktop): an issue-centric flat list of every
// suggestion across all PRs → a detail pane to read and act on one. Wired to
// Convex: the console records *intent* (approve / dismiss / undo / set-label)
// and the worker does the GitHub side. Read-only (the public build) hides every
// write affordance but keeps the reader. The mobile console renders follow-ups
// via src/mobile.
import { useEffect, useMemo, useState } from "react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { ArrowUpRight, Check, Inbox, Loader2, Sparkles } from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { ReviewReport, repoShort } from "../review/kit"
import { useReadOnly } from "../read-only"
import { FilterDropdown, type FilterOption } from "../ui/FilterDropdown"
import {
  type FollowUpActions,
  FU_CAT_CHIP,
  FU_CAT_TEXT,
  FU_STATUS,
  SOURCE_LABEL,
  type SugStatus,
  type Suggestion,
  TRIAGE,
  issueUrl,
  useFollowUpActions,
} from "./kit"

const FU_FILTERS: { value: SugStatus | "all"; label: string }[] = [
  { value: "all", label: "All follow-ups" },
  { value: "suggested", label: "Suggested" },
  { value: "approved", label: "Approved" },
  { value: "opened", label: "Opened" },
  { value: "dismissed", label: "Dismissed" },
]

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
      <Loader2 className="size-4 animate-spin" />
      Loading follow-ups…
    </div>
  )
}

function FuRow({ s, selected, onSelect }: { s: Suggestion; selected: boolean; onSelect: () => void }) {
  const st = FU_STATUS[s.status]
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-[6px] border px-[11px] py-[9px] text-left transition-colors",
        selected ? "border-edge2 bg-rowsel" : "border-transparent hover:bg-white/[0.02]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", selected ? "text-zinc-100" : "text-zinc-300")}>
          {s.title}
        </span>
        {s.status !== "suggested" && (
          <span className={cn("shrink-0 font-mono text-[9.5px] font-semibold tracking-[0.06em]", st.text)}>{st.label}</span>
        )}
      </div>
      <div className="mt-[7px] flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-500">
        <span className="min-w-0 truncate">
          {repoShort(s.repo)}  #{s.sourcePrNumber}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {s.status === "suggested" && s.triage === "kept" && (
            <Sparkles className="size-2.5 text-[#86efac]" aria-label="Kept by auto-review" />
          )}
          <span className={FU_CAT_TEXT[s.category]}>{s.category}</span>
        </span>
      </div>
    </button>
  )
}

function FuDetail({ s, actions }: { s: Suggestion; actions: FollowUpActions }) {
  const readOnly = useReadOnly()
  const st = FU_STATUS[s.status]
  const chip = FU_CAT_CHIP[s.category]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-[18px] py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded border px-2 py-[3px] font-mono text-[10px]", chip.text, chip.bg, chip.border)}>
            {s.category}
          </span>
          <span className="font-mono text-[10px] text-zinc-500">{SOURCE_LABEL[s.source]}</span>
          {s.status !== "suggested" && (
            <span className={cn("rounded border px-2 py-[3px] font-mono text-[10px] font-medium", st.text, st.bg, st.border)}>
              {st.label}
            </span>
          )}
        </div>
        <h2 className="mt-3 text-[17px] font-semibold leading-snug text-zinc-100">{s.title}</h2>
        <div className="mt-[9px] font-mono text-[11px] text-zinc-500">
          {s.repo}  #{s.sourcePrNumber}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        <ReviewReport report={s.body} />

        {s.files.length > 0 && (
          <>
            <div className="mb-2.5 mt-4 font-mono text-[9.5px] uppercase tracking-[0.14em] text-zinc-600">Files to touch</div>
            <div className="flex flex-wrap gap-[7px]">
              {s.files.map((f) => (
                <span key={f} className="rounded border border-edge bg-inset px-2.5 py-1 font-mono text-[11px] text-zinc-400">
                  {f}
                </span>
              ))}
            </div>
          </>
        )}

        <div className="my-4 h-px bg-line" />

        {/* auto-triage note — the agent's verdict on a row still awaiting the human */}
        {s.status === "suggested" && s.triage === "triaging" && (
          <div className="mb-3 inline-flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="size-3.5 animate-spin" />
            Auto-review is deciding…
          </div>
        )}
        {s.status === "suggested" && s.triage === "kept" && s.triageReason && (
          <div className="mb-3 flex items-start gap-2 rounded border border-[#3fb950]/25 bg-[#3fb950]/[0.06] px-3 py-2 text-xs leading-relaxed text-[#86efac]">
            <Sparkles className="mt-px size-3.5 shrink-0" />
            <span>Auto-review kept this — {s.triageReason}</span>
          </div>
        )}

        {/* action area — gated by status, hidden on the read-only public build */}
        {s.status === "suggested" &&
          (readOnly ? (
            <span className="text-xs text-zinc-600">Awaiting a decision</span>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <span className="text-xs text-zinc-500">Awaiting your decision</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => actions.dismiss(s)}
                  className="rounded border border-edge2 px-3.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-edgehi hover:text-zinc-200"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={() => actions.open(s)}
                  className="inline-flex items-center gap-1.5 rounded border border-accent-strong bg-accent px-3.5 py-1.5 text-xs font-medium text-[#08160c] transition-colors hover:bg-accent-strong"
                >
                  <Check className="size-3.5" strokeWidth={2.4} />
                  Open it
                </button>
              </div>
            </div>
          ))}

        {s.status === "approved" && (
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <span className="inline-flex items-center gap-2 text-xs text-[#86efac]">
              <Loader2 className="size-3.5 animate-spin" />
              Queued — the worker will file it on GitHub
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => actions.undo(s)}
                className="rounded border border-edge2 px-3.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-edgehi hover:text-zinc-200"
              >
                Undo
              </button>
            )}
          </div>
        )}

        {s.status === "opened" && (
          <>
            {s.issueNumber != null && (
              <a
                href={issueUrl(s.repo, s.issueNumber)}
                target="_blank"
                rel="noreferrer"
                className="mb-3 inline-flex items-center gap-2 text-xs text-[#7dd3fc] hover:underline"
              >
                <ArrowUpRight className="size-3.5" />
                Issue #{s.issueNumber} filed on GitHub
              </a>
            )}
            <div className="mb-2.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-zinc-600">Triage label</div>
            <div className="flex flex-wrap items-center gap-[7px]">
              {TRIAGE.map((t) => {
                const active = s.label === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={readOnly}
                    onClick={() => !readOnly && actions.setLabel(s, t.id)}
                    className={cn(
                      "rounded border px-2.5 py-[5px] font-mono text-[10px] transition-colors",
                      active
                        ? cn("bg-white/[0.05]", t.text, t.border)
                        : "border-line2 bg-[#0d0d0f] text-zinc-600",
                      !readOnly && !active && "hover:text-zinc-400",
                    )}
                  >
                    {t.id}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {s.status === "dismissed" && (
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <span className="text-xs text-zinc-600">
              {s.triage === "dropped" && s.triageReason
                ? `Dropped by auto-review — ${s.triageReason}`
                : "Dismissed — kept as history, never opened"}
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => actions.undo(s)}
                className="rounded border border-edge2 px-3.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-edgehi hover:text-zinc-200"
              >
                Restore
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function FuEmptyDetail() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-zinc-600">
      Select a follow-up to review the proposal.
    </div>
  )
}

// ── desktop: two-pane ─────────────────────────────────────────────────────────
export function FollowUpsDesktop() {
  const suggestions = useQuery(api.suggestedIssues.inbox)
  const actions = useFollowUpActions()
  const [filter, setFilter] = useState<SugStatus | "all">("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const items = useMemo(() => suggestions ?? [], [suggestions])
  const shown = useMemo(
    () => (filter === "all" ? items : items.filter((s) => s.status === filter)),
    [items, filter],
  )

  const options = useMemo<FilterOption<SugStatus | "all">[]>(
    () =>
      FU_FILTERS.map((f) => ({
        value: f.value,
        label: f.label,
        count: f.value === "all" ? items.length : items.filter((s) => s.status === f.value).length,
      })),
    [items],
  )

  // Land on the first follow-up in the current filter so the pane is never empty;
  // keep the user's pick stable as live data streams in, but drop one that left.
  useEffect(() => {
    if (shown.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !shown.some((s) => s._id === selectedId)) setSelectedId(shown[0]._id)
  }, [shown, selectedId])

  const selected = shown.find((s) => s._id === selectedId) ?? null

  if (suggestions === undefined) {
    return <Loading />
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-4 px-5 py-[18px]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line2 bg-panel">
        <div className="flex shrink-0 items-center border-b border-line px-2.5 py-2">
          <FilterDropdown
            icon={<Inbox className="size-3.5" />}
            heading="Filter by status"
            options={options}
            value={filter}
            onChange={setFilter}
          />
        </div>
        <div className="flex shrink-0 items-center gap-[7px] px-3 pb-1.5 pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
          <Inbox className="size-3" />
          Follow-ups
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
          <div className="flex flex-col gap-[5px]">
            {shown.map((s) => (
              <FuRow key={s._id} s={s} selected={s._id === selectedId} onSelect={() => setSelectedId(s._id)} />
            ))}
            {shown.length === 0 && (
              <div className="rounded-md border border-dashed border-edge p-[18px] text-center text-xs text-zinc-600">
                No follow-ups in this view.
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line2 bg-panel">
        {selected ? <FuDetail s={selected} actions={actions} /> : <FuEmptyDetail />}
      </section>
    </div>
  )
}
