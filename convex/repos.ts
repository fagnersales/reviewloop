import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"

// A hard ceiling on the watch list. `watchedRepos` is config-scale — a handful of
// repos a human curates from the dashboard — so this bound is generous. It exists
// because `add` is a public mutation (anyone with the deployment can call it), so
// the table no longer has an implicit upper bound: without a cap, both the table
// and every `.collect()` over it could grow without limit. The cap does double
// duty — `add` rejects past it, and every read below `.take(MAX_WATCHED_REPOS)`
// instead of an unbounded `.collect()`, so no read scans more than this many rows
// even if the cap were somehow bypassed. Shared with `doEnqueue` in reviews.ts,
// which gates reviews on the same table.
export const MAX_WATCHED_REPOS = 100

// All watched rows, read with a hard upper bound. The table is capped at
// MAX_WATCHED_REPOS by `add`, so this returns every row — `.take` is the bound
// that keeps the read safe regardless.
async function watchedRows(ctx: QueryCtx) {
  return ctx.db.query("watchedRepos").take(MAX_WATCHED_REPOS)
}

// GitHub repo slugs are case-insensitive ("Vercel/Next.js" === "vercel/next.js"),
// so we match case-insensitively to avoid duplicate watch entries. We still store
// and display the repo with its original casing (the dashboard filter compares it
// against `reviews.repo`, which carries GitHub's canonical casing).
//
// Matching over the bounded `watchedRows` keeps the dedup back-compatible with
// existing rows (no new stored field needed) while staying read-bounded.
async function getRepoRow(ctx: QueryCtx, repo: string) {
  const target = repo.toLowerCase()
  const rows = await watchedRows(ctx)
  return rows.find((r) => r.repo.toLowerCase() === target) ?? null
}

// The watch list is owned entirely by the dashboard (add/remove below) and read
// live by the worker via `list`. There's no worker→Convex publish step: a repo is
// watched because it's a row in this table, full stop — adding one here is all it
// takes for the worker to start reconciling and reviewing its PRs.

// Dashboard adds a repo to the watch list. Expects "owner/name". Rejects past
// MAX_WATCHED_REPOS so the public mutation can't grow the table without bound.
export const add = mutation({
  args: { repo: v.string() },
  returns: v.union(
    v.literal("added"),
    v.literal("exists"),
    v.literal("invalid"),
    v.literal("full"),
  ),
  handler: async (ctx, { repo }) => {
    const name = repo.trim()
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return "invalid"
    // One bounded read serves both checks: dedup (case-insensitive) and the cap.
    const rows = await watchedRows(ctx)
    const target = name.toLowerCase()
    if (rows.some((r) => r.repo.toLowerCase() === target)) return "exists"
    if (rows.length >= MAX_WATCHED_REPOS) return "full"
    await ctx.db.insert("watchedRepos", { repo: name, updatedAt: Date.now() })
    return "added"
  },
})

// Dashboard removes a repo from the watch list. Removal is authoritative: new
// reviews stop (both the webhook and the reconcile enqueue gate on this table —
// see doEnqueue in reviews.ts). Reviews already queued/running for it still
// finish; the GitHub webhook can stay configured (its deliveries just log as
// "unwatched"), so add/remove here doesn't require touching GitHub.
export const remove = mutation({
  args: { repo: v.string() },
  returns: v.null(),
  handler: async (ctx, { repo }) => {
    const existing = await getRepoRow(ctx, repo)
    if (existing) await ctx.db.delete(existing._id)
    return null
  },
})

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await watchedRows(ctx)
    return rows.map((r) => r.repo).sort()
  },
})
