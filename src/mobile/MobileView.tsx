// The mobile view.
//
// A clean PR list (matching the desktop header) pushes to a full-screen PR detail
// — a page change, not an overlay. The detail shows the PR header and the review
// loop; tapping a loop step raises a bottom sheet with that step's content (review
// summary, commit list, in-flight status, …).
import { useMemo, useRef, useState } from "react"
import {
  Activity,
  ChevronLeft,
  ExternalLink,
  GitCommit,
  GitPullRequest,
  ListFilter,
  Search,
  X,
} from "lucide-react"
import { cn } from "../lib/cn"
import { type Pr, ScoreBadge, StatusBadge, prTiming, repoShort, useNow, useOpenOnly } from "../review/kit"
import { PrCard, RepoChips } from "./list"
import { EventDetailContent, ReviewLoop, usePrLoop } from "./detail"
import { DraggableSheet } from "./sheet"

const META_LINK = "rounded-sm underline-offset-2 transition active:text-zinc-200"

// Hoisted so the sheet receives a stable `snaps` reference — a fresh array each
// render would re-run the sheet's open-effect on every Convex live update.
const SHEET_SNAPS = [0.85]

// The PR detail header: status + score, title, and the metadata row of links.
function DetailHeader({ pr }: { pr: Pr }) {
  const now = useNow()
  const timing = prTiming(pr, now)
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge pr={pr} />
        <ScoreBadge score={pr.confidence} />
      </div>
      <h2 className="mt-2.5 text-balance text-[17px] font-semibold leading-snug text-zinc-50">{pr.title}</h2>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-zinc-500">
        <a href={`https://github.com/${pr.repo}`} target="_blank" rel="noreferrer" className={META_LINK}>
          {pr.repo}
        </a>
        <a href={pr.prUrl} target="_blank" rel="noreferrer" className={cn(META_LINK, "font-mono")}>
          #{pr.prNumber}
        </a>
        <a href={`https://github.com/${pr.author}`} target="_blank" rel="noreferrer" className={META_LINK}>
          {pr.author}
        </a>
        <a
          href={`https://github.com/${pr.repo}/commit/${pr.headSha}`}
          target="_blank"
          rel="noreferrer"
          className={cn(META_LINK, "flex items-center gap-1 font-mono")}
        >
          <GitCommit className="size-3" />
          {pr.headSha.slice(0, 7)}
        </a>
        {timing && (
          <span className="flex items-center gap-1" title={timing.title}>
            {timing.header}
          </span>
        )}
      </div>
    </div>
  )
}

function DetailScreen({ pr, onBack }: { pr: Pr; onBack: () => void }) {
  const { events, passById, defaultEventId } = usePrLoop(pr)
  const [sheetId, setSheetId] = useState<string | null>(null)
  const selectedEvent = events.find((e) => e.id === sheetId) ?? null
  // Keep the last opened step rendered while the sheet slides out, so its body
  // doesn't blank before the close animation finishes.
  const lastEventRef = useRef(selectedEvent)
  if (selectedEvent) lastEventRef.current = selectedEvent
  const shownEvent = selectedEvent ?? lastEventRef.current

  return (
    <div className="flex h-full flex-col bg-[#080809]">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 px-2 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-0.5 rounded-md py-1 pl-1 pr-2 text-sm text-sky-300 active:text-sky-200"
        >
          <ChevronLeft className="size-5" />
          Back
        </button>
        <span className="ml-auto truncate font-mono text-xs text-zinc-600">
          {repoShort(pr.repo)} #{pr.prNumber}
        </span>
        <a
          href={pr.prUrl}
          target="_blank"
          rel="noreferrer"
          className="flex size-7 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 active:text-zinc-100"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-zinc-800/80 p-4">
          <DetailHeader pr={pr} />
        </div>
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Activity className="size-3.5" />
            Review loop · tap a step
          </div>
          <ReviewLoop events={events} selectedId={sheetId ?? defaultEventId} onSelect={setSheetId} />
        </div>
      </div>

      <DraggableSheet
        open={sheetId !== null}
        onClose={() => setSheetId(null)}
        snaps={SHEET_SNAPS}
        header={
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-1">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Step detail</span>
            <button
              type="button"
              onClick={() => setSheetId(null)}
              className="flex size-7 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 active:text-zinc-100"
            >
              <X className="size-4" />
            </button>
          </div>
        }
      >
        <EventDetailContent pr={pr} event={shownEvent} passById={passById} />
      </DraggableSheet>
    </div>
  )
}

export function MobileView({ prs }: { prs: Pr[] }) {
  const [activeRepo, setActiveRepo] = useState("all")
  // Store the selection by key and re-derive the live PR object each render, so
  // the detail screen keeps receiving Convex updates (status, new rounds,
  // streaming progress) while a review is in flight. A snapshot would freeze it.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [openOnly, setOpenOnly] = useOpenOnly()

  const now = useNow()

  const selected = useMemo(
    () => (selectedKey ? prs.find((p) => p.key === selectedKey) ?? null : null),
    [prs, selectedKey],
  )
  // Keep the outgoing PR rendered through the 300ms slide-out so the pane doesn't
  // blank. Keyed by PR key at the call site, so a different PR remounts a fresh
  // DetailScreen (no stale sheet/loop state bleeding across PRs).
  const lastSelectedRef = useRef<Pr | null>(selected)
  if (selected) lastSelectedRef.current = selected
  const detailPr = selected ?? lastSelectedRef.current

  const repos = useMemo(
    () => Array.from(new Set(prs.map((p) => p.repo))).sort((a, b) => a.localeCompare(b)),
    [prs],
  )

  const visible = useMemo(() => {
    const byRepo =
      activeRepo === "all" ? prs : prs.filter((p) => p.repo.toLowerCase() === activeRepo.toLowerCase())
    // `prState` is undefined for open PRs and "merged"/"closed" otherwise.
    const byState = openOnly ? byRepo.filter((p) => p.prState == null) : byRepo
    const q = query.trim().toLowerCase()
    return q
      ? byState.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            `#${p.prNumber}`.includes(q) ||
            p.repo.toLowerCase().includes(q),
        )
      : byState
  }, [prs, activeRepo, query, openOnly])

  return (
    <div className="relative h-full overflow-hidden bg-[#080809] text-zinc-100">
      {/* List screen */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-transform duration-300 ease-out",
          selected ? "-translate-x-1/4" : "translate-x-0",
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 px-4 py-3">
          <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
            <GitPullRequest className="size-4 text-sky-300" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">PR Review Console</div>
            <div className="truncate text-xs text-zinc-600">Claude Code and Codex review loops</div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-3 p-4">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5">
              <Search className="size-4 shrink-0 text-zinc-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search PRs or repos…"
                className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} className="text-zinc-500 active:text-zinc-200">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <RepoChips repos={repos} active={activeRepo} onChange={setActiveRepo} />
            <div className="flex items-center justify-between px-0.5">
              <span className="text-xs text-zinc-500">{visible.length} PRs</span>
              <button
                type="button"
                onClick={() => setOpenOnly((v) => !v)}
                aria-pressed={openOnly}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition",
                  openOnly
                    ? "border-zinc-600 bg-zinc-800 text-zinc-200"
                    : "border-zinc-800 bg-zinc-950 text-zinc-500 active:text-zinc-300",
                )}
              >
                <ListFilter className="size-3" />
                Open only
              </button>
            </div>
            <div className="space-y-2">
              {visible.map((pr) => (
                <PrCard
                  key={pr.key}
                  pr={pr}
                  now={now}
                  onTap={(p) => setSelectedKey(p.key)}
                  showRepo={activeRepo === "all"}
                />
              ))}
              {visible.length === 0 && (
                <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
                  No PRs match.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Detail screen (pushed in from the right) */}
      <div
        className={cn(
          "absolute inset-0 transition-transform duration-300 ease-out",
          selected ? "translate-x-0" : "translate-x-full",
        )}
      >
        {detailPr && <DetailScreen key={detailPr.key} pr={detailPr} onBack={() => setSelectedKey(null)} />}
      </div>
    </div>
  )
}
