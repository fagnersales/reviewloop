import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Crash recovery: requeue any review whose worker died mid-run (see STALE_MS in
// reviews.ts). The common path is webhook-driven; this only catches stragglers.
crons.interval(
  "requeue stale reviews",
  { minutes: 5 },
  internal.reviews.requeueStale,
  {},
)

// Honesty for the agent-ack signal: drop acks a fix agent left on a reviewed pass
// but never followed with a commit (see ACK_STALE_MS in reviews.ts), so the board
// reverts from "In progress" to "Awaiting agent" instead of lying indefinitely.
crons.interval(
  "clear stale acks",
  { minutes: 10 },
  internal.reviews.clearStaleAcks,
  {},
)

// Crash recovery for the solver: requeue any solve whose worker died mid-run (see
// STALE_MS in solveTasks.ts). Solves run for tens of minutes to hours, so this
// fires on a long interval and the STALE bound is generous — the common path is
// webhook/reconcile-driven; this only catches a crashed solver.
crons.interval(
  "requeue stale solves",
  { minutes: 15 },
  internal.solveTasks.requeueStale,
  {},
)

export default crons
