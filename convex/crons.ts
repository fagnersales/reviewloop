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

// Crash recovery for inbox auto-triage: release `triaging` claims whose worker
// died mid-judgment (see TRIAGE_STALE_MS in suggestedIssues.ts), so the proposal
// becomes claimable again instead of looking in-flight forever.
crons.interval(
  "requeue stale follow-up triage",
  { minutes: 10 },
  internal.suggestedIssues.requeueStaleTriage,
  {},
)

// Crash recovery for checkout provisioning: fail any "provisioning" row whose
// solver died mid-clone/setup (see PROVISION_STALE_MS in solverCheckouts.ts),
// so the console shows the failure instead of a spinner forever.
crons.interval(
  "fail stale checkout provisions",
  { minutes: 15 },
  internal.solverCheckouts.failStaleProvisions,
  {},
)

export default crons
