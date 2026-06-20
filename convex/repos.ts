import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"

// GitHub repo slugs are case-insensitive ("Vercel/Next.js" === "vercel/next.js"),
// so we match case-insensitively to avoid duplicate watch entries. We still store
// and display the repo with its original casing (the dashboard filter compares it
// against `reviews.repo`, which carries GitHub's canonical casing).
//
// `watchedRepos` is config-scale (a handful of rows owned by the dashboard), so a
// full `.collect()` here is bounded and acceptable — and it keeps the dedup
// back-compatible with existing rows (no new stored field needed).
async function getRepoRow(ctx: QueryCtx, repo: string) {
  const target = repo.toLowerCase()
  const rows = await ctx.db.query("watchedRepos").collect()
  return rows.find((r) => r.repo.toLowerCase() === target) ?? null
}

// The watch list is owned entirely by the dashboard (add/remove below) and read
// live by the worker via `list`. There's no worker→Convex publish step: a repo is
// watched because it's a row in this table, full stop — adding one here is all it
// takes for the worker to start reconciling and reviewing its PRs.

// Dashboard adds a repo to the watch list. Expects "owner/name".
export const add = mutation({
  args: { repo: v.string() },
  returns: v.union(v.literal("added"), v.literal("exists"), v.literal("invalid")),
  handler: async (ctx, { repo }) => {
    const name = repo.trim()
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return "invalid"
    if (await getRepoRow(ctx, name)) return "exists"
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
    const rows = await ctx.db.query("watchedRepos").collect()
    return rows.map((r) => r.repo).sort()
  },
})
