import { v } from "convex/values"
import { mutation, query } from "./_generated/server"

// Worker publishes the repos it's configured to review (from worker/config.json)
// on startup, so the dashboard lists every watched repo — even one with zero
// reviews yet — instead of only repos that happen to have review activity.
export const setWatched = mutation({
  args: { repos: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { repos }) => {
    const want = new Set(repos)
    const existing = await ctx.db.query("watchedRepos").collect()
    for (const row of existing) {
      if (want.has(row.repo)) want.delete(row.repo) // keep it
      else await ctx.db.delete(row._id) // no longer configured
    }
    for (const repo of want) {
      await ctx.db.insert("watchedRepos", { repo, updatedAt: Date.now() })
    }
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
