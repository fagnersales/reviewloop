// The mobile console, per the "reviewloop mobile" design: one shell owning the
// brand bar, a per-tab list screen (Reviews / Solves / Follow-ups) with filter
// chips, a bottom tab bar, and a full-screen detail that pushes in from the
// right. The tab bar lives on the list screen only — the detail covers it.
//
// Selection is stored by id and the live row re-derived each render, so an open
// detail keeps receiving Convex updates (status, new rounds, streaming progress)
// while a review or solve is in flight. A snapshot would freeze it.
import { useMemo, useRef, useState } from "react"
import { useQuery } from "convex-helpers/react/cache/hooks"
import { ArrowUpRight, Bot, ChevronLeft, GitPullRequest, Inbox, Loader2, Lock, Search, X } from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"
import { type View, useView } from "../lib/view"
import { useReadOnly } from "../read-only"
import {
  type Pr,
  ConfText,
  PrStatusText,
  prTiming,
  repoShort,
  roundCount,
  useNow,
} from "../review/kit"
import {
  type SolveStatus,
  type SolveTask,
  SolveStatusText,
  orderSolves,
  solveSub,
} from "../solves/kit"
import {
  FU_CAT_TEXT,
  FU_STATUS,
  type SugStatus,
  type Suggestion,
  issueUrl,
  useFollowUpActions,
} from "../follow-ups/kit"
import { MobileReviewDetail } from "./ReviewDetail"
import { MobileSolveDetail } from "./SolveDetail"
import { MobileFollowUpDetail } from "./FollowUpDetail"

// ── list cards ───────────────────────────────────────────────────────────────

const CARD =
  "flex w-full flex-col rounded-[11px] border border-line2 bg-panel px-3.5 py-[13px] text-left transition-colors active:bg-rowsel"

function RvCard({ pr, now, showRepo, onTap }: { pr: Pr; now: number; showRepo: boolean; onTap: () => void }) {
  const timing = prTiming(pr, now)
  const rounds = roundCount(pr)
  return (
    <button type="button" onClick={onTap} className={CARD}>
      <div className="flex items-center justify-between gap-2.5">
        <span className="min-w-0 truncate text-sm font-medium text-[#e8e8ea]">{pr.title}</span>
        <ConfText score={pr.confidence} />
      </div>
      <div className="mt-[9px] flex items-center justify-between gap-2 font-mono text-[10.5px] text-[#6e6e78]">
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

function SvCard({ t, onTap }: { t: SolveTask; onTap: () => void }) {
  const sub = solveSub(t)
  return (
    <button type="button" onClick={onTap} className={CARD}>
      <div className="flex items-center justify-between gap-2.5">
        <span className="min-w-0 truncate text-sm font-medium text-[#e8e8ea]">{t.issueTitle}</span>
        <SolveStatusText status={t.status} />
      </div>
      <div className="mt-[7px] font-mono text-[10.5px] text-[#6e6e78]">
        {repoShort(t.repo)}  #{t.issueNumber}
      </div>
      <div className={cn("mt-1.5 truncate text-xs leading-relaxed", sub.cls)}>{sub.text}</div>
    </button>
  )
}

function FuCard({ s, onTap }: { s: Suggestion; onTap: () => void }) {
  const st = FU_STATUS[s.status]
  return (
    <button type="button" onClick={onTap} className={CARD}>
      <div className="flex items-center justify-between gap-2.5">
        <span className="min-w-0 truncate text-sm font-medium text-[#e8e8ea]">{s.title}</span>
        {s.status !== "suggested" && (
          <span className={cn("shrink-0 font-mono text-[9.5px] font-semibold tracking-[0.05em]", st.text)}>
            {st.label}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10.5px] text-[#6e6e78]">
        <span className="min-w-0 truncate">
          {repoShort(s.repo)}  #{s.sourcePrNumber}
        </span>
        <span className={cn("shrink-0", FU_CAT_TEXT[s.category])}>{s.category}</span>
      </div>
    </button>
  )
}

// ── shell atoms ──────────────────────────────────────────────────────────────

function Chip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-[7px] font-mono text-[11px] font-medium transition-colors",
        active ? "border-edge2 bg-[#1f1f24] text-zinc-100" : "border-line2 bg-[#0d0d0f] text-zinc-400",
      )}
    >
      {label}
      <span className={cn("text-[10px]", active ? "text-zinc-400" : "text-zinc-600")}>{count}</span>
    </button>
  )
}

function TabBtn({
  active,
  onClick,
  icon: Icon,
  label,
  badge = 0,
}: {
  active: boolean
  onClick: () => void
  icon: typeof GitPullRequest
  label: string
  badge?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 flex-col items-center gap-[5px] py-[5px] transition-colors",
        active ? "text-accent" : "text-zinc-600",
      )}
    >
      <span className="relative flex">
        <Icon className="size-[22px]" strokeWidth={1.8} />
        {badge > 0 && (
          <span className="absolute -right-1.5 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-lg border-[1.5px] border-panel bg-[#e3b341] px-[3px] font-mono text-[9px] font-bold text-[#1a1304]">
            {badge}
          </span>
        )}
      </span>
      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.08em]">{label}</span>
    </button>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-zinc-500">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  )
}

function EmptyCard({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-edge p-6 text-center text-[13px] text-zinc-600">
      {label}
    </div>
  )
}

// The full-screen detail chrome: accent back button + optional GitHub link.
function DetailShell({
  backLabel,
  href,
  onBack,
  children,
}: {
  backLabel: string
  href: string | null
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex shrink-0 items-center justify-between gap-2.5 border-b border-line px-3 pb-3 pt-[calc(env(safe-area-inset-top)+14px)]">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-0.5 py-1 pl-0.5 pr-1.5 text-[15px] font-medium text-accent active:opacity-70"
        >
          <ChevronLeft className="size-5" strokeWidth={2.2} />
          {backLabel}
        </button>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            aria-label="Open on GitHub"
            className="flex size-[34px] shrink-0 items-center justify-center rounded-[7px] border border-edge text-zinc-500 active:text-zinc-200"
          >
            <ArrowUpRight className="size-4" />
          </a>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-10 pt-[18px]">{children}</div>
    </div>
  )
}

// ── filters ──────────────────────────────────────────────────────────────────

const SOLVE_CHIPS: { value: SolveStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "solving", label: "Solving" },
  { value: "queued", label: "Queued" },
  { value: "pr-opened", label: "PR opened" },
  { value: "done", label: "Merged" },
  { value: "failed", label: "Failed" },
]

const FU_CHIPS: { value: SugStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "suggested", label: "Suggested" },
  { value: "approved", label: "Approved" },
  { value: "opened", label: "Opened" },
  { value: "dismissed", label: "Dismissed" },
]

const TAB_TITLE: Record<View, string> = {
  reviews: "Reviews",
  solves: "Solves",
  "follow-ups": "Follow-ups",
}

// The open detail, stored by view + row id; the live row is re-derived each render.
type Detail = { view: View; id: string }

type LiveDetail =
  | { view: "reviews"; pr: Pr }
  | { view: "solves"; task: SolveTask }
  | { view: "follow-ups"; fu: Suggestion }

export function MobileApp() {
  const readOnly = useReadOnly()
  const [view, setView] = useView()
  const now = useNow()

  const prs = useQuery(api.reviews.prs)
  const board = useQuery(api.solveTasks.board)
  const inbox = useQuery(api.suggestedIssues.inbox)
  const pending = useQuery(api.suggestedIssues.pendingCount) ?? 0
  const solves = useMemo(() => orderSolves(board), [board])
  const fus = useMemo(() => inbox ?? [], [inbox])
  const fuActions = useFollowUpActions()

  const [activeRepo, setActiveRepo] = useState("all")
  const [query, setQuery] = useState("")
  const [solveFilter, setSolveFilter] = useState<SolveStatus | "all">("all")
  const [fuFilter, setFuFilter] = useState<SugStatus | "all">("all")
  const [detail, setDetail] = useState<Detail | null>(null)

  const goTab = (v: View) => {
    setView(v)
    setDetail(null)
  }

  // ── reviews list ──
  const allPrs = useMemo(() => prs ?? [], [prs])
  const repos = useMemo(
    () => Array.from(new Set(allPrs.map((p) => p.repo))).sort((a, b) => a.localeCompare(b)),
    [allPrs],
  )
  const rvShown = useMemo(() => {
    const byRepo =
      activeRepo === "all" ? allPrs : allPrs.filter((p) => p.repo.toLowerCase() === activeRepo.toLowerCase())
    const q = query.trim().toLowerCase()
    return q
      ? byRepo.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            `#${p.prNumber}`.includes(q) ||
            p.repo.toLowerCase().includes(q),
        )
      : byRepo
  }, [allPrs, activeRepo, query])

  // ── solves / follow-ups lists ──
  const svShown = useMemo(
    () => (solveFilter === "all" ? solves : solves.filter((t) => t.status === solveFilter)),
    [solves, solveFilter],
  )
  const fuShown = useMemo(
    () => (fuFilter === "all" ? fus : fus.filter((s) => s.status === fuFilter)),
    [fus, fuFilter],
  )

  // Live row for the open detail. If the row leaves the board the detail closes,
  // but the last live snapshot keeps rendering through the slide-out animation.
  const live: LiveDetail | null = useMemo(() => {
    if (!detail) return null
    if (detail.view === "reviews") {
      const pr = allPrs.find((p) => p.key === detail.id)
      return pr ? { view: "reviews", pr } : null
    }
    if (detail.view === "solves") {
      const task = solves.find((t) => t._id === detail.id)
      return task ? { view: "solves", task } : null
    }
    const fu = fus.find((s) => s._id === detail.id)
    return fu ? { view: "follow-ups", fu } : null
  }, [detail, allPrs, solves, fus])

  const lastLiveRef = useRef<LiveDetail | null>(null)
  if (live) lastLiveRef.current = live
  const shownDetail = live ?? lastLiveRef.current
  const detailOpen = live !== null

  const count =
    view === "reviews"
      ? `${rvShown.length} PR${rvShown.length === 1 ? "" : "s"}`
      : view === "solves"
        ? `${svShown.length} solve${svShown.length === 1 ? "" : "s"}`
        : `${fuShown.length} item${fuShown.length === 1 ? "" : "s"}`

  return (
    <div className="relative h-dvh overflow-hidden bg-canvas text-zinc-300">
      {/* ── list screen ── */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-transform duration-300 ease-out",
          detailOpen ? "-translate-x-1/4" : "translate-x-0",
        )}
      >
        {/* brand bar */}
        <div className="shrink-0 px-[18px] pt-[calc(env(safe-area-inset-top)+14px)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-edge2 bg-gradient-to-b from-[#141417] to-[#0d0d0f]">
                <GitPullRequest className="size-4 text-accent" />
              </div>
              <div className="min-w-0">
                <div className="text-[15px] font-semibold tracking-[-0.01em] text-zinc-100">reviewloop.sh</div>
                <div className="mt-0.5 flex items-center gap-[5px] font-mono text-[9px] uppercase tracking-[0.13em] text-zinc-600">
                  <span className="size-[5px] rounded-full bg-accent shadow-[0_0_0_3px_rgba(63,185,80,0.12)]" />
                  {readOnly ? "Phone · signed in" : "Local · admin"}
                </div>
              </div>
            </div>
            {readOnly && (
              <span className="inline-flex shrink-0 items-center gap-[5px] rounded-md border border-[#e3b341]/30 bg-[#e3b341]/10 px-2 py-[5px] font-mono text-[9px] font-semibold tracking-[0.1em] text-[#e3b341]">
                <Lock className="size-[11px]" />
                READ-ONLY
              </span>
            )}
          </div>
        </div>

        {/* title + count */}
        <div className="shrink-0 px-[18px] pb-3 pt-[18px]">
          <div className="flex items-baseline justify-between gap-2.5">
            <h1 className="text-[25px] font-bold tracking-[-0.02em] text-zinc-100">{TAB_TITLE[view]}</h1>
            <span className="shrink-0 font-mono text-[11px] text-zinc-600">{count}</span>
          </div>
        </div>

        {/* search (reviews only) */}
        {view === "reviews" && (
          <div className="shrink-0 px-[18px] pb-[11px]">
            <div className="flex items-center gap-2 rounded-[9px] border border-edge bg-inset px-3 py-2.5">
              <Search className="size-[15px] shrink-0 text-zinc-600" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search PRs or repos…"
                className="min-w-0 flex-1 bg-transparent text-sm text-zinc-300 outline-none placeholder:text-zinc-600"
              />
              {query && (
                <button
                  type="button"
                  title="Clear search"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="flex text-zinc-600 active:text-zinc-300"
                >
                  <X className="size-[15px]" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* filter chips */}
        <div className="shrink-0">
          <div className="flex gap-[7px] overflow-x-auto px-[18px] pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {view === "reviews" && (
              <>
                <Chip active={activeRepo === "all"} label="All" count={allPrs.length} onClick={() => setActiveRepo("all")} />
                {repos.map((r) => (
                  <Chip
                    key={r}
                    active={activeRepo.toLowerCase() === r.toLowerCase()}
                    label={repoShort(r)}
                    count={allPrs.filter((p) => p.repo === r).length}
                    onClick={() => setActiveRepo(r)}
                  />
                ))}
              </>
            )}
            {view === "solves" &&
              SOLVE_CHIPS.map((c) => (
                <Chip
                  key={c.value}
                  active={solveFilter === c.value}
                  label={c.label}
                  count={c.value === "all" ? solves.length : solves.filter((t) => t.status === c.value).length}
                  onClick={() => setSolveFilter(c.value)}
                />
              ))}
            {view === "follow-ups" &&
              FU_CHIPS.map((c) => (
                <Chip
                  key={c.value}
                  active={fuFilter === c.value}
                  label={c.label}
                  count={c.value === "all" ? fus.length : fus.filter((s) => s.status === c.value).length}
                  onClick={() => setFuFilter(c.value)}
                />
              ))}
          </div>
        </div>

        {/* scroll list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-5 pt-0.5">
          {view === "reviews" &&
            (prs === undefined ? (
              <Loading label="Loading reviews…" />
            ) : (
              <div className="flex flex-col gap-2.5">
                {rvShown.map((pr) => (
                  <RvCard
                    key={pr.key}
                    pr={pr}
                    now={now}
                    showRepo={activeRepo === "all"}
                    onTap={() => setDetail({ view: "reviews", id: pr.key })}
                  />
                ))}
                {rvShown.length === 0 && (
                  <EmptyCard label={query.trim() ? "No PRs match your search." : "No reviews yet."} />
                )}
              </div>
            ))}
          {view === "solves" &&
            (board === undefined ? (
              <Loading label="Loading solves…" />
            ) : (
              <div className="flex flex-col gap-2.5">
                {svShown.map((t) => (
                  <SvCard key={t._id} t={t} onTap={() => setDetail({ view: "solves", id: t._id })} />
                ))}
                {svShown.length === 0 && <EmptyCard label="No solves in this view." />}
              </div>
            ))}
          {view === "follow-ups" &&
            (inbox === undefined ? (
              <Loading label="Loading follow-ups…" />
            ) : (
              <div className="flex flex-col gap-2.5">
                {fuShown.map((s) => (
                  <FuCard key={s._id} s={s} onTap={() => setDetail({ view: "follow-ups", id: s._id })} />
                ))}
                {fuShown.length === 0 && <EmptyCard label="No follow-ups in this view." />}
              </div>
            ))}
        </div>

        {/* bottom tab bar */}
        <nav className="flex shrink-0 items-stretch gap-0.5 border-t border-line bg-panel px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-[9px]">
          <TabBtn active={view === "reviews"} onClick={() => goTab("reviews")} icon={GitPullRequest} label="Reviews" />
          <TabBtn active={view === "solves"} onClick={() => goTab("solves")} icon={Bot} label="Solves" />
          <TabBtn
            active={view === "follow-ups"}
            onClick={() => goTab("follow-ups")}
            icon={Inbox}
            label="Follow-ups"
            badge={pending}
          />
        </nav>
      </div>

      {/* ── detail screen (pushed in from the right) ── */}
      <div
        className={cn(
          "absolute inset-0 transition-transform duration-300 ease-out",
          detailOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {shownDetail?.view === "reviews" && (
          <DetailShell backLabel="Reviews" href={shownDetail.pr.prUrl} onBack={() => setDetail(null)}>
            <MobileReviewDetail key={shownDetail.pr.key} pr={shownDetail.pr} />
          </DetailShell>
        )}
        {shownDetail?.view === "solves" && (
          <DetailShell backLabel="Solves" href={shownDetail.task.prUrl ?? null} onBack={() => setDetail(null)}>
            <MobileSolveDetail task={shownDetail.task} />
          </DetailShell>
        )}
        {shownDetail?.view === "follow-ups" && (
          <DetailShell
            backLabel="Follow-ups"
            href={
              shownDetail.fu.status === "opened" && shownDetail.fu.issueNumber != null
                ? issueUrl(shownDetail.fu.repo, shownDetail.fu.issueNumber)
                : null
            }
            onBack={() => setDetail(null)}
          >
            <MobileFollowUpDetail s={shownDetail.fu} actions={fuActions} readOnly={readOnly} />
          </DetailShell>
        )}
      </div>
    </div>
  )
}
