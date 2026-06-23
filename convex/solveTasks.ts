import { v } from "convex/values"
import { mutation, query, internalMutation } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import { solveTaskFields } from "./schema"
import { MAX_WATCHED_REPOS } from "./repos"

// A "solving" row older than this with no finish = a crashed solver. A solve is a
// whole build → open-PR → internal review/auto-fix loop, so it runs *much* longer
// than a review (tens of minutes to hours). This backstop must comfortably exceed
// the worker's `solveTimeoutMin` (default 180) so the requeue cron never preempts a
// genuinely-running solve and double-spawns it — keep them in sync if you raise the
// worker's timeout past this.
const STALE_MS = 6 * 60 * 60 * 1000 // 6h

// Stop retrying a solve that keeps failing. After this many requeue→fail cycles the
// row stays `failed` (dropping out of the claimable query) with its `error` kept,
// instead of being re-spawned forever (mirrors suggestedIssues' attempts cap).
const MAX_ATTEMPTS = 3

// Full row shape (system fields + columns) for query return validators.
const solveDoc = v.object({
  _id: v.id("solveTasks"),
  _creationTime: v.number(),
  ...solveTaskFields,
})

// Args the webhook / reconcile supply to create a solve task.
const enqueueArgs = {
  repo: v.string(),
  issueNumber: v.number(),
  issueTitle: v.string(),
  issueUrl: v.string(),
}

// Queue a solve for this issue. Idempotent and gated on `watchedRepos`, like
// reviews.doEnqueue: both entry points (the `issues` webhook and the worker's
// reconcile) funnel here, so a repo removed from the dashboard stops getting
// solves, and a `ready-for-agent` label on a never-watched repo can't trigger an
// unsandboxed autonomous build. Repo slugs are matched case-insensitively, the
// same way as convex/repos.ts.
//
// Unlike reviews (one row per head SHA), a solve is keyed by (repo, issueNumber)
// and there is exactly **one** row per issue — so a retry *reuses* the existing
// failed row (flip back to queued, reset the retry budget) instead of inserting a
// new one, which would otherwise accumulate without bound for a permanently
// unsolvable issue. The `ready-for-agent` label is the retry switch: while it's on
// the issue, the reconcile keeps re-queuing a failed solve at its interval; remove
// the label to stop. A queued/solving/pr-opened/done row means the issue is already
// in flight or finished, so it collapses to a duplicate.
async function doEnqueue(
  ctx: MutationCtx,
  a: { repo: string; issueNumber: number; issueTitle: string; issueUrl: string },
): Promise<"enqueued" | "duplicate" | "unwatched"> {
  const target = a.repo.toLowerCase()
  const watched = await ctx.db.query("watchedRepos").take(MAX_WATCHED_REPOS)
  if (!watched.some((r) => r.repo.toLowerCase() === target)) return "unwatched"

  const existing = await ctx.db
    .query("solveTasks")
    .withIndex("by_repo_issue", (q) =>
      q.eq("repo", a.repo).eq("issueNumber", a.issueNumber),
    )
    .collect()
  if (existing.some((r) => r.status !== "failed")) return "duplicate"

  // Reuse a prior failed row if there is one (newest), else insert fresh. Either
  // way the issue ends up with a single queued row, retry budget reset.
  const prior = existing.sort((x, y) => y.queuedAt - x.queuedAt)[0]
  if (prior) {
    await ctx.db.patch(prior._id, {
      issueTitle: a.issueTitle,
      issueUrl: a.issueUrl,
      status: "queued",
      queuedAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      worker: undefined,
      progress: undefined,
      error: undefined,
      attempts: 0,
    })
    return "enqueued"
  }
  await ctx.db.insert("solveTasks", {
    repo: a.repo,
    issueNumber: a.issueNumber,
    issueTitle: a.issueTitle,
    issueUrl: a.issueUrl,
    status: "queued",
    queuedAt: Date.now(),
  })
  return "enqueued"
}

// Called by the `issues` webhook (server-side only).
export const enqueue = internalMutation({
  args: enqueueArgs,
  returns: v.union(
    v.literal("enqueued"),
    v.literal("duplicate"),
    v.literal("unwatched"),
  ),
  handler: (ctx, args) => doEnqueue(ctx, args),
})

// Called by the worker's "re-scan ready-for-agent issues" reconcile (needs a
// public surface).
export const enqueueMissing = mutation({
  args: enqueueArgs,
  returns: v.union(
    v.literal("enqueued"),
    v.literal("duplicate"),
    v.literal("unwatched"),
  ),
  handler: (ctx, args) => doEnqueue(ctx, args),
})

// The `ready-for-agent` label was removed, or the issue was closed, before the
// solver picked it up — cancel any still-queued solve for it. Deliberately only
// touches `queued` rows: an in-flight `solving` run (or a finished pr-opened/done)
// is left alone, so pulling the label mid-build doesn't orphan a worktree or a PR.
export const cancelQueued = internalMutation({
  args: { repo: v.string(), issueNumber: v.number() },
  returns: v.number(),
  handler: async (ctx, { repo, issueNumber }) => {
    const rows = await ctx.db
      .query("solveTasks")
      .withIndex("by_repo_issue", (q) =>
        q.eq("repo", repo).eq("issueNumber", issueNumber),
      )
      .collect()
    let cancelled = 0
    for (const r of rows) {
      if (r.status === "queued") {
        await ctx.db.delete(r._id)
        cancelled++
      }
    }
    return cancelled
  },
})

// Worker claims a queued solve. Convex serializes mutations, so two solvers can't
// both win: the loser sees status !== "queued" and gets false.
export const claim = mutation({
  args: { id: v.id("solveTasks"), worker: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, worker }) => {
    const row = await ctx.db.get(id)
    if (!row || row.status !== "queued") return false
    await ctx.db.patch(id, {
      status: "solving",
      startedAt: Date.now(),
      worker,
    })
    return true
  },
})

// Worker streams a one-line "what the agent is doing right now". Ignored once the
// row leaves "solving" so a late update can't resurrect stale text.
export const setProgress = mutation({
  args: { id: v.id("solveTasks"), line: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, line }) => {
    const row = await ctx.db.get(id)
    if (!row || row.status !== "solving") return null
    await ctx.db.patch(id, { progress: line })
    return null
  },
})

// Worker reports a finished run. Outcome is explicit because the success state
// carries the opened PR:
//   "pr-opened" — the run located the PR it opened (prNumber/prUrl/branch set)
//   "failed"    — errored, timed out, opened no PR, or no checkout was registered
// A failed finish bumps `attempts` so a persistently failing issue eventually stops
// being requeued (see MAX_ATTEMPTS); a pr-opened finish resets it.
export const finish = mutation({
  args: {
    id: v.id("solveTasks"),
    outcome: v.union(v.literal("pr-opened"), v.literal("failed")),
    prNumber: v.optional(v.number()),
    prUrl: v.optional(v.string()),
    branch: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, outcome, prNumber, prUrl, branch, error }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, {
      status: outcome,
      finishedAt: Date.now(),
      progress: undefined, // clear the live activity line
      branch: branch ?? row.branch,
      prNumber: prNumber ?? row.prNumber,
      prUrl: prUrl ?? row.prUrl,
      error,
      attempts: outcome === "failed" ? (row.attempts ?? 0) + 1 : 0,
    })
    return null
  },
})

// The pull_request webhook calls this when a PR merges: flip the solve that opened
// that PR (matched by the by_pr index) to `done`, closing the issue → solve → PR
// lineage. Only an in-flight/opened solve transitions — a row already done/failed,
// or one for an unrelated PR, is left untouched. Returns how many it marked.
export const markMerged = internalMutation({
  args: { repo: v.string(), prNumber: v.number() },
  returns: v.number(),
  handler: async (ctx, { repo, prNumber }) => {
    const rows = await ctx.db
      .query("solveTasks")
      .withIndex("by_pr", (q) => q.eq("repo", repo).eq("prNumber", prNumber))
      .collect()
    let marked = 0
    for (const r of rows) {
      if (r.status === "pr-opened" || r.status === "solving") {
        await ctx.db.patch(r._id, { status: "done", finishedAt: Date.now() })
        marked++
      }
    }
    return marked
  },
})

// Cron-driven crash recovery: a "solving" row whose worker died gets requeued, up
// to MAX_ATTEMPTS, after which it's left `failed` so a doomed solve doesn't spin.
export const requeueStale = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now()
    const solving = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "solving"))
      .collect()
    let requeued = 0
    for (const r of solving) {
      if (now - (r.startedAt ?? r.queuedAt) <= STALE_MS) continue
      const attempts = (r.attempts ?? 0) + 1
      if (attempts > MAX_ATTEMPTS) {
        await ctx.db.patch(r._id, {
          status: "failed",
          finishedAt: now,
          progress: undefined,
          attempts,
          error: "gave up: solver did not finish after repeated attempts",
        })
        continue
      }
      await ctx.db.patch(r._id, {
        status: "queued",
        startedAt: undefined,
        worker: undefined,
        progress: undefined,
        attempts,
        error: "requeued: previous solve did not finish in time",
      })
      requeued++
    }
    return requeued
  },
})

// The worker subscribes to this: every queued solve, oldest first. Excludes rows
// that have exhausted their retry budget (left `failed`, never requeued past it).
export const claimable = query({
  args: {},
  returns: v.array(solveDoc),
  handler: async (ctx) => {
    return await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(50)
  },
})

// One live solve for one (repo, issueNumber) — the most relevant row when an issue
// has both a prior `failed` attempt and a fresh `queued` retry: prefer a terminal
// pr-opened/done, else the newest by queuedAt. Null until first queued. Parallels
// reviews.getByPrSha; backs inspection / a future blocking CLI.
export const getByRepoIssue = query({
  args: { repo: v.string(), issueNumber: v.number() },
  returns: v.union(v.null(), solveDoc),
  handler: async (ctx, { repo, issueNumber }) => {
    const rows = await ctx.db
      .query("solveTasks")
      .withIndex("by_repo_issue", (q) =>
        q.eq("repo", repo).eq("issueNumber", issueNumber),
      )
      .collect()
    if (rows.length === 0) return null
    const terminal = rows.filter(
      (r) => r.status === "pr-opened" || r.status === "done",
    )
    const pool = terminal.length ? terminal : rows
    return pool.reduce((a, b) => (b.queuedAt > a.queuedAt ? b : a))
  },
})

// The Solves nav badge subscribes to this: how many solves are in flight (queued
// or building) right now. Cheap — a bounded read per active status, mirroring
// suggestedIssues.pendingCount, so the other views show it without loading the board.
export const activeCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const solving = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "solving"))
      .take(50)
    const queued = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(50)
    return solving.length + queued.length
  },
})

// The dashboard "Solves" view subscribes to this: live board buckets, mirroring
// reviews.board. The view flattens these into one activity-ordered list.
export const board = query({
  args: {},
  returns: v.object({
    solving: v.array(solveDoc),
    queued: v.array(solveDoc),
    recent: v.array(solveDoc),
  }),
  handler: async (ctx) => {
    const solving = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "solving"))
      .order("asc")
      .take(25)
    const queued = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(50)
    const prOpened = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "pr-opened"))
      .order("desc")
      .take(30)
    const done = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "done"))
      .order("desc")
      .take(30)
    const failed = await ctx.db
      .query("solveTasks")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(30)
    const recent = [...prOpened, ...done, ...failed]
      .sort((a, b) => (b.finishedAt ?? b.queuedAt) - (a.finishedAt ?? a.queuedAt))
      .slice(0, 30)
    return { solving, queued, recent }
  },
})
