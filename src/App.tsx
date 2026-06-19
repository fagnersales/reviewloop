import { useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  ListFilter,
  Loader2,
  Plus,
  Rows3,
  Search,
  Sparkles,
  X,
} from "lucide-react"
import { cn } from "./lib/cn"

type ProviderKey = "codex" | "claude"
type ReviewStatus = "reviewing" | "queued" | "mergeable" | "blocked" | "landed"
type EventKind = "opened" | "review" | "agent" | "commit" | "mergeable" | "blocked"

type Repo = {
  id: string
  name: string
  branch: string
  active: number
  queued: number
  lastSync: string
}

type ReviewEvent = {
  id: string
  kind: EventKind
  title: string
  body: string
  time: string
  score?: number
}

type Review = {
  id: string
  repoId: string
  prNumber: number
  title: string
  author: string
  branch: string
  status: ReviewStatus
  provider: ProviderKey
  model: string
  round: number
  score: number
  progress: number
  findings: string
  commits: number
  checks: string
  updated: string
  currentStep: string
  summary: string
  nextAction: string
  events: ReviewEvent[]
}

const INITIAL_REPOS: Repo[] = [
  {
    id: "prr-console",
    name: "fagnersales/prr-console",
    branch: "main",
    active: 3,
    queued: 1,
    lastSync: "18s ago",
  },
  {
    id: "billing",
    name: "acme/billing-platform",
    branch: "release/2026.06",
    active: 2,
    queued: 0,
    lastSync: "44s ago",
  },
  {
    id: "t3code",
    name: "pingdotgg/t3code",
    branch: "main",
    active: 2,
    queued: 2,
    lastSync: "1m ago",
  },
]

const REVIEWS: Review[] = [
  {
    id: "review-1",
    repoId: "prr-console",
    prNumber: 48,
    title: "Add event timeline for agent review loops",
    author: "fagner",
    branch: "feat/review-events",
    status: "reviewing",
    provider: "codex",
    model: "GPT-5 Codex",
    round: 4,
    score: 4,
    progress: 72,
    findings: "1 P1, 2 P2",
    commits: 7,
    checks: "12/13",
    updated: "23s ago",
    currentStep: "Codex is checking the latest commit range",
    summary:
      "The review started with missing pagination and an unsafe event merge. Two commits landed to normalize timeline ordering, add empty states, and tighten status labels. The current pass is validating mobile behavior before merge.",
    nextAction: "Wait for final smoke check, then merge if the score stays at 4/5.",
    events: [
      {
        id: "r1-e1",
        kind: "opened",
        title: "PR opened",
        body: "Initial timeline surface with mock GitHub events.",
        time: "10:14",
      },
      {
        id: "r1-e2",
        kind: "review",
        title: "PR reviewed",
        body: "Found event ordering bug, missing mobile empty state, and vague merge copy.",
        time: "10:20",
        score: 3,
      },
      {
        id: "r1-e3",
        kind: "agent",
        title: "Agent is working on it",
        body: "Codex applied focused fixes and kept the timeline contract unchanged.",
        time: "10:22",
      },
      {
        id: "r1-e4",
        kind: "commit",
        title: "Commits landed",
        body: "3 commits pushed: event sort, mobile detail stack, summary card.",
        time: "10:31",
      },
      {
        id: "r1-e5",
        kind: "review",
        title: "PR reviewed",
        body: "No blocking defects left. One P2 remains around filter persistence.",
        time: "10:36",
        score: 4,
      },
      {
        id: "r1-e6",
        kind: "agent",
        title: "Agent is working on it",
        body: "Final pass is checking the compact viewport and review summary copy.",
        time: "now",
      },
    ],
  },
  {
    id: "review-2",
    repoId: "billing",
    prNumber: 183,
    title: "Reconcile invoice retry state machine",
    author: "maya",
    branch: "fix/retry-ledger",
    status: "blocked",
    provider: "claude",
    model: "Claude Sonnet 4.5",
    round: 2,
    score: 2,
    progress: 41,
    findings: "2 P1, 4 P2",
    commits: 2,
    checks: "8/10",
    updated: "2m ago",
    currentStep: "Claude Code is waiting on failing retry tests",
    summary:
      "The first pass found a duplicated retry transition that could double-charge pending invoices. The agent patched the transition guard, but two tests still fail because the mock ledger now disagrees with production rounding.",
    nextAction: "Fix the ledger fixture before asking for another agent pass.",
    events: [
      {
        id: "r2-e1",
        kind: "opened",
        title: "PR opened",
        body: "Retry graph moved behind the invoice worker.",
        time: "09:42",
      },
      {
        id: "r2-e2",
        kind: "review",
        title: "PR reviewed",
        body: "Found double-transition risk and missing idempotency assertion.",
        time: "09:48",
        score: 2,
      },
      {
        id: "r2-e3",
        kind: "agent",
        title: "Agent is working on it",
        body: "Claude Code added an idempotency guard and expanded retry tests.",
        time: "09:51",
      },
      {
        id: "r2-e4",
        kind: "commit",
        title: "Commits landed",
        body: "2 commits pushed. Retry guard is fixed, fixtures still fail.",
        time: "10:05",
      },
      {
        id: "r2-e5",
        kind: "blocked",
        title: "Review blocked",
        body: "Test fixture mismatch needs a human decision on rounding.",
        time: "10:08",
      },
    ],
  },
  {
    id: "review-3",
    repoId: "t3code",
    prNumber: 3141,
    title: "Hide disabled providers from model selector",
    author: "tarik02",
    branch: "provider-picker-cleanup",
    status: "mergeable",
    provider: "codex",
    model: "GPT-5 Codex",
    round: 5,
    score: 5,
    progress: 100,
    findings: "0 P0, 0 P1",
    commits: 5,
    checks: "18/18",
    updated: "5m ago",
    currentStep: "Allowed to merge",
    summary:
      "The review found stale disabled providers in the selector rail. The follow-up commits filtered unavailable instances, preserved custom provider order, and added regression coverage for the empty selector state.",
    nextAction: "Merge when the owner is ready.",
    events: [
      {
        id: "r3-e1",
        kind: "opened",
        title: "PR opened",
        body: "Selector cleanup for disabled providers.",
        time: "08:54",
      },
      {
        id: "r3-e2",
        kind: "review",
        title: "PR reviewed",
        body: "Initial implementation hid too much when custom providers were disabled.",
        time: "09:02",
        score: 3,
      },
      {
        id: "r3-e3",
        kind: "agent",
        title: "Agent is working on it",
        body: "Codex narrowed filtering to unavailable instances only.",
        time: "09:10",
      },
      {
        id: "r3-e4",
        kind: "commit",
        title: "Commits landed",
        body: "5 commits pushed with tests and settings copy updates.",
        time: "09:28",
      },
      {
        id: "r3-e5",
        kind: "mergeable",
        title: "PR reviewed",
        body: "Allowed to merge after final provider-order checks passed.",
        time: "09:36",
        score: 5,
      },
    ],
  },
  {
    id: "review-4",
    repoId: "prr-console",
    prNumber: 52,
    title: "Persist repo filters across sessions",
    author: "nina",
    branch: "persist-filters",
    status: "queued",
    provider: "claude",
    model: "Claude Opus 4.5",
    round: 1,
    score: 0,
    progress: 8,
    findings: "not reviewed",
    commits: 1,
    checks: "queued",
    updated: "7m ago",
    currentStep: "Waiting for an available review worker",
    summary:
      "Queued for first pass. The PR changes only client-side state persistence and should be checked for URL/share behavior and local-storage migration edge cases.",
    nextAction: "Start first review when the worker is free.",
    events: [
      {
        id: "r4-e1",
        kind: "opened",
        title: "PR opened",
        body: "Adds local persistence for repo filters.",
        time: "10:07",
      },
    ],
  },
  {
    id: "review-5",
    repoId: "billing",
    prNumber: 177,
    title: "Split webhook ingestion from normalization",
    author: "jo",
    branch: "webhook-normalizer",
    status: "landed",
    provider: "codex",
    model: "GPT-5 Codex Fast",
    round: 3,
    score: 4,
    progress: 100,
    findings: "0 P1, 1 P2",
    commits: 4,
    checks: "15/15",
    updated: "18m ago",
    currentStep: "Merged",
    summary:
      "The review pushed the ingestion split through three passes. The remaining P2 is a naming cleanup that was accepted as follow-up work because the behavior is covered by integration tests.",
    nextAction: "Watch production webhook error rate for the next deploy.",
    events: [
      {
        id: "r5-e1",
        kind: "opened",
        title: "PR opened",
        body: "Separates GitHub delivery ingestion from payload normalization.",
        time: "08:10",
      },
      {
        id: "r5-e2",
        kind: "review",
        title: "PR reviewed",
        body: "Requested replay-safe delivery storage.",
        time: "08:22",
        score: 3,
      },
      {
        id: "r5-e3",
        kind: "commit",
        title: "Commits landed",
        body: "Replay-safe delivery IDs and integration tests landed.",
        time: "08:49",
      },
      {
        id: "r5-e4",
        kind: "mergeable",
        title: "PR reviewed",
        body: "Allowed to merge.",
        time: "09:03",
        score: 4,
      },
      {
        id: "r5-e5",
        kind: "commit",
        title: "Merged",
        body: "Squash merge completed.",
        time: "09:08",
      },
    ],
  },
  {
    id: "review-6",
    repoId: "prr-console",
    prNumber: 39,
    title: "Stream worker logs into the dashboard",
    author: "fagner",
    branch: "feat/worker-log-stream",
    status: "landed",
    provider: "codex",
    model: "GPT-5 Codex",
    round: 3,
    score: 5,
    progress: 100,
    findings: "0 P1, 0 P2",
    commits: 6,
    checks: "14/14",
    updated: "2h ago",
    currentStep: "Merged",
    summary:
      "Three passes tightened backpressure and reconnect logic for the worker log stream. The final review cleared every finding and the change merged after a green deploy preview.",
    nextAction: "No further review needed — merged.",
    events: [
      {
        id: "r6-e1",
        kind: "opened",
        title: "PR opened",
        body: "Adds an SSE channel from the worker to the dashboard.",
        time: "Mon 14:02",
      },
      {
        id: "r6-e2",
        kind: "review",
        title: "PR reviewed",
        body: "Requested reconnect/backoff and a bounded buffer.",
        time: "Mon 14:20",
        score: 3,
      },
      {
        id: "r6-e3",
        kind: "agent",
        title: "Agent is working on it",
        body: "Codex added exponential backoff and a ring buffer.",
        time: "Mon 14:33",
      },
      {
        id: "r6-e4",
        kind: "commit",
        title: "Commits landed",
        body: "4 commits pushed with stream tests.",
        time: "Mon 15:01",
      },
      {
        id: "r6-e5",
        kind: "mergeable",
        title: "PR reviewed",
        body: "Allowed to merge.",
        time: "Mon 15:18",
        score: 5,
      },
      {
        id: "r6-e6",
        kind: "commit",
        title: "Merged",
        body: "Squash merge completed and deployed.",
        time: "Mon 15:24",
      },
    ],
  },
  {
    id: "review-7",
    repoId: "t3code",
    prNumber: 3098,
    title: "Add keyboard shortcuts to the model selector",
    author: "tarik02",
    branch: "selector-hotkeys",
    status: "landed",
    provider: "claude",
    model: "Claude Sonnet 4.5",
    round: 2,
    score: 4,
    progress: 100,
    findings: "0 P1, 1 P2",
    commits: 3,
    checks: "20/20",
    updated: "yesterday",
    currentStep: "Merged",
    summary:
      "The selector gained arrow-key navigation and a quick-open chord. One P2 around focus-trap edge cases was accepted as follow-up because it only affects nested dialogs.",
    nextAction: "No further review needed — merged.",
    events: [
      {
        id: "r7-e1",
        kind: "opened",
        title: "PR opened",
        body: "Keyboard navigation for the provider/model list.",
        time: "Tue 10:11",
      },
      {
        id: "r7-e2",
        kind: "review",
        title: "PR reviewed",
        body: "Asked for roving tabindex and an escape handler.",
        time: "Tue 10:40",
        score: 3,
      },
      {
        id: "r7-e3",
        kind: "agent",
        title: "Agent is working on it",
        body: "Claude Code implemented roving focus and the shortcuts.",
        time: "Tue 11:02",
      },
      {
        id: "r7-e4",
        kind: "commit",
        title: "Commits landed",
        body: "3 commits pushed with accessibility tests.",
        time: "Tue 11:39",
      },
      {
        id: "r7-e5",
        kind: "mergeable",
        title: "PR reviewed",
        body: "Allowed to merge with one P2 follow-up.",
        time: "Tue 12:05",
        score: 4,
      },
      {
        id: "r7-e6",
        kind: "commit",
        title: "Merged",
        body: "Rebase merge completed.",
        time: "Tue 12:11",
      },
    ],
  },
  {
    id: "review-8",
    repoId: "billing",
    prNumber: 165,
    title: "Cache currency conversion rates per request",
    author: "maya",
    branch: "fx-rate-cache",
    status: "landed",
    provider: "codex",
    model: "GPT-5 Codex Fast",
    round: 2,
    score: 5,
    progress: 100,
    findings: "0 P1, 0 P2",
    commits: 4,
    checks: "11/11",
    updated: "3d ago",
    currentStep: "Merged",
    summary:
      "Conversion rates are now memoized per request lifecycle, cutting redundant FX lookups. The review confirmed cache invalidation on rate refresh and merged with full coverage.",
    nextAction: "No further review needed — merged.",
    events: [
      {
        id: "r8-e1",
        kind: "opened",
        title: "PR opened",
        body: "Adds a per-request FX rate cache.",
        time: "Sat 09:20",
      },
      {
        id: "r8-e2",
        kind: "review",
        title: "PR reviewed",
        body: "Requested invalidation on rate refresh.",
        time: "Sat 09:48",
        score: 4,
      },
      {
        id: "r8-e3",
        kind: "agent",
        title: "Agent is working on it",
        body: "Codex wired cache invalidation to the refresh hook.",
        time: "Sat 10:05",
      },
      {
        id: "r8-e4",
        kind: "commit",
        title: "Commits landed",
        body: "2 commits pushed with cache tests.",
        time: "Sat 10:31",
      },
      {
        id: "r8-e5",
        kind: "mergeable",
        title: "PR reviewed",
        body: "Allowed to merge.",
        time: "Sat 10:52",
        score: 5,
      },
      {
        id: "r8-e6",
        kind: "commit",
        title: "Merged",
        body: "Squash merge completed.",
        time: "Sat 10:58",
      },
    ],
  },
]

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

function repoName(repos: Repo[], repoId: string) {
  return repos.find((repo) => repo.id === repoId)?.name ?? repoId
}

function scoreTone(score: number) {
  if (score >= 4) return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
  if (score >= 3) return "border-amber-400/25 bg-amber-400/10 text-amber-200"
  if (score > 0) return "border-red-400/25 bg-red-400/10 text-red-200"
  return "border-zinc-700 bg-zinc-900 text-zinc-500"
}

function statusMeta(status: ReviewStatus) {
  switch (status) {
    case "reviewing":
      return {
        label: "Reviewing",
        icon: Loader2,
        tone: "border-sky-400/25 bg-sky-400/10 text-sky-200",
      }
    case "queued":
      return {
        label: "Queued",
        icon: Clock3,
        tone: "border-zinc-700 bg-zinc-900/80 text-zinc-400",
      }
    case "mergeable":
      return {
        label: "Allowed",
        icon: GitMerge,
        tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
      }
    case "blocked":
      return {
        label: "Blocked",
        icon: AlertTriangle,
        tone: "border-red-400/25 bg-red-400/10 text-red-200",
      }
    case "landed":
      return {
        label: "Merged",
        icon: CheckCircle2,
        tone: "border-violet-400/25 bg-violet-400/10 text-violet-200",
      }
  }
}

function eventIcon(kind: EventKind) {
  switch (kind) {
    case "opened":
      return GitPullRequest
    case "review":
      return Rows3
    case "agent":
      return Loader2
    case "commit":
      return GitCommit
    case "mergeable":
      return GitMerge
    case "blocked":
      return AlertTriangle
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
        kind === "mergeable" && "border-emerald-400/30 text-emerald-300",
        kind === "blocked" && "border-red-400/30 text-red-300",
        kind === "opened" && "border-zinc-700 text-zinc-400",
      )}
    >
      <Icon className={cn("size-3.5", kind === "agent" && "animate-spin")} />
    </span>
  )
}

function StatusBadge({ status }: { status: ReviewStatus }) {
  const meta = statusMeta(status)
  const Icon = meta.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        meta.tone,
      )}
    >
      <Icon className={cn("size-3", status === "reviewing" && "animate-spin")} />
      {meta.label}
    </span>
  )
}

function ScoreBadge({ score }: { score: number }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
        scoreTone(score),
      )}
    >
      {score > 0 ? `${score}/5` : "new"}
    </span>
  )
}

function RepoSegmented({
  repos,
  activeRepo,
  onRepoChange,
  onAddRepo,
}: {
  repos: Repo[]
  activeRepo: string
  onRepoChange: (repoId: string) => void
  onAddRepo: (name: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState("")

  const submit = () => {
    const name = value.trim()
    if (!name) return
    onAddRepo(name)
    setValue("")
    setAdding(false)
  }

  const segments = [
    { id: "all", label: "All", meta: REVIEWS.length, withIcon: true },
    ...repos.map((repo) => ({
      id: repo.id,
      label: repo.name.split("/").pop() ?? repo.name,
      meta: repo.active,
      withIcon: false,
    })),
  ]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex max-w-full overflow-x-auto rounded-md border border-zinc-800">
        {segments.map((segment, index) => (
          <button
            key={segment.id}
            type="button"
            onClick={() => onRepoChange(segment.id)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition",
              index > 0 && "border-l border-zinc-800",
              activeRepo === segment.id
                ? "bg-zinc-800 text-zinc-100"
                : "bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
            )}
          >
            {segment.withIcon && <ListFilter className="size-3.5" />}
            {segment.label}
            <span className="text-[10px] text-zinc-500">{segment.meta}</span>
          </button>
        ))}
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
            className="h-8 w-40 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
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

function PrPicker({
  reviews,
  selectedId,
  onSelect,
  emptyLabel = "No mocked reviews for this repository yet.",
}: {
  reviews: Review[]
  selectedId: string | null
  onSelect: (id: string) => void
  emptyLabel?: string
}) {
  return (
    <div className="space-y-1.5">
      {reviews.map((review) => (
        <button
          key={review.id}
          onClick={() => onSelect(review.id)}
          type="button"
          className={cn(
            "w-full rounded-md border px-2.5 py-2 text-left transition",
            selectedId === review.id
              ? "border-zinc-700 bg-zinc-900 text-zinc-100"
              : "border-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/60 hover:text-zinc-200",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">#{review.prNumber}</span>
            <ScoreBadge score={review.score} />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-xs">{review.title}</span>
            <span className="shrink-0">
              <StatusBadge status={review.status} />
            </span>
          </div>
        </button>
      ))}
      {reviews.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

function ReviewDetail({
  review,
  repos,
  compact,
}: {
  review: Review | null
  repos: Repo[]
  compact: boolean
}) {
  if (!review) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-5 text-sm text-zinc-500">
        Pick a repository with active reviews to see PR context.
      </section>
    )
  }
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/70">
      <div className="border-b border-zinc-800 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={review.status} />
              <ScoreBadge score={review.score} />
            </div>
            <h2 className="mt-3 text-balance text-base font-semibold text-zinc-50">
              {review.title}
            </h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
              <span>{repoName(repos, review.repoId)}</span>
              <span className="font-mono">#{review.prNumber}</span>
              <span>{review.author}</span>
              <span className="flex items-center gap-1">
                <GitBranch className="size-3" />
                {review.branch}
              </span>
            </div>
          </div>
          <a
            href="#"
            onClick={(event) => event.preventDefault()}
            title="Open on GitHub"
            aria-label="Open on GitHub"
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
          <Timeline events={review.events} />
        </div>

        <div className={cn("p-4", compact && "border-t border-zinc-800")}>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Sparkles className="size-3.5" />
            Summary
          </div>
          <p className="text-sm leading-6 text-zinc-300">{review.summary}</p>
          <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-xs leading-5 text-zinc-400">
            <span className="text-zinc-200">Next:</span> {review.nextAction}
          </div>
        </div>
      </div>
    </section>
  )
}

function Timeline({ events }: { events: ReviewEvent[] }) {
  return (
    <div className="relative space-y-4">
      <div className="absolute bottom-4 left-3.5 top-4 w-px bg-zinc-800" />
      {events.map((event) => (
        <div key={event.id} className="relative flex gap-3">
          <EventGlyph kind={event.kind} />
          <div className="min-w-0 flex-1 pb-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-zinc-100">
                  {event.title}
                </span>
                {event.score != null && <ScoreBadge score={event.score} />}
              </div>
              <span className="shrink-0 text-xs text-zinc-600">{event.time}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{event.body}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function ReviewConsole({
  repos,
  reviews,
  activeRepo,
  selectedReview,
  selectedId,
  compact,
  onRepoChange,
  onSelectReview,
  onAddRepo,
}: {
  repos: Repo[]
  reviews: Review[]
  activeRepo: string
  selectedReview: Review | null
  selectedId: string | null
  compact: boolean
  onRepoChange: (repoId: string) => void
  onSelectReview: (id: string) => void
  onAddRepo: (name: string) => void
}) {
  const [query, setQuery] = useState("")
  const trimmed = query.trim().toLowerCase()
  const visibleReviews = trimmed
    ? reviews.filter((review) => {
        const repo = repoName(repos, review.repoId).toLowerCase()
        return (
          review.title.toLowerCase().includes(trimmed) ||
          `#${review.prNumber}`.includes(trimmed) ||
          repo.includes(trimmed)
        )
      })
    : reviews

  return (
    <div className={cn("p-4", !compact && "p-6")}>
      <div className="mb-4">
        <RepoSegmented
          repos={repos}
          activeRepo={activeRepo}
          onRepoChange={onRepoChange}
          onAddRepo={onAddRepo}
        />
      </div>

      <div
        className={cn(
          "grid gap-4",
          compact
            ? "grid-cols-1"
            : "grid-cols-[20rem_minmax(0,1fr)]",
        )}
      >
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
              <span className="text-zinc-600">{visibleReviews.length}</span>
            </div>
            <PrPicker
              reviews={visibleReviews}
              selectedId={selectedId}
              onSelect={onSelectReview}
              emptyLabel={trimmed ? "No PRs match your search." : "No mocked reviews for this repository yet."}
            />
          </div>
        </section>
        <ReviewDetail review={selectedReview} repos={repos} compact={compact} />
      </div>
    </div>
  )
}

export default function App() {
  const [repos, setRepos] = useState(INITIAL_REPOS)
  const [activeRepo, setActiveRepo] = useState("all")
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(REVIEWS[0]?.id ?? null)
  const isNarrowViewport = useIsNarrowViewport()

  const filteredReviews = useMemo(
    () =>
      activeRepo === "all"
        ? REVIEWS
        : REVIEWS.filter((review) => review.repoId === activeRepo),
    [activeRepo],
  )
  const selectedReview =
    filteredReviews.find((review) => review.id === selectedReviewId) ??
    filteredReviews[0] ??
    null
  const compact = isNarrowViewport

  useEffect(() => {
    if (filteredReviews.length === 0) {
      setSelectedReviewId(null)
      return
    }
    if (!selectedReviewId || !filteredReviews.some((review) => review.id === selectedReviewId)) {
      setSelectedReviewId(filteredReviews[0].id)
    }
  }, [filteredReviews, selectedReviewId])

  const addRepo = (name: string) => {
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    if (!id || repos.some((repo) => repo.id === id || repo.name === name)) return
    setRepos((current) => [
      ...current,
      {
        id,
        name,
        branch: "main",
        active: 0,
        queued: 0,
        lastSync: "just now",
      },
    ])
    setActiveRepo(id)
  }

  return (
    <div className="min-h-full bg-[#080809] text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-[#080809]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3">
          <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
            <GitPullRequest className="size-4 text-sky-300" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">
              PR Review Console
            </div>
            <div className="truncate text-xs text-zinc-600">
              Claude Code and Codex review loops
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-3 py-4">
        <ReviewConsole
          repos={repos}
          reviews={filteredReviews}
          activeRepo={activeRepo}
          selectedReview={selectedReview}
          selectedId={selectedReviewId}
          compact={compact}
          onRepoChange={setActiveRepo}
          onSelectReview={setSelectedReviewId}
          onAddRepo={addRepo}
        />
      </main>
    </div>
  )
}
