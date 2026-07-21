import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import { ruleLevel } from "./schema"

// House rules — operator taste the reviewer enforces (e.g. "no code comments").
// A rule is either global (no `repo` — applies to every watched repo) or scoped
// to one "owner/name". Owned entirely by the console's rules editor
// (add/setLevel/remove below) and read live by the worker via `list`, which
// filters by the PR's repo and injects the applicable rules into the review
// brief at spawn time — a change applies to the next review, never one already
// running.
//
// Like watchedRepos, these are public mutations (the console is the gate), so
// both the row count and the text length are hard-capped to keep the table and
// its `.collect()`-shaped reads bounded.

// Config-scale ceiling across all scopes: a human curates a handful of rules.
// `add` rejects past it, and `list` reads `.take(MAX_RULES)` so no read scans
// more even if the cap were somehow bypassed.
export const MAX_RULES = 50

// One rule is a sentence, not an essay — long policy belongs in the repo's
// CLAUDE.md, which the reviewer already respects.
export const MAX_RULE_LENGTH = 300

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("reviewRules"),
      text: v.string(),
      level: ruleLevel,
      repo: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("reviewRules").take(MAX_RULES)
    return rows.map((r) => ({ id: r._id, text: r.text, level: r.level, repo: r.repo, updatedAt: r.updatedAt }))
  },
})

export const add = mutation({
  args: { text: v.string(), level: ruleLevel, repo: v.optional(v.string()) },
  returns: v.union(
    v.literal("added"),
    v.literal("exists"),
    v.literal("invalid"),
    v.literal("full"),
  ),
  handler: async (ctx, { text, level, repo }) => {
    const rule = text.trim()
    if (!rule || rule.length > MAX_RULE_LENGTH) return "invalid"
    const scope = repo?.trim() || undefined
    if (scope && !/^[^/\s]+\/[^/\s]+$/.test(scope)) return "invalid"
    // One bounded read serves both checks: dedup and the cap. Dedup is per
    // scope (both case-insensitive — GitHub slugs are): the same sentence may
    // exist globally and for a repo, but not twice in one scope.
    const rows = await ctx.db.query("reviewRules").take(MAX_RULES)
    const target = rule.toLowerCase()
    const targetScope = scope?.toLowerCase() ?? null
    if (
      rows.some(
        (r) =>
          r.text.toLowerCase() === target && (r.repo?.toLowerCase() ?? null) === targetScope,
      )
    )
      return "exists"
    if (rows.length >= MAX_RULES) return "full"
    await ctx.db.insert("reviewRules", { text: rule, level, repo: scope, updatedAt: Date.now() })
    return "added"
  },
})

export const setText = mutation({
  args: { id: v.id("reviewRules"), text: v.string() },
  returns: v.union(v.literal("updated"), v.literal("exists"), v.literal("invalid")),
  handler: async (ctx, { id, text }) => {
    const rule = text.trim()
    if (!rule || rule.length > MAX_RULE_LENGTH) return "invalid"
    // Tolerate a stale id (rule deleted from another tab): report "updated" and
    // let the live list drop the row.
    const row = await ctx.db.get(id)
    if (!row) return "updated"
    // Same per-scope dedup as `add`, excluding the rule being edited.
    const rows = await ctx.db.query("reviewRules").take(MAX_RULES)
    const target = rule.toLowerCase()
    const scope = row.repo?.toLowerCase() ?? null
    if (
      rows.some(
        (r) =>
          r._id !== id && r.text.toLowerCase() === target && (r.repo?.toLowerCase() ?? null) === scope,
      )
    )
      return "exists"
    await ctx.db.patch(id, { text: rule, updatedAt: Date.now() })
    return "updated"
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
