import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"

async function getRepoRow(ctx: QueryCtx, repo: string) {
  return await ctx.db
    .query("watchedRepos")
    .withIndex("by_repo", (q) => q.eq("repo", repo))
    .unique()
}

// Worker publishes the repos it's configured to review (from worker/config.json)
// on startup. Additive: it ensures each configured repo is present without
// deleting others, so repos added from the dashboard survive a worker restart.
// The watch list is owned by the dashboard; the worker only guarantees its own
// repos are listed.
export const setWatched = mutation({
  args: { repos: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { repos }) => {
    for (const repo of repos) {
      const existing = await getRepoRow(ctx, repo)
      if (!existing) await ctx.db.insert("watchedRepos", { repo, updatedAt: Date.now() })
    }
    return null
  },
})

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

// Dashboard removes a repo from the watch list. (The worker re-adds it on its
// next publish if the repo is still in its config.)
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
