import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import { ruleDraftMode, ruleDraftStatus } from "./schema"

// The "rewrite"/"shorten" buttons on the house-rules composer. Convex can't spawn
// `claude`, so — like reviews and solves — the console records intent in a tiny
// job queue and the worker (which holds the CLI) claims it, runs the transform,
// and writes the result back. The composer subscribes to its own job row and
// drops the output into the draft textarea. Rows are ephemeral: the composer
// discards its row once consumed, and `request` prunes stale ones, so the table
// stays bounded without a cleanup cron.
//
// Public mutations (the console is the gate, like rules.ts), so the input is
// length-capped and the table is row-capped to keep every read bounded.

// Generous vs. the 300-char rule cap on purpose: the whole point of rewrite /
// shorten is to pull an over-budget draft back under the cap, so the input the
// composer sends may itself exceed MAX_RULE_LENGTH.
export const MAX_INPUT = 2000

// A human clicks one button at a time; the queue only ever fills if the worker is
// down and orphans accumulate — and the stale-prune below clears those anyway.
const MAX_JOBS = 30

// A job older than this is an orphan (the composer closed before it resolved, or
// the worker is down); `request` deletes it so the queue self-heals.
const STALE_MS = 3 * 60 * 1000

export const request = mutation({
  args: { input: v.string(), mode: ruleDraftMode },
  returns: v.union(v.id("ruleDrafts"), v.literal("invalid"), v.literal("busy")),
  handler: async (ctx, { input, mode }) => {
    const text = input.trim()
    if (!text || text.length > MAX_INPUT) return "invalid"
    // Prune orphaned/stale rows first (one bounded read serves the prune and the
    // cap), then reject if too many live jobs remain.
    const now = Date.now()
    const rows = await ctx.db.query("ruleDrafts").take(MAX_JOBS + 20)
    let live = 0
    for (const r of rows) {
      if (now - r.createdAt > STALE_MS) await ctx.db.delete(r._id)
      else live++
    }
    if (live >= MAX_JOBS) return "busy"
    return await ctx.db.insert("ruleDrafts", {
      input: text,
      mode,
      status: "queued",
      createdAt: now,
    })
  },
})

// The composer subscribes to its own job row; null once it's discarded.
export const get = query({
  args: { id: v.id("ruleDrafts") },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("ruleDrafts"),
      mode: ruleDraftMode,
      status: ruleDraftStatus,
      output: v.optional(v.string()),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    return { id: row._id, mode: row.mode, status: row.status, output: row.output, error: row.error }
  },
})

export const discard = mutation({
  args: { id: v.id("ruleDrafts") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (row) await ctx.db.delete(id)
    return null
  },
})

// ── worker side ──────────────────────────────────────────────────────────────

// The worker subscribes to this: every queued transform, oldest first.
export const claimable = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("ruleDrafts"),
      input: v.string(),
      mode: ruleDraftMode,
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("ruleDrafts")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(MAX_JOBS)
    return rows.map((r) => ({ id: r._id, input: r.input, mode: r.mode }))
  },
})

export const claim = mutation({
  args: { id: v.id("ruleDrafts"), worker: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, worker }) => {
    const row = await ctx.db.get(id)
    if (!row || row.status !== "queued") return false
    await ctx.db.patch(id, { status: "running", worker })
    return true
  },
})

export const finish = mutation({
  args: {
    id: v.id("ruleDrafts"),
    ok: v.boolean(),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, ok, output, error }) => {
    const row = await ctx.db.get(id)
    // Ignore a late finish (the composer may have discarded the row already).
    if (!row || row.status !== "running") return null
    await ctx.db.patch(id, { status: ok ? "done" : "failed", output, error })
    return null
  },
})
