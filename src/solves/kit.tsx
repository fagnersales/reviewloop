// Solves kit: the Convex-row type, the solve-status vocabulary, and the
// design-palette atoms for the autonomous-solver view — shared by the desktop
// two-pane (Solves.tsx) and the mobile console (src/mobile). The view is
// read-only — a solve is autonomous, and the only human action (merging the PR)
// happens on GitHub — so there are no action affordances here, just status.
import { type FunctionReturnType } from "convex/server"
import { api } from "../../convex/_generated/api"
import { cn } from "../lib/cn"

// The board returns three buckets of the same row shape; one row = one solve task.
export type SolveBoard = FunctionReturnType<typeof api.solveTasks.board>
export type SolveTask = SolveBoard["solving"][number]
export type SolveStatus = SolveTask["status"]

// The console's design palette: status as a coloured uppercase mono label (rows)
// / dot + label pill (headers), with the live state pulsing. queued → amber
// (waiting) · solving → sky (building) · pr-opened → violet (PR up, awaiting a
// human merge) · done → emerald (merged) · failed → red.
export const SOLVE_META: Record<
  SolveStatus,
  { label: string; text: string; dot: string; bg: string; border: string; pulse: boolean }
> = {
  queued: { label: "QUEUED", text: "text-[#fcd34d]", dot: "bg-[#e3b341]", bg: "bg-[#e3b341]/10", border: "border-[#e3b341]/30", pulse: false },
  solving: { label: "SOLVING", text: "text-[#7dd3fc]", dot: "bg-[#38bdf8]", bg: "bg-[#38bdf8]/10", border: "border-[#38bdf8]/30", pulse: true },
  "pr-opened": { label: "PR OPENED", text: "text-[#d8b4fe]", dot: "bg-[#a371f7]", bg: "bg-[#a371f7]/10", border: "border-[#a371f7]/30", pulse: false },
  done: { label: "MERGED", text: "text-[#86efac]", dot: "bg-[#3fb950]", bg: "bg-[#3fb950]/10", border: "border-[#3fb950]/30", pulse: false },
  failed: { label: "FAILED", text: "text-[#fca5a5]", dot: "bg-[#f85149]", bg: "bg-[#f85149]/10", border: "border-[#f85149]/30", pulse: false },
}

// The "what happens next" explainer for the states that aren't self-evident.
export const SOLVE_NOTE: Partial<Record<SolveStatus, string>> = {
  queued: "Waiting for an available solver worker. The /pr-feature run starts once a slot frees up.",
  "pr-opened": "The agent opened a PR and stopped — solvers never merge. A human reviews and merges it on GitHub.",
  done: "The PR was merged on GitHub, closing the issue → solve → PR lineage. Nothing more to do.",
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

// The one-line, status-coloured subtitle under a row's title.
export function solveSub(t: SolveTask): { text: string; cls: string } {
  if (t.status === "solving") return { text: t.progress || "Starting…", cls: "text-[#7dd3fc]" }
  if (t.status === "queued") return { text: "Waiting for a solver", cls: "text-zinc-500" }
  if (t.status === "failed") return { text: t.error || "Failed", cls: "text-[#fca5a5]" }
  if (t.status === "done" && t.prNumber != null) return { text: `Merged · PR #${t.prNumber}`, cls: "text-zinc-500" }
  if (t.prNumber != null) return { text: `Opened PR #${t.prNumber}`, cls: "text-zinc-500" }
  return { text: SOLVE_META[t.status].label, cls: "text-zinc-500" }
}

export function SolveStatusText({ status }: { status: SolveStatus }) {
  const m = SOLVE_META[status]
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] font-semibold tracking-[0.06em]", m.text)}>
      <span className={cn("size-[5px] shrink-0 rounded-full", m.dot, m.pulse && "rl-pulse")} />
      {m.label}
    </span>
  )
}

export function SolveStatusPill({ status }: { status: SolveStatus }) {
  const m = SOLVE_META[status]
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded border px-2.5 py-[3px] font-mono text-[10px] font-medium", m.text, m.bg, m.border)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", m.dot, m.pulse && "rl-pulse")} />
      {m.label}
    </span>
  )
}
