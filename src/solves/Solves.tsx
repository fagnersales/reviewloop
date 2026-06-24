// The autonomous-solver view: an activity-ordered list of every solve task → a
// detail pane that surfaces the same live "what the agent is doing right now"
// status the worker streams, plus the issue → PR lineage. Desktop is a two-pane
// (list + detail); mobile drills list → detail. Read-only — a solve is autonomous
// and the only human action (merging the PR) happens on GitHub — so there are no
// action affordances, just status. Mirrors the Follow-ups view's structure.
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  ChevronLeft,
  CircleDot,
  ExternalLink,
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
  SOLVE_STATUS,
  SolveStateDot,
  StatusPill,
  orderSolves,
  solveIssueUrl,
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

// One-line summary shown under a row's title: the live progress for a solving row,
// the PR for an opened/merged one, the reason for a failed one.
function rowSubtitle(t: SolveTask): ReactNode {
  if (t.status === "solving")
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sky-300/90">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span className="truncate">{t.progress || "Starting…"}</span>
      </span>
    )
  if (t.status === "queued") return <span className="text-zinc-500">Queued — waiting for a solver</span>
  if (t.status === "failed")
    return <span className="truncate text-rose-300/80">{t.error || "Failed"}</span>
  if (t.prNumber != null)
    return (
      <span className="text-zinc-500">
        {t.status === "done" ? "Merged" : "Opened"} PR{" "}
        <span className="font-mono text-zinc-400">#{t.prNumber}</span>
      </span>
    )
  return <span className="text-zinc-500">{SOLVE_STATUS[t.status].label}</span>
}

// ── list row (shared desktop + mobile) ───────────────────────────────────────
function SolveRow({
  t,
  selected,
  onSelect,
}: {
  t: SolveTask
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2.5 text-left transition",
        selected
          ? "border-zinc-700 bg-zinc-900 text-zinc-100"
          : "border-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/60 hover:text-zinc-200",
      )}
    >
      <span className="mt-1.5">
        <SolveStateDot status={t.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.issueTitle}</span>
          <span className="shrink-0 font-mono text-[11px] text-zinc-600">#{t.issueNumber}</span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px]">
          <span className="shrink-0 truncate text-zinc-500">{repoShort(t.repo)}</span>
          <span className="min-w-0 flex-1 truncate">{rowSubtitle(t)}</span>
        </span>
      </span>
    </button>
  )
}

// ── detail: a labelled key/value row ─────────────────────────────────────────
function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-zinc-600">{label}</span>
      <span className="min-w-0 truncate text-right text-zinc-300">{children}</span>
    </div>
  )
}

// ── detail pane ───────────────────────────────────────────────────────────────
function SolveDetail({ t }: { t: SolveTask }) {
  const now = useNow(t.status === "solving")
  const elapsed = t.startedAt
    ? clock((t.finishedAt ?? now) - t.startedAt)
    : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={t.status} />
          <a
            href={solveIssueUrl(t)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
          >
            <CircleDot className="size-3" />#{t.issueNumber}
            <ExternalLink className="size-3" />
          </a>
          <span className="font-mono text-[11px] text-zinc-600">{repoShort(t.repo)}</span>
        </div>

        <h1 className="mt-3 text-balance text-xl font-semibold leading-snug text-zinc-50">
          {t.issueTitle}
        </h1>

        {/* The live "what it's doing right now" line — the headline for a solving row. */}
        {t.status === "solving" && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-sky-500/20 bg-sky-500/[0.06] p-3">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-sky-300" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-sky-100">{t.progress || "Starting…"}</div>
              <div className="mt-0.5 font-mono text-[11px] text-sky-300/70">
                building{elapsed ? ` · ${elapsed}` : ""}
              </div>
            </div>
          </div>
        )}

        {t.status === "failed" && t.error && (
          <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] p-3 text-sm text-rose-200">
            {t.error}
          </div>
        )}

        {/* Lineage: issue → PR. */}
        <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            <GitPullRequest className="size-3.5" />
            Lineage
          </div>
          <div className="flex items-center gap-2 text-sm">
            <a
              href={solveIssueUrl(t)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-zinc-300 underline-offset-2 hover:text-sky-200 hover:underline"
            >
              <CircleDot className="size-3.5" />#{t.issueNumber}
            </a>
            <span className="text-zinc-600">→</span>
            {t.prNumber != null && t.prUrl ? (
              <a
                href={t.prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-zinc-100 underline-offset-2 hover:text-sky-200 hover:underline"
              >
                <GitPullRequest className="size-3.5" />#{t.prNumber}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="font-mono text-zinc-600">PR pending</span>
            )}
          </div>
        </div>

        {/* Timing + provenance. */}
        <div className="mt-4 space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <Meta label="Queued">{ago(t.queuedAt, now)}</Meta>
          {t.startedAt != null && <Meta label="Started">{ago(t.startedAt, now)}</Meta>}
          {t.status === "solving" && elapsed && (
            <Meta label="Building">
              <span className="font-mono">{elapsed}</span>
            </Meta>
          )}
          {t.finishedAt != null && <Meta label="Finished">{ago(t.finishedAt, now)}</Meta>}
          {t.branch && (
            <Meta label="Branch">
              <span className="inline-flex items-center gap-1 font-mono text-zinc-400">
                <GitBranch className="size-3" />
                {t.branch}
              </span>
            </Meta>
          )}
          {t.worker && <Meta label="Solver">{t.worker}</Meta>}
        </div>
      </div>
    </div>
  )
}

// ── shared list ───────────────────────────────────────────────────────────────
function Header({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
        <Bot className="size-3.5" />
        Solves
        <span className="text-zinc-600">{count}</span>
      </span>
    </div>
  )
}

function List({
  items,
  selectedId,
  onSelect,
}: {
  items: SolveTask[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="space-y-1.5">
      {items.map((t) => (
        <SolveRow key={t._id} t={t} selected={t._id === selectedId} onSelect={() => onSelect(t._id)} />
      ))}
      {items.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
          No solves yet. Label an issue <span className="font-mono text-zinc-400">ready-for-agent</span> to start one.
        </div>
      )}
    </div>
  )
}

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
      <Loader2 className="size-4 animate-spin" />
      Loading solves…
    </div>
  )
}

function useSolves() {
  const board = useQuery(api.solveTasks.board)
  const items = useMemo(() => orderSolves(board), [board])
  return { board, items }
}

// ── desktop design atoms ─────────────────────────────────────────────────────
// The console's design palette: status as a coloured mono label (rows) / dot+
// label pill (header), with the live state pulsing. Mobile keeps the kit atoms.
const SOLVE_META: Record<
  SolveStatus,
  { label: string; text: string; dot: string; bg: string; border: string; pulse: boolean }
> = {
  queued: { label: "QUEUED", text: "text-[#fcd34d]", dot: "bg-[#e3b341]", bg: "bg-[#e3b341]/10", border: "border-[#e3b341]/30", pulse: false },
  solving: { label: "SOLVING", text: "text-[#7dd3fc]", dot: "bg-[#38bdf8]", bg: "bg-[#38bdf8]/10", border: "border-[#38bdf8]/30", pulse: true },
  "pr-opened": { label: "PR OPENED", text: "text-[#d8b4fe]", dot: "bg-[#a371f7]", bg: "bg-[#a371f7]/10", border: "border-[#a371f7]/30", pulse: false },
  done: { label: "MERGED", text: "text-[#86efac]", dot: "bg-[#3fb950]", bg: "bg-[#3fb950]/10", border: "border-[#3fb950]/30", pulse: false },
  failed: { label: "FAILED", text: "text-[#fca5a5]", dot: "bg-[#f85149]", bg: "bg-[#f85149]/10", border: "border-[#f85149]/30", pulse: false },
}

const SOLVE_NOTE: Partial<Record<SolveStatus, string>> = {
  queued: "Waiting for an available solver worker. The /pr-feature run starts once a slot frees up.",
  "pr-opened": "The agent opened a PR and stopped — solvers never merge. A human reviews and merges it on GitHub.",
  done: "The PR was merged on GitHub, closing the issue → solve → PR lineage. Nothing more to do.",
}

const SOLVE_FILTERS: { value: SolveStatus | "all"; label: string }[] = [
  { value: "all", label: "All solves" },
  { value: "solving", label: "Solving" },
  { value: "queued", label: "Queued" },
  { value: "pr-opened", label: "PR opened" },
  { value: "done", label: "Merged" },
  { value: "failed", label: "Failed" },
]

// The one-line, status-coloured subtitle under a row's title.
function solveSub(t: SolveTask): { text: string; cls: string } {
  if (t.status === "solving") return { text: t.progress || "Starting…", cls: "text-[#7dd3fc]" }
  if (t.status === "queued") return { text: "Waiting for a solver", cls: "text-zinc-500" }
  if (t.status === "failed") return { text: t.error || "Failed", cls: "text-[#fca5a5]" }
  if (t.status === "done" && t.prNumber != null) return { text: `Merged · PR #${t.prNumber}`, cls: "text-zinc-500" }
  if (t.prNumber != null) return { text: `Opened PR #${t.prNumber}`, cls: "text-zinc-500" }
  return { text: SOLVE_STATUS[t.status].label, cls: "text-zinc-500" }
}

function SolveStatusText({ status }: { status: SolveStatus }) {
  const m = SOLVE_META[status]
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] font-semibold tracking-[0.06em]", m.text)}>
      <span className={cn("size-[5px] shrink-0 rounded-full", m.dot, m.pulse && "prr-pulse")} />
      {m.label}
    </span>
  )
}

function SolveStatusPill({ status }: { status: SolveStatus }) {
  const m = SOLVE_META[status]
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded border px-2.5 py-[3px] font-mono text-[10px] font-medium", m.text, m.bg, m.border)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", m.dot, m.pulse && "prr-pulse")} />
      {m.label}
    </span>
  )
}

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

// ── mobile: drill-down ────────────────────────────────────────────────────────
export function SolvesMobile() {
  const { board, items } = useSolves()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId ? items.find((t) => t._id === selectedId) ?? null : null

  let body: ReactNode
  if (board === undefined) {
    body = <Loading />
  } else if (selected) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 px-2 py-2.5">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="flex items-center gap-0.5 rounded-md py-1 pl-1 pr-2 text-sm text-sky-300 active:text-sky-200"
          >
            <ChevronLeft className="size-5" />
            Solves
          </button>
          <span className="ml-auto truncate font-mono text-xs text-zinc-600">
            {repoShort(selected.repo)} #{selected.issueNumber}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <SolveDetail t={selected} />
        </div>
      </div>
    )
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-4">
          <Header count={items.length} />
          <List items={items} selectedId={null} onSelect={setSelectedId} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#080809]">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
          <Bot className="size-4 text-sky-300" />
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">Autonomous Solves</span>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  )
}
