// Shared foundation for the mobile variants.
//
// The pure helpers and presentational atoms here mirror the ones currently
// living inside src/App.tsx. They're duplicated for now so the desktop view
// stays untouched while we explore mobile layouts; once a variant is chosen we
// unify these into one module that both App.tsx and the mobile view import.
import { useEffect, useState } from "react"
import { type FunctionReturnType } from "convex/server"
import Markdown from "markdown-to-jsx"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
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

// Highest-severity blocker count, used to flag a PR as "needs attention".
export function blockerCount(x: { p0?: number; p1?: number }) {
  return (x.p0 ?? 0) + (x.p1 ?? 0)
}

export type StatusDisplay = { label: string; icon: LucideIcon; tone: string; spin?: boolean }

export function statusDisplay(pr: Pr): StatusDisplay {
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
