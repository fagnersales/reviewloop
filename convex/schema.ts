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
}

export default defineSchema({
  reviews: defineTable(reviewFields)
    // worker subscription + dashboard board, newest-first within a status
    .index("by_status", ["status", "queuedAt"])
    // dedup key: one review per (repo, PR, head SHA). A prefix lookup on
    // (repo, prNumber) finds every SHA of a PR (used by closePr).
    .index("by_pr_sha", ["repo", "prNumber", "headSha"]),

  // Append-only debug log of every webhook GitHub delivered, so wiring problems
  // ("did the event even arrive?") are visible without reading Convex logs.
  webhookDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    action: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    outcome: v.string(), // enqueued | duplicate | ignored | closed | bad-signature
    receivedAt: v.number(),
  }).index("by_received", ["receivedAt"]),

  // Repos this console is configured to review, published by the worker from
  // worker/config.json so the dashboard can list them before any PR is reviewed.
  watchedRepos: defineTable({
    repo: v.string(),
    updatedAt: v.number(),
  }),
})
