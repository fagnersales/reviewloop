import { v } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import {
  reviewerModel,
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

// A `triaging` claim older than this belongs to a crashed worker: the judgment
// run is a one-shot `claude -p` that finishes in well under a couple of minutes,
// so requeueStaleTriage (cron) can safely hand the row back out.
const TRIAGE_STALE_MS = 10 * 60 * 1000

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

// Stable idempotency key for a proposal: an agent re-run, or a second reviewloop-feature
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

// ── producer: the reviewloop-suggest CLI ─────────────────────────────────────────────

// One proposed follow-up, as the reviewloop-feature agent emits it (files optional).
const suggestItem = v.object({
  category: suggestionCategory,
  source: suggestionSource,
  title: v.string(),
  body: v.string(),
  files: v.optional(v.array(v.string())),
})

// Called by `reviewloop-suggest` (worker/suggest.mjs) at the unattended wrap-up of a PR.
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
// and there's nothing to undo, so it refuses. Restoring a row auto-triage had
// dropped stamps it `kept` (reason cleared — it was a drop rationale): a human
// override outranks the agent, which must never re-drop it.
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
      ...(row.triage === "dropped" ? { triage: "kept" as const, triageReason: undefined } : {}),
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

// ── auto-triage: the inbox's optional agent gatekeeper ────────────────────────
// Off by default. When the operator flips it on (the Follow-ups view toggle),
// the worker judges each untriaged `suggested` row with a one-shot `claude -p`
// and either drops it (dismissed, agent as decider) or keeps it for the human.
// Deliberately filter-only: a kept row still needs the normal human "Open it" —
// gate 1 and gate 2 stay human (see the lifecycle note in schema.ts). Turning
// the toggle on also sweeps the *existing* backlog: any suggested row without a
// verdict becomes claimable, not just ones that arrive later.

// The console toggle + model picker, and the worker's gate, in one place. No row
// means off; no model means "nobody has picked yet" and the worker uses its
// config fallback (exactly the reviewerSettings contract).
export const autoTriage = query({
  args: {},
  returns: v.object({ enabled: v.boolean(), model: v.optional(reviewerModel) }),
  handler: async (ctx) => {
    const row = await ctx.db.query("triageSettings").first()
    return { enabled: row?.enabled ?? false, model: row?.model }
  },
})

// A partial patch: the toggle sends { enabled }, the model picker { model } —
// each leaves the other alone. A model pick before any toggle creates the row
// still off, so picking a model never silently enables auto-review.
export const setAutoTriage = mutation({
  args: { enabled: v.optional(v.boolean()), model: v.optional(reviewerModel) },
  returns: v.null(),
  handler: async (ctx, { enabled, model }) => {
    const row = await ctx.db.query("triageSettings").first()
    const patch = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(model !== undefined ? { model } : {}),
      updatedAt: Date.now(),
    }
    if (row) await ctx.db.patch(row._id, patch)
    else await ctx.db.insert("triageSettings", { enabled: enabled ?? false, model, updatedAt: Date.now() })
    return null
  },
})

// The worker subscribes to this: suggested rows awaiting a triage judgment.
// Empty whenever the toggle is off — the worker needs no setting of its own, and
// flipping the toggle re-fires the subscription with the whole backlog. Oldest
// first, retry-capped like the other claimable queries.
export const toTriage = query({
  args: {},
  returns: v.array(suggestionDoc),
  handler: async (ctx) => {
    const cfg = await ctx.db.query("triageSettings").first()
    if (!cfg?.enabled) return []
    const rows = await ctx.db
      .query("suggestedIssues")
      .withIndex("by_status", (q) => q.eq("status", "suggested"))
      .order("asc")
      .take(INBOX_TAKE.suggested)
    return rows.filter(
      (r) => r.triage === undefined && (r.triageAttempts ?? 0) < MAX_WORKER_ATTEMPTS,
    )
  },
})

// Worker claims a row before spawning the judgment run — first writer wins, so
// two workers never judge the same proposal. `triagedAt` starts the stale clock.
export const claimTriage = mutation({
  args: { id: v.id("suggestedIssues"), worker: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, worker }) => {
    const row = await ctx.db.get(id)
    if (!row || row.status !== "suggested" || row.triage !== undefined) return false
    await ctx.db.patch(id, { triage: "triaging", triagedAt: Date.now(), triagedBy: worker })
    return true
  },
})

// Worker reports the verdict. A late finish (claim lost to the stale cron, or a
// human decided while the run was in flight) is dropped — the human always wins:
// a row no longer `suggested` just gets its claim marker cleared, verdict unused.
export const finishTriage = mutation({
  args: {
    id: v.id("suggestedIssues"),
    verdict: v.union(v.literal("keep"), v.literal("drop")),
    reason: v.string(),
    by: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { id, verdict, reason, by }) => {
    const row = await ctx.db.get(id)
    if (!row || row.triage !== "triaging") return null
    if (row.status !== "suggested") {
      await ctx.db.patch(id, { triage: undefined, triagedAt: undefined })
      return null
    }
    const now = Date.now()
    if (verdict === "keep") {
      await ctx.db.patch(id, {
        triage: "kept",
        triagedAt: now,
        triagedBy: by,
        triageReason: reason,
      })
    } else {
      await ctx.db.patch(id, {
        triage: "dropped",
        triagedAt: now,
        triagedBy: by,
        triageReason: reason,
        status: "dismissed",
        decidedAt: now,
        decidedBy: by,
      })
    }
    return null
  },
})

// Worker records a failed judgment run: the claim is released so a retry can
// claim it, and triageAttempts eventually drops the row out of toTriage (see
// MAX_WORKER_ATTEMPTS) — it then just stays `suggested`, awaiting the human as
// if auto-triage were off. Failing open is the point: a broken triage agent
// must never wedge the inbox.
export const recordTriageError = mutation({
  args: { id: v.id("suggestedIssues"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, error }) => {
    const row = await ctx.db.get(id)
    if (!row || row.triage !== "triaging") return null
    await ctx.db.patch(id, {
      triage: undefined,
      triagedAt: undefined,
      error,
      triageAttempts: (row.triageAttempts ?? 0) + 1,
    })
    return null
  },
})

// Crash recovery (cron): release `triaging` claims whose worker died mid-run, so
// the row becomes claimable again instead of looking in-flight forever. Counts as
// an attempt — a row that only ever crashes still hits the retry cap.
export const requeueStaleTriage = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db
      .query("suggestedIssues")
      .withIndex("by_status", (q) => q.eq("status", "suggested"))
      .take(INBOX_TAKE.suggested)
    for (const r of rows) {
      if (r.triage !== "triaging") continue
      if (now - (r.triagedAt ?? 0) < TRIAGE_STALE_MS) continue
      await ctx.db.patch(r._id, {
        triage: undefined,
        triagedAt: undefined,
        triageAttempts: (r.triageAttempts ?? 0) + 1,
      })
    }
    return null
  },
})
