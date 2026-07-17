// The mobile PR detail: the status/confidence header, the metadata row, and the
// review loop as a tap-to-expand accordion (per the "PRR Console Mobile" design)
// — each loop step expands inline to its content (review summary, commit list,
// live cloud-log, info card) instead of raising a bottom sheet. A PR with no
// report yet gets a centered focal state (reviewing hero / queued / failed).
import { useMemo, useState } from "react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock3,
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
  type Pass,
  type Pr,
  type TimelineEvent,
  ConfPill,
  ConfText,
  LoopGlyph,
  PrStatusPill,
  ReviewReport,
  buildEvents,
  findingsLine,
  githubCommitUrl,
  prTiming,
  useNow,
} from "../review/kit"

const META_LINK = "rounded-sm underline-offset-2 transition-colors active:text-zinc-300"

// ── per-step expanded bodies ─────────────────────────────────────────────────

// The persisted cloud-log of a pass — live (streaming) while it's reviewing,
// the durable session record once it finished. Self-hides when empty.
function PassLog({ reviewId, streaming }: { reviewId: Pass["_id"]; streaming: boolean }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  if (lines.length === 0) return null
  return (
    <CloudLogConsole
      lines={lines}
      streaming={streaming}
      title={streaming ? "Cloud review" : "Session log"}
      bodyClassName="h-[140px]"
      maxVisible={4}
      className="mt-3"
    />
  )
}

// A "what is this step" card for the loop anchors that aren't a review or commit.
function InfoCard({
  icon: Icon,
  tone,
  title,
  body,
  spin,
}: {
  icon: LucideIcon
  tone: string
  title: string
  body: string
  spin?: boolean
}) {
  return (
    <div className={cn("flex items-start gap-3 rounded-[7px] border bg-inset p-3.5", tone)}>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[7px] border", tone)}>
        <Icon className={cn("size-4", spin && "animate-spin")} />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-zinc-200">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{body}</div>
      </div>
    </div>
  )
}

function CommitsBody({ pr, pass }: { pr: Pr; pass?: Pass }) {
  const commits = pass?.commits ?? []
  if (commits.length === 0) {
    return (
      <div className="rounded-[7px] border border-dashed border-edge bg-inset p-3.5 text-xs leading-relaxed text-zinc-500">
        The commit list for this push hasn’t been captured yet.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-[13px]">
      {commits.map((c: Commit) => (
        <div key={c.sha} className="flex items-start gap-2.5">
          {c.avatarUrl ? (
            <img
              src={c.avatarUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="size-[22px] shrink-0 rounded-full border border-edge2 bg-[#1d1d21]"
            />
          ) : (
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border border-edge2 bg-[#1d1d21] font-mono text-[9px] uppercase text-zinc-400">
              {c.author.slice(0, 2)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <a
              href={githubCommitUrl(pr.repo, c.sha)}
              target="_blank"
              rel="noreferrer"
              className="block text-[13px] leading-snug text-zinc-200 underline-offset-2 active:text-zinc-50"
            >
              {c.message}
            </a>
            <div className="mt-[3px] flex items-center gap-[9px] font-mono text-[11px] text-zinc-500">
              <span>
                <span className="text-[#86efac]">+{c.additions}</span>{" "}
                <span className="text-[#fca5a5]">−{c.deletions}</span>
              </span>
              <span className="text-zinc-600">{c.sha.slice(0, 7)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function EventBody({
  pr,
  event,
  passById,
  now,
}: {
  pr: Pr
  event: TimelineEvent
  passById: Map<string, Pass>
  now: number
}) {
  const pass = event.passId ? passById.get(event.passId) : undefined

  if (event.kind === "commit") {
    return <CommitsBody pr={pr} pass={pass} />
  }

  if (event.kind === "review") {
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-[7px]">
          <ConfPill score={pass?.confidence} />
          <span className="rounded border border-edge bg-inset px-2 py-[3px] font-mono text-[11px] text-zinc-400">
            {findingsLine(pass ?? {})}
          </span>
          {event.headSha && (
            <a
              href={githubCommitUrl(pr.repo, event.headSha)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-zinc-600 underline-offset-2 active:text-zinc-400"
            >
              {event.headSha.slice(0, 7)}
            </a>
          )}
        </div>
        {pass?.report ? (
          <ReviewReport report={pass.report} />
        ) : (
          <p className="text-[13px] leading-relaxed text-zinc-500">
            No written summary was posted for this review.
          </p>
        )}
        {pass && <PassLog reviewId={pass._id} streaming={false} />}
      </div>
    )
  }

  if (event.kind === "agent") {
    const reviewing = pass?.status === "reviewing"
    return (
      <div>
        <InfoCard
          icon={reviewing ? Loader2 : Clock3}
          tone={reviewing ? "border-[#38bdf8]/30 text-[#7dd3fc]" : "border-edge2 text-zinc-400"}
          title={reviewing ? "Agent is reviewing this commit" : "Queued for review"}
          body={
            reviewing
              ? "The summary will appear here once the review is posted."
              : "Waiting for an available review worker."
          }
          spin={reviewing}
        />
        {reviewing && pass && <PassLog reviewId={pass._id} streaming />}
      </div>
    )
  }

  if (event.kind === "failed") {
    return (
      <div>
        <InfoCard
          icon={AlertTriangle}
          tone="border-[#f85149]/25 text-[#fca5a5]"
          title="The review run didn’t complete"
          body={pass?.error ?? event.body}
        />
        {pass && <PassLog reviewId={pass._id} streaming={false} />}
      </div>
    )
  }

  if (event.kind === "ack") {
    return (
      <InfoCard
        icon={Hand}
        tone="border-[#818cf8]/30 text-[#c4b5fd]"
        title={`Acked by ${pass?.ackedBy ?? "an agent"}`}
        body={`Picked up ${ago(event.time, now)} — an agent is working on the findings. Stays “In progress” until a fix is pushed, or the ack goes stale and it reverts to “Awaiting agent”.`}
      />
    )
  }

  if (event.kind === "queued") {
    return (
      <InfoCard
        icon={Clock3}
        tone="border-edge2 text-zinc-400"
        title="Queued for review"
        body="Waiting for an available review worker."
      />
    )
  }

  if (event.kind === "opened") {
    return (
      <InfoCard
        icon={GitPullRequest}
        tone="border-edge2 text-zinc-400"
        title={`Opened by ${pr.author}`}
        body={`This review loop started ${ago(event.time, now)}.`}
      />
    )
  }

  const merged = event.kind === "merged"
  return (
    <InfoCard
      icon={merged ? GitMerge : GitPullRequestClosed}
      tone={merged ? "border-[#a371f7]/30 text-[#d8b4fe]" : "border-edge2 text-zinc-400"}
      title={merged ? "PR merged on GitHub" : "PR closed without merging"}
      body={
        merged
          ? "No further review is needed for this pull request."
          : "This pull request was closed without merging."
      }
    />
  )
}

// ── accordion ────────────────────────────────────────────────────────────────

function LoopAccordion({ pr }: { pr: Pr }) {
  const now = useNow()
  const events = useMemo(() => buildEvents(pr), [pr])
  const passById = useMemo(() => new Map<string, Pass>(pr.passes.map((p) => [p._id, p])), [pr])
  const defaultEventId = useMemo(() => {
    const latestReview = [...events]
      .reverse()
      .find((e) => e.kind === "review" && passById.get(e.passId ?? "")?.report)
    return latestReview?.id ?? events[events.length - 1]?.id ?? null
  }, [events, passById])

  // null = nothing expanded; unset (no user pick yet) = the default step. The
  // component is keyed by PR at the call site, so the pick resets per PR.
  const [picked, setPicked] = useState<{ id: string | null } | null>(null)
  const expandedId = picked ? picked.id : defaultEventId

  return (
    <div className="relative">
      <div className="absolute bottom-4 left-[13px] top-4 w-px bg-edge3" />
      {events.map((event) => {
        const open = event.id === expandedId
        return (
          <div key={event.id} className="relative">
            <button
              type="button"
              onClick={() => setPicked({ id: open ? null : event.id })}
              aria-expanded={open}
              className="relative z-[1] flex w-full items-start gap-[11px] py-[7px] text-left"
            >
              <LoopGlyph kind={event.kind} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-[7px]">
                    <span className="truncate text-[13.5px] font-medium text-zinc-200">{event.title}</span>
                    {event.score != null && <ConfText score={event.score} />}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-600">{ago(event.time, now)}</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-zinc-500">{event.body}</span>
              </span>
              <span
                className={cn(
                  "mt-1 flex shrink-0 items-center text-zinc-600 transition-transform duration-150",
                  open && "rotate-90",
                )}
              >
                <ChevronRight className="size-3.5" />
              </span>
            </button>
            {open && (
              <div className="prr-fade pb-4 pl-[39px] pr-0.5 pt-1.5">
                <EventBody pr={pr} event={event} passById={passById} now={now} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── centered states (no report yet) ──────────────────────────────────────────

function ReviewingHero({ reviewId }: { reviewId: Pass["_id"] }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  return (
    <div className="flex flex-col items-center gap-[18px] px-1 py-9 text-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="size-[26px] animate-spin text-[#7dd3fc]" />
        <p className="text-[15px] font-medium text-zinc-100">Claude is reviewing the PR…</p>
      </div>
      {lines.length > 0 && (
        <CloudLogConsole lines={lines} streaming title="Cloud review" className="w-full text-left" maxVisible={5} />
      )}
    </div>
  )
}

function CenteredState({ pr }: { pr: Pr }) {
  const firstError =
    pr.status === "failed" ? [...pr.passes].reverse().find((p) => p.error)?.error : undefined
  const state =
    pr.status === "failed"
      ? {
          tone: "border-[#f85149]/25 bg-[#f85149]/[0.08] text-[#fca5a5]",
          icon: AlertTriangle,
          title: "Review didn’t complete",
          body: firstError ?? "The review run errored or timed out before a summary was posted.",
        }
      : pr.status === "queued"
        ? {
            tone: "border-edge2 bg-inset text-zinc-400",
            icon: Clock3,
            title: "Queued for review",
            body: "Waiting for an available review worker. The summary will appear here once the review is posted.",
          }
        : {
            tone: "border-edge2 bg-inset text-zinc-500",
            icon: Sparkles,
            title: "No review yet",
            body: "No review has been posted for this PR yet.",
          }
  const Icon = state.icon
  return (
    <div className="flex flex-col items-center gap-[18px] px-1.5 py-9 text-center">
      <span className={cn("flex size-12 items-center justify-center rounded-full border", state.tone)}>
        <Icon className="size-[22px]" />
      </span>
      <div className="max-w-[42ch]">
        <p className="text-[15px] font-medium text-zinc-200">{state.title}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">{state.body}</p>
      </div>
    </div>
  )
}

// ── the detail body ──────────────────────────────────────────────────────────

// The PR-header timing item; owns its own ticker leaf via useNow at the parent.
export function MobileReviewDetail({ pr }: { pr: Pr }) {
  const now = useNow()
  const timing = prTiming(pr, now)
  const verb = pr.prState === "merged" ? "merged" : pr.prState === "closed" ? "closed" : "open"

  const latestReport = [...pr.passes].reverse().find((p) => p.report)
  const reviewingPass = [...pr.passes].reverse().find((p) => p.status === "reviewing")

  // Total lines changed across the PR, summed from every captured commit.
  let addTotal = 0
  let delTotal = 0
  for (const pass of pr.passes) {
    for (const c of pass.commits ?? []) {
      addTotal += c.additions
      delTotal += c.deletions
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <PrStatusPill pr={pr} />
        <ConfPill score={pr.confidence} />
      </div>
      <h2 className="mt-[13px] text-[19px] font-semibold leading-[1.3] text-zinc-100">{pr.title}</h2>
      <div className="mt-[11px] flex min-w-0 flex-wrap items-center gap-x-[11px] gap-y-[9px] font-mono text-[11px] text-[#6e6e78]">
        <a href={`https://github.com/${pr.repo}`} target="_blank" rel="noreferrer" className={META_LINK}>
          {pr.repo}
        </a>
        <a href={pr.prUrl} target="_blank" rel="noreferrer" className={cn(META_LINK, "text-accent")}>
          #{pr.prNumber}
        </a>
        <a href={`https://github.com/${pr.author}`} target="_blank" rel="noreferrer" className={META_LINK}>
          {pr.author}
        </a>
        <a
          href={githubCommitUrl(pr.repo, pr.headSha)}
          target="_blank"
          rel="noreferrer"
          className={cn(META_LINK, "flex items-center gap-1")}
        >
          <GitCommit className="size-[11px]" />
          {pr.headSha.slice(0, 7)}
        </a>
        {timing && (
          <span className="flex items-center gap-1" title={timing.title}>
            <Clock3 className="size-[11px]" />
            {verb} {timing.span}
          </span>
        )}
        {addTotal + delTotal > 0 && (
          <span className="inline-flex items-center gap-1.5" title="Lines changed across this PR">
            <span className="text-[#86efac]">+{addTotal}</span>
            <span className="text-[#fca5a5]">−{delTotal}</span>
          </span>
        )}
      </div>

      {latestReport?.report ? (
        <>
          <div className="mb-4 mt-[18px] h-px bg-line" />
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
            <Activity className="size-3" />
            Review loop
          </div>
          <LoopAccordion pr={pr} />
        </>
      ) : reviewingPass ? (
        <ReviewingHero key={reviewingPass._id} reviewId={reviewingPass._id} />
      ) : (
        <CenteredState pr={pr} />
      )}
    </div>
  )
}
