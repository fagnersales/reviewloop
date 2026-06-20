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

export default crons
