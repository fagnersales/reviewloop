// The autonomous-solver view (desktop): an activity-ordered list of every solve
// task → a detail pane that surfaces the same live "what the agent is doing
// right now" status the worker streams, plus the issue → PR lineage. Read-only —
// a solve is autonomous and the only human action (merging the PR) happens on
// GitHub — so there are no action affordances, just status. Mirrors the
// Follow-ups view's structure. The mobile console renders solves via src/mobile.
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CircleDot,
  GitBranch,
  GitPullRequest,
  Loader2,
} from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { ago, clock } from "../lib/format"
import { repoShort } from "../review/kit"
import { FilterDropdown, type FilterOption } from "../ui/FilterDropdown"
import {
  type SolveStatus,
  type SolveTask,
  SOLVE_NOTE,
  SolveStatusPill,
  SolveStatusText,
  orderSolves,
  solveIssueUrl,
  solveSub,
} from "./kit"

// A 1s tick, only while something is live, for the building elapsed clock.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
      <Loader2 className="size-4 animate-spin" />
      Loading solves…
    </div>
  )
}

export function useSolves() {
  const board = useQuery(api.solveTasks.board)
  const items = useMemo(() => orderSolves(board), [board])
  return { board, items }
}

const SOLVE_FILTERS: { value: SolveStatus | "all"; label: string }[] = [
  { value: "all", label: "All solves" },
  { value: "solving", label: "Solving" },
  { value: "queued", label: "Queued" },
  { value: "pr-opened", label: "PR opened" },
  { value: "done", label: "Merged" },
  { value: "failed", label: "Failed" },
]

function SolveRowD({ t, selected, onSelect }: { t: SolveTask; selected: boolean; onSelect: () => void }) {
  const sub = solveSub(t)
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
          {t.issueTitle}
        </span>
        <SolveStatusText status={t.status} />
      </div>
      <div className="mt-[7px] flex items-center gap-2 font-mono text-[10px] text-zinc-500">
        <span className="shrink-0">
          {repoShort(t.repo)}  #{t.issueNumber}
        </span>
        <span className="text-zinc-700">·</span>
        <span className={cn("min-w-0 truncate", sub.cls)}>{sub.text}</span>
      </div>
    </button>
  )
}

// A labelled key/value row in the details card.
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-2.5 text-xs">
      <span className="text-zinc-600">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-zinc-400">{children}</span>
    </div>
  )
}

function SolveDetailD({ t }: { t: SolveTask }) {
  const now = useNow(t.status === "solving")
  const elapsed = t.startedAt ? clock((t.finishedAt ?? now) - t.startedAt) : null
  const note = SOLVE_NOTE[t.status]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-[18px] py-4">
        <div className="flex flex-wrap items-center gap-2">
          <SolveStatusPill status={t.status} />
          <a
            href={solveIssueUrl(t)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400 transition-colors hover:text-zinc-200"
          >
            <CircleDot className="size-3" />#{t.issueNumber}
          </a>
          <span className="font-mono text-[11px] text-zinc-500">{repoShort(t.repo)}</span>
        </div>
        <h2 className="mt-3 text-[17px] font-semibold leading-snug text-zinc-100">{t.issueTitle}</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        {t.status === "solving" && (
          <div className="flex items-start gap-[11px] rounded-lg border border-[#38bdf8]/25 bg-[#38bdf8]/[0.06] p-3.5">
            <Loader2 className="mt-px size-[17px] shrink-0 animate-spin text-[#7dd3fc]" />
            <div className="min-w-0 flex-1">
              <div className="text-sm leading-snug text-[#e0f2fe]">{t.progress || "Starting…"}</div>
              <div className="mt-[3px] font-mono text-[11px] text-[#7dd3fc]">building{elapsed ? ` · ${elapsed}` : ""}</div>
            </div>
          </div>
        )}

        {t.status === "failed" && t.error && (
          <div className="flex items-start gap-[11px] rounded-lg border border-[#f85149]/25 bg-[#f85149]/[0.06] p-3.5">
            <AlertTriangle className="mt-px size-4 shrink-0 text-[#fca5a5]" />
            <div className="text-[13px] leading-relaxed text-[#fecaca]">{t.error}</div>
          </div>
        )}

        {note && <p className="text-[13px] leading-relaxed text-zinc-400">{note}</p>}

        {/* lineage: issue → PR */}
        <div className="mt-[18px] rounded-lg border border-line2 bg-[#0d0d0f] p-3.5">
          <div className="mb-2.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-zinc-600">Lineage</div>
          <div className="flex items-center gap-2.5 font-mono text-[13px]">
            <a
              href={solveIssueUrl(t)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-zinc-400 transition-colors hover:text-zinc-200"
            >
              <CircleDot className="size-3.5" />#{t.issueNumber}
            </a>
            <span className="text-zinc-700">→</span>
            {t.prNumber != null && t.prUrl ? (
              <a
                href={t.prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-zinc-100 transition-colors hover:text-white"
              >
                <GitPullRequest className="size-3.5" />#{t.prNumber}
                <ArrowUpRight className="size-3" />
              </a>
            ) : t.status === "solving" ? (
              <span className="text-[#7dd3fc]">building…</span>
            ) : (
              <span className="text-zinc-600">PR pending</span>
            )}
          </div>
        </div>

        {/* timing + provenance */}
        <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-line2 bg-[#0d0d0f] p-3.5">
          <DetailRow label="Queued">{ago(t.queuedAt, now)}</DetailRow>
          {t.startedAt != null && <DetailRow label="Started">{ago(t.startedAt, now)}</DetailRow>}
          {t.status === "solving" && elapsed && (
            <div className="flex justify-between gap-2.5 text-xs">
              <span className="text-zinc-600">Building</span>
              <span className="font-mono text-[#7dd3fc]">{elapsed}</span>
            </div>
          )}
          {t.finishedAt != null && <DetailRow label="Finished">{ago(t.finishedAt, now)}</DetailRow>}
          {t.branch && (
            <DetailRow label="Branch">
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3" />
                {t.branch}
              </span>
            </DetailRow>
          )}
          {t.worker && <DetailRow label="Solver">{t.worker}</DetailRow>}
        </div>
      </div>
    </div>
  )
}

// ── desktop: two-pane ─────────────────────────────────────────────────────────
export function SolvesDesktop() {
  const { board, items } = useSolves()
  const [filter, setFilter] = useState<SolveStatus | "all">("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const shown = useMemo(
    () => (filter === "all" ? items : items.filter((t) => t.status === filter)),
    [items, filter],
  )

  const options = useMemo<FilterOption<SolveStatus | "all">[]>(
    () =>
      SOLVE_FILTERS.map((f) => ({
        value: f.value,
        label: f.label,
        count: f.value === "all" ? items.length : items.filter((t) => t.status === f.value).length,
      })),
    [items],
  )

  // Land on the first solve in the current filter so the pane is never empty;
  // keep the user's pick stable as live data streams in, but drop one that left.
  useEffect(() => {
    if (shown.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !shown.some((t) => t._id === selectedId)) setSelectedId(shown[0]._id)
  }, [shown, selectedId])

  const selected = shown.find((t) => t._id === selectedId) ?? null

  if (board === undefined) {
    return <Loading />
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-4 px-5 py-[18px]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line2 bg-panel">
        <div className="flex shrink-0 items-center border-b border-line px-2.5 py-2">
          <FilterDropdown
            icon={<Bot className="size-3.5" />}
            heading="Filter by status"
            options={options}
            value={filter}
            onChange={setFilter}
          />
        </div>
        <div className="flex shrink-0 items-center gap-[7px] px-3 pb-1.5 pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
          <Bot className="size-3" />
          Solves
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
          <div className="flex flex-col gap-[5px]">
            {shown.map((t) => (
              <SolveRowD key={t._id} t={t} selected={t._id === selectedId} onSelect={() => setSelectedId(t._id)} />
            ))}
            {shown.length === 0 && (
              <div className="rounded-md border border-dashed border-edge p-[18px] text-center text-xs text-zinc-600">
                No solves in this view.
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line2 bg-panel">
        {selected ? (
          <SolveDetailD t={selected} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-zinc-600">
            Select a solve to watch its status.
          </div>
        )}
      </section>
    </div>
  )
}
