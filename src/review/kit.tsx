// Shared review kit: the types, hooks, pure helpers, and presentational atoms
// used by both the desktop console (src/App.tsx) and the mobile view
// (src/mobile/*). This is the single source of truth for that logic — App.tsx
// imports from here rather than defining its own copies.
import { useEffect, useState } from "react"
import { type FunctionReturnType } from "convex/server"
import Markdown from "markdown-to-jsx"
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hand,
  Loader2,
  type LucideIcon,
  Rows3,
  XCircle,
} from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { longDur } from "../lib/format"

export type Pr = FunctionReturnType<typeof api.reviews.prs>[number]
export type Pass = Pr["passes"][number]
export type Commit = NonNullable<Pass["commits"]>[number]
export type EventKind =
  | "opened"
  | "review"
  | "agent"
  | "ack"
  | "queued"
  | "commit"
  | "merged"
  | "failed"
  | "closed"

export type TimelineEvent = {
  id: string
  kind: EventKind
  title: string
  body: string
  time: number
  score?: number
  passId?: string
  headSha?: string
}

// ── hooks ───────────────────────────────────────────────────────────────────

// True below the breakpoint where the desktop two-pane layout stops fitting; the
// app swaps to the mobile view there.
export function useIsNarrowViewport() {
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

// A clock that re-renders on an interval, so "open for…" durations keep growing
// without a backend event to nudge the subscription.
export function useNow(periodMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs)
    return () => clearInterval(id)
  }, [periodMs])
  return now
}

// The "open only" PR-list filter is a view preference, not server state, so it
// lives in localStorage and survives reloads. Shared by both the desktop list and
// the mobile view so the preference carries across layouts.
const OPEN_ONLY_KEY = "prr.pr-list.open-only"

export function useOpenOnly() {
  const [openOnly, setOpenOnly] = useState(() =>
    typeof window === "undefined" ? false : window.localStorage.getItem(OPEN_ONLY_KEY) === "1",
  )
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(OPEN_ONLY_KEY, openOnly ? "1" : "0")
    }
  }, [openOnly])
  return [openOnly, setOpenOnly] as const
}

// ── pure helpers (shared with App.tsx) ──────────────────────────────────────

export function repoShort(repo: string) {
  return repo.split("/").pop() ?? repo
}

export function roundCount(pr: Pr) {
  return new Set(pr.passes.map((p) => p.headSha)).size
}

export function prTiming(
  pr: Pr,
  now: number,
): { span: string; header: string; title: string } | null {
  const start = pr.prCreatedAt ?? pr.passes[0]?.queuedAt
  if (start == null) return null
  if (pr.prState) {
    const span = longDur((pr.closedAt ?? pr.updatedAt) - start)
    const verb = pr.prState === "merged" ? "Merged" : "Closed"
    return { span, header: `${verb} in ${span}`, title: `${verb} ${span} after opening` }
  }
  const span = longDur(now - start)
  return { span, header: `Open for ${span}`, title: `Open for ${span}` }
}

export function findingsLine(x: { p0?: number; p1?: number; p2?: number }) {
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

// The lifecycle state a PR row resolves to — computed server-side by
// convex/prStatus.ts and shipped on the `prs` query as `pr.statusKey`, so the
// rules (ack → in progress, blockers/unparseable counts → awaiting, clean →
// verified) live in one module and the client only maps states to tones.
export type StatusKey = Pr["statusKey"]

export type StatusDisplay = { label: string; icon: LucideIcon; tone: string; spin?: boolean }

// The legacy icon-pill badge (still used by the mobile view). Keyed on the
// served statusKey so the lifecycle logic lives in exactly one place.
const STATUS_LEGACY: Record<StatusKey, StatusDisplay> = {
  merged: { label: "Merged", icon: GitMerge, tone: "border-violet-400/25 bg-violet-400/10 text-violet-200" },
  closed: { label: "Closed", icon: GitPullRequestClosed, tone: "border-zinc-700 bg-zinc-900/80 text-zinc-400" },
  reviewing: { label: "Reviewing", icon: Loader2, tone: "border-sky-400/25 bg-sky-400/10 text-sky-200", spin: true },
  queued: { label: "Queued", icon: Clock3, tone: "border-zinc-700 bg-zinc-900/80 text-zinc-400" },
  inprogress: { label: "In progress", icon: Activity, tone: "border-indigo-400/25 bg-indigo-400/10 text-indigo-200" },
  awaiting: { label: "Awaiting agent", icon: Hand, tone: "border-amber-400/25 bg-amber-400/10 text-amber-200" },
  verified: { label: "Reviewed", icon: CheckCircle2, tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" },
  failed: { label: "Failed", icon: XCircle, tone: "border-red-400/25 bg-red-400/10 text-red-200" },
}

export function statusDisplay(pr: Pr): StatusDisplay {
  return STATUS_LEGACY[pr.statusKey]
}

// ── design-palette status + confidence metas (desktop console) ───────────────
// Tailwind class fragments matching the design's exact hex: a colored uppercase
// mono label + dot for list rows, and the same colors in a bordered pill for
// detail headers. `pulse` marks the live states (reviewing / in-progress).
export type ToneMeta = { label: string; text: string; dot: string; bg: string; border: string; pulse: boolean }

export const STATUS_META: Record<StatusKey, ToneMeta> = {
  verified: { label: "VERIFIED", text: "text-[#86efac]", dot: "bg-[#3fb950]", bg: "bg-[#3fb950]/10", border: "border-[#3fb950]/30", pulse: false },
  awaiting: { label: "AWAITING AGENT", text: "text-[#fcd34d]", dot: "bg-[#e3b341]", bg: "bg-[#e3b341]/10", border: "border-[#e3b341]/30", pulse: false },
  inprogress: { label: "IN PROGRESS", text: "text-[#c4b5fd]", dot: "bg-[#818cf8]", bg: "bg-[#818cf8]/10", border: "border-[#818cf8]/30", pulse: true },
  reviewing: { label: "REVIEWING", text: "text-[#7dd3fc]", dot: "bg-[#38bdf8]", bg: "bg-[#38bdf8]/10", border: "border-[#38bdf8]/30", pulse: true },
  queued: { label: "QUEUED", text: "text-zinc-400", dot: "bg-zinc-500", bg: "bg-inset", border: "border-edge2", pulse: false },
  failed: { label: "FAILED", text: "text-[#fca5a5]", dot: "bg-[#f85149]", bg: "bg-[#f85149]/10", border: "border-[#f85149]/30", pulse: false },
  merged: { label: "MERGED", text: "text-[#d8b4fe]", dot: "bg-[#a371f7]", bg: "bg-[#a371f7]/10", border: "border-[#a371f7]/30", pulse: false },
  closed: { label: "CLOSED", text: "text-zinc-400", dot: "bg-zinc-600", bg: "bg-inset", border: "border-edge2", pulse: false },
}

export type ConfMeta = { text: string; color: string; bg: string; border: string; star: boolean }

// Confidence (the review score): a starred decimal coloured by tier — red below
// 2, amber below 4, green at/above 4. `—` (no star) when there's no score yet.
export function confMeta(score?: number): ConfMeta {
  if (score == null) return { text: "—", color: "text-zinc-600", bg: "bg-inset", border: "border-edge", star: false }
  const text = score.toFixed(1)
  if (score < 2) return { text, color: "text-[#fca5a5]", bg: "bg-[#f85149]/10", border: "border-[#f85149]/30", star: true }
  if (score < 4) return { text, color: "text-[#fcd34d]", bg: "bg-[#e3b341]/10", border: "border-[#e3b341]/30", star: true }
  return { text, color: "text-[#86efac]", bg: "bg-[#3fb950]/10", border: "border-[#3fb950]/30", star: true }
}

export function scoreTone(score?: number) {
  if (score == null) return "border-zinc-700 bg-zinc-900 text-zinc-500"
  if (score >= 4) return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
  if (score >= 3) return "border-amber-400/25 bg-amber-400/10 text-amber-200"
  return "border-red-400/25 bg-red-400/10 text-red-200"
}

export function githubCommitUrl(repo: string, sha: string) {
  return `https://github.com/${repo}/commit/${sha}`
}

export function eventIcon(kind: EventKind): LucideIcon {
  switch (kind) {
    case "opened":
      return GitPullRequest
    case "review":
      return Rows3
    case "agent":
      return Loader2
    case "ack":
      return Hand
    case "queued":
      return Clock3
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

export function buildEvents(pr: Pr): TimelineEvent[] {
  const events: TimelineEvent[] = []
  const first = pr.passes[0]
  if (first) {
    events.push({
      id: `${pr.key}-opened`,
      kind: "opened",
      title: "PR opened",
      body: `Opened by ${pr.author}.`,
      time: pr.prCreatedAt ?? first.queuedAt,
      passId: first._id,
      headSha: first.headSha,
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
        passId: pass._id,
        headSha: pass.headSha,
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
        passId: pass._id,
        headSha: pass.headSha,
      })
      // An agent acked this review (via prr-ack) and is on the findings — the
      // trustworthy "someone picked it up" the console can't otherwise know.
      if (pass.ackedAt != null) {
        events.push({
          id: `${pass._id}-ack`,
          kind: "ack",
          title: "Agent picked it up",
          body: `${pass.ackedBy ?? "An agent"} is working on the findings.`,
          time: pass.ackedAt,
          passId: pass._id,
          headSha: pass.headSha,
        })
      }
    } else if (pass.status === "reviewing") {
      events.push({
        id: pass._id,
        kind: "agent",
        title: "Agent is reviewing",
        body: pass.progress ?? "The agent is reviewing this commit.",
        time: pass.startedAt ?? pass.queuedAt,
        passId: pass._id,
        headSha: pass.headSha,
      })
    } else if (pass.status === "failed") {
      events.push({
        id: pass._id,
        kind: "failed",
        title: "Review failed",
        body: pass.error ?? "The run errored or timed out.",
        time: pass.finishedAt ?? pass.queuedAt,
        passId: pass._id,
        headSha: pass.headSha,
      })
    } else {
      events.push({
        id: pass._id,
        kind: "queued",
        title: "Queued for review",
        body: "Waiting for an available review worker.",
        time: pass.queuedAt,
        passId: pass._id,
        headSha: pass.headSha,
      })
    }
  }

  if (pr.prState) {
    const start = pr.prCreatedAt ?? first?.queuedAt
    const end = pr.closedAt ?? pr.updatedAt
    const took = start != null ? ` ${longDur(end - start)} after opening` : ""
    if (pr.prState === "merged") {
      events.push({
        id: `${pr.key}-merged`,
        kind: "merged",
        title: "Merged",
        body: `PR merged on GitHub${took} — no further review needed.`,
        time: end,
      })
    } else {
      events.push({
        id: `${pr.key}-closed`,
        kind: "closed",
        title: "Closed",
        body: `PR closed without merging${took}.`,
        time: end,
      })
    }
  }

  return events
}

// ── presentational atoms ────────────────────────────────────────────────────

export function StatusBadge({ pr, className }: { pr: Pr; className?: string }) {
  const s = statusDisplay(pr)
  const Icon = s.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        s.tone,
        className,
      )}
    >
      <Icon className={cn("size-3", s.spin && "animate-spin")} />
      {s.label}
    </span>
  )
}

export function ScoreBadge({ score, className }: { score?: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
        scoreTone(score),
        className,
      )}
    >
      {score != null ? `${score}/5` : "new"}
    </span>
  )
}

export function EventGlyph({ kind }: { kind: EventKind }) {
  const Icon = eventIcon(kind)
  return (
    <span
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md border bg-zinc-950",
        kind === "agent" && "border-sky-400/30 text-sky-300",
        kind === "ack" && "border-indigo-400/30 text-indigo-300",
        kind === "review" && "border-amber-400/30 text-amber-300",
        kind === "commit" && "border-violet-400/30 text-violet-300",
        kind === "merged" && "border-emerald-400/30 text-emerald-300",
        kind === "failed" && "border-red-400/30 text-red-300",
        kind === "queued" && "border-zinc-700 text-zinc-400",
        kind === "closed" && "border-zinc-700 text-zinc-400",
        kind === "opened" && "border-zinc-700 text-zinc-400",
      )}
    >
      <Icon className={cn("size-3.5", kind === "agent" && "animate-spin")} />
    </span>
  )
}

// ── design-palette atoms (desktop console) ──────────────────────────────────
// List rows wear the status/confidence as bare coloured mono text + dot; detail
// headers wear the same colours as a bordered pill.

export function PrStatusText({ pr }: { pr: Pr }) {
  const m = STATUS_META[pr.statusKey]
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.06em]", m.text)}>
      <span className={cn("size-[5px] shrink-0 rounded-full", m.dot, m.pulse && "prr-pulse")} />
      {m.label}
    </span>
  )
}

export function PrStatusPill({ pr }: { pr: Pr }) {
  const m = STATUS_META[pr.statusKey]
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded border px-2.5 py-[3px] font-mono text-[10px] font-medium", m.text, m.bg, m.border)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", m.dot, m.pulse && "prr-pulse")} />
      {m.label}
    </span>
  )
}

export function ConfText({ score }: { score?: number }) {
  const m = confMeta(score)
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] font-semibold", m.color)}>
      {m.star && <span>★</span>}
      {m.text}
    </span>
  )
}

export function ConfPill({ score }: { score?: number }) {
  const m = confMeta(score)
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-2 py-[3px] font-mono text-[11px] font-semibold", m.color, m.bg, m.border)}>
      {m.star && <span>★</span>}
      {m.text}
    </span>
  )
}

// The review-loop node: a 27px circle, coloured per event kind. A review is a
// green check, a commit/opening is neutral, ack/merge/fail carry their tone, and
// an in-flight re-review spins.
const LOOP_GLYPH: Record<EventKind, { icon: LucideIcon; cls: string; spin?: boolean }> = {
  opened: { icon: GitPullRequest, cls: "border-edge2 bg-[#0d0d0f] text-zinc-500" },
  commit: { icon: GitCommit, cls: "border-edge2 bg-[#0d0d0f] text-zinc-400" },
  review: { icon: Check, cls: "border-[#3fb950]/40 bg-[#3fb950]/[0.12] text-[#86efac]" },
  ack: { icon: Hand, cls: "border-[#818cf8]/40 bg-[#818cf8]/[0.12] text-[#c4b5fd]" },
  agent: { icon: Loader2, cls: "border-[#38bdf8]/40 bg-[#38bdf8]/[0.12] text-[#7dd3fc]", spin: true },
  queued: { icon: Clock3, cls: "border-edge2 bg-[#0d0d0f] text-zinc-400" },
  merged: { icon: GitMerge, cls: "border-[#a371f7]/40 bg-[#a371f7]/[0.12] text-[#d8b4fe]" },
  failed: { icon: AlertTriangle, cls: "border-[#f85149]/40 bg-[#f85149]/[0.12] text-[#fca5a5]" },
  closed: { icon: GitPullRequestClosed, cls: "border-edge2 bg-[#0d0d0f] text-zinc-400" },
}

export function LoopGlyph({ kind }: { kind: EventKind }) {
  const g = LOOP_GLYPH[kind]
  const Icon = g.icon
  return (
    <span className={cn("relative z-10 flex size-[27px] shrink-0 items-center justify-center rounded-full border", g.cls)}>
      <Icon className={cn("size-[13px]", g.spin && "animate-spin")} />
    </span>
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

export function ReviewReport({ report }: { report: string }) {
  return (
    <div className="[&>*:first-child]:mt-0">
      <Markdown options={{ forceBlock: true, overrides: MARKDOWN_OVERRIDES }}>{report}</Markdown>
    </div>
  )
}
