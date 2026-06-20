import { v } from "convex/values"
import { mutation, query, internalMutation } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { commitInfo, logKind, reviewFields, reviewStatus } from "./schema"

const STALE_MS = 25 * 60 * 1000 // a "reviewing" row older than this = crashed worker

// Full row shape (system fields + columns) for query return validators.
const reviewDoc = v.object({
  _id: v.id("reviews"),
  _creationTime: v.number(),
  ...reviewFields,
})

// Args the webhook / rescan supply to create a review.
const enqueueArgs = {
  repo: v.string(),
  prNumber: v.number(),
  headSha: v.string(),
  title: v.string(),
  author: v.string(),
  prUrl: v.string(),
  // GitHub's pull_request.created_at (ms). Optional: the worker reconcile passes
  // it when available, but old callers / missing data just leave it unset.
  prCreatedAt: v.optional(v.number()),
}

// Insert a queued review unless this exact head SHA already has a live row.
// Idempotent: GitHub re-deliveries and rescans collapse onto the same row, so a
// PR is reviewed once per head commit (the invariant watch.sh enforced by hand).
async function doEnqueue(
  ctx: MutationCtx,
  a: {
    repo: string
    prNumber: number
    headSha: string
    title: string
    author: string
    prUrl: string
    prCreatedAt?: number
  },
): Promise<"enqueued" | "duplicate" | "unwatched"> {
  // The watch list is authoritative for *what gets reviewed*, not just for the
  // reconcile rescan. Both entry points — the webhook (`enqueue`) and the worker's
  // reconcile (`enqueueMissing`) — funnel through here, so gating on `watchedRepos`
  // means a repo removed from the dashboard stops getting new reviews, and a repo
  // never added can't trigger an (unsandboxed) auto-clone-and-review at all. Repo
  // slugs are case-insensitive, matched the same way as convex/repos.ts. The set is
  // config-scale, so a single `.collect()` is bounded and acceptable.
  const target = a.repo.toLowerCase()
  const watched = await ctx.db.query("watchedRepos").collect()
  if (!watched.some((r) => r.repo.toLowerCase() === target)) return "unwatched"

  const existing = await ctx.db
    .query("reviews")
    .withIndex("by_pr_sha", (q) =>
      q.eq("repo", a.repo).eq("prNumber", a.prNumber).eq("headSha", a.headSha),
    )
    .collect()
  // a prior failed run may be retried; anything else for this SHA means "done"
  if (existing.some((r) => r.status !== "failed")) return "duplicate"
  await ctx.db.insert("reviews", {
    ...a,
    status: "queued",
    queuedAt: Date.now(),
  })
  return "enqueued"
}

// Called by the webhook (server-side only).
export const enqueue = internalMutation({
  args: enqueueArgs,
  returns: v.union(
    v.literal("enqueued"),
    v.literal("duplicate"),
    v.literal("unwatched"),
  ),
  handler: (ctx, args) => doEnqueue(ctx, args),
})

// Called by the worker's "re-scan open PRs" reconcile (needs a public surface).
export const enqueueMissing = mutation({
  args: enqueueArgs,
  returns: v.union(
    v.literal("enqueued"),
    v.literal("duplicate"),
    v.literal("unwatched"),
  ),
  handler: (ctx, args) => doEnqueue(ctx, args),
})

// PR lifecycle from GitHub. "merged"/"closed" stamp every review row for the PR
// (and drop any still-queued one — no point reviewing a closed PR); "open"
// (reopened) clears the stamp.
export const setPrState = internalMutation({
  args: {
    repo: v.string(),
    prNumber: v.number(),
    state: v.union(v.literal("merged"), v.literal("closed"), v.literal("open")),
    // GitHub's merged_at/closed_at (ms) — the merge/close moment. Omitted on
    // "open" (reopen), where we instead clear any stored closedAt.
    at: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { repo, prNumber, state, at }) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_pr_sha", (q) => q.eq("repo", repo).eq("prNumber", prNumber))
      .collect()
    for (const r of rows) {
      if (state !== "open" && r.status === "queued") {
        await ctx.db.delete(r._id)
        continue
      }
      await ctx.db.patch(r._id, {
        prState: state === "open" ? undefined : state,
        // stamp the close moment; a reopen wipes it so "open for…" resumes
        closedAt: state === "open" ? undefined : at,
      })
    }
    return null
  },
})

// Worker claims a queued review. Convex serializes mutations, so two workers
// can't both win: the loser sees status !== "queued" and gets false.
export const claim = mutation({
  args: { id: v.id("reviews"), worker: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, worker }) => {
    const row = await ctx.db.get(id)
    if (!row || row.status !== "queued") return false
    await ctx.db.patch(id, {
      status: "reviewing",
      startedAt: Date.now(),
      worker,
    })
    return true
  },
})

// Worker streams a one-line "what the agent is doing right now". Ignored once
// the row leaves "reviewing" so a late update can't resurrect stale text.
//
// Besides updating the single live `progress` line (kept for back-compat — the
// board/header still read it), each call *appends* the line to `reviewLogLines`,
// the durable, complete history the cloud-log console renders. Persisting
// server-side means the full log survives a remount/reload and a viewer that
// joins mid-review still sees every line, not just the tail observed since mount.
export const updateProgress = mutation({
  args: { id: v.id("reviews"), line: v.string(), kind: v.optional(logKind) },
  returns: v.null(),
  handler: async (ctx, { id, line, kind }) => {
    const row = await ctx.db.get(id)
    if (!row || row.status !== "reviewing") return null
    // Append to the durable log, but skip a plain line identical to the latest
    // one (the worker throttle already dedups consecutive lines; a requeue/retry
    // can re-emit the last line). A kinded line — e.g. the terminal "done" —
    // always appends so severity markers are never swallowed.
    if (kind !== undefined || line !== row.progress) {
      await ctx.db.insert("reviewLogLines", { reviewId: id, ts: Date.now(), text: line, kind })
    }
    await ctx.db.patch(id, { progress: line })
    return null
  },
})

// Worker reports a finished run.
export const finish = mutation({
  args: {
    id: v.id("reviews"),
    ok: v.boolean(),
    reviewUrl: v.optional(v.string()),
    confidence: v.optional(v.number()),
    reviewEffort: v.optional(v.number()),
    p0: v.optional(v.number()),
    p1: v.optional(v.number()),
    p2: v.optional(v.number()),
    report: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, ok, ...rest }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, {
      status: ok ? "reviewed" : "failed",
      finishedAt: Date.now(),
      progress: undefined, // clear the live activity line
      ...rest,
    })
    return null
  },
})

// Worker stores the commits that landed in this push (captured from GitHub) so
// the dashboard can show what changed this turn without its own GitHub auth.
export const setCommits = mutation({
  args: { id: v.id("reviews"), commits: v.array(commitInfo) },
  returns: v.null(),
  handler: async (ctx, { id, commits }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, { commits })
    return null
  },
})

// The head SHA of the PR's most recent *earlier* pass — a different commit queued
// before this one. The worker uses it as the lower bound when slicing "this
// push's" commits out of the PR's full commit list. Null when this is the PR's
// first pass (so the whole list is this turn's).
export const priorHead = query({
  args: {
    repo: v.string(),
    prNumber: v.number(),
    headSha: v.string(),
    queuedAt: v.number(),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { repo, prNumber, headSha, queuedAt }) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_pr_sha", (q) => q.eq("repo", repo).eq("prNumber", prNumber))
      .collect()
    const prior = rows
      .filter((r) => r.headSha !== headSha && r.queuedAt <= queuedAt)
      .sort((a, b) => b.queuedAt - a.queuedAt)[0]
    return prior?.headSha ?? null
  },
})

// Cron-driven crash recovery: a "reviewing" row whose worker died gets requeued.
export const requeueStale = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now()
    const reviewing = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "reviewing"))
      .collect()
    let requeued = 0
    for (const r of reviewing) {
      if (now - (r.startedAt ?? r.queuedAt) > STALE_MS) {
        await ctx.db.patch(r._id, {
          status: "queued",
          startedAt: undefined,
          worker: undefined,
          progress: undefined,
          error: "requeued: previous run did not finish in time",
        })
        requeued++
      }
    }
    return requeued
  },
})

// Debug log of an inbound webhook delivery.
export const recordDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    event: v.string(),
    action: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    outcome: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("webhookDeliveries", { ...args, receivedAt: Date.now() })
    return null
  },
})

// The worker subscribes to this: every queued review, oldest first.
export const claimable = query({
  args: {},
  returns: v.array(reviewDoc),
  handler: async (ctx) => {
    return await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(50)
  },
})

// A blocking caller (`prr await`) subscribes to this: the single live review row
// for one (repo, PR, head SHA). Multiple rows can share that key — a failed
// attempt followed by a re-enqueue — so we return the most relevant one: a
// terminal `reviewed` row if any exists, else the newest by `queuedAt`. Null
// until a webhook/rescan first queues this head SHA.
export const getByPrSha = query({
  args: {
    repo: v.string(),
    prNumber: v.number(),
    headSha: v.string(),
  },
  returns: v.union(v.null(), reviewDoc),
  handler: async (ctx, { repo, prNumber, headSha }) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_pr_sha", (q) =>
        q.eq("repo", repo).eq("prNumber", prNumber).eq("headSha", headSha),
      )
      .collect()
    if (rows.length === 0) return null
    const reviewed = rows.filter((r) => r.status === "reviewed")
    const pool = reviewed.length ? reviewed : rows
    return pool.reduce((a, b) => (b.queuedAt > a.queuedAt ? b : a))
  },
})

// One persisted progress line, shaped to the client's CloudLogLine so the
// cloud-log console can render the query result directly (no remap).
const reviewLogLine = v.object({
  id: v.string(),
  text: v.string(),
  at: v.number(),
  kind: v.optional(logKind),
})

// The cloud-log console subscribes to this: the full, ordered progress log for
// one review pass (the `reviews` row id), oldest first. Replaces the old
// client-side `useProgressHistory` tail — every line the worker streamed is
// here, so a viewer that opens mid-review (or remounts on PR reselect) still
// sees the whole session. The by_review index returns a review's lines in
// insertion order; `.take` keeps the read bounded (a 25-min run at the worker's
// ~1/s throttle is well under this cap, so in practice nothing is dropped).
const REVIEW_LOG_MAX = 2000
export const reviewLog = query({
  args: { reviewId: v.id("reviews") },
  returns: v.array(reviewLogLine),
  handler: async (ctx, { reviewId }) => {
    const lines = await ctx.db
      .query("reviewLogLines")
      .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
      .order("asc")
      .take(REVIEW_LOG_MAX)
    return lines.map((l) => ({ id: l._id, text: l.text, at: l.ts, kind: l.kind }))
  },
})

// The dashboard subscribes to this: live board buckets.
export const board = query({
  args: {},
  returns: v.object({
    reviewing: v.array(reviewDoc),
    queued: v.array(reviewDoc),
    recent: v.array(reviewDoc),
  }),
  handler: async (ctx) => {
    const reviewing = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "reviewing"))
      .order("asc")
      .take(25)
    const queued = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(50)
    const reviewed = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "reviewed"))
      .order("desc")
      .take(30)
    const failed = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(30)
    const recent = [...reviewed, ...failed]
      .sort((a, b) => (b.finishedAt ?? b.queuedAt) - (a.finishedAt ?? a.queuedAt))
      .slice(0, 30)
    return { reviewing, queued, recent }
  },
})

// One review pass = one `reviews` row (one head SHA of a PR).
const prPass = v.object({
  _id: v.id("reviews"),
  headSha: v.string(),
  status: reviewStatus,
  queuedAt: v.number(),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  confidence: v.optional(v.number()),
  reviewEffort: v.optional(v.number()),
  p0: v.optional(v.number()),
  p1: v.optional(v.number()),
  p2: v.optional(v.number()),
  report: v.optional(v.string()),
  reviewUrl: v.optional(v.string()),
  progress: v.optional(v.string()),
  error: v.optional(v.string()),
  worker: v.optional(v.string()),
  commits: v.optional(v.array(commitInfo)),
})

// A PR = every review pass for one (repo, prNumber), with the latest pass's
// state surfaced for the list/header.
const prDoc = v.object({
  key: v.string(),
  repo: v.string(),
  prNumber: v.number(),
  title: v.string(),
  author: v.string(),
  prUrl: v.string(),
  headSha: v.string(),
  status: reviewStatus,
  prState: v.optional(v.union(v.literal("merged"), v.literal("closed"))),
  confidence: v.optional(v.number()),
  p0: v.optional(v.number()),
  p1: v.optional(v.number()),
  p2: v.optional(v.number()),
  progress: v.optional(v.string()),
  updatedAt: v.number(),
  // GitHub lifecycle anchors for the list/header timing. Optional: a PR whose
  // rows predate timestamp capture has neither, and the client falls back to
  // the first pass's queuedAt / updatedAt.
  prCreatedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  passes: v.array(prPass),
})

// The dashboard subscribes to this: every PR with active or recent review
// activity, grouped from its per-commit review rows, newest activity first.
export const prs = query({
  args: {},
  returns: v.array(prDoc),
  handler: async (ctx) => {
    const reviewing = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "reviewing"))
      .order("desc")
      .take(25)
    const queued = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("desc")
      .take(50)
    const reviewed = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "reviewed"))
      .order("desc")
      .take(100)
    const failed = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(50)

    const groups = new Map<string, Doc<"reviews">[]>()
    for (const row of [...reviewing, ...queued, ...reviewed, ...failed]) {
      const key = `${row.repo}#${row.prNumber}`
      const arr = groups.get(key)
      if (arr) arr.push(row)
      else groups.set(key, [row])
    }

    const result = []
    for (const [key, rows] of groups) {
      // passes oldest-first = the review loop in chronological order
      rows.sort((a, b) => a.queuedAt - b.queuedAt)
      const latest = rows[rows.length - 1]
      const prState = rows.find((r) => r.prState)?.prState
      // GitHub stamps every row of the PR identically, so the first non-null wins
      const prCreatedAt = rows.find((r) => r.prCreatedAt != null)?.prCreatedAt
      const closedAt = rows.find((r) => r.closedAt != null)?.closedAt
      result.push({
        key,
        repo: latest.repo,
        prNumber: latest.prNumber,
        title: latest.title,
        author: latest.author,
        prUrl: latest.prUrl,
        headSha: latest.headSha,
        status: latest.status,
        prState,
        confidence: latest.confidence,
        p0: latest.p0,
        p1: latest.p1,
        p2: latest.p2,
        progress: latest.progress,
        updatedAt: latest.finishedAt ?? latest.startedAt ?? latest.queuedAt,
        prCreatedAt,
        closedAt,
        passes: rows.map((r) => ({
          _id: r._id,
          headSha: r.headSha,
          status: r.status,
          queuedAt: r.queuedAt,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          confidence: r.confidence,
          reviewEffort: r.reviewEffort,
          p0: r.p0,
          p1: r.p1,
          p2: r.p2,
          report: r.report,
          reviewUrl: r.reviewUrl,
          progress: r.progress,
          error: r.error,
          worker: r.worker,
          commits: r.commits,
        })),
      })
    }
    // newest PR activity first
    result.sort((a, b) => b.updatedAt - a.updatedAt)
    return result
  },
})
