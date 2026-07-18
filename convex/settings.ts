import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import { reviewerEffort, reviewerModel } from "./schema"

// The reviewer's model + effort — one settings row, owned by the console picker
// and read live by the review worker over a subscription (exactly like the
// watch list). No row means no human has picked yet: `get` returns null and the
// worker falls back to its config.json model + the CLI's default effort, so a
// fresh deployment of this module never silently overrides an operator's
// existing worker config. The first `set` creates the row; from then on the
// console's choice is authoritative. A change applies to the next review the
// worker starts — never to one already running (the worker reads the settings
// at spawn time).

export const get = query({
  args: {},
  returns: v.union(v.object({ model: reviewerModel, effort: reviewerEffort }), v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("reviewerSettings").first()
    return row ? { model: row.model, effort: row.effort } : null
  },
})

export const set = mutation({
  args: { model: reviewerModel, effort: reviewerEffort },
  returns: v.null(),
  handler: async (ctx, { model, effort }) => {
    const row = await ctx.db.query("reviewerSettings").first()
    if (row) await ctx.db.patch(row._id, { model, effort, updatedAt: Date.now() })
    else await ctx.db.insert("reviewerSettings", { model, effort, updatedAt: Date.now() })
    return null
  },
})
