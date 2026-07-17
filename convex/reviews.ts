import { v } from "convex/values"
import { mutation, query, internalMutation } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { commitInfo, logKind, reviewFields, reviewStatus } from "./schema"
import { MAX_WATCHED_REPOS } from "./repos"
import {
  groupByPr,
  latestPass,
  preferredPass,
  statusKey,
  statusKeyValidator,
} from "./prStatus"

const STALE_MS = 25 * 60 * 1000 // a "reviewing" row older than this = crashed worker

// A fix-agent ack older than this with no fix pushed since = the agent stalled or
// gave up. `clearStaleAcks` drops it so the PR flips back to "Awaiting agent" and
// gets picked up again, instead of showing a forever-stale "In progress". Kept
// generous: a false clear here causes duplicate pickup (worse than a slightly
// stale badge), and a real review fix can legitimately take a while.
const ACK_STALE_MS = 90 * 60 * 1000

// Stop the worker re-attempting `gh pr merge` forever when it keeps failing
// (conflicts, failing required checks, branch protection). After this many tries the
// pass drops out of pendingMerges with its `mergeError` kept for the console.
const MAX_MERGE_ATTEMPTS = 5

// Upper bound on how many log lines `reviewLog` returns, and how many a single
// `clearReviewLog` sweep deletes in one mutation. A 25-min run at the worker's
// ~1/s throttle stays well under this; the cap just keeps the read/write sizes
// safe if the timeout is raised or a run is unusually chatty.
const REVIEW_LOG_MAX = 2000

// Delete a review's persisted progress lines (bounded). Used when a stale
// "reviewing" row is requeued so the retry — which reuses the same `reviews`
// row, hence the same `reviewId` — starts with a fresh log instead of
// concatenating onto the crashed attempt's lines.
async function clearReviewLog(ctx: MutationCtx, reviewId: Id<"reviews">) {
  const prior = await ctx.db
    .query("reviewLogLines")
    .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
    .take(REVIEW_LOG_MAX)
  for (const l of prior) await ctx.db.delete(l._id)
}

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
  // slugs are case-insensitive, matched the same way as convex/repos.ts. The watch
  // list is capped at MAX_WATCHED_REPOS by `repos.add`, so `.take(...)` reads the
  // whole set while keeping this gate read-bounded now that `add` is public.
  const target = a.repo.toLowerCase()
  const watched = await ctx.db.query("watchedRepos").take(MAX_WATCHED_REPOS)
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

// A fix agent acks (or, with `clear`, releases) a review pass — the entrypoint
// behind the `reviewloop-ack` CLI. Acking stamps the `reviewed` row so the console shows
// "In progress" instead of "Awaiting agent"; it's the one fact the console can't
// observe on its own (an agent has started but hasn't pushed a commit yet).
//
// Target resolution: with `headSha`, the row for that exact commit; without it,
// the PR's *latest* pass — the one the board shows — so a concurrent re-push can't
// make the ack land on a superseded reviewed row and silently no-op. Only a
// `reviewed`, still-open pass is ackable — there's nothing to pick up on a
// queued/reviewing/failed row or a merged/closed PR.
export const ack = mutation({
  args: {
    repo: v.string(),
    prNumber: v.number(),
    headSha: v.optional(v.string()),
    by: v.string(),
    // release a prior ack (agent bailed) instead of recording one
    clear: v.optional(v.boolean()),
  },
  returns: v.object({
    ok: v.boolean(),
    // why it didn't take, for the CLI to surface (absent on success)
    reason: v.optional(v.string()),
    headSha: v.optional(v.string()),
    ackedAt: v.optional(v.number()),
    ackedBy: v.optional(v.string()),
  }),
  handler: async (ctx, { repo, prNumber, headSha, by, clear }) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_pr_sha", (q) => q.eq("repo", repo).eq("prNumber", prNumber))
      .collect()
    if (rows.length === 0) return { ok: false, reason: "no review row for this PR" }

    // Pick the pass to ack: the exact head SHA if given (preferredPass: its
    // reviewed row over a stale failed attempt), else the PR's *latest* pass.
    //
    // For the no-head case, latestPass (newest queuedAt across all statuses) is
    // deliberately what the board surfaces (prs() reads latest.ackedAt) — NOT the
    // newest *reviewed* pass. If a re-push raced in between await and ack, the
    // newest reviewed row is already superseded; acking it would silently no-op on
    // the board. Targeting the latest pass instead means the guard below reports
    // "pass is reviewing, not reviewed" (the agent can name an older --head to ack
    // a prior pass on purpose) rather than acking into the void.
    let target
    if (headSha) {
      const forSha = rows.filter((r) => r.headSha === headSha)
      if (forSha.length === 0)
        return { ok: false, reason: `no review row for ${headSha.slice(0, 7)}` }
      target = preferredPass(forSha)
    } else {
      target = latestPass(rows)
    }

    if (target.status !== "reviewed")
      return {
        ok: false,
        reason: `pass is ${target.status}, not reviewed`,
        headSha: target.headSha,
      }
    if (target.prState)
      return { ok: false, reason: `PR is ${target.prState}`, headSha: target.headSha }

    if (clear) {
      await ctx.db.patch(target._id, { ackedAt: undefined, ackedBy: undefined })
      return { ok: true, headSha: target.headSha }
    }
    const ackedAt = Date.now()
    await ctx.db.patch(target._id, { ackedAt, ackedBy: by })
    return { ok: true, headSha: target.headSha, ackedAt, ackedBy: by }
  },
})

// Human clicks "Merge" on a reviewed PR — the final gate, behind the console Merge
// button. Convex only records intent; the worker holds gh auth and runs the actual
// `gh pr merge` when it sees this via pendingMerges (exactly like ack and the
// suggestedIssues flow). Targets the PR's *latest* pass — the one the board
// surfaces — so a concurrent re-push can't make the request land on a superseded
// row. Only a still-open, `reviewed` pass is mergeable: there's nothing to merge on
// a queued/reviewing/failed pass or an already merged/closed PR. The human's
// judgment is the gate here — P2s (or even P1s) don't block the request; the merge
// itself still respects GitHub branch protection / required checks worker-side.
export const requestMerge = mutation({
  args: { repo: v.string(), prNumber: v.number(), by: v.string() },
  returns: v.object({
    ok: v.boolean(),
    reason: v.optional(v.string()),
    headSha: v.optional(v.string()),
  }),
  handler: async (ctx, { repo, prNumber, by }) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_pr_sha", (q) => q.eq("repo", repo).eq("prNumber", prNumber))
      .collect()
    if (rows.length === 0) return { ok: false, reason: "no review row for this PR" }
    const target = latestPass(rows)
    if (target.status !== "reviewed")
      return { ok: false, reason: `pass is ${target.status}, not reviewed`, headSha: target.headSha }
    if (target.prState)
      return { ok: false, reason: `PR is ${target.prState}`, headSha: target.headSha }
    await ctx.db.patch(target._id, {
      mergeRequestedAt: Date.now(),
      mergeRequestedBy: by,
      mergeError: undefined,
      mergeAttempts: 0,
    })
    return { ok: true, headSha: target.headSha }
  },
})

// The worker subscribes to this: reviewed passes a human asked to merge that aren't
// merged/closed yet and haven't exhausted their retry budget.
export const pendingMerges = query({
  args: {},
  returns: v.array(reviewDoc),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_status", (q) => q.eq("status", "reviewed"))
      .order("desc")
      .take(100)
    return rows.filter(
      (r) =>
        r.mergeRequestedAt != null &&
        r.prState == null &&
        (r.mergeAttempts ?? 0) < MAX_MERGE_ATTEMPTS,
    )
  },
})

// Worker reports the merge landed. Clears the intent so pendingMerges drops it at
// once — the closed/merged webhook then flips prState to "merged" (and the solve
// task to done). Clearing here, rather than waiting on the webhook, stops the worker
// re-merging an already-merged PR in the gap before the delivery arrives.
export const markMergeDone = mutation({
  args: { id: v.id("reviews") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, { mergeRequestedAt: undefined, mergeError: undefined })
    return null
  },
})

// Worker records a failed `gh pr merge` (conflicts, failing required checks, branch
// protection). Clears the merge intent — so the worker does NOT blindly auto-retry a
// merge that needs human attention — and keeps the reason for the console to surface
// with a "Retry merge" affordance. mergeAttempts is bumped as a guard so a pathological
// re-request loop still bottoms out at MAX_MERGE_ATTEMPTS.
export const recordMergeError = mutation({
  args: { id: v.id("reviews"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, error }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, {
      mergeError: error,
      mergeRequestedAt: undefined,
      mergeAttempts: (row.mergeAttempts ?? 0) + 1,
    })
    return null
  },
})

// Cron-driven honesty: a still-current reviewed pass whose ack has gone stale (the
// agent acked but never pushed a fix — see ACK_STALE_MS) gets its ack dropped, so
// the board reverts from "In progress" to "Awaiting agent" and the PR is picked up
// again. Only the PR's *latest* pass is considered — an ack on a superseded pass is
// a true historical record (the agent did push a fix), so it's left intact.
export const clearStaleAcks = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now()
    // Reconstruct each PR's latest pass from bounded recent scans, mirroring prs().
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
    let cleared = 0
    for (const rows of groupByPr([...reviewing, ...queued, ...reviewed, ...failed]).values()) {
      const r = latestPass(rows)
      // A merged/closed PR can't be picked up again, so clearing its ack buys no
      // honesty — it only erases the "Agent picked it up" history of real work.
      // Skip it (matches the "superseded acks are kept" rule); only live reviewed
      // passes can go stale.
      if (
        r.status === "reviewed" &&
        r.prState == null &&
        r.ackedAt != null &&
        now - r.ackedAt > ACK_STALE_MS
      ) {
        await ctx.db.patch(r._id, { ackedAt: undefined, ackedBy: undefined })
        cleared++
      }
    }
    return cleared
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
        // Drop the crashed attempt's log so the retry's lines don't concatenate
        // onto it under the shared reviewId.
        await clearReviewLog(ctx, r._id)
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

// A blocking caller (`reviewloop await`) subscribes to this: the single live review row
// for one (repo, PR, head SHA). Multiple rows can share that key — a failed
// attempt followed by a re-enqueue — so we return the most relevant one
// (preferredPass: a terminal `reviewed` row if any exists, else the newest by
// `queuedAt`). Null until a webhook/rescan first queues this head SHA.
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
    return preferredPass(rows)
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

// The cloud-log console subscribes to this: the ordered progress log for one
// review pass (the `reviews` row id), oldest first. Replaces the old client-side
// `useProgressHistory` tail — every line the worker streamed is here, so a
// viewer that opens mid-review (or remounts on PR reselect) sees the whole
// session. A 25-min run at the worker's ~1/s throttle stays under the cap, so in
// practice nothing is dropped; if a run *does* exceed it we keep the newest
// lines (the live tail) rather than freezing the ticker on the run's start —
// hence `order("desc")` then reverse back to chronological for display.
export const reviewLog = query({
  args: { reviewId: v.id("reviews") },
  returns: v.array(reviewLogLine),
  handler: async (ctx, { reviewId }) => {
    const newestFirst = await ctx.db
      .query("reviewLogLines")
      .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
      .order("desc")
      .take(REVIEW_LOG_MAX)
    return newestFirst
      .reverse()
      .map((l) => ({ id: l._id, text: l.text, at: l.ts, kind: l.kind }))
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

// A PR = every review pass for one (repo, prNumber), with the latest pass's
// state surfaced for the list/header. A pass is served as the full `reviews`
// row (reviewDoc) — no projection to hand-maintain; adding a column is a
// schema-only change.
const prDoc = v.object({
  key: v.string(),
  repo: v.string(),
  prNumber: v.number(),
  title: v.string(),
  author: v.string(),
  prUrl: v.string(),
  headSha: v.string(),
  status: reviewStatus,
  // The lifecycle state this PR resolves to — computed here (convex/prStatus.ts)
  // so every consumer reads the same answer instead of re-deriving it.
  statusKey: statusKeyValidator,
  prState: v.optional(v.union(v.literal("merged"), v.literal("closed"))),
  confidence: v.optional(v.number()),
  p0: v.optional(v.number()),
  p1: v.optional(v.number()),
  p2: v.optional(v.number()),
  progress: v.optional(v.string()),
  // The latest pass's ack (a fix agent picked up its review). Drives the
  // "Awaiting agent" vs "In progress" distinction on the list/header badge.
  ackedAt: v.optional(v.number()),
  ackedBy: v.optional(v.string()),
  // The latest pass's merge state (the console Merge button). mergeRequestedAt set =
  // "Merging…" (worker is running gh pr merge); mergeError = the last attempt's reason.
  mergeRequestedAt: v.optional(v.number()),
  mergeRequestedBy: v.optional(v.string()),
  mergeError: v.optional(v.string()),
  updatedAt: v.number(),
  // GitHub lifecycle anchors for the list/header timing. Optional: a PR whose
  // rows predate timestamp capture has neither, and the client falls back to
  // the first pass's queuedAt / updatedAt.
  prCreatedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  passes: v.array(reviewDoc),
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

    const result = []
    for (const [key, rows] of groupByPr([...reviewing, ...queued, ...reviewed, ...failed])) {
      // passes oldest-first = the review loop in chronological order
      rows.sort((a, b) => a.queuedAt - b.queuedAt)
      const latest = latestPass(rows)
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
        statusKey: statusKey({
          prState,
          status: latest.status,
          ackedAt: latest.ackedAt,
          p0: latest.p0,
          p1: latest.p1,
        }),
        prState,
        confidence: latest.confidence,
        p0: latest.p0,
        p1: latest.p1,
        p2: latest.p2,
        progress: latest.progress,
        ackedAt: latest.ackedAt,
        ackedBy: latest.ackedBy,
        mergeRequestedAt: latest.mergeRequestedAt,
        mergeRequestedBy: latest.mergeRequestedBy,
        mergeError: latest.mergeError,
        updatedAt: latest.finishedAt ?? latest.startedAt ?? latest.queuedAt,
        prCreatedAt,
        closedAt,
        passes: rows,
      })
    }
    // newest PR activity first
    result.sort((a, b) => b.updatedAt - a.updatedAt)
    return result
  },
})
