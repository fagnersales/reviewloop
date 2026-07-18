import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import { ruleLevel } from "./schema"

// House rules — operator taste the reviewer enforces on every PR (e.g. "no code
// comments"). Owned entirely by the console's rules editor (add/setLevel/remove
// below) and read live by the worker via `list`, which injects the rules into
// the review brief at spawn time — a change applies to the next review, never
// one already running. Rules apply to every watched repo.
//
// Like watchedRepos, these are public mutations (the console is the gate), so
// both the row count and the text length are hard-capped to keep the table and
// its `.collect()`-shaped reads bounded.

// Config-scale ceiling: a human curates a handful of rules. `add` rejects past
// it, and `list` reads `.take(MAX_RULES)` so no read scans more even if the cap
// were somehow bypassed.
export const MAX_RULES = 50

// One rule is a sentence, not an essay — long policy belongs in the repo's
// CLAUDE.md, which the reviewer already respects.
export const MAX_RULE_LENGTH = 300

export const list = query({
  args: {},
  returns: v.array(
    v.object({ id: v.id("reviewRules"), text: v.string(), level: ruleLevel }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("reviewRules").take(MAX_RULES)
    return rows.map((r) => ({ id: r._id, text: r.text, level: r.level }))
  },
})

export const add = mutation({
  args: { text: v.string(), level: ruleLevel },
  returns: v.union(
    v.literal("added"),
    v.literal("exists"),
    v.literal("invalid"),
    v.literal("full"),
  ),
  handler: async (ctx, { text, level }) => {
    const rule = text.trim()
    if (!rule || rule.length > MAX_RULE_LENGTH) return "invalid"
    // One bounded read serves both checks: dedup (case-insensitive) and the cap.
    const rows = await ctx.db.query("reviewRules").take(MAX_RULES)
    const target = rule.toLowerCase()
    if (rows.some((r) => r.text.toLowerCase() === target)) return "exists"
    if (rows.length >= MAX_RULES) return "full"
    await ctx.db.insert("reviewRules", { text: rule, level, updatedAt: Date.now() })
    return "added"
  },
})

export const setLevel = mutation({
  args: { id: v.id("reviewRules"), level: ruleLevel },
  returns: v.null(),
  handler: async (ctx, { id, level }) => {
    // Tolerate a stale id (rule deleted from another tab) instead of throwing.
    const row = await ctx.db.get(id)
    if (row) await ctx.db.patch(id, { level, updatedAt: Date.now() })
    return null
  },
})

export const remove = mutation({
  args: { id: v.id("reviewRules") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (row) await ctx.db.delete(id)
    return null
  },
})
