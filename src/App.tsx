import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { type FunctionReturnType } from "convex/server"
import Markdown from "markdown-to-jsx"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  ListFilter,
  Loader2,
  type LucideIcon,
  Plus,
  Rows3,
  Search,
  Sparkles,
  X,
  XCircle,
} from "lucide-react"
import { api } from "../convex/_generated/api"
import { cn } from "./lib/cn"
import { ago } from "./lib/format"

type Pr = FunctionReturnType<typeof api.reviews.prs>[number]
type EventKind = "opened" | "review" | "agent" | "commit" | "merged" | "failed" | "closed"

type TimelineEvent = {
  id: string
  kind: EventKind
  title: string
  body: string
  time: number
  score?: number
}

function useIsNarrowViewport() {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 760px)").matches,
  )

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)")
    const update = () => setIsNarrow(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return isNarrow
}

function repoShort(repo: string) {
  return repo.split("/").pop() ?? repo
}

function findingsLine(x: { p0?: number; p1?: number; p2?: number }) {
  const p0 = x.p0 ?? 0
  const p1 = x.p1 ?? 0
  const p2 = x.p2 ?? 0
  if (p0 + p1 + p2 === 0) return "No inline findings."
  const parts: string[] = []
  if (p0) parts.push(`${p0} P0`)
  if (p1) parts.push(`${p1} P1`)
  if (p2) parts.push(`${p2} P2`)
  return parts.join(" · ")
}

type StatusDisplay = { label: string; icon: LucideIcon; tone: string; spin?: boolean }

function statusDisplay(pr: Pr): StatusDisplay {
  if (pr.prState === "merged")
    return {
      label: "Merged",
      icon: GitMerge,
      tone: "border-violet-400/25 bg-violet-400/10 text-violet-200",
    }
  if (pr.prState === "closed")
    return {
      label: "Closed",
      icon: GitPullRequestClosed,
      tone: "border-zinc-700 bg-zinc-900/80 text-zinc-400",
    }
  switch (pr.status) {
    case "reviewing":
      return {
        label: "Reviewing",
        icon: Loader2,
        tone: "border-sky-400/25 bg-sky-400/10 text-sky-200",
        spin: true,
      }
    case "queued":
      return {
        label: "Queued",
        icon: Clock3,
        tone: "border-zinc-700 bg-zinc-900/80 text-zinc-400",
      }
    case "reviewed":
      return {
        label: "Reviewed",
        icon: CheckCircle2,
        tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
      }
    case "failed":
      return {
        label: "Failed",
        icon: XCircle,
        tone: "border-red-400/25 bg-red-400/10 text-red-200",
      }
  }
}

function scoreTone(score?: number) {
  if (score == null) return "border-zinc-700 bg-zinc-900 text-zinc-500"
  if (score >= 4) return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
  if (score >= 3) return "border-amber-400/25 bg-amber-400/10 text-amber-200"
  return "border-red-400/25 bg-red-400/10 text-red-200"
}

// Rebuild the review loop from a PR's per-commit review passes: opened anchor,
// a "new commit" marker whenever the head SHA changes, the review/score for each
// reviewed pass, the live line for an in-flight pass, and a merge/close cap.
function buildEvents(pr: Pr): TimelineEvent[] {
  const events: TimelineEvent[] = []
  const first = pr.passes[0]
  if (first) {
    events.push({
      id: `${pr.key}-opened`,
      kind: "opened",
      title: "PR opened",
      body: `Opened by ${pr.author}.`,
      time: first.queuedAt,
    })
  }

  let prevSha: string | undefined
  for (const pass of pr.passes) {
    if (prevSha && pass.headSha !== prevSha) {
      events.push({
        id: `${pass._id}-commit`,
        kind: "commit",
        title: "Commits landed",
        body: `New commit ${pass.headSha.slice(0, 7)} pushed.`,
        time: pass.queuedAt,
      })
    }
    prevSha = pass.headSha

    if (pass.status === "reviewed") {
      events.push({
        id: pass._id,
        kind: "review",
        title: "PR reviewed",
        body: findingsLine(pass),
        time: pass.finishedAt ?? pass.queuedAt,
        score: pass.confidence,
      })
    } else if (pass.status === "reviewing") {
      events.push({
        id: pass._id,
        kind: "agent",
        title: "Agent is reviewing",
        body: pass.progress ?? "The agent is reviewing this commit.",
        time: pass.startedAt ?? pass.queuedAt,
      })
    } else if (pass.status === "failed") {
      events.push({
        id: pass._id,
        kind: "failed",
        title: "Review failed",
        body: pass.error ?? "The run errored or timed out.",
        time: pass.finishedAt ?? pass.queuedAt,
      })
    } else {
      events.push({
        id: pass._id,
        kind: "agent",
        title: "Queued for review",
        body: "Waiting for an available review worker.",
        time: pass.queuedAt,
      })
    }
  }

  if (pr.prState === "merged") {
    events.push({
      id: `${pr.key}-merged`,
      kind: "merged",
      title: "Merged",
      body: "PR merged on GitHub — no further review needed.",
      time: pr.updatedAt,
    })
  } else if (pr.prState === "closed") {
    events.push({
      id: `${pr.key}-closed`,
      kind: "closed",
      title: "Closed",
      body: "PR closed without merging.",
      time: pr.updatedAt,
    })
  }

  return events
}

function eventIcon(kind: EventKind): LucideIcon {
  switch (kind) {
    case "opened":
      return GitPullRequest
    case "review":
      return Rows3
    case "agent":
      return Loader2
    case "commit":
      return GitCommit
    case "merged":
      return GitMerge
    case "failed":
      return AlertTriangle
    case "closed":
      return GitPullRequestClosed
  }
}

function EventGlyph({ kind }: { kind: EventKind }) {
  const Icon = eventIcon(kind)
  return (
    <span
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md border bg-zinc-950",
        kind === "agent" && "border-sky-400/30 text-sky-300",
        kind === "review" && "border-amber-400/30 text-amber-300",
        kind === "commit" && "border-violet-400/30 text-violet-300",
        kind === "merged" && "border-emerald-400/30 text-emerald-300",
        kind === "failed" && "border-red-400/30 text-red-300",
        kind === "closed" && "border-zinc-700 text-zinc-400",
        kind === "opened" && "border-zinc-700 text-zinc-400",
      )}
    >
      <Icon className={cn("size-3.5", kind === "agent" && "animate-spin")} />
    </span>
  )
}

function StatusBadge({ pr }: { pr: Pr }) {
  const s = statusDisplay(pr)
  const Icon = s.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        s.tone,
      )}
    >
      <Icon className={cn("size-3", s.spin && "animate-spin")} />
      {s.label}
    </span>
  )
}

function ScoreBadge({ score }: { score?: number }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
        scoreTone(score),
      )}
    >
      {score != null ? `${score}/5` : "new"}
    </span>
  )
}

function RepoSegmented({
  repos,
  prs,
  activeRepo,
  onRepoChange,
  onAdd,
  onRemove,
}: {
  repos: string[]
  prs: Pr[]
  activeRepo: string
  onRepoChange: (repo: string) => void
  onAdd: (repo: string) => void
  onRemove: (repo: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState("")
  const watched = new Set(repos)
  const repoSet = Array.from(new Set([...repos, ...prs.map((p) => p.repo)])).sort()

  const submit = () => {
    const name = value.trim()
    if (!name) return
    onAdd(name)
    setValue("")
    setAdding(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex max-w-full items-stretch overflow-x-auto rounded-md border border-zinc-800">
        <button
          type="button"
          onClick={() => onRepoChange("all")}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition",
            activeRepo === "all"
              ? "bg-zinc-800 text-zinc-100"
              : "bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
          )}
        >
          <ListFilter className="size-3.5" />
          All
          <span className="text-[10px] text-zinc-500">{prs.length}</span>
        </button>
        {repoSet.map((repo) => {
          const active = activeRepo === repo
          const count = prs.filter((p) => p.repo === repo).length
          return (
            <div
              key={repo}
              className={cn(
                "group/seg relative inline-flex shrink-0 items-center border-l border-zinc-800 transition",
                active ? "bg-zinc-800" : "bg-zinc-950 hover:bg-zinc-900",
              )}
            >
              <button
                type="button"
                onClick={() => onRepoChange(repo)}
                className={cn(
                  "inline-flex items-center gap-1.5 py-1.5 pl-3 text-xs font-medium transition",
                  active ? "text-zinc-100" : "text-zinc-400 group-hover/seg:text-zinc-200",
                  watched.has(repo) ? "pr-1.5" : "pr-3",
                )}
              >
                {repoShort(repo)}
                <span className="text-[10px] text-zinc-500">{count}</span>
              </button>
              {watched.has(repo) && (
                <button
                  type="button"
                  title={`Remove ${repo}`}
                  aria-label={`Remove ${repo}`}
                  onClick={() => onRemove(repo)}
                  className="mr-1.5 rounded p-0.5 text-zinc-600 opacity-0 transition hover:text-zinc-200 focus:opacity-100 group-hover/seg:opacity-100"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {adding ? (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit()
              if (event.key === "Escape") {
                setValue("")
                setAdding(false)
              }
            }}
            placeholder="owner/repo"
            className="h-8 w-44 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={submit}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
          >
            Add
          </button>
        </div>
      ) : (
        <button
          type="button"
          title="Add repository"
          aria-label="Add repository"
          onClick={() => setAdding(true)}
          className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 p-1.5 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function PrList({
  prs,
  selectedKey,
  onSelect,
  emptyLabel,
}: {
  prs: Pr[]
  selectedKey: string | null
  onSelect: (key: string) => void
  emptyLabel: string
}) {
  return (
    <div className="space-y-1.5">
      {prs.map((pr) => (
        <button
          key={pr.key}
          type="button"
          onClick={() => onSelect(pr.key)}
          className={cn(
            "w-full rounded-md border px-2.5 py-2 text-left transition",
            selectedKey === pr.key
              ? "border-zinc-700 bg-zinc-900 text-zinc-100"
              : "border-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/60 hover:text-zinc-200",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">#{pr.prNumber}</span>
            <ScoreBadge score={pr.confidence} />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-xs">{pr.title}</span>
            <span className="shrink-0">
              <StatusBadge pr={pr} />
            </span>
          </div>
        </button>
      ))}
      {prs.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const now = Date.now()
  return (
    <div className="relative space-y-4">
      <div className="absolute bottom-4 left-3.5 top-4 w-px bg-zinc-800" />
      {events.map((event) => (
        <div key={event.id} className="relative flex gap-3">
          <EventGlyph kind={event.kind} />
          <div className="min-w-0 flex-1 pb-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-zinc-100">{event.title}</span>
                {event.score != null && <ScoreBadge score={event.score} />}
              </div>
              <span className="shrink-0 text-xs text-zinc-600">{ago(event.time, now)}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{event.body}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

const MARKDOWN_OVERRIDES = {
  h1: { props: { className: "mt-4 mb-2 text-base font-semibold text-zinc-100" } },
  h2: { props: { className: "mt-4 mb-2 text-sm font-semibold text-zinc-100" } },
  h3: {
    props: {
      className: "mt-3 mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400",
    },
  },
  p: { props: { className: "my-2 text-sm leading-6 text-zinc-300" } },
  ul: {
    props: {
      className: "my-2 ml-4 list-disc space-y-1 text-sm text-zinc-300 marker:text-zinc-600",
    },
  },
  ol: {
    props: {
      className: "my-2 ml-4 list-decimal space-y-1 text-sm text-zinc-300 marker:text-zinc-600",
    },
  },
  li: { props: { className: "leading-6" } },
  a: {
    props: {
      className:
        "text-sky-300 underline decoration-zinc-700 underline-offset-2 hover:text-sky-200",
      target: "_blank",
      rel: "noreferrer",
    },
  },
  code: {
    props: {
      className: "rounded bg-zinc-800 px-1 py-0.5 font-mono text-[12px] text-zinc-200",
    },
  },
  pre: {
    props: {
      className:
        "my-2 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300",
    },
  },
  strong: { props: { className: "font-semibold text-zinc-100" } },
  hr: { props: { className: "my-3 border-zinc-800" } },
  blockquote: {
    props: {
      className: "my-2 border-l-2 border-zinc-700 pl-3 text-sm italic text-zinc-400",
    },
  },
}

function ReviewReport({ report }: { report: string }) {
  return (
    <div className="[&>*:first-child]:mt-0">
      <Markdown options={{ forceBlock: true, overrides: MARKDOWN_OVERRIDES }}>{report}</Markdown>
    </div>
  )
}

function ReviewDetail({ pr, compact }: { pr: Pr | null; compact: boolean }) {
  if (!pr) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-5 text-sm text-zinc-500">
        Select a PR to see its review history.
      </section>
    )
  }
  const events = buildEvents(pr)
  const latestReport = [...pr.passes].reverse().find((p) => p.report)
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/70">
      <div className="border-b border-zinc-800 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge pr={pr} />
              <ScoreBadge score={pr.confidence} />
            </div>
            <h2 className="mt-3 text-balance text-base font-semibold text-zinc-50">{pr.title}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
              <span>{pr.repo}</span>
              <span className="font-mono">#{pr.prNumber}</span>
              <span>{pr.author}</span>
              <span className="flex items-center gap-1 font-mono">
                <GitCommit className="size-3" />
                {pr.headSha.slice(0, 7)}
              </span>
            </div>
          </div>
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noreferrer"
            title="Open PR on GitHub"
            aria-label="Open PR on GitHub"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-100"
          >
            <ExternalLink className="size-4" />
          </a>
        </div>
      </div>

      <div
        className={cn(
          "grid border-t border-zinc-800",
          compact ? "grid-cols-1" : "grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]",
        )}
      >
        <div className={cn("p-4", !compact && "border-r border-zinc-800")}>
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Activity className="size-3.5" />
            Review loop
          </div>
          <Timeline events={events} />
        </div>

        <div className={cn("p-4", compact && "border-t border-zinc-800")}>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Sparkles className="size-3.5" />
            Summary
          </div>
          {latestReport?.report ? (
            <>
              <ReviewReport report={latestReport.report} />
              {latestReport.reviewUrl && (
                <a
                  href={latestReport.reviewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
                >
                  <ExternalLink className="size-3.5" />
                  View review on GitHub
                </a>
              )}
            </>
          ) : (
            <p className="text-sm leading-6 text-zinc-500">
              No review has been posted for this PR yet.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function ReviewConsole({
  allPrs,
  repoFiltered,
  repos,
  activeRepo,
  selectedPr,
  compact,
  onRepoChange,
  onSelect,
  onAddRepo,
  onRemoveRepo,
}: {
  allPrs: Pr[]
  repoFiltered: Pr[]
  repos: string[]
  activeRepo: string
  selectedPr: Pr | null
  compact: boolean
  onRepoChange: (repo: string) => void
  onSelect: (key: string) => void
  onAddRepo: (repo: string) => void
  onRemoveRepo: (repo: string) => void
}) {
  const [query, setQuery] = useState("")
  const trimmed = query.trim().toLowerCase()
  const visible = trimmed
    ? repoFiltered.filter(
        (pr) =>
          pr.title.toLowerCase().includes(trimmed) ||
          `#${pr.prNumber}`.includes(trimmed) ||
          pr.repo.toLowerCase().includes(trimmed),
      )
    : repoFiltered

  return (
    <div className={cn("p-4", !compact && "p-6")}>
      <div className="mb-4">
        <RepoSegmented
          repos={repos}
          prs={allPrs}
          activeRepo={activeRepo}
          onRepoChange={onRepoChange}
          onAdd={onAddRepo}
          onRemove={onRemoveRepo}
        />
      </div>

      <div className={cn("grid gap-4", compact ? "grid-cols-1" : "grid-cols-[20rem_minmax(0,1fr)]")}>
        <section className="self-start overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70">
          <div className="flex h-10 items-center gap-2 border-b border-zinc-800 px-3 transition focus-within:bg-zinc-900/40">
            <Search className="size-4 shrink-0 text-zinc-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search PRs or repos..."
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
            />
            {query && (
              <button
                type="button"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="text-zinc-500 hover:text-zinc-200"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="p-3">
            <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <span className="flex items-center gap-2">
                <GitPullRequest className="size-3.5" />
                PRs
              </span>
              <span className="text-zinc-600">{visible.length}</span>
            </div>
            <PrList
              prs={visible}
              selectedKey={selectedPr?.key ?? null}
              onSelect={onSelect}
              emptyLabel={trimmed ? "No PRs match your search." : "No reviews for this repository yet."}
            />
          </div>
        </section>
        <ReviewDetail pr={selectedPr} compact={compact} />
      </div>
    </div>
  )
}

export default function App() {
  const prsData = useQuery(api.reviews.prs)
  const reposData = useQuery(api.repos.list)
  const addRepo = useMutation(api.repos.add)
  const removeRepo = useMutation(api.repos.remove)
  const [activeRepo, setActiveRepo] = useState("all")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const isNarrow = useIsNarrowViewport()
  const compact = isNarrow

  const handleAddRepo = (repo: string) => {
    void addRepo({ repo }).then((result) => {
      if (result === "added") setActiveRepo(repo)
    })
  }

  const handleRemoveRepo = (repo: string) => {
    void removeRepo({ repo })
    if (activeRepo === repo) setActiveRepo("all")
  }

  const repoFiltered = useMemo(() => {
    const all = prsData ?? []
    return activeRepo === "all" ? all : all.filter((p) => p.repo === activeRepo)
  }, [prsData, activeRepo])

  const selectedPr = repoFiltered.find((p) => p.key === selectedKey) ?? repoFiltered[0] ?? null

  useEffect(() => {
    if (repoFiltered.length === 0) {
      if (selectedKey !== null) setSelectedKey(null)
      return
    }
    if (!selectedKey || !repoFiltered.some((p) => p.key === selectedKey)) {
      setSelectedKey(repoFiltered[0].key)
    }
  }, [repoFiltered, selectedKey])

  const loading = prsData === undefined || reposData === undefined
  const prs = prsData ?? []
  const repos = reposData ?? []

  return (
    <div className="min-h-full bg-[#080809] text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-[#080809]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3">
          <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
            <GitPullRequest className="size-4 text-sky-300" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">PR Review Console</div>
            <div className="truncate text-xs text-zinc-600">
              Claude Code and Codex review loops
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-3 py-4">
        {loading ? (
          <div className="flex min-h-[60vh] items-center justify-center gap-2 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Loading reviews…
          </div>
        ) : prs.length === 0 ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
            <GitPullRequest className="size-6 text-zinc-700" />
            <div>No reviews yet.</div>
            <div className="text-xs text-zinc-600">
              The worker hasn’t reviewed any pull requests on the watched repos.
            </div>
          </div>
        ) : (
          <ReviewConsole
            allPrs={prs}
            repoFiltered={repoFiltered}
            repos={repos}
            activeRepo={activeRepo}
            selectedPr={selectedPr}
            compact={compact}
            onRepoChange={setActiveRepo}
            onSelect={setSelectedKey}
            onAddRepo={handleAddRepo}
            onRemoveRepo={handleRemoveRepo}
          />
        )}
      </main>
    </div>
  )
}
