import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useMutation } from "convex/react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Clock3,
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
  ConfPill,
  ConfText,
  LoopGlyph,
  ModelPill,
  PrStatusPill,
  PrStatusText,
  ReviewReport,
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
import { FilterDropdown, type FilterOption } from "./ui/FilterDropdown"
import { PhoneAccess } from "./ui/PhoneAccess"
import { ReviewerSettings } from "./ui/ReviewerSettings"
import { MobileApp } from "./mobile/MobileApp"
import { useReadOnly } from "./read-only"
import { useView } from "./lib/view"
import { FollowUpsDesktop } from "./follow-ups/FollowUps"
import { SolvesDesktop } from "./solves/Solves"

// ── small shared pieces ──────────────────────────────────────────────────────

// The mono uppercase section label that heads each panel region.
function Kicker({ icon: Icon, label, spin }: { icon: LucideIcon; label: string; spin?: boolean }) {
  return (
    <div className="mb-3.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
      <Icon className={cn("size-3", spin && "animate-spin")} />
      {label}
    </div>
  )
}

// The flat, bordered "open this on GitHub" link used throughout the detail pane.
function GhLink({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded border border-edge bg-inset px-[11px] py-1.5 text-xs text-zinc-300 transition-colors hover:border-edge2 hover:text-zinc-100",
        className,
      )}
    >
      <ArrowUpRight className="size-3.5" />
      {label}
    </a>
  )
}

// ── repo add control ─────────────────────────────────────────────────────────

type AddResult = "added" | "exists" | "invalid" | "full"

// The "+" beside the repo dropdown. Click to reveal an inline owner/repo input
// that surfaces the backend's verdict (already-watched / full / bad slug) inline
// instead of letting it vanish. Hidden on the read-only public build.
function AddRepo({ onAdd }: { onAdd: (repo: string) => Promise<AddResult> }) {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setValue("")
    setError(null)
    setAdding(false)
  }

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
    if (result === "added") close()
    else setError(result === "exists" ? "Already watched" : result === "full" ? "Watch list is full" : "Use owner/name")
  }

  if (!adding) {
    return (
      <button
        type="button"
        title="Add repository"
        aria-label="Add repository"
        onClick={() => setAdding(true)}
        className="flex size-8 shrink-0 items-center justify-center rounded-[5px] border border-edge bg-[#0d0d0f] text-zinc-500 transition-colors hover:border-edge2 hover:text-zinc-300"
      >
        <Plus className="size-3.5" />
      </button>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <input
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit()
          if (e.key === "Escape") close()
        }}
        placeholder="owner/repo"
        className={cn(
          "h-8 min-w-0 flex-1 rounded-[5px] border bg-inset px-2.5 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600",
          error ? "border-[#f85149]/50" : "border-edge3 focus:border-edgehi",
        )}
      />
      <button
        type="button"
        onClick={() => void submit()}
        className="shrink-0 rounded-[5px] border border-edge bg-[#0d0d0f] px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-edge2"
      >
        Add
      </button>
      {error && (
        <span className="shrink-0 text-[11px] text-[#fca5a5]" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// ── PR list ──────────────────────────────────────────────────────────────────

function PrRow({
  pr,
  selected,
  showRepo,
  onSelect,
  now,
}: {
  pr: Pr
  selected: boolean
  showRepo: boolean
  onSelect: () => void
  now: number
}) {
  const timing = prTiming(pr, now)
  const rounds = roundCount(pr)
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
          {pr.title}
        </span>
        <ConfText score={pr.confidence} />
      </div>
      <div className="mt-[7px] flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-500">
        <span className="min-w-0 truncate">
          {showRepo && `${repoShort(pr.repo)}  `}#{pr.prNumber}
          {timing && ` · ${timing.span}`}
          {rounds > 1 && `  ↻${rounds}`}
        </span>
        <PrStatusText pr={pr} />
      </div>
    </button>
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
    <div className="flex flex-col gap-[5px]">
      {prs.map((pr) => (
        <PrRow
          key={pr.key}
          pr={pr}
          selected={selectedKey === pr.key}
          showRepo={showRepo}
          onSelect={() => onSelect(pr.key)}
          now={now}
        />
      ))}
      {prs.length === 0 && (
        <div className="rounded-md border border-dashed border-edge p-[18px] text-center text-xs text-zinc-600">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

// ── review loop (timeline) ───────────────────────────────────────────────────

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
    <div className="relative">
      <div className="absolute bottom-4 left-[13px] top-4 w-px bg-edge3" />
      {events.map((event) => {
        const selected = event.id === selectedId
        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelect(event.id)}
            aria-pressed={selected}
            className={cn(
              "relative -mx-1.5 flex w-[calc(100%+12px)] gap-3 rounded-[6px] border px-1.5 py-[7px] text-left transition-colors",
              selected ? "border-edge2 bg-rowsel" : "border-transparent hover:bg-white/[0.02]",
            )}
          >
            <LoopGlyph kind={event.kind} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-[7px]">
                  <span className="truncate text-[13px] font-medium text-zinc-200">{event.title}</span>
                  {event.score != null && <ConfText score={event.score} />}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-600">{ago(event.time, now)}</span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-zinc-500">{event.body}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ── event detail panel ───────────────────────────────────────────────────────

// A hollow node + author avatar + message + LOC delta + SHA, GitHub-style.
function CommitsPanel({ pr, pass }: { pr: Pr; pass?: Pass }) {
  const commits = pass?.commits ?? []
  if (commits.length === 0) {
    return (
      <div>
        <Kicker icon={GitCommit} label="Commits" />
        <div className="rounded-md border border-edge bg-inset p-3 text-xs leading-relaxed text-zinc-500">
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
      <Kicker icon={GitCommit} label={`Commits · ${commits.length}`} />
      <div className="flex flex-col gap-3.5">
        {commits.map((c: Commit) => (
          <div key={c.sha} className="flex items-start gap-[11px]">
            <span className="flex size-[22px] shrink-0 items-center justify-center">
              <span className="size-[11px] rounded-full border-2 border-zinc-600 bg-panel" />
            </span>
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
                className="block truncate text-[13px] text-zinc-200 underline-offset-2 hover:text-zinc-50 hover:underline"
              >
                {c.message}
              </a>
              <div className="mt-[3px] flex items-center gap-[9px] font-mono text-[11px] text-zinc-500">
                <span className="truncate">{c.author}</span>
                <span>
                  <span className="text-[#86efac]">+{c.additions}</span>{" "}
                  <span className="text-[#fca5a5]">−{c.deletions}</span>
                </span>
                <span className="shrink-0 text-zinc-600">{c.sha.slice(0, 7)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
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
    <div className={cn("flex items-start gap-3 rounded-md border bg-inset p-4", tone)}>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md border", tone)}>
        <Icon className={cn("size-3.5", spin && "animate-spin")} />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-zinc-200">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{body}</div>
      </div>
    </div>
  )
}

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
        <Kicker icon={Sparkles} label="Review summary" />
        <div className="mb-3.5 flex flex-wrap items-center gap-2">
          <ConfPill score={pass?.confidence} />
          <span className="rounded border border-edge bg-inset px-2 py-[3px] font-mono text-[11px] text-zinc-400">
            {findingsLine(pass ?? {})}
          </span>
          <ModelPill pass={pass} />
          {event.headSha && (
            <a
              href={githubCommitUrl(pr.repo, event.headSha)}
              target="_blank"
              rel="noreferrer"
              title="View commit on GitHub"
              className="font-mono text-[11px] text-zinc-600 underline-offset-2 hover:text-zinc-400 hover:underline"
            >
              {event.headSha.slice(0, 7)}
            </a>
          )}
        </div>
        {pass?.report ? (
          <ReviewReport report={pass.report} />
        ) : (
          <p className="text-sm leading-6 text-zinc-500">No written summary was posted for this review.</p>
        )}
        {pass?.reviewUrl && <GhLink href={pass.reviewUrl} label="View review on GitHub" className="mt-3.5" />}
        {pass && <PassSessionLog reviewId={pass._id} />}
      </div>
    )
  }

  if (event.kind === "agent") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    const reviewing = pass?.status === "reviewing"
    return (
      <div>
        <Kicker icon={reviewing ? Loader2 : Clock3} label={reviewing ? "Reviewing" : "Queued"} spin={reviewing} />
        {reviewing && pass ? (
          <AgentReviewingCard reviewId={pass._id} />
        ) : (
          <InfoCard
            icon={Clock3}
            tone="border-edge2 text-zinc-400"
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
        <Kicker icon={Hand} label="Picked up by an agent" />
        <InfoCard
          icon={Hand}
          tone="border-[#818cf8]/30 text-[#c4b5fd]"
          title={`Acked by ${pass?.ackedBy ?? "an agent"}`}
          body={`Picked up ${ago(event.time, now)} — an agent is working on the findings. Stays “In progress” until a fix is pushed, or the ack goes stale and it reverts to “Awaiting agent”.`}
        />
        {pass?.reviewUrl && <GhLink href={pass.reviewUrl} label="View review on GitHub" className="mt-3.5" />}
      </div>
    )
  }

  if (event.kind === "failed") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    return (
      <div>
        <Kicker icon={AlertTriangle} label="Review failed" />
        <InfoCard
          icon={AlertTriangle}
          tone="border-[#f85149]/30 text-[#fca5a5]"
          title="The review run didn’t complete"
          body={pass?.error ?? event.body}
        />
        {pass && <PassSessionLog reviewId={pass._id} />}
      </div>
    )
  }

  if (event.kind === "queued") {
    return (
      <div>
        <Kicker icon={Clock3} label="Queued for review" />
        <InfoCard
          icon={Clock3}
          tone="border-edge2 text-zinc-400"
          title="Queued for review"
          body="Waiting for an available review worker."
        />
      </div>
    )
  }

  if (event.kind === "opened") {
    const pass = event.passId ? passById.get(event.passId) : undefined
    return (
      <div>
        <Kicker icon={GitPullRequest} label="Pull request opened" />
        <InfoCard
          icon={GitPullRequest}
          tone="border-edge2 text-zinc-400"
          title={`Opened by ${pr.author}`}
          body={`This review loop started ${ago(event.time, now)}.`}
        />
        <GhLink href={pr.prUrl} label="View pull request on GitHub" className="mt-3.5" />
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
      <Kicker icon={merged ? GitMerge : GitPullRequestClosed} label={merged ? "Merged" : "Closed"} />
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
      <GhLink href={pr.prUrl} label="View pull request on GitHub" className="mt-3.5" />
    </div>
  )
}

// ── live cloud-log surfaces (subscribe to the durable server-side log) ────────

// The first-review hero: a calm centered focal point — a spinner, the line
// "Claude is reviewing the PR…", and the live cloud-log in one flat card.
function ReviewingHero({ reviewId }: { reviewId: Pass["_id"] }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="size-6 animate-spin text-[#7dd3fc]" />
        <p className="text-[15px] font-medium text-zinc-100">Claude is reviewing the PR…</p>
      </div>
      {lines.length > 0 && (
        <div className="relative w-full max-w-md overflow-hidden rounded-lg border border-line2 bg-sunken p-1.5">
          <ExpandLogButton lines={lines} streaming title="Cloud review" className="absolute right-2 top-2 z-20" />
          <div className="h-[168px]">
            <RollingTicker lines={lines} maxVisible={6} streaming />
          </div>
        </div>
      )}
    </div>
  )
}

// The live cloud-log for a re-review round (a prior report already exists, so
// we're in the two-column loop view).
function AgentReviewingCard({ reviewId }: { reviewId: Pass["_id"] }) {
  const lines = useQuery(api.reviews.reviewLog, { reviewId }) ?? []
  if (lines.length === 0) {
    return (
      <InfoCard
        icon={Loader2}
        tone="border-[#38bdf8]/30 text-[#7dd3fc]"
        title="Agent is reviewing this commit"
        body="The summary will appear here once the review is posted."
        spin
      />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line2 bg-sunken">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Loader2 className="size-4 shrink-0 animate-spin text-[#7dd3fc]" />
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

// The persisted log of a finished pass — the durable record that outlives the
// live ticker. Self-hides for passes with no persisted lines.
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
// each second, keeping the per-second clock off the markdown report.
function MetaTiming({ pr }: { pr: Pr }) {
  const now = useNow()
  const timing = prTiming(pr, now)
  if (!timing) return null
  const verb = pr.prState === "merged" ? "merged" : pr.prState === "closed" ? "closed" : "open"
  return (
    <span className="flex items-center gap-1" title={timing.title}>
      <Clock3 className="size-[11px]" />
      {verb} {timing.span}
    </span>
  )
}

// The final human gate: squash-merge a reviewed PR from the console. Records
// intent (reviews.requestMerge); the worker runs `gh pr merge`. Only on an open,
// reviewed PR, never in the read-only build.
function MergeButton({ pr }: { pr: Pr }) {
  const readOnly = useReadOnly()
  const requestMerge = useMutation(api.reviews.requestMerge)
  const [confirming, setConfirming] = useState(false)

  if (readOnly || pr.status !== "reviewed" || pr.prState) return null

  if (pr.mergeRequestedAt != null) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-[5px] border border-[#a371f7]/30 bg-[#a371f7]/10 px-2.5 py-1.5 text-xs font-medium text-[#d8b4fe]">
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
          className="inline-flex items-center gap-1 rounded-[5px] border border-[#a371f7]/40 bg-[#a371f7]/15 px-2 py-1.5 text-xs font-medium text-[#d8b4fe] transition-colors hover:bg-[#a371f7]/25"
        >
          <GitMerge className="size-3.5" />
          Confirm
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-[5px] border border-edge px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:border-edge2 hover:text-zinc-200"
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
      title={pr.mergeError ? `Last merge attempt failed: ${pr.mergeError}` : "Squash-merge and delete the branch"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[5px] border px-2.5 py-1.5 text-xs font-medium transition-colors",
        pr.mergeError
          ? "border-[#f85149]/30 bg-[#f85149]/10 text-[#fca5a5] hover:bg-[#f85149]/20"
          : "border-[#a371f7]/30 bg-[#a371f7]/10 text-[#d8b4fe] hover:bg-[#a371f7]/20",
      )}
    >
      <GitMerge className="size-3.5" />
      {pr.mergeError ? "Retry merge" : "Merge"}
    </button>
  )
}

const META_LINK = "rounded-sm underline-offset-2 transition-colors hover:text-zinc-300 hover:underline"

function ReviewDetail({ pr, hasPrs, isAll }: { pr: Pr | null; hasPrs: boolean; isAll: boolean }) {
  const events = useMemo(() => (pr ? buildEvents(pr) : []), [pr])
  const passById = useMemo(
    () => new Map<string, Pass>((pr?.passes ?? []).map((p) => [p._id, p])),
    [pr],
  )
  const defaultEventId = useMemo(() => {
    const latestReview = [...events]
      .reverse()
      .find((e) => e.kind === "review" && passById.get(e.passId ?? "")?.report)
    return latestReview?.id ?? events[events.length - 1]?.id ?? null
  }, [events, passById])

  const [selectedId, setSelectedId] = useState<string | null>(defaultEventId)
  const prKey = pr?.key ?? null
  const lastKeyRef = useRef(prKey)
  useEffect(() => {
    if (lastKeyRef.current !== prKey) {
      lastKeyRef.current = prKey
      setSelectedId(defaultEventId)
    }
  }, [prKey, defaultEventId])

  const loopRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = loopRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [prKey])

  if (!pr) {
    return (
      <section className="flex min-h-0 flex-col items-center justify-center rounded-lg border border-line2 bg-panel p-6 text-center text-[13px] text-zinc-600">
        {hasPrs
          ? "Select a PR to see its review history."
          : isAll
            ? "No reviews yet. Reviews appear here once the worker reviews a PR on a watched repo."
            : "No reviews for this repository yet. They’ll appear once the worker reviews a PR here."}
      </section>
    )
  }

  const latestReport = [...pr.passes].reverse().find((p) => p.report)
  const reviewingPass = [...pr.passes].reverse().find((p) => p.status === "reviewing")
  const selectedEvent =
    events.find((e) => e.id === selectedId) ?? events.find((e) => e.id === defaultEventId) ?? null

  // Total lines changed across the PR, summed from every captured commit.
  let addTotal = 0
  let delTotal = 0
  for (const pass of pr.passes) {
    for (const c of pass.commits ?? []) {
      addTotal += c.additions
      delTotal += c.deletions
    }
  }
  const hasDiff = addTotal + delTotal > 0

  const firstReviewError =
    pr.status === "failed" ? [...pr.passes].reverse().find((p) => p.error)?.error : undefined
  const firstReview =
    pr.status === "failed"
      ? {
          tone: "border-[#f85149]/25 bg-[#f85149]/[0.08] text-[#fca5a5]",
          icon: AlertTriangle,
          title: "Review didn’t complete",
          body: firstReviewError ?? "The review run errored or timed out before a summary was posted.",
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
  const FirstIcon = firstReview.icon

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line2 bg-panel">
      {/* header */}
      <div className="shrink-0 border-b border-line px-[18px] py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PrStatusPill pr={pr} />
              <ConfPill score={pr.confidence} />
            </div>
            <h2 className="mt-3 text-[17px] font-semibold leading-snug text-zinc-100">{pr.title}</h2>
            <div className="mt-[9px] flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-zinc-500">
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
                href={`https://github.com/${pr.repo}/commit/${pr.headSha}`}
                target="_blank"
                rel="noreferrer"
                className={cn(META_LINK, "flex items-center gap-1")}
              >
                <GitCommit className="size-[11px]" />
                {pr.headSha.slice(0, 7)}
              </a>
              <MetaTiming pr={pr} />
              {hasDiff && (
                <span className="inline-flex items-center gap-1.5" title="Lines changed across this PR">
                  <span className="text-[#86efac]">+{addTotal}</span>
                  <span className="text-[#fca5a5]">−{delTotal}</span>
                </span>
              )}
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
              className="flex size-8 shrink-0 items-center justify-center rounded-[5px] border border-edge text-zinc-500 transition-colors hover:border-edge2 hover:text-zinc-200"
            >
              <ArrowUpRight className="size-4" />
            </a>
          </div>
        </div>
      </div>

      {latestReport?.report ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div ref={loopRef} className="min-h-0 overflow-y-auto border-r border-line p-4">
            <Kicker icon={Activity} label="Review loop" />
            <Timeline events={events} selectedId={selectedEvent?.id ?? null} onSelect={setSelectedId} />
          </div>
          <div key={selectedEvent?.id ?? "none"} className="min-h-0 overflow-y-auto p-4">
            <div className="rl-fade">
              <EventDetail pr={pr} event={selectedEvent} passById={passById} />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {reviewingPass ? (
            <ReviewingHero key={reviewingPass._id} reviewId={reviewingPass._id} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-[18px] px-6 py-8 text-center">
              <span className={cn("flex size-[46px] items-center justify-center rounded-full border", firstReview.tone)}>
                <FirstIcon className="size-5" />
              </span>
              <div className="max-w-[42ch]">
                <p className="text-sm font-medium text-zinc-200">{firstReview.title}</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-500">{firstReview.body}</p>
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
}: {
  allPrs: Pr[]
  repoFiltered: Pr[]
  repos: string[]
  activeRepo: string
  selectedPr: Pr | null
  onRepoChange: (repo: string) => void
  onSelect: (key: string) => void
  onAddRepo: (repo: string) => Promise<AddResult>
}) {
  const readOnly = useReadOnly()
  const [query, setQuery] = useState("")
  const [openOnly, setOpenOnly] = useOpenOnly()
  const trimmed = query.trim().toLowerCase()

  // Repo dropdown options: "All repositories" + each watched/seen repo, deduped
  // case-insensitively (stored casing vs GitHub's canonical casing), with counts.
  const repoOptions = useMemo<FilterOption<string>[]>(() => {
    const byKey = new Map<string, string>()
    for (const r of repos) byKey.set(r.toLowerCase(), r)
    for (const pr of allPrs) byKey.set(pr.repo.toLowerCase(), pr.repo)
    const names = Array.from(byKey.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    const count = (repo: string) => allPrs.filter((p) => p.repo.toLowerCase() === repo.toLowerCase()).length
    return [
      { value: "all", label: "All repositories", count: allPrs.length },
      ...names.map((n) => ({ value: n, label: n, count: count(n) })),
    ]
  }, [repos, allPrs])

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
    <div className="flex min-h-0 flex-1 flex-col px-5 py-[18px]">
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-4">
        {/* list column */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line2 bg-panel">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2">
            <FilterDropdown
              icon={<GitPullRequest className="size-3.5" />}
              heading="Filter by repository"
              options={repoOptions}
              value={activeRepo}
              onChange={onRepoChange}
            />
            {!readOnly && <AddRepo onAdd={onAddRepo} />}
          </div>

          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
            <Search className="size-[15px] shrink-0 text-zinc-600" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search PRs or repos…"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600"
            />
            {query && (
              <button
                type="button"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="flex text-zinc-600 hover:text-zinc-300"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between px-3 pb-1.5 pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
            <span className="flex items-center gap-[7px]">
              <GitPullRequest className="size-3" />
              PRs
            </span>
            <button
              type="button"
              onClick={() => setOpenOnly((v) => !v)}
              aria-pressed={openOnly}
              title={openOnly ? "Showing open PRs only — click to show all" : "Show only open PRs"}
              className={cn(
                "inline-flex items-center gap-1 rounded border px-[7px] py-[3px] text-[10px] font-medium normal-case tracking-normal transition-colors",
                openOnly
                  ? "border-edgehi bg-railsel text-zinc-300"
                  : "border-edge bg-[#0d0d0f] text-zinc-600 hover:border-edge2 hover:text-zinc-400",
              )}
            >
              <ListFilter className="size-[11px]" />
              Open only
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
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

// ── top-level nav ────────────────────────────────────────────────────────────
// Three views behind one chrome: the PR-review board, the autonomous-solver
// status, and the PR-follow-ups inbox. Desktop gets a slim left rail; below the
// narrow breakpoint the app hands off to the purpose-built mobile console
// (src/mobile/MobileApp), which owns its own bottom tab bar.

function NavLogo() {
  return (
    <div className="flex size-[30px] shrink-0 items-center justify-center rounded-[7px] border border-edge2 bg-gradient-to-b from-[#141417] to-[#0d0d0f]">
      <GitPullRequest className="size-[15px] text-accent" />
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
        "relative flex size-10 items-center justify-center rounded-md border transition-colors",
        active
          ? "border-edge2 bg-railsel text-zinc-100"
          : "border-transparent text-zinc-500 hover:bg-railsel/60 hover:text-zinc-300",
      )}
    >
      <Icon className="size-[18px]" />
      {count > 0 && (
        <span className="absolute -right-[3px] -top-[3px] inline-flex h-4 min-w-4 items-center justify-center rounded-lg border border-panel bg-[#e3b341] px-[3px] font-mono text-[9px] font-bold text-[#1a1304]">
          {count}
        </span>
      )}
    </button>
  )
}

export default function App() {
  const prsData = useQuery(api.reviews.prs)
  const reposData = useQuery(api.repos.list)
  const addRepo = useMutation(api.repos.add)
  const [activeRepo, setActiveRepo] = useState("all")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const isNarrow = useIsNarrowViewport()
  const [view, setView] = useView()
  const pending = useQuery(api.suggestedIssues.pendingCount) ?? 0
  const solving = useQuery(api.solveTasks.activeCount) ?? 0

  const handleRepoChange = (repo: string) => setActiveRepo(repo)

  const handleAddRepo = (repo: string) =>
    addRepo({ repo }).then((result) => {
      if (result === "added") setActiveRepo(repo)
      return result
    })

  const repoFiltered = useMemo(() => {
    const all = prsData ?? []
    if (activeRepo === "all") return all
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

  // Below the breakpoint the desktop two-pane can't breathe, so the app hands
  // off to the purpose-built mobile console (its own brand bar, tab bar, and
  // full-screen detail pushes).
  if (isNarrow) {
    return <MobileApp />
  }

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-zinc-200">
      {/* slim icon rail: Reviews ⇄ Solves ⇄ Follow-ups, phone access pinned to the foot */}
      <nav className="flex w-14 shrink-0 flex-col items-center gap-2.5 border-r border-line bg-panel py-3.5">
        <NavLogo />
        <div className="my-0.5 h-px w-6 bg-line2" />
        <RailBtn active={view === "reviews"} onClick={() => setView("reviews")} icon={GitPullRequest} label="Reviews" />
        <RailBtn active={view === "solves"} onClick={() => setView("solves")} icon={Bot} label="Solves" count={solving} />
        <RailBtn active={view === "follow-ups"} onClick={() => setView("follow-ups")} icon={Inbox} label="Follow-ups" count={pending} />
        <div className="mt-auto" />
        <ReviewerSettings />
        <PhoneAccess />
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
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
          <ReviewConsole
            allPrs={prs}
            repoFiltered={repoFiltered}
            repos={repos}
            activeRepo={activeRepo}
            selectedPr={selectedPr}
            onRepoChange={handleRepoChange}
            onSelect={setSelectedKey}
            onAddRepo={handleAddRepo}
          />
        )}
      </main>
    </div>
  )
}
