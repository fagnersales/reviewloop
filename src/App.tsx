import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import {
  Activity,
  AlertTriangle,
  Bot,
  Clock3,
  ExternalLink,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hand,
  Inbox,
  ListFilter,
  Loader2,
  type LucideIcon,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  X,
} from "lucide-react"
import { api } from "../convex/_generated/api"
import { cn } from "./lib/cn"
import { ago } from "./lib/format"
import { CloudLogConsole, ExpandLogButton, RollingTicker } from "./components/cloud-log"
import {
  type Commit,
  type Pass,
  type Pr,
  type TimelineEvent,
  EventGlyph,
  ReviewReport,
  ScoreBadge,
  StatusBadge,
  buildEvents,
  findingsLine,
  githubCommitUrl,
  prTiming,
  repoShort,
  roundCount,
  useIsNarrowViewport,
  useNow,
  useOpenOnly,
} from "./review/kit"
import { MobileView } from "./mobile/MobileView"
import { useReadOnly } from "./read-only"
import { SharePanel } from "./SharePanel"
import { FollowUpsDesktop, FollowUpsMobile } from "./follow-ups/FollowUps"
import { SolvesDesktop, SolvesMobile } from "./solves/Solves"

type AddResult = "added" | "exists" | "invalid" | "full"
function RepoSegmented({
  repos,
  prs,
  activeRepo,
  onRepoChange,
  onAdd,
  onRemove,
  removeError,
}: {
  repos: string[]
  prs: Pr[]
  activeRepo: string
  onRepoChange: (repo: string) => void
  onAdd: (repo: string) => Promise<AddResult>
  onRemove: (repo: string) => void
  removeError: string | null
}) {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  // The hosted (public) console is read-only: no watch-list editing, so the
  // add input and per-repo remove buttons are dropped entirely.
  const readOnly = useReadOnly()
  // GitHub repo slugs are case-insensitive, so compare on lower-case throughout.
  // `repos` carries the stored (user-typed) casing; `prs[].repo` carries GitHub's
  // canonical casing. Dedup on the lower-cased key, preferring the canonical
  // casing from `prs` so each real repo renders as exactly one segment.
  const watched = new Set(repos.map((r) => r.toLowerCase()))
  const byKey = new Map<string, string>()
  for (const repo of repos) byKey.set(repo.toLowerCase(), repo)
  for (const pr of prs) byKey.set(pr.repo.toLowerCase(), pr.repo)
  const repoSet = Array.from(byKey.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

  // Only clear/close on a real add; on invalid/exists keep the input open and
  // surface why, so the backend's verdict reaches the user instead of vanishing.
  const submit = async () => {
    const name = value.trim()
    if (!name) return
    let result: AddResult
    try {
      result = await onAdd(name)
    } catch {
      setError("Couldn’t add — try again")
      return
    }
    if (result === "added") {
      setValue("")
      setError(null)
      setAdding(false)
    } else if (result === "exists") {
      setError("Already watched")
    } else if (result === "full") {
      setError("Watch list is full")
    } else {
      setError("Use owner/name")
    }
  }

  const closeAdd = () => {
    setValue("")
    setError(null)
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
        </button>
        {repoSet.map((repo) => {
          const key = repo.toLowerCase()
          const active = activeRepo.toLowerCase() === key
          const isWatched = watched.has(key)
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
                  isWatched && !readOnly ? "pr-1.5" : "pr-3",
                )}
              >
                {repoShort(repo)}
              </button>
              {isWatched && !readOnly && (
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

      {!readOnly &&
        (adding ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit()
              if (event.key === "Escape") closeAdd()
            }}
            placeholder="owner/repo"
            className={cn(
              "h-8 w-44 rounded-md border bg-zinc-900 px-2.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600",
              error ? "border-red-500/60 focus:border-red-500/60" : "border-zinc-700 focus:border-zinc-500",
            )}
          />
          <button
            type="button"
            onClick={() => void submit()}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
          >
            Add
          </button>
          {error && (
            <span className="text-xs text-red-300" role="alert">
              {error}
            </span>
          )}
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
        ))}

      {removeError && (
        <span className="text-xs text-red-300" role="alert">
          {removeError}
        </span>
      )}
    </div>
  )
}

function PrList({
  prs,
  selectedKey,
  onSelect,
  emptyLabel,
  showRepo,
}: {
  prs: Pr[]
  selectedKey: string | null
  onSelect: (key: string) => void
  emptyLabel: string
  showRepo: boolean
}) {
  const now = useNow()
  return (
    <div className="space-y-1.5">
      {prs.map((pr) => {
        const timing = prTiming(pr, now)
        const rounds = roundCount(pr)
        return (
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
            {/* Title leads; the review score (the point of the console) is the
                one badge that earns the top line. */}
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{pr.title}</span>
              <ScoreBadge score={pr.confidence} />
            </div>
            {/* Everything secondary collapses into one muted line: repo · #num ·
                timing · rounds on the left, lifecycle status on the right. */}
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
              <span className="flex min-w-0 items-center gap-2">
                {showRepo && <span className="truncate">{repoShort(pr.repo)}</span>}
                <span className="shrink-0 font-mono">#{pr.prNumber}</span>
                {timing && (
                  <span className="inline-flex shrink-0 items-center gap-1" title={timing.title}>
                    <Clock3 className="size-3" />
                    {timing.span}
                  </span>
                )}
                {rounds > 1 && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1"
                    title={`${rounds} review rounds`}
                  >
                    <RotateCw className="size-3" />
                    {rounds}
                  </span>
                )}
              </span>
              <StatusBadge pr={pr} />
            </div>
          </button>
        )
      })}
      {prs.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

// The review loop. Every step is a button: clicking it drives the detail panel
// to the right (a review's summary, a commit's GitHub-style view, …). The rail
// runs through the glyph centers; `-mx-2` lets the selected row's highlight bleed
// past the content while the glyphs stay aligned to the rail.
function Timeline({
  events,
  selectedId,
  onSelect,
}: {
  events: TimelineEvent[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const now = useNow()
  return (
    <div className="relative space-y-1">
      <div className="absolute bottom-[1.375rem] left-3.5 top-[1.375rem] w-px bg-zinc-800" />
      {events.map((event) => {
        const selected = event.id === selectedId
        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelect(event.id)}
            aria-pressed={selected}
            className={cn(
              "relative -mx-2 flex w-[calc(100%+1rem)] gap-3 rounded-md border px-2 py-2 text-left transition",
              selected
                ? "border-zinc-700 bg-zinc-900/80"
                : "border-transparent hover:bg-zinc-900/40",
            )}
          >
            <EventGlyph kind={event.kind} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-100">{event.title}</span>
                  {event.score != null && <ScoreBadge score={event.score} />}
                </div>
                <span className="shrink-0 text-xs text-zinc-600">{ago(event.time, now)}</span>
              </div>
              <p className="mt-1 truncate text-xs leading-5 text-zinc-500">{event.body}</p>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function PanelHeader({ icon: Icon, label, spin }: { icon: LucideIcon; label: string; spin?: boolean }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
      <Icon className={cn("size-3.5", spin && "animate-spin")} />
      {label}
    </div>
  )
}

function GitHubLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
    >
      <ExternalLink className="size-3.5" />
      {label}
    </a>
  )
}

// A hollow node on the commits rail — the GitHub commit-dot look.
function CommitNode() {
  return (
    <span className="relative z-10 flex size-7 shrink-0 items-center justify-center">
      <span className="flex size-3.5 items-center justify-center rounded-full border-2 border-zinc-600 bg-zinc-950">
        <span className="size-1 rounded-full bg-zinc-500" />
      </span>
    </span>
  )
}

function CommitAvatar({ url, author }: { url?: string; author: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-5 shrink-0 rounded-full border border-zinc-800 bg-zinc-900"
      />
    )
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-[9px] font-semibold uppercase text-zinc-400">
      {author.slice(0, 1)}
    </span>
  )
}

// The LOC delta GitHub shows next to a commit: +additions in green, −deletions in red.
function LocDelta({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono tabular-nums">
      <span className="text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-400">−{deletions}</span>
    </span>
  )
}

// The view a "Commits landed" step opens: the commits that landed in that push,
// as GitHub lists them — a rail of nodes, the author avatar, the commit message
// linking to GitHub, the author, the LOC delta, and the SHA. No review verdicts:
// a review covers the whole push, not individual commits.
function CommitsPanel({ pr, pass }: { pr: Pr; pass?: Pass }) {
  const commits = pass?.commits ?? []
  if (commits.length === 0) {
    return (
      <div>
        <PanelHeader icon={GitCommit} label="Commits" />
        <div className="rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 p-3 text-xs leading-5 text-zinc-500">
          The commit list for this push hasn’t been captured yet.
          {pass?.headSha && (
            <>
              {" "}
              <a
                href={githubCommitUrl(pr.repo, pass.headSha)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
              >
                {pass.headSha.slice(0, 7)}
              </a>{" "}
              on GitHub.
            </>
          )}
        </div>
      </div>
    )
  }
  return (
    <div>
      <PanelHeader icon={GitCommit} label={`Commits · ${commits.length}`} />
      <ol className="relative">
        {commits.map((c: Commit, i) => {
          const first = i === 0
          const last = i === commits.length - 1
          return (
            <li key={c.sha} className="relative flex items-start gap-3 py-2">
              {commits.length > 1 && (
                // Per-row rail segment: rows wrap to varied heights, so a single
                // fixed-height line can't connect the node dots — each row draws
                // its own segment from/through its dot (top-trimmed on the first
                // row, bottom-trimmed on the last).
                <span
                  className={cn(
                    "absolute left-3.5 w-px bg-zinc-800",
                    first ? "bottom-0 top-[1.375rem]" : last ? "top-0 h-[1.375rem]" : "inset-y-0",
                  )}
                />
              )}
              <CommitNode />
              <CommitAvatar url={c.avatarUrl} author={c.author} />
              <div className="min-w-0 flex-1">
                <a
                  href={githubCommitUrl(pr.repo, c.sha)}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-sm font-medium text-zinc-100 underline-offset-2 hover:text-sky-200 hover:underline"
                >
                  {c.message}
                </a>
                <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                  <span className="truncate">{c.author}</span>
                  <LocDelta additions={c.additions} deletions={c.deletions} />
                  <a
                    href={githubCommitUrl(pr.repo, c.sha)}
                    target="_blank"
                    rel="noreferrer"
                    title="View commit on GitHub"
                    className="shrink-0 font-mono text-zinc-500 underline-offset-2 transition hover:text-zinc-200 hover:underline"
                  >
                    {c.sha.slice(0, 7)}
                  </a>
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// A small "what is this step" card for the loop anchors (opened / merged / closed
// / failed / in-flight) — the steps that aren't a full review or a commit list.
function InfoCard({
  tone,
  icon,
  title,
  body,
  spin,
}: {
  tone: string
  icon: LucideIcon
  title: string
  body: string
  spin?: boolean
}) {
  const Icon = icon
  return (
    <div className="flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border", tone)}>
        <Icon className={cn("size-3.5", spin && "animate-spin")} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{body}</p>
      </div>
    </div>
  )
}

// The contextual detail panel: it renders whatever the selected review-loop step
// is "about" — a review's summary, a commit's GitHub view, or a step info card.
function EventDetail({
  pr,
  event,
  passById,
}: {
  pr: Pr
  event: TimelineEvent | null
  passById: Map<string, Pass>
}) {
  const now = useNow()
  if (!event) return null

  if (event.kind === "commit") {
    return <CommitsPanel pr={pr} pass={event.passId ? passById.get(event.passId) : undefined} />
  }

  if (event.kind === "review") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    return (
      <div>
        <PanelHeader icon={Sparkles} label="Review summary" />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ScoreBadge score={pass?.confidence} />
          <span className="rounded-md border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 text-[11px] text-zinc-400">
            {findingsLine(pass ?? {})}
          </span>
          {event.headSha && (
            <a
              href={githubCommitUrl(pr.repo, event.headSha)}
              target="_blank"
              rel="noreferrer"
              title="View commit on GitHub"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              <GitCommit className="size-3" />
              {event.headSha.slice(0, 7)}
            </a>
          )}
        </div>
        {pass?.report ? (
          <ReviewReport report={pass.report} />
        ) : (
          <p className="text-sm leading-6 text-zinc-500">
            No written summary was posted for this review.
          </p>
        )}
        {pass?.reviewUrl && <GitHubLink href={pass.reviewUrl} label="View review on GitHub" />}
        {pass && <PassSessionLog reviewId={pass._id} />}
      </div>
    )
  }

  if (event.kind === "agent") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    const reviewing = pass?.status === "reviewing"
    return (
      <div>
        <PanelHeader
          icon={reviewing ? Loader2 : Clock3}
          label={reviewing ? "Reviewing" : "Queued"}
          spin={reviewing}
        />
        {/* During a re-review (a prior report already exists, so we're in the
            two-column view) the live cloud-log carries the status itself — its
            header is "Agent is reviewing this commit", mirroring the first-review
            hero's single-card language. */}
        {reviewing && pass ? (
          <AgentReviewingCard reviewId={pass._id} />
        ) : (
          <InfoCard
            tone="border-zinc-700 text-zinc-400"
            icon={Clock3}
            title="Queued for review"
            body="Waiting for an available review worker."
          />
        )}
      </div>
    )
  }

  if (event.kind === "ack") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    return (
      <div>
        <PanelHeader icon={Hand} label="Picked up by an agent" />
        <InfoCard
          tone="border-indigo-400/30 text-indigo-300"
          icon={Hand}
          title={`Acked by ${pass?.ackedBy ?? "an agent"}`}
          body={`Picked up ${ago(event.time, now)} — an agent is working on the findings. Stays "In progress" until a fix is pushed (or the ack goes stale and it reverts to "Awaiting agent").`}
        />
        {pass?.reviewUrl && <GitHubLink href={pass.reviewUrl} label="View review on GitHub" />}
      </div>
    )
  }

  if (event.kind === "failed") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    return (
      <div>
        <PanelHeader icon={AlertTriangle} label="Review failed" />
        <InfoCard
          tone="border-red-400/30 text-red-300"
          icon={AlertTriangle}
          title="The review run didn’t complete"
          body={pass?.error ?? event.body}
        />
        {pass && <PassSessionLog reviewId={pass._id} />}
      </div>
    )
  }

  if (event.kind === "opened") {
    // The opening push is a "Commits landed" with no SHA-change marker, so its
    // commits are surfaced here — the only place they're reachable in the loop.
    const pass = event.passId ? passById.get(event.passId) : undefined
    return (
      <div>
        <PanelHeader icon={GitPullRequest} label="Pull request opened" />
        <InfoCard
          tone="border-zinc-700 text-zinc-400"
          icon={GitPullRequest}
          title={`Opened by ${pr.author}`}
          body={`This review loop started ${ago(event.time, now)}.`}
        />
        <GitHubLink href={pr.prUrl} label="View pull request on GitHub" />
        {pass?.commits && pass.commits.length > 0 && (
          <div className="mt-5">
            <CommitsPanel pr={pr} pass={pass} />
          </div>
        )}
      </div>
    )
  }

  // merged | closed
  const merged = event.kind === "merged"
  return (
    <div>
      <PanelHeader icon={merged ? GitMerge : GitPullRequestClosed} label={merged ? "Merged" : "Closed"} />
      <InfoCard
        tone={merged ? "border-violet-400/30 text-violet-300" : "border-zinc-700 text-zinc-400"}
        icon={merged ? GitMerge : GitPullRequestClosed}
        title={merged ? "PR merged on GitHub" : "PR closed without merging"}
        body={
          merged
            ? "No further review is needed for this pull request."
            : "This pull request was closed without merging."
        }
      />
      <GitHubLink href={pr.prUrl} label="View pull request on GitHub" />
    </div>
  )
}


// Muted-by-default metadata links in the PR header: they read as plain caption
// text until hovered, when they reveal their clickability.
const META_LINK = "rounded-sm underline-offset-2 transition hover:text-zinc-200 hover:underline"

// The first-review "hero": a calm centered focal point — a spinner, the line
// "Claude is reviewing the PR…", and the live cloud-log in a single flat,
// width-constrained card (no nested card, no count, no subtitle). Subscribes to
// `reviewLog` — the complete, durable history the worker appended server-side —
// so opening the dashboard mid-review (or remounting on PR reselect) shows every
// line, not just what this tab observed since mount. The card only appears once
// the first line lands; until then it's just the title.
function ReviewingHero({ reviewId }: { reviewId: Pass["_id"] }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="size-6 animate-spin text-sky-300" />
        <p className="text-base font-medium text-zinc-100">Claude is reviewing the PR…</p>
      </div>
      {lines.length > 0 && (
        <div className="relative w-full max-w-lg overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70 p-1.5">
          <ExpandLogButton lines={lines} streaming title="Cloud review" className="absolute right-2 top-2 z-20" />
          {/* Height fits six rows so the oldest just fades at the top edge —
              no dead band above the log. */}
          <div className="h-[168px]">
            <RollingTicker lines={lines} maxVisible={6} streaming />
          </div>
        </div>
      )}
    </div>
  )
}

// The live cloud-log for a re-review round (a prior report already exists, so
// we're in the two-column loop view). The status *is* the card header — "Agent
// is reviewing this commit" with the log streaming below — so the re-review
// surface mirrors the first-review hero's single-card language. Falls back to a
// plain info card until the first line lands.
function AgentReviewingCard({ reviewId }: { reviewId: Pass["_id"] }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  if (lines.length === 0) {
    return (
      <InfoCard
        tone="border-sky-400/30 text-sky-300"
        icon={Loader2}
        title="Agent is reviewing this commit"
        body="The summary will appear here once the review is posted."
        spin
      />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Loader2 className="size-4 shrink-0 animate-spin text-sky-300" />
          <span className="truncate text-sm font-medium text-zinc-100">Agent is reviewing this commit</span>
        </div>
        <ExpandLogButton lines={lines} streaming title="Cloud review" />
      </header>
      <div className="p-1.5">
        <div className="h-[140px]">
          <RollingTicker lines={lines} maxVisible={5} streaming />
        </div>
      </div>
    </div>
  )
}

// The persisted log of a *finished* pass — the durable record that outlives the
// live ticker. Rendered non-streaming, so every line shows its severity dot,
// including the terminal green `done` / red `error` (the live ticker can't: its
// newest line is always the blue active pulse, and it unmounts the moment the
// pass leaves "reviewing"). Self-hides for passes with no persisted lines, e.g.
// ones reviewed before this log existed.
function PassSessionLog({ reviewId }: { reviewId: Pass["_id"] }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  if (lines.length === 0) return null
  return (
    <div className="mt-4">
      <CloudLogConsole lines={lines} streaming={false} title="Session log" />
    </div>
  )
}

// The PR-header timing item. Owns its own ticker so only this leaf re-renders
// each second — keeping the per-second clock off ReviewDetail, whose Markdown
// report would otherwise re-parse on every tick.
function MetaTiming({ pr }: { pr: Pr }) {
  const now = useNow()
  const timing = prTiming(pr, now)
  if (!timing) return null
  return (
    <span className="flex items-center gap-1" title={timing.title}>
      <Clock3 className="size-3" />
      {timing.header}
    </span>
  )
}

// The final human gate: squash-merge a reviewed PR from the console. Records intent
// (reviews.requestMerge); the worker runs `gh pr merge` (it holds gh auth and the
// merge respects branch protection). Only shows on an open, reviewed PR, and never
// in the read-only public build (it's a write). A confirm step guards the
// irreversible action and warns when the review still has P0/P1 blockers; a failed
// attempt surfaces its reason and flips to "Retry merge".
function MergeButton({ pr }: { pr: Pr }) {
  const readOnly = useReadOnly()
  const requestMerge = useMutation(api.reviews.requestMerge)
  const [confirming, setConfirming] = useState(false)

  if (readOnly || pr.status !== "reviewed" || pr.prState) return null

  // Worker is mid-merge.
  if (pr.mergeRequestedAt != null) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-xs font-medium text-violet-200">
        <Loader2 className="size-3.5 animate-spin" />
        Merging…
      </span>
    )
  }

  const blockers = (pr.p0 ?? 0) > 0 || (pr.p1 ?? 0) > 0
  const submit = () => {
    void requestMerge({ repo: pr.repo, prNumber: pr.prNumber, by: "dashboard" })
    setConfirming(false)
  }

  if (confirming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] text-zinc-500">{blockers ? "Has P0/P1 —" : "Squash-merge?"}</span>
        <button
          type="button"
          onClick={submit}
          className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/15 px-2 py-1.5 text-xs font-medium text-violet-100 transition hover:bg-violet-500/25"
        >
          <GitMerge className="size-3.5" />
          Confirm
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md border border-zinc-800 px-2 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          Cancel
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      title={
        pr.mergeError
          ? `Last merge attempt failed: ${pr.mergeError}`
          : "Squash-merge and delete the branch"
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
        pr.mergeError
          ? "border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20"
          : "border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20",
      )}
    >
      <GitMerge className="size-3.5" />
      {pr.mergeError ? "Retry merge" : "Merge"}
    </button>
  )
}

function ReviewDetail({
  pr,
  hasPrs,
  isAll,
}: {
  pr: Pr | null
  hasPrs: boolean
  isAll: boolean
}) {
  const events = useMemo(() => (pr ? buildEvents(pr) : []), [pr])
  const passById = useMemo(
    () => new Map<string, Pass>((pr?.passes ?? []).map((p) => [p._id, p])),
    [pr],
  )
  // Default selection = the most recent review that has a summary, so opening a
  // PR lands on its latest summary (matching the old always-latest behavior).
  const defaultEventId = useMemo(() => {
    const latestReview = [...events]
      .reverse()
      .find((e) => e.kind === "review" && passById.get(e.passId ?? "")?.report)
    return latestReview?.id ?? events[events.length - 1]?.id ?? null
  }, [events, passById])

  const [selectedId, setSelectedId] = useState<string | null>(defaultEventId)
  // Reset to the default only when the PR itself changes — keep the user's pick
  // stable as live data streams into the same PR.
  const prKey = pr?.key ?? null
  const lastKeyRef = useRef(prKey)
  useEffect(() => {
    if (lastKeyRef.current !== prKey) {
      lastKeyRef.current = prKey
      setSelectedId(defaultEventId)
    }
  }, [prKey, defaultEventId])

  // Opening a PR scrolls the review loop to its latest step.
  const loopRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = loopRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [prKey])

  if (!pr) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-5 text-sm text-zinc-500">
        {hasPrs
          ? "Select a PR to see its review history."
          : isAll
            ? "No reviews yet. Reviews appear here once the worker reviews a PR on a watched repo."
            : "No reviews for this repository yet. Reviews will appear here once the worker reviews a PR on a watched repo."}
      </section>
    )
  }
  const latestReport = [...pr.passes].reverse().find((p) => p.report)
  // The pass `claude -p /pr-review` is running right now (if any) — the source of
  // the live cloud-log. When the PR is reviewing, it's the newest pass.
  const reviewingPass = [...pr.passes].reverse().find((p) => p.status === "reviewing")
  const selectedEvent =
    events.find((e) => e.id === selectedId) ??
    events.find((e) => e.id === defaultEventId) ??
    null
  // With no report yet (the PR's first review), the whole detail body becomes
  // one centered status state; shape its icon/copy from the live status.
  const firstReviewError =
    pr.status === "failed" ? [...pr.passes].reverse().find((p) => p.error)?.error : undefined
  const firstReview =
    pr.status === "failed"
      ? {
          tone: "border-red-400/25 bg-red-400/10 text-red-300",
          icon: <AlertTriangle className="size-5" />,
          title: "Review didn’t complete",
          body: firstReviewError ?? "The review run errored or timed out before a summary was posted.",
        }
      : pr.status === "queued"
        ? {
            tone: "border-zinc-700 bg-zinc-900 text-zinc-400",
            icon: <Clock3 className="size-5" />,
            title: "Queued for review",
            body: "Waiting for an available review worker. The summary will appear here once the review is posted.",
          }
        : pr.status === "reviewing"
          ? {
              tone: "border-sky-400/25 bg-sky-400/10 text-sky-300",
              icon: <Loader2 className="size-5 animate-spin" />,
              title: "Reviewing this PR…",
              body: "The agent is reviewing the first commit. The summary will appear here once it’s done.",
            }
          : {
              tone: "border-zinc-700 bg-zinc-900 text-zinc-500",
              icon: <Sparkles className="size-5" />,
              title: "No review yet",
              body: "No review has been posted for this PR yet.",
            }
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-950/70">
      <div className="shrink-0 border-b border-zinc-800 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge pr={pr} />
              <ScoreBadge score={pr.confidence} />
            </div>
            <h2 className="mt-3 text-balance text-base font-semibold text-zinc-50">{pr.title}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
              <a
                href={`https://github.com/${pr.repo}`}
                target="_blank"
                rel="noreferrer"
                title={`Open ${pr.repo} on GitHub`}
                className={META_LINK}
              >
                {pr.repo}
              </a>
              <a
                href={pr.prUrl}
                target="_blank"
                rel="noreferrer"
                title="Open this PR on GitHub"
                className={cn(META_LINK, "font-mono")}
              >
                #{pr.prNumber}
              </a>
              <a
                href={`https://github.com/${pr.author}`}
                target="_blank"
                rel="noreferrer"
                title={`Open @${pr.author} on GitHub`}
                className={META_LINK}
              >
                {pr.author}
              </a>
              <a
                href={`https://github.com/${pr.repo}/commit/${pr.headSha}`}
                target="_blank"
                rel="noreferrer"
                title="Open this commit on GitHub"
                className={cn(META_LINK, "flex items-center gap-1 font-mono")}
              >
                <GitCommit className="size-3" />
                {pr.headSha.slice(0, 7)}
              </a>
              <MetaTiming pr={pr} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <MergeButton pr={pr} />
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
      </div>

      {latestReport?.report ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] grid-rows-1 border-t border-zinc-800">
          <div ref={loopRef} className="min-h-0 overflow-y-auto border-r border-zinc-800 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Activity className="size-3.5" />
              Review loop
            </div>
            <Timeline events={events} selectedId={selectedEvent?.id ?? null} onSelect={setSelectedId} />
          </div>

          <div className="min-h-0 overflow-y-auto p-4">
            <EventDetail pr={pr} event={selectedEvent} passById={passById} />
          </div>
        </div>
      ) : (
        // No report yet (the PR's first review): one centered state spanning the
        // whole body, instead of a sparse two-column split with an empty Summary.
        <div className="flex min-h-0 flex-1 flex-col border-t border-zinc-800">
          {reviewingPass ? (
            // Actively reviewing: the cloud-review hero `claude -p /pr-review` is
            // producing right now. Keyed per review pass so switching PRs / new
            // commits start fresh.
            <ReviewingHero key={reviewingPass._id} reviewId={reviewingPass._id} />
          ) : (
            // Queued / failed / no-review-yet: a simple centered status.
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <span className={cn("flex size-11 items-center justify-center rounded-full border", firstReview.tone)}>
                {firstReview.icon}
              </span>
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-zinc-200">{firstReview.title}</p>
                <p className="mx-auto max-w-[42ch] text-xs leading-5 text-zinc-500">{firstReview.body}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ReviewConsole({
  allPrs,
  repoFiltered,
  repos,
  activeRepo,
  selectedPr,
  onRepoChange,
  onSelect,
  onAddRepo,
  onRemoveRepo,
  removeError,
}: {
  allPrs: Pr[]
  repoFiltered: Pr[]
  repos: string[]
  activeRepo: string
  selectedPr: Pr | null
  onRepoChange: (repo: string) => void
  onSelect: (key: string) => void
  onAddRepo: (repo: string) => Promise<AddResult>
  onRemoveRepo: (repo: string) => void
  removeError: string | null
}) {
  const [query, setQuery] = useState("")
  const [openOnly, setOpenOnly] = useOpenOnly()
  const trimmed = query.trim().toLowerCase()
  // `prState` is undefined for open PRs and "merged"/"closed" otherwise, so
  // "open only" is just the rows with no terminal state.
  const stateFiltered = openOnly ? repoFiltered.filter((pr) => pr.prState == null) : repoFiltered
  const visible = trimmed
    ? stateFiltered.filter(
        (pr) =>
          pr.title.toLowerCase().includes(trimmed) ||
          `#${pr.prNumber}`.includes(trimmed) ||
          pr.repo.toLowerCase().includes(trimmed),
      )
    : stateFiltered

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4 shrink-0">
        <RepoSegmented
          repos={repos}
          prs={allPrs}
          activeRepo={activeRepo}
          onRepoChange={onRepoChange}
          onAdd={onAddRepo}
          onRemove={onRemoveRepo}
          removeError={removeError}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[20rem_minmax(0,1fr)] grid-rows-1 gap-4">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 px-3 transition focus-within:bg-zinc-900/40">
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
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="mb-2 flex items-center justify-between gap-2 px-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <span className="flex items-center gap-2">
                <GitPullRequest className="size-3.5" />
                PRs
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpenOnly((v) => !v)}
                  aria-pressed={openOnly}
                  title={openOnly ? "Showing open PRs only — click to show all" : "Show only open PRs"}
                  className={cn(
                    "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition",
                    openOnly
                      ? "border-zinc-600 bg-zinc-800 text-zinc-200"
                      : "border-zinc-800 bg-zinc-950 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300",
                  )}
                >
                  <ListFilter className="size-3" />
                  Open only
                </button>
                <span className="text-zinc-600">{visible.length}</span>
              </div>
            </div>
            <PrList
              prs={visible}
              selectedKey={selectedPr?.key ?? null}
              onSelect={onSelect}
              showRepo={activeRepo === "all"}
              emptyLabel={
                trimmed
                  ? "No PRs match your search."
                  : openOnly
                    ? "No open PRs."
                    : activeRepo === "all"
                      ? "No reviews yet."
                      : "No reviews for this repository yet."
              }
            />
          </div>
        </section>
        <ReviewDetail pr={selectedPr} hasPrs={repoFiltered.length > 0} isAll={activeRepo === "all"} />
      </div>
    </div>
  )
}

// ── top-level nav (Reviews ⇄ Follow-ups ⇄ Solves) ────────────────────────────
// The console is three views behind one chrome: the PR-review board, the
// PR-follow-ups inbox, and the autonomous-solver status. Desktop gets a slim left
// rail; below the narrow breakpoint they collapse to a bottom tab bar (mobile-native).
type View = "reviews" | "follow-ups" | "solves"
const VIEWS: readonly View[] = ["reviews", "follow-ups", "solves"]
const VIEW_KEY = "prr.view"

// Remember the last view across reloads (a view preference, like useOpenOnly).
function useView() {
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "reviews"
    const stored = window.localStorage.getItem(VIEW_KEY)
    return (VIEWS as readonly string[]).includes(stored ?? "") ? (stored as View) : "reviews"
  })
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_KEY, view)
  }, [view])
  return [view, setView] as const
}

function NavLogo() {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
      <GitPullRequest className="size-4 text-sky-300" />
    </div>
  )
}

function RailBtn({
  active,
  onClick,
  icon: Icon,
  label,
  count = 0,
}: {
  active: boolean
  onClick: () => void
  icon: LucideIcon
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "relative flex size-10 items-center justify-center rounded-md border transition",
        active
          ? "border-zinc-700 bg-zinc-800 text-zinc-100"
          : "border-transparent text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200",
      )}
    >
      <Icon className="size-5" />
      {count > 0 && (
        <span className="absolute -right-1 -top-1 inline-flex min-w-[1rem] items-center justify-center rounded-full border border-[#080809] bg-amber-400 px-1 text-[10px] font-bold text-zinc-900">
          {count}
        </span>
      )}
    </button>
  )
}

function BottomTab({
  active,
  onClick,
  icon: Icon,
  label,
  count = 0,
}: {
  active: boolean
  onClick: () => void
  icon: LucideIcon
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition",
        active ? "text-amber-200" : "text-zinc-500",
      )}
    >
      <span className="relative">
        <Icon className="size-5" />
        {count > 0 && (
          <span className="absolute -right-2.5 -top-1.5 inline-flex min-w-[0.9rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-zinc-900">
            {count}
          </span>
        )}
      </span>
      {label}
    </button>
  )
}

export default function App() {
  const prsData = useQuery(api.reviews.prs)
  const reposData = useQuery(api.repos.list)
  const addRepo = useMutation(api.repos.add)
  const removeRepo = useMutation(api.repos.remove)
  const [activeRepo, setActiveRepo] = useState("all")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const isNarrow = useIsNarrowViewport()
  const [view, setView] = useView()
  // The pending-decision count drives the Follow-ups nav badge. A tiny dedicated
  // query so the Reviews view shows it without loading the whole inbox.
  const pending = useQuery(api.suggestedIssues.pendingCount) ?? 0
  // In-flight solves (queued + building) drive the Solves nav badge — same
  // lightweight-count pattern.
  const solving = useQuery(api.solveTasks.activeCount) ?? 0

  // Clearing the stale remove banner on any deliberate navigation/add keeps a
  // failed-remove message from outliving its relevance across unrelated actions.
  const handleRepoChange = (repo: string) => {
    setRemoveError(null)
    setActiveRepo(repo)
  }

  const handleAddRepo = (repo: string) =>
    addRepo({ repo }).then((result) => {
      if (result === "added") {
        setRemoveError(null)
        setActiveRepo(repo)
      }
      return result
    })

  const handleRemoveRepo = (repo: string) => {
    setRemoveError(null)
    // Repo slugs are case-insensitive, so compare on lower-case. Only fall
    // back to All once removal actually succeeds and the segment would
    // disappear (no reviews keep it visible) — a failed remove must not
    // navigate away from a repo that's still watched and present.
    const key = repo.toLowerCase()
    const wouldDisappear =
      activeRepo.toLowerCase() === key && !(prsData ?? []).some((p) => p.repo.toLowerCase() === key)
    void removeRepo({ repo })
      .then(() => {
        if (wouldDisappear) setActiveRepo("all")
      })
      .catch(() => {
        setRemoveError(`Couldn’t remove ${repoShort(repo)} — try again`)
      })
  }

  const repoFiltered = useMemo(() => {
    const all = prsData ?? []
    if (activeRepo === "all") return all
    // Repo slugs are case-insensitive; `activeRepo` may carry the stored casing
    // while `p.repo` carries GitHub's canonical casing.
    const key = activeRepo.toLowerCase()
    return all.filter((p) => p.repo.toLowerCase() === key)
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

  // Below the breakpoint the desktop two-pane layout can't breathe, so the app
  // hands off to a purpose-built mobile view (drill-down list → PR detail) rather
  // than collapsing the panes into one long scroll, with a bottom tab bar to swap
  // between Reviews and Follow-ups. h-dvh (not h-screen/100vh) so the bottom sheet
  // and tab bar aren't clipped behind a mobile browser's retracting toolbar.
  if (isNarrow) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-[#080809] text-zinc-100">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {view === "follow-ups" ? (
            <FollowUpsMobile />
          ) : view === "solves" ? (
            <SolvesMobile />
          ) : loading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
              <Loader2 className="size-4 animate-spin" />
              Loading reviews…
            </div>
          ) : (
            <MobileView prs={prs} />
          )}
        </div>
        <nav className="flex shrink-0 border-t border-zinc-800/80">
          <BottomTab active={view === "reviews"} onClick={() => setView("reviews")} icon={GitPullRequest} label="Reviews" />
          <BottomTab
            active={view === "follow-ups"}
            onClick={() => setView("follow-ups")}
            icon={Inbox}
            label="Follow-ups"
            count={pending}
          />
          <BottomTab
            active={view === "solves"}
            onClick={() => setView("solves")}
            icon={Bot}
            label="Solves"
            count={solving}
          />
        </nav>
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#080809] text-zinc-100">
      {/* Slim icon rail: Reviews (the board) ⇄ Follow-ups (the inbox). */}
      <aside className="flex w-14 shrink-0 flex-col items-center gap-1.5 border-r border-zinc-800/80 py-3">
        <div className="mb-2">
          <NavLogo />
        </div>
        <RailBtn active={view === "reviews"} onClick={() => setView("reviews")} icon={GitPullRequest} label="Reviews" />
        <RailBtn
          active={view === "follow-ups"}
          onClick={() => setView("follow-ups")}
          icon={Inbox}
          label="Follow-ups"
          count={pending}
        />
        <RailBtn
          active={view === "solves"}
          onClick={() => setView("solves")}
          icon={Bot}
          label="Solves"
          count={solving}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-[#080809]/95 px-4 py-3 backdrop-blur">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">
              {view === "follow-ups"
                ? "PR Follow-ups"
                : view === "solves"
                  ? "Autonomous Solves"
                  : "PR Review Console"}
            </div>
            {view === "reviews" && (
              <div className="truncate text-xs text-zinc-600">Claude Code and Codex review loops</div>
            )}
          </div>
          <div className="ml-auto shrink-0">
            <SharePanel />
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {view === "follow-ups" ? (
            <FollowUpsDesktop />
          ) : view === "solves" ? (
            <SolvesDesktop />
          ) : loading ? (
            <div className="flex min-h-[60vh] flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
              <Loader2 className="size-4 animate-spin" />
              Loading reviews…
            </div>
          ) : (
            <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-3 py-4">
              <ReviewConsole
                allPrs={prs}
                repoFiltered={repoFiltered}
                repos={repos}
                activeRepo={activeRepo}
                selectedPr={selectedPr}
                onRepoChange={handleRepoChange}
                onSelect={setSelectedKey}
                onAddRepo={handleAddRepo}
                onRemoveRepo={handleRemoveRepo}
                removeError={removeError}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
