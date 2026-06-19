#!/usr/bin/env node
// Blocking "wait for a PR review" CLI: `prr await <pr>`.
//
// Subscribes to the prr-console Convex `reviews` row for one
// (repo, prNumber, headSha) over the sync websocket and blocks until that row
// reaches a terminal state, then prints the result JSON to stdout and exits with
// a verdict code. Head-SHA keyed, so it waits for THIS push's review — not a
// stale one. Meant to be run in the background by an automated caller (Claude
// Code) after pushing a PR, so a review never needs a human in the relay.
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

// The query reference. Prefer the typed `api.reviews.getByPrSha` (present after
// codegen); fall back to the string function reference so the CLI still runs if
// codegen hasn't picked it up yet.
const GET_BY_PR_SHA = api?.reviews?.getByPrSha ?? "reviews:getByPrSha"

const HELP = `prr await — block until a PR's review finishes

Usage:
  node worker/await.mjs <pr> [options]

Subscribes to the prr-console Convex review row for this PR's head commit and
blocks until it is reviewed/failed, then prints the result JSON to stdout.

Arguments:
  <pr>                 PR number (required)

Options:
  --repo <owner/name>  target repo (default: \`gh repo view\` of the cwd)
  --head <sha>         PR head SHA (default: \`gh pr view <pr> --json headRefOid\`)
  --timeout <seconds>  give up after this many seconds (default: 1800)
  --json               machine-readable stdout (default: on)
  --quiet              suppress the stderr heartbeat
  -h, --help           show this help

Exit codes:
  0    reviewed, no P0/P1
  2    reviewed with P0/P1 blockers (or counts unparseable — read the review)
  3    failed
  124  timeout (prints last-known state)
  1    usage / connection error
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
let warnedMissing = false // worker-down guard fired?
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
    // null on success/timeout. `report` is included when present for diagnostics.
    error: row?.error ?? null,
    report: row?.report ?? null,
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

let unsubscribe
try {
  unsubscribe = client.onUpdate(GET_BY_PR_SHA, { repo, prNumber, headSha }, onRow)
} catch (e) {
  process.stderr.write(`prr await: failed to subscribe: ${String(e)}\n`)
  await client.close().catch(() => {})
  process.exit(1)
}

// Worker-down guard: if no row appears within ~60s, warn once (to stderr) and
// keep waiting until the real timeout.
const missingTimer = setTimeout(() => {
  if (!lastRow && !warnedMissing) {
    warnedMissing = true
    process.stderr.write(
      `prr await: no queued/reviewing row for ${short} after 60s — is the worker running and the webhook configured for ${repo}?\n`,
    )
  }
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
