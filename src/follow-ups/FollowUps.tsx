// The PR-follow-ups inbox: an issue-centric flat list of every suggestion across
// all PRs → a detail pane to read and act on one. Desktop is a two-pane (list +
// detail); mobile drills list → detail. Wired to Convex: the console records
// *intent* (approve / dismiss / undo / set-label) and the worker does the GitHub
// side. Read-only (the public build) hides every write affordance but keeps the
// reader — including Copy brief, which is client-only.
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import {
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  GitCommit,
  GitPullRequest,
  Inbox,
  ListFilter,
  Loader2,
  Undo2,
  X,
} from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { ReviewReport, repoShort } from "../review/kit"
import { useReadOnly } from "../read-only"
import {
  CATEGORY,
  CategoryChip,
  type Suggestion,
  type TriageLabel,
  LabelChip,
  LabelPicker,
  SourceTag,
  StateDot,
  issueBrief,
  issueUrl,
} from "./kit"

// The actor label stamped on a console decision (decidedBy). The console has no
// per-user identity, so it's just "dashboard" — distinct from a CLI's $USER@$HOST.
const ACTOR = "dashboard"

function useFollowUpActions() {
  const approve = useMutation(api.suggestedIssues.approve)
  const dismiss = useMutation(api.suggestedIssues.dismiss)
  const undo = useMutation(api.suggestedIssues.undo)
  const setLabel = useMutation(api.suggestedIssues.setLabel)
  return useMemo(
    () => ({
      open: (s: Suggestion) => void approve({ id: s._id, by: ACTOR }),
      dismiss: (s: Suggestion) => void dismiss({ id: s._id, by: ACTOR }),
      undo: (s: Suggestion) => void undo({ id: s._id }),
      setLabel: (s: Suggestion, label: TriageLabel) => void setLabel({ id: s._id, label }),
    }),
    [approve, dismiss, undo, setLabel],
  )
}

type Actions = ReturnType<typeof useFollowUpActions>

// ── list row (shared desktop + mobile) ───────────────────────────────────────
function IssueRow({
  s,
  selected,
  onSelect,
}: {
  s: Suggestion
  selected: boolean
  onSelect: () => void
}) {
  const dismissed = s.status === "dismissed"
  const c = CATEGORY[s.category]
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
        <StateDot status={s.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", dismissed && "text-zinc-500 line-through")}>
            {s.title}
          </span>
          {s.status === "opened" && s.issueNumber != null && (
            <span className="shrink-0 font-mono text-[11px] text-zinc-600">#{s.issueNumber}</span>
          )}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
          <span className={cn("size-1.5 shrink-0 rounded-full", c.dot)} title={c.label} />
          <span className="truncate">{repoShort(s.repo)}</span>
          <span className="shrink-0 font-mono text-zinc-600">from #{s.sourcePrNumber}</span>
          {s.status === "opened" && s.label && (
            <span className="ml-auto shrink-0">
              <LabelChip value={s.label} />
            </span>
          )}
        </span>
      </span>
    </button>
  )
}

// ── action footer ─────────────────────────────────────────────────────────────
function CopyBriefButton({ s }: { s: Suggestion }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(issueBrief(s))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — no-op */
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy brief"}
    </button>
  )
}

function ActionFooter({ s, actions }: { s: Suggestion; actions: Actions }) {
  const readOnly = useReadOnly()
  const copyBtn = <CopyBriefButton s={s} />

  // Read-only console: no writes. Opened rows still show their label statically;
  // everything else is just the brief.
  if (readOnly) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {s.status === "opened" && s.label && <LabelChip value={s.label} />}
        {copyBtn}
      </div>
    )
  }

  if (s.status === "opened") {
    return (
      <div className="flex flex-col gap-3">
        <LabelPicker value={s.label ?? "needs-triage"} onChange={(l) => actions.setLabel(s, l)} />
        <div className="flex items-center gap-2">{copyBtn}</div>
      </div>
    )
  }

  if (s.status === "approved") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-sky-300">
          <Loader2 className="size-3.5 animate-spin" />
          Filing the issue on GitHub…
        </span>
        <div className="flex items-center gap-2">
          {copyBtn}
          <button
            type="button"
            onClick={() => actions.undo(s)}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
          >
            <Undo2 className="size-3.5" />
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (s.status === "dismissed") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">Dismissed — won't be opened.</span>
        <button
          type="button"
          onClick={() => actions.undo(s)}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          <Undo2 className="size-3.5" />
          Undo
        </button>
      </div>
    )
  }

  // suggested
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => actions.open(s)}
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20"
      >
        <Check className="size-3.5" />
        Open issue
      </button>
      {copyBtn}
      <button
        type="button"
        onClick={() => actions.dismiss(s)}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-300"
      >
        <X className="size-3.5" />
        Dismiss
      </button>
    </div>
  )
}

// ── detail pane ───────────────────────────────────────────────────────────────
function IssueDetail({ s, actions }: { s: Suggestion; actions: Actions }) {
  const dismissed = s.status === "dismissed"
  const opened = s.status === "opened"
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-2">
          <CategoryChip category={s.category} />
          <SourceTag source={s.source} />
          {opened && s.issueNumber != null && (
            <a
              href={issueUrl(s.repo, s.issueNumber)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] text-emerald-200"
            >
              <Check className="size-3" />#{s.issueNumber}
              <ExternalLink className="size-3" />
            </a>
          )}
          {dismissed && (
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-400">
              <X className="size-3" />
              Dismissed
            </span>
          )}
        </div>
        <h1
          className={cn(
            "mt-3 text-balance text-xl font-semibold leading-snug",
            dismissed ? "text-zinc-500 line-through" : "text-zinc-50",
          )}
        >
          {s.title}
        </h1>
        <div className="mt-3">
          <ReviewReport report={s.body} />
        </div>
        {s.files.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-zinc-600">Files</span>
            {s.files.map((f) => (
              <span
                key={f}
                className="rounded border border-zinc-800 bg-zinc-900/70 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400"
              >
                {f}
              </span>
            ))}
          </div>
        )}
        <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            <GitPullRequest className="size-3.5" />
            Source PR
          </div>
          <a
            href={s.sourcePrUrl}
            target="_blank"
            rel="noreferrer"
            className="block text-sm font-medium text-zinc-100 underline-offset-2 hover:text-sky-200 hover:underline"
          >
            <span className="font-mono text-zinc-500">#{s.sourcePrNumber}</span> {s.sourcePrTitle}
          </a>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-zinc-500">
            <span className="truncate">{s.repo}</span>
            <a
              href={`https://github.com/${s.repo}/commit/${s.sourceHeadSha}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-mono underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              <GitCommit className="size-3" />
              {s.sourceHeadSha.slice(0, 7)}
            </a>
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-zinc-800 bg-[#080809]/80 p-3">
        <ActionFooter s={s} actions={actions} />
      </div>
    </div>
  )
}

function FilterBar({
  shown,
  total,
  pendingOnly,
  onToggle,
}: {
  shown: number
  total: number
  pendingOnly: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
        <Inbox className="size-3.5" />
        Follow-ups
        <span className="text-zinc-600">{shown}</span>
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={pendingOnly}
        title={pendingOnly ? `Showing pending only — click to show all ${total}` : "Show only pending"}
        className={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition",
          pendingOnly
            ? "border-zinc-600 bg-zinc-800 text-zinc-200"
            : "border-zinc-800 bg-zinc-950 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300",
        )}
      >
        <ListFilter className="size-3" />
        Pending only
      </button>
    </div>
  )
}

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full border border-zinc-800 text-zinc-600">
        <Inbox className="size-5" />
      </span>
      <p className="text-sm text-zinc-500">Select a follow-up to read it.</p>
    </div>
  )
}

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
      <Loader2 className="size-4 animate-spin" />
      Loading follow-ups…
    </div>
  )
}

// Shared list-building + filter state for both layouts.
function useInboxState(suggestions: Suggestion[] | undefined) {
  const [pendingOnly, setPendingOnly] = useState(false)
  const items = suggestions ?? []
  const shown = useMemo(
    () => (pendingOnly ? items.filter((s) => s.status === "suggested") : items),
    [items, pendingOnly],
  )
  return { items, shown, pendingOnly, setPendingOnly }
}

function List({
  shown,
  selectedId,
  onSelect,
  pendingOnly,
}: {
  shown: Suggestion[]
  selectedId: string | null
  onSelect: (id: string) => void
  pendingOnly: boolean
}) {
  return (
    <div className="space-y-1.5">
      {shown.map((s) => (
        <IssueRow key={s._id} s={s} selected={s._id === selectedId} onSelect={() => onSelect(s._id)} />
      ))}
      {shown.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
          {pendingOnly ? "No pending follow-ups — inbox clear." : "No follow-ups yet."}
        </div>
      )}
    </div>
  )
}

// ── desktop: two-pane ─────────────────────────────────────────────────────────
export function FollowUpsDesktop() {
  const suggestions = useQuery(api.suggestedIssues.inbox)
  const actions = useFollowUpActions()
  const { items, shown, pendingOnly, setPendingOnly } = useInboxState(suggestions)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Land on the first follow-up so the pane is never empty; keep the user's pick
  // stable as live data streams in, but drop a selection that vanished.
  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !items.some((s) => s._id === selectedId)) setSelectedId(items[0]._id)
  }, [items, selectedId])

  const selected = items.find((s) => s._id === selectedId) ?? null

  if (suggestions === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Loading />
      </div>
    )
  }

  return (
    <div className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 grid-cols-[22rem_minmax(0,1fr)] grid-rows-1 gap-4 px-3 py-4">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70">
        <div className="shrink-0 border-b border-zinc-800 p-3">
          <FilterBar
            shown={shown.length}
            total={items.length}
            pendingOnly={pendingOnly}
            onToggle={() => setPendingOnly((v) => !v)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <List shown={shown} selectedId={selectedId} onSelect={setSelectedId} pendingOnly={pendingOnly} />
        </div>
      </section>
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70">
        {selected ? <IssueDetail s={selected} actions={actions} /> : <EmptyDetail />}
      </section>
    </div>
  )
}

// ── mobile: drill-down ────────────────────────────────────────────────────────
export function FollowUpsMobile() {
  const suggestions = useQuery(api.suggestedIssues.inbox)
  const actions = useFollowUpActions()
  const { items, shown, pendingOnly, setPendingOnly } = useInboxState(suggestions)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = selectedId ? items.find((s) => s._id === selectedId) ?? null : null

  let body: ReactNode
  if (suggestions === undefined) {
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
            Inbox
          </button>
          <span className="ml-auto truncate font-mono text-xs text-zinc-600">
            {repoShort(selected.repo)} #{selected.sourcePrNumber}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <IssueDetail s={selected} actions={actions} />
        </div>
      </div>
    )
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-4">
          <FilterBar
            shown={shown.length}
            total={items.length}
            pendingOnly={pendingOnly}
            onToggle={() => setPendingOnly((v) => !v)}
          />
          <List shown={shown} selectedId={null} onSelect={setSelectedId} pendingOnly={pendingOnly} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#080809]">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
          <Inbox className="size-4 text-amber-300" />
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">PR Follow-ups</span>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  )
}
