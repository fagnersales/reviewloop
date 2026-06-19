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

export default crons
