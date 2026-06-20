#!/usr/bin/env node
// Blocking "wait for a PR review" CLI: `node worker/await.mjs <pr>`
// (installed bin: `prr-await <pr>`).
//
// Subscribes to the prr-console Convex `reviews` row for one
// (repo, prNumber, headSha) over the sync websocket and blocks until that row
// reaches a terminal state, then prints the result JSON to stdout and exits with
// a verdict code. Head-SHA keyed, so it waits for THIS push's review — not a
// stale one. Meant to be run in the background by an automated caller (Claude
// Code) after pushing a PR, so a review never needs a human in the relay.
//
// Self-heals a dropped webhook (issue #9): if no review row exists for this head
// SHA after a ~60s grace period — the symptom of a missed `synchronize` delivery
// — it enqueues the review itself via the same idempotent `reviews.enqueueMissing`
// path the worker's reconcile uses, instead of blocking until the worker's ~30-min
// fallback reconcile happens to fire (or our own timeout).
//
// Mirrors worker/index.mjs's Convex-subscription + config-loading conventions.

import { ConvexClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const base = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"))
  try {
    const local = JSON.parse(
      readFileSync(join(__dirname, "config.local.json"), "utf8"),
    )
    Object.assign(base, local)
  } catch {
    /* no local override */
  }
  return base
}

// Pull VITE_CONVEX_URL / CONVEX_URL out of ../.env.local (written by `convex dev`).
function envLocalUrl() {
  try {
    const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8")
    const get = (k) => txt.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim()
    return get("VITE_CONVEX_URL") || get("CONVEX_URL")
  } catch {
    return undefined
  }
}

const cfg = loadConfig()
const CONVEX_URL = process.env.PRR_CONVEX_URL || cfg.convexUrl || envLocalUrl()

// The query reference. `api` is `anyApi` (a Proxy), so this always resolves to
// the `reviews:getByPrSha` reference regardless of codegen — whether the query
// is actually *deployed* is decided at runtime and surfaced via onQueryError.
const GET_BY_PR_SHA = api.reviews.getByPrSha

const HELP = `prr-await — block until a PR's review finishes

Usage:
  node worker/await.mjs <pr> [options]

Subscribes to the prr-console Convex review row for this PR's head commit and
blocks until it is reviewed/failed, then prints the result JSON to stdout.

If no row exists after ~60s (a dropped webhook delivery), it self-heals by
enqueuing the review itself via the idempotent reviews.enqueueMissing path,
rather than waiting on the worker's slow fallback reconcile.

Arguments:
  <pr>                 PR number (required)

Options:
  --repo <owner/name>  target repo (default: \`gh repo view\` of the cwd)
  --head <sha>         PR head SHA (default: \`gh pr view <pr> --json headRefOid\`)
  --timeout <seconds>  give up after this many seconds (default: 1800)
  --json               accepted for clarity; it is the default and has no opposite flag.
                       stdout carries the result JSON only on a terminal outcome
                       (exit 0/2/3/124); exit 1 (usage/connection/query) prints nothing
                       to stdout.
  --quiet              suppress the stderr heartbeat
  -h, --help           show this help

Exit codes:
  0    reviewed, no P0/P1
  2    reviewed with P0/P1 blockers (or counts unparseable — read the review)
  3    failed
  124  timeout (prints last-known state)
  1    usage / connection error, or repo not watched by prr-console
`

// ── arg parsing ──────────────────────────────────────────────────────────────
function die(msg) {
  process.stderr.write(`prr await: ${msg}\n`)
  process.exit(1)
}

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8" })
  if (r.status !== 0) return undefined
  return (r.stdout || "").trim() || undefined
}

// `gh ... --json <fields>` parsed to an object (undefined on any failure).
function ghJson(args) {
  const r = spawnSync("gh", args, { encoding: "utf8" })
  if (r.status !== 0) return undefined
  try {
    return JSON.parse(r.stdout || "")
  } catch {
    return undefined
  }
}

function parseArgs(argv) {
  const opts = {
    pr: undefined,
    repo: undefined,
    head: undefined,
    timeout: 1800,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP)
      process.exit(0)
    } else if (a === "--repo") {
      opts.repo = argv[++i]
    } else if (a === "--head") {
      opts.head = argv[++i]
    } else if (a === "--timeout") {
      opts.timeout = Number(argv[++i])
    } else if (a === "--json") {
      // default on; accepted for explicitness
    } else if (a === "--quiet") {
      opts.quiet = true
    } else if (a.startsWith("-")) {
      die(`unknown option: ${a}`)
    } else if (opts.pr === undefined) {
      opts.pr = a
    } else {
      die(`unexpected argument: ${a}`)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

if (opts.pr === undefined) die("missing <pr> argument (try --help)")
const prNumber = Number(opts.pr)
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  die(`invalid PR number: ${opts.pr}`)
}
if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
  die(`invalid --timeout: must be a positive number of seconds`)
}

// repo: explicit, else infer from the current repo
const repo =
  opts.repo || gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
if (!repo) {
  die("could not determine repo — pass --repo <owner/name> (gh repo view failed)")
}

// head SHA: explicit, else resolve the PR's head ref
const headSha =
  opts.head ||
  gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"])
if (!headSha) {
  die(
    `could not resolve head SHA for ${repo}#${prNumber} — pass --head <sha> (gh pr view failed)`,
  )
}

if (!CONVEX_URL) {
  die(
    "no Convex URL. Set PRR_CONVEX_URL, config.convexUrl, or run `npx convex dev` first.",
  )
}

// ── subscription + blocking wait ─────────────────────────────────────────────
const short = headSha.slice(0, 7)
const log = (...a) => {
  if (!opts.quiet) process.stderr.write(a.join(" ") + "\n")
}

const client = new ConvexClient(CONVEX_URL)

let lastRow = null // newest seen row (for the timeout dump)
let lastHeartbeat = "" // dedupe the stderr heartbeat
let selfHealAttempted = false // the 60s self-heal already ran (once)?
let settled = false // terminal handler already ran?

// Result JSON shape, shared by reviewed / failed / timeout output.
function resultJson(row, status) {
  return {
    status: status ?? row?.status ?? "unknown",
    repo,
    prNumber,
    headSha,
    reviewUrl: row?.reviewUrl ?? null,
    confidence: row?.confidence ?? null,
    reviewEffort: row?.reviewEffort ?? null,
    p0: row?.p0 ?? null,
    p1: row?.p1 ?? null,
    p2: row?.p2 ?? null,
    // Surface the failure reason on a `failed` row (set by the worker's `finish`);
    // null on success/timeout.
    error: row?.error ?? null,
    finishedAt: row?.finishedAt ?? null,
  }
}

async function settle(row, status, code) {
  if (settled) return
  settled = true
  clearTimeout(timeoutTimer)
  clearTimeout(missingTimer)
  process.stdout.write(JSON.stringify(resultJson(row, status)) + "\n")
  await client.close().catch(() => {})
  process.exit(code)
}

function onRow(row) {
  lastRow = row ?? lastRow
  if (!row) return // not queued yet — worker-down guard handles this

  // throttled/deduped stderr heartbeat
  const beat = `${row.status} #${prNumber} @${short}${row.progress ? ` · ${row.progress}` : ""}`
  if (beat !== lastHeartbeat) {
    lastHeartbeat = beat
    log(beat)
  }

  if (row.status === "reviewed") {
    // p0/p1 are best-effort scraped (worker parseReport); undefined ≠ 0. Treat an
    // unparseable count as a blocker so a parse miss never reports "clean".
    const unknown = row.p0 == null || row.p1 == null
    const hasBlockers = (row.p0 ?? 0) > 0 || (row.p1 ?? 0) > 0
    settle(row, "reviewed", unknown || hasBlockers ? 2 : 0)
  } else if (row.status === "failed") {
    settle(row, "failed", 3)
  }
}

log(`waiting on ${repo}#${prNumber} @${short} (timeout ${opts.timeout}s) · ${CONVEX_URL}`)

// onError: ConvexClient.onUpdate delivers a *server-side* query failure here.
// Without it the client does `void Promise.reject(error)` → an unhandled
// rejection that terminates the process. (The try/catch below only catches a
// synchronous subscribe-time throw.) The most likely cause pre-merge is the
// query simply not being deployed yet, so we hint that. Exit promptly with 1 —
// don't let the 60s "worker down" guard be what the user sees.
async function onQueryError(e) {
  if (settled) return
  settled = true
  clearTimeout(timeoutTimer)
  clearTimeout(missingTimer)
  process.stderr.write(
    `prr await: query error: ${String(e)}\n` +
      `prr await: (is reviews:getByPrSha deployed? this query is added by the PR — it won't exist until merge)\n`,
  )
  await client.close().catch(() => {})
  process.exit(1)
}

let unsubscribe
try {
  unsubscribe = client.onUpdate(
    GET_BY_PR_SHA,
    { repo, prNumber, headSha },
    onRow,
    onQueryError,
  )
} catch (e) {
  process.stderr.write(`prr await: failed to subscribe: ${String(e)}\n`)
  await client.close().catch(() => {})
  process.exit(1)
}

// Self-heal guard: if no row appears within ~60s, the most likely cause is a
// dropped `synchronize` webhook delivery (issue #9) — the push happened but no
// review was ever queued. Rather than block until the worker's ~30-min fallback
// reconcile happens to fire (or our own timeout), enqueue the review ourselves
// via the same idempotent path the reconcile uses (`reviews.enqueueMissing`),
// collapsing worst-case latency from ~30min to ~60s. doEnqueue is idempotent
// (returns "duplicate"), so this is safe even if a late webhook/reconcile fires.
async function selfHeal() {
  if (settled || lastRow || selfHealAttempted) return
  selfHealAttempted = true

  const meta = ghJson([
    "pr", "view", String(prNumber), "--repo", repo,
    "--json", "title,author,url,createdAt,state,isDraft",
  ])

  // Gate the enqueue on the PR's lifecycle before doing it. A self-heal enqueue
  // is billing-adjacent, so it must share the same invariant as the two canonical
  // enqueue paths: only open, non-draft PRs get reviewed.
  //
  // Fail *closed* when PR state is unknown: if `gh pr view` failed we'd rather
  // decline than risk queuing a review for a PR that's actually a draft/closed.
  // A genuinely-open PR loses only the fast path — the worker's ~30-min reconcile
  // still heals it.
  if (!meta) {
    process.stderr.write(
      `prr await: couldn't fetch PR state for ${repo}#${prNumber} after 60s — ` +
        `not self-healing; the worker's reconcile will heal it if it's open. ` +
        `Waiting until --timeout\n`,
    )
    return
  }
  // Both canonical paths skip drafts/closed on purpose — the webhook ignores
  // `pr.draft` and the reconcile uses `--state open` + an `isDraft` skip — so
  // "no row after 60s" is the *expected* state here, not a dropped delivery.
  // Keep waiting (a draft marked ready fires its own `ready_for_review` webhook).
  // gh `state` is uppercase (OPEN/CLOSED/MERGED).
  if (meta.isDraft === true || (meta.state && meta.state !== "OPEN")) {
    process.stderr.write(
      `prr await: no row for ${short} after 60s, but ${repo}#${prNumber} is ` +
        `${meta.isDraft ? "a draft" : String(meta.state).toLowerCase()} — ` +
        `not self-healing (drafts/closed PRs aren't reviewed). Waiting until --timeout\n`,
    )
    return
  }

  // PR is watched-repo-eligible (open, non-draft) — gather best-effort dashboard
  // metadata; construct a deterministic PR URL as a fallback for any missing field.
  const title = meta.title ?? ""
  const author = meta.author?.login ?? ""
  const prUrl = meta.url ?? `https://github.com/${repo}/pull/${prNumber}`
  const createdMs = Date.parse(meta.createdAt ?? "")
  const prCreatedAt = Number.isNaN(createdMs) ? undefined : createdMs

  let outcome
  try {
    outcome = await client.mutation(api.reviews.enqueueMissing, {
      repo,
      prNumber,
      headSha,
      title,
      author,
      prUrl,
      prCreatedAt,
    })
  } catch (e) {
    process.stderr.write(
      `prr await: no row for ${short} after 60s and self-heal enqueue failed: ${String(e)} — ` +
        `is the worker running and ${repo} watched? still waiting until --timeout\n`,
    )
    return
  }

  if (settled) return
  if (outcome === "unwatched") {
    // Definitive: an unwatched repo will never be reviewed, so don't sit idle
    // until --timeout — surface it and give up now (exit 1, a config error the
    // caller shouldn't blindly retry). This is the one self-heal outcome we can
    // be certain about; "enqueued"/"duplicate" still need the worker to finish.
    settled = true
    clearTimeout(timeoutTimer)
    clearTimeout(missingTimer)
    process.stderr.write(
      `prr await: ${repo} is not watched by prr-console — no review will be queued. ` +
        `Add it in the dashboard / worker/config.json.\n`,
    )
    await client.close().catch(() => {})
    process.exit(1)
  } else if (outcome === "enqueued") {
    // We queued the row, but only the worker can review it. If it never leaves
    // "queued" the worker is likely down — keep the old diagnostic so the
    // operator isn't left guessing until the timeout dump.
    log(
      `self-healed: no row for ${short} after 60s (dropped webhook?) — enqueued the review myself; ` +
        `waiting (if it stays queued, is the worker running for ${repo}?)`,
    )
  } else if (outcome === "duplicate") {
    log(
      `self-heal: a review row for ${short} already exists — a late webhook/reconcile beat me; waiting`,
    )
  }
}
const missingTimer = setTimeout(() => {
  void selfHeal()
}, 60_000)

// Hard timeout: dump last-known state and exit 124.
const timeoutTimer = setTimeout(() => {
  process.stderr.write(
    `prr await: timed out after ${opts.timeout}s waiting on ${repo}#${prNumber} @${short}\n`,
  )
  settle(lastRow, lastRow?.status ?? "timeout", 124)
}, opts.timeout * 1000)

// keep onUpdate referenced for linters; unsubscribe is closed by client.close()
void unsubscribe

async function shutdown() {
  if (settled) return
  settled = true
  clearTimeout(timeoutTimer)
  clearTimeout(missingTimer)
  process.stderr.write("\nprr await: interrupted\n")
  await client.close().catch(() => {})
  process.exit(1)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
