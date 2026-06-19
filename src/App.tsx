import { useEffect, useState, type ReactNode } from "react"
import { useQuery } from "convex/react"
import { api } from "../convex/_generated/api"
import type { Doc } from "../convex/_generated/dataModel"
import {
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
} from "lucide-react"
import { cn } from "./lib/cn"
import { ago, dur, clock } from "./lib/format"

type Review = Doc<"reviews">

const ETA_MS = 10 * 60 * 1000 // a review takes ~10 min; the progress bar targets this

// A clock that re-renders on an interval so elapsed timers stay live.
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

function ScoreBadge({ score }: { score?: number }) {
  if (score == null) return null
  const tone =
    score >= 4
      ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
      : score >= 3
        ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
        : "bg-red-500/15 text-red-300 ring-red-500/30"
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs font-semibold ring-1",
        tone,
      )}
      title="merge-readiness confidence"
    >
      {score}/5
    </span>
  )
}

function LifecycleBadge({ state }: { state?: "merged" | "closed" }) {
  if (!state) return null
  const merged = state === "merged"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1",
        merged
          ? "bg-purple-500/15 text-purple-300 ring-purple-500/30"
          : "bg-zinc-500/15 text-zinc-400 ring-zinc-500/30",
      )}
    >
      {merged ? (
        <GitMerge className="size-3" />
      ) : (
        <GitPullRequestClosed className="size-3" />
      )}
      {merged ? "Merged" : "Closed"}
    </span>
  )
}

function PChips({ r }: { r: Review }) {
  const items: Array<[string, number | undefined, string]> = [
    ["P0", r.p0, "bg-red-500/15 text-red-300 ring-red-500/30"],
    ["P1", r.p1, "bg-orange-500/15 text-orange-300 ring-orange-500/30"],
    ["P2", r.p2, "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30"],
  ]
  const shown = items.filter(([, n]) => n != null && n > 0)
  if (shown.length === 0) return null
  return (
    <div className="flex gap-1">
      {shown.map(([label, n, tone]) => (
        <span
          key={label}
          className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium ring-1", tone)}
        >
          {n} {label}
        </span>
      ))}
    </div>
  )
}

function PrTitle({ r }: { r: Review }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <a
          href={r.prUrl}
          target="_blank"
          rel="noreferrer"
          className="truncate font-medium text-zinc-100 hover:text-white hover:underline"
        >
          {r.title || `PR #${r.prNumber}`}
        </a>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-mono">#{r.prNumber}</span>
        <span>·</span>
        <span>{r.author || "unknown"}</span>
        <span>·</span>
        <span className="font-mono">{r.headSha.slice(0, 7)}</span>
      </div>
    </div>
  )
}

function ReviewingCard({ r, now }: { r: Review; now: number }) {
  const started = r.startedAt ?? r.queuedAt
  const elapsed = now - started
  const pct = Math.min(100, (elapsed / ETA_MS) * 100)
  const over = elapsed > ETA_MS
  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-sky-400" />
          <PrTitle r={r} />
        </div>
        <div className="shrink-0 text-right">
          <div
            className={cn(
              "font-mono text-sm tabular-nums",
              over ? "text-amber-300" : "text-sky-300",
            )}
          >
            {clock(elapsed)}
          </div>
          <div className="text-[11px] text-zinc-500">
            {over ? "over ~10m" : "~10m typical"}
          </div>
        </div>
      </div>
      {r.progress && (
        <div
          className="mt-2 truncate font-mono text-xs text-zinc-400"
          title={r.progress}
        >
          <span className="text-zinc-600">›</span> {r.progress}
        </div>
      )}
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-1000 ease-linear",
            over ? "bg-amber-400" : "bg-sky-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {r.worker && (
        <div className="mt-1.5 text-[11px] text-zinc-600">on {r.worker}</div>
      )}
    </div>
  )
}

function QueuedRow({ r, now }: { r: Review; now: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <Clock className="size-4 shrink-0 text-zinc-500" />
        <PrTitle r={r} />
      </div>
      <span className="shrink-0 text-xs text-zinc-500">
        waiting {dur(now - r.queuedAt)}
      </span>
    </div>
  )
}

function RecentRow({ r, now }: { r: Review; now: number }) {
  const ok = r.status === "reviewed"
  const took =
    r.finishedAt && r.startedAt ? r.finishedAt - r.startedAt : undefined
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {ok ? (
          <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
        ) : (
          <XCircle className="size-4 shrink-0 text-red-400" />
        )}
        <PrTitle r={r} />
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <LifecycleBadge state={r.prState} />
        {ok ? (
          <>
            <PChips r={r} />
            <ScoreBadge score={r.confidence} />
          </>
        ) : (
          <span
            className="max-w-[16rem] truncate text-xs text-red-300/80"
            title={r.error}
          >
            {r.error || "failed"}
          </span>
        )}
        <span className="hidden text-[11px] text-zinc-600 sm:inline">
          {took != null ? dur(took) : ""} · {r.finishedAt ? ago(r.finishedAt, now) : ""}
        </span>
        {r.reviewUrl && (
          <a
            href={r.reviewUrl}
            target="_blank"
            rel="noreferrer"
            className="text-zinc-500 hover:text-zinc-200"
            title="open the GitHub review"
          >
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
        <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium text-zinc-400">
          {count}
        </span>
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

export default function App() {
  const board = useQuery(api.reviews.board)
  const now = useNow(1000)

  const reviewing = board?.reviewing ?? []
  const queued = board?.queued ?? []
  const recent = board?.recent ?? []

  const repos = Array.from(
    new Set([...reviewing, ...queued, ...recent].map((r) => r.repo)),
  )

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <header className="mb-8">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
          <GitPullRequest className="size-5 text-sky-400" />
          PR Review Console
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {repos.length ? repos.join(", ") : "waiting for PR events…"}
        </p>
      </header>

      {board === undefined ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" /> connecting…
        </div>
      ) : (
        <>
          {reviewing.length > 0 && (
            <Section title="Verifying now" count={reviewing.length}>
              {reviewing.map((r) => (
                <ReviewingCard key={r._id} r={r} now={now} />
              ))}
            </Section>
          )}

          {queued.length > 0 && (
            <Section title="Queued" count={queued.length}>
              {queued.map((r) => (
                <QueuedRow key={r._id} r={r} now={now} />
              ))}
            </Section>
          )}

          <Section title="Recently verified" count={recent.length}>
            {recent.length === 0 ? (
              <p className="text-sm text-zinc-600">
                No reviews yet. Open or push to a PR and it shows up here.
              </p>
            ) : (
              recent.map((r) => <RecentRow key={r._id} r={r} now={now} />)
            )}
          </Section>
        </>
      )}

      <footer className="mt-10 flex items-center gap-2 text-xs text-zinc-600">
        <span className="size-1.5 rounded-full bg-emerald-500 pulse-dot" />
        live · event-driven via GitHub webhook
      </footer>
    </div>
  )
}
