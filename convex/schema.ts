import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

// A review goes queued -> reviewing -> reviewed | failed.
//   queued    : a webhook (or rescan) saw a PR head SHA with no review yet
//   reviewing : the worker claimed it and `claude -p /pr-review N` is running
//   reviewed  : the review was posted to GitHub (see reviewUrl)
//   failed    : the run errored or timed out
export const reviewStatus = v.union(
  v.literal("queued"),
  v.literal("reviewing"),
  v.literal("reviewed"),
  v.literal("failed"),
)

// Semantic kind of a streamed review-log line — mirrors the client's
// CloudLogKind ("info" | "done" | "warn" | "error"), driving the ticker's dot
// colour/glyph. Optional on a line; absent reads as "info".
export const logKind = v.union(
  v.literal("info"),
  v.literal("done"),
  v.literal("warn"),
  v.literal("error"),
)

// ── follow-up suggestions ────────────────────────────────────────────────────
// A `suggestedIssues` row is a *proposal* a pr-feature agent emitted at the
// unattended wrap-up of a PR it built — out-of-scope work it deferred, a
// limitation it disclosed, a tangent it noticed. It is NOT a GitHub issue yet:
// the console is the async approval inbox, and only on a human "Open" does the
// worker file it (Convex has no GitHub auth — the worker does, exactly like
// reviews). The lifecycle is two deliberate human gates, no auto-cascade:
//   suggested  : proposed by the agent, awaiting a human decision
//   approved   : human said "open it" — the worker will `gh issue create` it
//   opened      : filed on GitHub (issueNumber set), labelled needs-triage
//   dismissed   : human said no — kept as history, never opened
// Gate 2 lives on an `opened` row: the human picks a triage `label`, and the
// worker propagates it to the real GitHub issue (the solver gates on the real
// `ready-for-agent` label, so this is not cosmetic).
export const suggestionStatus = v.union(
  v.literal("suggested"),
  v.literal("approved"),
  v.literal("opened"),
  v.literal("dismissed"),
)

// What kind of work the follow-up is.
export const suggestionCategory = v.union(
  v.literal("bug"),
  v.literal("enhancement"),
  v.literal("chore"),
)

// How the agent surfaced it while building the PR (drives the source tag).
export const suggestionSource = v.union(
  v.literal("deferred-p2"),
  v.literal("disclosed-limitation"),
  v.literal("build-tangent"),
)

// The triage state-role labels (canonical names; the real GitHub label strings
// are per-repo tracker config). An opened follow-up always starts needs-triage;
// the human promotes it. `ready-for-agent` is what the autonomous solver loop
// gates on — promotion is the deliberate second gate.
export const triageLabel = v.union(
  v.literal("needs-triage"),
  v.literal("ready-for-agent"),
  v.literal("ready-for-human"),
  v.literal("wontfix"),
)

// The non-system columns of a `suggestedIssues` row.
export const suggestedIssueFields = {
  // source PR provenance — the PR the agent built when it proposed this
  repo: v.string(), // "owner/name"
  sourcePrNumber: v.number(),
  sourceHeadSha: v.string(), // head SHA at proposal time
  sourcePrTitle: v.string(),
  sourcePrUrl: v.string(),
  // the proposal itself
  title: v.string(),
  body: v.string(), // markdown
  category: suggestionCategory,
  source: suggestionSource,
  files: v.array(v.string()), // "files to touch" the brief points a fresh agent at
  // stable idempotency key derived from (repo, sourcePrNumber, title): an agent
  // re-run, or a second pr-feature session, collapses onto the same row instead
  // of double-filing. Also embedded as a marker in the opened issue body so the
  // worker can dedup against GitHub (crash-safety between create and markOpened).
  dedupKey: v.string(),
  status: suggestionStatus,
  proposedBy: v.string(), // agent/host label, like reviews.worker
  createdAt: v.number(),
  // human decision (gate 1): when/who approved or dismissed
  decidedAt: v.optional(v.number()),
  decidedBy: v.optional(v.string()),
  // set by the worker on `opened` — the filed GitHub issue
  issueNumber: v.optional(v.number()),
  // desired triage label (gate 2). On open it's needs-triage; the console picker
  // changes it and the worker propagates the change to GitHub.
  label: v.optional(triageLabel),
  // the label the worker last actually applied on GitHub — drives label sync:
  // a row with label !== appliedLabel needs the worker to `gh issue edit` it.
  appliedLabel: v.optional(triageLabel),
  // worker-loop safety: bounded retries + last error for the GitHub side-effect
  // (issue create / label edit), so a persistent gh failure surfaces instead of
  // spinning the subscription forever.
  attempts: v.optional(v.number()),
  error: v.optional(v.string()),
}

// One commit in a PR push, captured by the worker from GitHub (the dashboard has
// no GitHub auth of its own) — the commits that landed in a single review turn.
export const commitInfo = v.object({
  sha: v.string(),
  message: v.string(),
  author: v.string(), // GitHub login, or the git author name when unlinked
  avatarUrl: v.optional(v.string()),
  additions: v.number(),
  deletions: v.number(),
})

// The non-system columns of a `reviews` row — reused by query return validators.
export const reviewFields = {
  repo: v.string(), // "owner/name"
  prNumber: v.number(),
  headSha: v.string(),
  title: v.string(),
  author: v.string(),
  prUrl: v.string(),
  status: reviewStatus,
  queuedAt: v.number(),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  worker: v.optional(v.string()),
  // a one-line "what the agent is doing right now", streamed during reviewing
  progress: v.optional(v.string()),
  // GitHub's own PR lifecycle timestamps (ms), the anchors for "time to merge"
  // and "open for…". Optional because rows queued before this was added, and
  // reconcile-discovered PRs that miss the value, fall back to queuedAt/updatedAt.
  //   prCreatedAt : pull_request.created_at — when the PR was opened
  //   closedAt    : pull_request.merged_at (merged) or closed_at (closed)
  prCreatedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  // PR lifecycle once GitHub closes it: merged, or closed-without-merging
  prState: v.optional(v.union(v.literal("merged"), v.literal("closed"))),
  // A fix agent's acknowledgement that it has picked up THIS review pass and is
  // working on the findings (stamped by `reviews.ack` / the `prr-ack` CLI). It's
  // the difference the console can't otherwise know: a `reviewed` row with no ack
  // is "Awaiting agent" (nobody's on it), one with an ack is "In progress". Set
  // only on a `reviewed` row; cleared by `clearStaleAcks` when an ack goes stale
  // (the agent never pushed a fix), so the board never shows a false "In progress".
  //   ackedAt : when the agent acked (ms)
  //   ackedBy : who acked — agent/host label, free-form (e.g. "claude@macbook")
  ackedAt: v.optional(v.number()),
  ackedBy: v.optional(v.string()),
  // results, filled by `finish`
  reviewUrl: v.optional(v.string()),
  confidence: v.optional(v.number()),
  reviewEffort: v.optional(v.number()),
  p0: v.optional(v.number()),
  p1: v.optional(v.number()),
  p2: v.optional(v.number()),
  report: v.optional(v.string()),
  error: v.optional(v.string()),
  // the commits that landed in this push, captured by the worker from GitHub
  commits: v.optional(v.array(commitInfo)),
}

export default defineSchema({
  reviews: defineTable(reviewFields)
    // worker subscription + dashboard board, newest-first within a status
    .index("by_status", ["status", "queuedAt"])
    // dedup key: one review per (repo, PR, head SHA). A prefix lookup on
    // (repo, prNumber) finds every SHA of a PR (used by closePr).
    .index("by_pr_sha", ["repo", "prNumber", "headSha"]),

  // The cloud-review session's progress log, one row per appended line. Lives in
  // its own table (not an array on the review row) so it grows without rewriting
  // the review doc or hitting the 1MB document cap — see the schema guideline on
  // unbounded lists. `reviews.progress` still holds the *latest* line for
  // back-compat; this table is the complete, durable history. Ordered by the
  // by_review index, which returns a review's lines in insertion (_creationTime)
  // order.
  reviewLogLines: defineTable({
    reviewId: v.id("reviews"),
    // ms timestamp the append mutation stamped (Convex server time) — drives the
    // ticker's clock column. Within ~the throttle interval of the worker's emit.
    ts: v.number(),
    text: v.string(),
    kind: v.optional(logKind),
  }).index("by_review", ["reviewId"]),

  // Append-only debug log of every webhook GitHub delivered, so wiring problems
  // ("did the event even arrive?") are visible without reading Convex logs.
  webhookDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    action: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    outcome: v.string(), // enqueued | duplicate | unwatched | ignored | closed | bad-signature
    receivedAt: v.number(),
  }).index("by_received", ["receivedAt"]),

  // Repos this console reviews — the single source of truth for the watch list.
  // Owned by the dashboard (convex/repos.ts add/remove); the worker subscribes to
  // it (repos.list) and reconciles/reviews whatever is here. No worker config file.
  watchedRepos: defineTable({
    repo: v.string(),
    updatedAt: v.number(),
  }),

  // Follow-up issue proposals from pr-feature agents — see suggestedIssueFields.
  suggestedIssues: defineTable(suggestedIssueFields)
    // inbox (newest-first within a status) + the worker's claimable-style reads
    .index("by_status", ["status", "createdAt"])
    // dedup + lineage: every suggestion for a source PR (prefix on repo)
    .index("by_source_pr", ["repo", "sourcePrNumber"])
    // idempotency: the `suggest` mutation collapses a re-proposal onto its row
    .index("by_dedup", ["dedupKey"]),
})
