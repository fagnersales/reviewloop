import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import {
  suggestedIssueFields,
  suggestionCategory,
  suggestionSource,
  triageLabel,
} from "./schema"
import { MAX_WATCHED_REPOS } from "./repos"

// Stop the worker re-attempting a GitHub side-effect (issue create / label edit)
// forever when it keeps failing. After this many tries the row drops out of the
// worker's claimable queries with its `error` recorded, instead of spinning.
const MAX_WORKER_ATTEMPTS = 5

// Bounded reads for the inbox: suggestions are config-scale (a handful per PR, a
// handful of PRs), and these caps keep every read safe even as `opened`/`dismissed`
// history accumulates. Mirrors the per-status `.take` bounds in reviews.board.
const INBOX_TAKE = { suggested: 200, approved: 100, opened: 200, dismissed: 100 }

// Full row shape (system fields + columns) for query return validators.
const suggestionDoc = v.object({
  _id: v.id("suggestedIssues"),
  _creationTime: v.number(),
  ...suggestedIssueFields,
})

// ── helpers ──────────────────────────────────────────────────────────────────

// A url-safe, length-clamped slug of a title — the stable part of the dedup key.
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

// Stable idempotency key for a proposal: an agent re-run, or a second pr-feature
// session on the same PR, derives the same key and collapses onto the same row.
// Repo slugs are case-insensitive, matched the same way as convex/repos.ts.
function dedupKeyFor(repo: string, prNumber: number, title: string): string {
  return `${repo.toLowerCase()}#${prNumber}:${slug(title)}`
}

// The watch list gates *what gets suggested*, exactly as doEnqueue gates reviews:
// a repo the dashboard isn't watching can't have proposals filed against it.
async function isWatched(ctx: MutationCtx, repo: string): Promise<boolean> {
  const target = repo.toLowerCase()
  const watched = await ctx.db.query("watchedRepos").take(MAX_WATCHED_REPOS)
  return watched.some((r) => r.repo.toLowerCase() === target)
}

// ── producer: the prr-suggest CLI ─────────────────────────────────────────────

// One proposed follow-up, as the pr-feature agent emits it (files optional).
const suggestItem = v.object({
  category: suggestionCategory,
  source: suggestionSource,
  title: v.string(),
  body: v.string(),
  files: v.optional(v.array(v.string())),
})

// Called by `prr-suggest` (worker/suggest.mjs) at the unattended wrap-up of a PR.
// Idempotent on dedupKey and gated on watchedRepos like reviews.doEnqueue: a
// re-run collapses onto existing rows (counted as duplicates), and an unwatched
// repo files nothing. A pre-existing row in ANY status (including dismissed) is a
// duplicate — once a human has decided on a proposal, a re-run must not resurrect
// it.
export const suggest = mutation({
  args: {
    repo: v.string(),
    sourcePrNumber: v.number(),
    sourceHeadSha: v.string(),
    sourcePrTitle: v.string(),
    sourcePrUrl: v.string(),
    proposedBy: v.string(),
    items: v.array(suggestItem),
  },
  returns: v.union(
    v.object({ outcome: v.literal("unwatched") }),
    v.object({
      outcome: v.literal("ok"),
      enqueued: v.number(),
      duplicate: v.number(),
      total: v.number(),
    }),
  ),
  handler: async (ctx, a) => {
    if (!(await isWatched(ctx, a.repo))) return { outcome: "unwatched" as const }
    let enqueued = 0
    let duplicate = 0
    for (const item of a.items) {
      const dedupKey = dedupKeyFor(a.repo, a.sourcePrNumber, item.title)
      const existing = await ctx.db
        .query("suggestedIssues")
        .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
        .first()
      if (existing) {
        duplicate++
        continue
      }
      await ctx.db.insert("suggestedIssues", {
        repo: a.repo,
        sourcePrNumber: a.sourcePrNumber,
        sourceHeadSha: a.sourceHeadSha,
        sourcePrTitle: a.sourcePrTitle,
        sourcePrUrl: a.sourcePrUrl,
        title: item.title,
        body: item.body,
        category: item.category,
        source: item.source,
        files: item.files ?? [],
        dedupKey,
        status: "suggested",
        proposedBy: a.proposedBy,
        createdAt: Date.now(),
      })
      enqueued++
    }
    return { outcome: "ok" as const, enqueued, duplicate, total: a.items.length }
  },
})

// ── dashboard: the inbox ──────────────────────────────────────────────────────

// The Follow-ups view subscribes to this: every suggestion across all PRs, newest
// activity first. Each row already carries its source-PR context (no join needed).
export const inbox = query({
  args: {},
  returns: v.array(suggestionDoc),
  handler: async (ctx) => {
    const byStatus = async (status: "suggested" | "approved" | "opened" | "dismissed", take: number) =>
      ctx.db
        .query("suggestedIssues")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(take)
    const [suggested, approved, opened, dismissed] = await Promise.all([
      byStatus("suggested", INBOX_TAKE.suggested),
      byStatus("approved", INBOX_TAKE.approved),
      byStatus("opened", INBOX_TAKE.opened),
      byStatus("dismissed", INBOX_TAKE.dismissed),
    ])
    return [...suggested, ...approved, ...opened, ...dismissed].sort(
      (a, b) => b.createdAt - a.createdAt,
    )
  },
})

// The rail/bottom-nav badge subscribes to this: how many proposals await a human
// decision. Cheap to compute on the Reviews view without loading the whole inbox.
export const pendingCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("suggestedIssues")
      .withIndex("by_status", (q) => q.eq("status", "suggested"))
      .take(INBOX_TAKE.suggested + INBOX_TAKE.approved)
    return rows.length
  },
})

// ── gate 1: approve / dismiss (intent only — the worker does the GitHub side) ──

const intentResult = v.object({ ok: v.boolean(), reason: v.optional(v.string()) })

// Human approves a proposal: the worker will then `gh issue create` it. Resets
// the worker error/attempt counters so a fresh approval gets a fresh retry budget.
export const approve = mutation({
  args: { id: v.id("suggestedIssues"), by: v.string() },
  returns: intentResult,
  handler: async (ctx, { id, by }) => {
    const row = await ctx.db.get(id)
    if (!row) return { ok: false, reason: "not found" }
    if (row.status !== "suggested") return { ok: false, reason: `already ${row.status}` }
    await ctx.db.patch(id, {
      status: "approved",
      decidedAt: Date.now(),
      decidedBy: by,
      attempts: 0,
      error: undefined,
    })
    return { ok: true }
  },
})

// Human dismisses a proposal (or cancels one still pending open). An already-opened
// issue can't be dismissed — it's filed on GitHub; close it there.
export const dismiss = mutation({
  args: { id: v.id("suggestedIssues"), by: v.string() },
  returns: intentResult,
  handler: async (ctx, { id, by }) => {
    const row = await ctx.db.get(id)
    if (!row) return { ok: false, reason: "not found" }
    if (row.status === "opened") return { ok: false, reason: "already opened on GitHub" }
    if (row.status === "dismissed") return { ok: true }
    await ctx.db.patch(id, { status: "dismissed", decidedAt: Date.now(), decidedBy: by })
    return { ok: true }
  },
})

// Undo a dismissal, or cancel a still-pending approval, back to "suggested". Safe
// against a race with the worker: once the row is "opened" the GitHub issue exists
// and there's nothing to undo, so it refuses.
export const undo = mutation({
  args: { id: v.id("suggestedIssues") },
  returns: intentResult,
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (!row) return { ok: false, reason: "not found" }
    if (row.status === "opened") return { ok: false, reason: "already opened on GitHub" }
    if (row.status === "suggested") return { ok: true }
    await ctx.db.patch(id, {
      status: "suggested",
      decidedAt: undefined,
      decidedBy: undefined,
      attempts: 0,
      error: undefined,
    })
    return { ok: true }
  },
})

// ── gate 2: set the triage label (intent only) ────────────────────────────────

// Human picks the triage label on an opened issue. Sets the *desired* label; the
// worker propagates it to the real GitHub issue (where the solver reads it). Only
// meaningful once opened — there's no GitHub issue to label before that.
export const setLabel = mutation({
  args: { id: v.id("suggestedIssues"), label: triageLabel },
  returns: intentResult,
  handler: async (ctx, { id, label }) => {
    const row = await ctx.db.get(id)
    if (!row) return { ok: false, reason: "not found" }
    if (row.status !== "opened") return { ok: false, reason: "not opened yet" }
    if (row.label === label) return { ok: true }
    // Re-arm the retry budget so a fresh label change gets fresh attempts even if
    // a prior sync had exhausted them.
    await ctx.db.patch(id, { label, attempts: 0, error: undefined })
    return { ok: true }
  },
})

// ── worker-facing: claimable queries + writeback mutations ─────────────────────

// The worker subscribes to this: approved proposals it still needs to file on
// GitHub. Excludes rows already opened and rows that have exhausted their retries.
export const approvedToOpen = query({
  args: {},
  returns: v.array(suggestionDoc),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("suggestedIssues")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .order("asc")
      .take(50)
    return rows.filter((r) => r.issueNumber == null && (r.attempts ?? 0) < MAX_WORKER_ATTEMPTS)
  },
})

// The worker subscribes to this: opened issues whose desired label hasn't been
// applied on GitHub yet (label !== appliedLabel). This is what makes gate 2 real.
export const labelToSync = query({
  args: {},
  returns: v.array(suggestionDoc),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("suggestedIssues")
      .withIndex("by_status", (q) => q.eq("status", "opened"))
      .order("asc")
      .take(INBOX_TAKE.opened)
    return rows.filter(
      (r) =>
        r.issueNumber != null &&
        r.label != null &&
        r.label !== r.appliedLabel &&
        (r.attempts ?? 0) < MAX_WORKER_ATTEMPTS,
    )
  },
})

// Worker reports it filed the GitHub issue (gate 1 done). The issue is created
// with the needs-triage label, so that's both the desired and applied label until
// the human promotes it. Resets attempts so label sync gets a fresh budget.
export const markOpened = mutation({
  args: { id: v.id("suggestedIssues"), issueNumber: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, issueNumber }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, {
      status: "opened",
      issueNumber,
      label: row.label ?? "needs-triage",
      appliedLabel: "needs-triage",
      attempts: 0,
      error: undefined,
    })
    return null
  },
})

// Worker reports it applied a label on GitHub (gate 2 done for this value). It
// stamps the label the worker *actually* applied; if the human changed it again
// in the meantime, label !== appliedLabel still holds and labelToSync re-fires.
export const markLabelApplied = mutation({
  args: { id: v.id("suggestedIssues"), label: triageLabel },
  returns: v.null(),
  handler: async (ctx, { id, label }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, { appliedLabel: label, attempts: 0, error: undefined })
    return null
  },
})

// Worker records a failed GitHub side-effect. Bumps attempts so the row eventually
// drops out of the claimable queries (see MAX_WORKER_ATTEMPTS) with its reason kept.
export const recordWorkerError = mutation({
  args: { id: v.id("suggestedIssues"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, error }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, { error, attempts: (row.attempts ?? 0) + 1 })
    return null
  },
})
