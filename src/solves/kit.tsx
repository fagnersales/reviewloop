// Solves kit: the Convex-row type, the solve-status vocabulary, and the
// presentational atoms for the autonomous-solver view. The interactive surfaces
// (rows, detail) live in Solves.tsx; this is the shared vocabulary. The view is
// read-only — a solve is autonomous, and the only human action (merging the PR)
// happens on GitHub — so there are no action affordances here, just status.
import { type FunctionReturnType } from "convex/server"
import {
  AlertTriangle,
  Clock,
  GitMerge,
  GitPullRequest,
  Loader2,
  type LucideIcon,
} from "lucide-react"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"

// The board returns three buckets of the same row shape; one row = one solve task.
export type SolveBoard = FunctionReturnType<typeof api.solveTasks.board>
export type SolveTask = SolveBoard["solving"][number]
export type SolveStatus = SolveTask["status"]

// queued → amber (waiting) · solving → sky (building, spinner) · pr-opened →
// violet (PR up, awaiting a human merge) · done → emerald (merged) · failed → rose.
export const SOLVE_STATUS: Record<
  SolveStatus,
  { label: string; dot: string; tone: string; icon: LucideIcon; spin?: boolean }
> = {
  queued: {
    label: "Queued",
    dot: "bg-amber-400",
    tone: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    icon: Clock,
  },
  solving: {
    label: "Solving",
    dot: "bg-sky-400",
    tone: "border-sky-400/25 bg-sky-400/10 text-sky-200",
    icon: Loader2,
    spin: true,
  },
  "pr-opened": {
    label: "PR opened",
    dot: "bg-violet-400",
    tone: "border-violet-400/25 bg-violet-400/10 text-violet-200",
    icon: GitPullRequest,
  },
  done: {
    label: "Merged",
    dot: "bg-emerald-400",
    tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    icon: GitMerge,
  },
  failed: {
    label: "Failed",
    dot: "bg-rose-500",
    tone: "border-rose-500/25 bg-rose-500/10 text-rose-200",
    icon: AlertTriangle,
  },
}

export const solveIssueUrl = (t: SolveTask) =>
  t.issueUrl || `https://github.com/${t.repo}/issues/${t.issueNumber}`

// A solve's "last activity" timestamp — drives ordering and the "Xm ago" stamp.
export const solveActivityAt = (t: SolveTask) => t.finishedAt ?? t.startedAt ?? t.queuedAt

// Flatten the board into one activity-ordered list: live solves first (newest
// build on top), then queued, then finished (newest first). Mirrors how the
// reviews board surfaces active work above the recent tail.
export function orderSolves(board: SolveBoard | undefined): SolveTask[] {
  if (!board) return []
  const solving = [...board.solving].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const queued = [...board.queued].sort((a, b) => a.queuedAt - b.queuedAt)
  const recent = [...board.recent].sort((a, b) => solveActivityAt(b) - solveActivityAt(a))
  return [...solving, ...queued, ...recent]
}

// A solid status dot; the solving state gets a soft pulse so the board reads as live.
export function SolveStateDot({ status }: { status: SolveStatus }) {
  const s = SOLVE_STATUS[status]
  return (
    <span className="relative inline-flex">
      <span className={cn("size-2 shrink-0 rounded-full", s.dot)} />
      {status === "solving" && (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", s.dot)} />
      )}
    </span>
  )
}

// The status chip: tone + icon + label, with a spinner while solving.
export function StatusPill({ status }: { status: SolveStatus }) {
  const s = SOLVE_STATUS[status]
  const Icon = s.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        s.tone,
      )}
    >
      <Icon className={cn("size-3", s.spin && "animate-spin")} />
      {s.label}
    </span>
  )
}
