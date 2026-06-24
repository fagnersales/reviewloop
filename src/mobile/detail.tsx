// Shared PR-detail building blocks for the mobile view: the vertical review-loop
// timeline and the per-step detail content (review summary / commit list / status
// card). These mirror the desktop EventDetail / Timeline / CommitsPanel, tuned for
// a single narrow column and touch targets.
import { useMemo } from "react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import {
  AlertTriangle,
  Clock3,
  ExternalLink,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hand,
  Loader2,
  type LucideIcon,
  Sparkles,
} from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { ago } from "../lib/format"
import { CloudLogConsole } from "../components/cloud-log"
import {
  type Commit,
  EventGlyph,
  type Pass,
  type Pr,
  type TimelineEvent,
  ScoreBadge,
  ReviewReport,
  buildEvents,
  findingsLine,
  githubCommitUrl,
  useNow,
} from "../review/kit"

// The vertical review loop. Each step is a big touch row; tapping calls onSelect.
export function ReviewLoop({
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
      <div className="absolute bottom-[1.6rem] left-3.5 top-[1.6rem] w-px bg-zinc-800" />
      {events.map((event) => {
        const selected = event.id === selectedId
        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelect(event.id)}
            aria-pressed={selected}
            className={cn(
              "relative -mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-lg border px-2 py-2.5 text-left transition",
              selected ? "border-zinc-700 bg-zinc-900/80" : "border-transparent active:bg-zinc-900/50",
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
      className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-2 text-xs text-zinc-300 active:border-zinc-700"
    >
      <ExternalLink className="size-3.5" />
      {label}
    </a>
  )
}

function InfoCard({
  tone,
  icon: Icon,
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
  if (url)
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-5 shrink-0 rounded-full border border-zinc-800 bg-zinc-900"
      />
    )
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-[9px] font-semibold uppercase text-zinc-400">
      {author.slice(0, 1)}
    </span>
  )
}

function LocDelta({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono tabular-nums">
      <span className="text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-400">−{deletions}</span>
    </span>
  )
}

function CommitsPanel({ pr, pass }: { pr: Pr; pass?: Pass }) {
  const commits = pass?.commits ?? []
  if (commits.length === 0) {
    return (
      <div>
        <PanelHeader icon={GitCommit} label="Commits" />
        <div className="rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 p-3 text-xs leading-5 text-zinc-500">
          The commit list for this push hasn’t been captured yet.
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
                  className="block text-sm font-medium text-zinc-100 underline-offset-2 active:text-sky-200"
                >
                  {c.message}
                </a>
                <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                  <span className="truncate">{c.author}</span>
                  <LocDelta additions={c.additions} deletions={c.deletions} />
                  <span className="shrink-0 font-mono text-zinc-500">{c.sha.slice(0, 7)}</span>
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// The detail body for a selected review-loop step.
export function EventDetailContent({
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
              className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-500"
            >
              <GitCommit className="size-3" />
              {event.headSha.slice(0, 7)}
            </a>
          )}
        </div>
        {pass?.report ? (
          <ReviewReport report={pass.report} />
        ) : (
          <p className="text-sm leading-6 text-zinc-500">No written summary was posted for this review.</p>
        )}
        {pass?.reviewUrl && <GitHubLink href={pass.reviewUrl} label="View review on GitHub" />}
      </div>
    )
  }

  if (event.kind === "agent" || event.kind === "queued") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    const reviewing = pass?.status === "reviewing"
    return (
      <div>
        <PanelHeader icon={reviewing ? Loader2 : Clock3} label={reviewing ? "Reviewing" : "Queued"} spin={reviewing} />
        <InfoCard
          tone={reviewing ? "border-sky-400/30 text-sky-300" : "border-zinc-700 text-zinc-400"}
          icon={reviewing ? Loader2 : Clock3}
          title={reviewing ? "Agent is reviewing this commit" : "Queued for review"}
          body={
            reviewing
              ? "The summary will appear here once the review is posted."
              : "Waiting for an available review worker."
          }
          spin={reviewing}
        />
        {reviewing && pass && (
          <div className="mt-3">
            <LiveReviewLog reviewId={pass._id} />
          </div>
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
          body={`Picked up ${ago(event.time, now)} — an agent is working on the findings. Stays “In progress” until a fix is pushed (or the ack goes stale and it reverts to “Awaiting agent”).`}
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
      </div>
    )
  }

  if (event.kind === "opened") {
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

// The cloud-review log for an in-flight pass. Subscribes to `reviewLog` — the
// complete, server-persisted history the worker appends — so remounting on PR
// reselect shows every line, not just the tail this tab observed since mount.
export function LiveReviewLog({ reviewId }: { reviewId: Pass["_id"] }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  if (lines.length === 0) return null
  return <CloudLogConsole lines={lines} streaming title="Cloud review" bodyClassName="h-[132px]" maxVisible={4} />
}

// Derive the loop events + default selection for a PR, memoized on the PR so the
// events array and passById Map are only rebuilt when the live PR changes (the
// desktop ReviewDetail memoizes the same way). The default lands on the latest
// review that actually has a summary.
export function usePrLoop(pr: Pr) {
  const events = useMemo(() => buildEvents(pr), [pr])
  const passById = useMemo(() => new Map<string, Pass>(pr.passes.map((p) => [p._id, p])), [pr])
  const defaultEventId = useMemo(() => {
    const latestReview = [...events]
      .reverse()
      .find((e) => e.kind === "review" && passById.get(e.passId ?? "")?.report)
    return latestReview?.id ?? events[events.length - 1]?.id ?? null
  }, [events, passById])
  return { events, passById, defaultEventId }
}
