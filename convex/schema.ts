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
    // worker wall-clock when the line was emitted (ms) — drives the ticker clock
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
})
