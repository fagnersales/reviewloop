import { v } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"
import { checkoutStatus, solverCheckoutFields } from "./schema"

// The solver checkout registry — the repo → local-path map each solver host is
// allowed to build in, plus per-repo operator instructions for the solve agent.
// Convex is the single source of truth (there is no config-file fallback): the
// console edits it, each solver subscribes to `forHost` for its own hostname and
// picks changes up live, and validation verdicts flow back via `reportStatus`.
// All mutations are public, exactly like repos.add — the console has no auth of
// its own — so every read is bounded by the caps below.

// Generous ceilings for what is config-scale data: a handful of machines, each
// with a handful of checkouts. `upsert`/`hello` reject past them, and every
// read `.take`s them, so no scan is unbounded even if a cap is bypassed.
const MAX_HOSTS = 20
const MAX_CHECKOUTS_PER_HOST = 50

const checkoutDoc = v.object({
  _id: v.id("solverCheckouts"),
  _creationTime: v.number(),
  ...solverCheckoutFields,
})

// A solver's live view of its own registry. Host is the exact os.hostname() the
// worker reports — no case games (hostnames are ours, not GitHub's).
export const forHost = query({
  args: { host: v.string() },
  returns: v.array(checkoutDoc),
  handler: async (ctx, { host }) => {
    return await ctx.db
      .query("solverCheckouts")
      .withIndex("by_host", (q) => q.eq("host", host))
      .take(MAX_CHECKOUTS_PER_HOST)
  },
})

// The console's editor view: every known host (even ones with no checkouts yet)
// and every registered checkout, grouped client-side.
export const board = query({
  args: {},
  returns: v.object({
    hosts: v.array(v.object({ host: v.string(), lastSeenAt: v.number() })),
    checkouts: v.array(checkoutDoc),
  }),
  handler: async (ctx) => {
    const hosts = await ctx.db.query("solverHosts").take(MAX_HOSTS)
    const checkouts = await ctx.db
      .query("solverCheckouts")
      .take(MAX_HOSTS * MAX_CHECKOUTS_PER_HOST)
    return {
      hosts: hosts
        .map((h) => ({ host: h.host, lastSeenAt: h.lastSeenAt }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      checkouts,
    }
  },
})

// A solver announces itself on startup so the console can offer its hostname in
// the editor before any checkout exists for it.
export const hello = mutation({
  args: { host: v.string() },
  returns: v.null(),
  handler: async (ctx, { host }) => {
    const name = host.trim()
    if (!name) return null
    const rows = await ctx.db.query("solverHosts").take(MAX_HOSTS)
    const existing = rows.find((r) => r.host === name)
    if (existing) await ctx.db.patch(existing._id, { lastSeenAt: Date.now() })
    else if (rows.length < MAX_HOSTS)
      await ctx.db.insert("solverHosts", { host: name, lastSeenAt: Date.now() })
    return null
  },
})

// Console adds or edits a checkout. One row per (host, repo) — repo matched
// case-insensitively like the watch list (GitHub slugs are), host matched
// exactly. A path change clears the old verdict: the row reads as "not yet
// validated" until the live solver re-checks it, never as stale-green.
export const upsert = mutation({
  args: {
    host: v.string(),
    repo: v.string(),
    path: v.string(),
    instructions: v.optional(v.string()),
  },
  returns: v.union(v.literal("saved"), v.literal("invalid"), v.literal("full")),
  handler: async (ctx, { host, repo, path, instructions }) => {
    const hostName = host.trim()
    const repoName = repo.trim()
    const pathName = path.trim()
    const notes = instructions?.trim() || undefined
    if (!hostName || !pathName || !/^[^/\s]+\/[^/\s]+$/.test(repoName)) return "invalid"

    const rows = await ctx.db
      .query("solverCheckouts")
      .withIndex("by_host", (q) => q.eq("host", hostName))
      .take(MAX_CHECKOUTS_PER_HOST)
    const target = repoName.toLowerCase()
    const existing = rows.find((r) => r.repo.toLowerCase() === target)

    if (existing) {
      // A path change re-requests provisioning (the new location is likely
      // unprepared) and clears the old verdict either way — the provisioner
      // fast-paths a path that turns out to be already prepared.
      await ctx.db.patch(existing._id, {
        repo: repoName,
        path: pathName,
        instructions: notes,
        updatedAt: Date.now(),
        ...(existing.path !== pathName
          ? {
              status: undefined,
              statusDetail: undefined,
              validatedAt: undefined,
              provision: "requested" as const,
              provisionProgress: undefined,
              provisionReport: undefined,
              provisionError: undefined,
            }
          : {}),
      })
      return "saved"
    }
    if (rows.length >= MAX_CHECKOUTS_PER_HOST) return "full"
    // Every new registration starts as a provisioning request — the operator
    // shouldn't have to know whether the path is prepared. The provisioner
    // no-ops (straight to ready) when it finds a checkout that already builds.
    await ctx.db.insert("solverCheckouts", {
      host: hostName,
      repo: repoName,
      path: pathName,
      instructions: notes,
      updatedAt: Date.now(),
      provision: "requested",
    })
    // Registering under a never-seen host claims the host row too, so the
    // entry doesn't dangle invisibly if the solver there hasn't started yet.
    const hosts = await ctx.db.query("solverHosts").take(MAX_HOSTS)
    if (!hosts.some((r) => r.host === hostName) && hosts.length < MAX_HOSTS)
      await ctx.db.insert("solverHosts", { host: hostName, lastSeenAt: 0 })
    return "saved"
  },
})

export const remove = mutation({
  args: { id: v.id("solverCheckouts") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id)
    return null
  },
})

// ── provisioning lifecycle (see provisionState in schema) ────────────────────
// Solver claims a requested provision. Convex serializes mutations, so two
// solvers... can't both win — but in practice only one solver runs per host and
// the row is host-keyed; the claim still guards a restarted solver racing its
// own previous life.
export const claimProvision = mutation({
  args: { id: v.id("solverCheckouts") },
  returns: v.boolean(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (!row || row.provision !== "requested") return false
    await ctx.db.patch(id, {
      provision: "provisioning",
      provisionProgress: undefined,
      provisionError: undefined,
      updatedAt: Date.now(), // the stale-provision cron's clock starts here
    })
    return true
  },
})

// One-line "what the provisioner is doing right now", same idiom as
// solveTasks.setProgress. Ignored once the row leaves "provisioning".
export const setProvisionProgress = mutation({
  args: { id: v.id("solverCheckouts"), line: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, line }) => {
    const row = await ctx.db.get(id)
    if (!row || row.provision !== "provisioning") return null
    await ctx.db.patch(id, { provisionProgress: line })
    return null
  },
})

export const finishProvision = mutation({
  args: {
    id: v.id("solverCheckouts"),
    outcome: v.union(v.literal("ready"), v.literal("failed")),
    report: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, outcome, report, error }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, {
      provision: outcome,
      provisionProgress: undefined,
      provisionReport: report,
      provisionError: error,
      updatedAt: Date.now(),
    })
    return null
  },
})

// Console retry (or a first run for a hand-registered row): flip any
// non-in-flight row back to requested.
export const requestProvision = mutation({
  args: { id: v.id("solverCheckouts") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (!row || row.provision === "provisioning") return null
    await ctx.db.patch(id, {
      provision: "requested",
      provisionProgress: undefined,
      provisionError: undefined,
      updatedAt: Date.now(),
    })
    return null
  },
})

// Cron-driven crash recovery: a "provisioning" row whose solver died is failed
// (with the reason) so the console never shows a spinner forever. The bound
// comfortably exceeds the worker's provision timeout; updatedAt is stamped at
// claim and finish, never by progress lines, so it measures the whole attempt.
const PROVISION_STALE_MS = 60 * 60 * 1000 // 1h
export const failStaleProvisions = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db
      .query("solverCheckouts")
      .take(MAX_HOSTS * MAX_CHECKOUTS_PER_HOST)
    let failed = 0
    for (const r of rows) {
      if (r.provision !== "provisioning" || now - r.updatedAt <= PROVISION_STALE_MS) continue
      await ctx.db.patch(r._id, {
        provision: "failed",
        provisionProgress: undefined,
        provisionError: "provisioner did not finish — is the solver on that host still running?",
        updatedAt: now,
      })
      failed++
    }
    return failed
  },
})

// The solver's on-the-ground verdict for a row (see checkoutStatus in schema).
// statusDetail always overwrites — omitting it clears a stale reason.
export const reportStatus = mutation({
  args: {
    id: v.id("solverCheckouts"),
    status: checkoutStatus,
    statusDetail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, status, statusDetail }) => {
    const row = await ctx.db.get(id)
    if (!row) return null
    await ctx.db.patch(id, { status, statusDetail, validatedAt: Date.now() })
    return null
  },
})
