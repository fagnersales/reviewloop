// Shared review kit: the types, hooks, pure helpers, and presentational atoms
// used by both the desktop console (src/App.tsx) and the mobile view
// (src/mobile/*). This is the single source of truth for that logic — App.tsx
// imports from here rather than defining its own copies.
import { useEffect, useState } from "react"
import { type FunctionReturnType } from "convex/server"
import Markdown from "markdown-to-jsx"
import {
  AlertTriangle,
  Check,
  Clock3,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hand,
  Loader2,
  type LucideIcon,
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
const OPEN_ONLY_KEY = "reviewloop.pr-list.open-only"

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

export function githubCommitUrl(repo: string, sha: string) {
  return `https://github.com/${repo}/commit/${sha}`
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
      // An agent acked this review (via reviewloop-ack) and is on the findings — the
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

// ── design-palette atoms ────────────────────────────────────────────────────
// List rows wear the status/confidence as bare coloured mono text + dot; detail
// headers wear the same colours as a bordered pill.

export function PrStatusText({ pr }: { pr: Pr }) {
  const m = STATUS_META[pr.statusKey]
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.06em]", m.text)}>
      <span className={cn("size-[5px] shrink-0 rounded-full", m.dot, m.pulse && "rl-pulse")} />
      {m.label}
    </span>
  )
}

export function PrStatusPill({ pr }: { pr: Pr }) {
  const m = STATUS_META[pr.statusKey]
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded border px-2.5 py-[3px] font-mono text-[10px] font-medium", m.text, m.bg, m.border)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", m.dot, m.pulse && "rl-pulse")} />
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

// The Claude wordmark glyph, inheriting the current text colour.
export function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  )
}

// The "what reviewed this" chip: the model alias (+ effort level) the worker
// stamped on the pass when it ran `claude -p`. Self-hides on passes from before
// the stamp existed.
export function ModelPill({ pass }: { pass?: Pass }) {
  if (!pass?.model) return null
  return (
    <span
      title="Model · effort that produced this review"
      className="inline-flex items-center gap-1.5 rounded border border-edge bg-inset px-2 py-[3px] font-mono text-[11px] text-zinc-500"
    >
      <ClaudeMark className="size-[11px] shrink-0 text-[#d97757]" />
      {pass.model}
      {pass.effort ? ` · ${pass.effort}` : ""}
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
