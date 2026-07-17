#!/usr/bin/env node
// "Acknowledge a PR review" CLI: `node worker/ack.mjs <pr>`
// (installed bin: `prr-ack <pr>`).
//
// A fix agent calls this once it has picked up a posted review and is starting on
// the findings. It stamps the prr-console Convex `reviews` row so the console can
// show a real "In progress" instead of "Awaiting agent" — the one thing the
// console can't observe on its own (an agent has started but hasn't pushed a
// commit yet). The natural companion to `prr-await`: await the review, then ack it.
//
// One-shot: it calls the `reviews.ack` mutation and exits. With `--head` it acks
// the review of that exact commit; without, the PR's most recent reviewed pass.
//
// Mirrors worker/await.mjs's Convex-connection + config-loading conventions.

import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import { loadConfig, resolveConvexUrl, ghText, defaultBy } from "./lib.mjs"

const cfg = loadConfig()
const CONVEX_URL = resolveConvexUrl(cfg)

// `api` is `anyApi` (a Proxy), so this always resolves to the `reviews:ack`
// reference regardless of codegen — whether it's actually *deployed* is decided at
// runtime and surfaced by the mutation call.
const ACK = api.reviews.ack

const HELP = `prr-ack — acknowledge a PR review (mark it "in progress")

Usage:
  node worker/ack.mjs <pr> [options]

Stamps the prr-console review row so the console shows "In progress" instead of
"Awaiting agent" — telling everyone a fix agent has picked this review up. Run it
right after \`prr-await\` returns a review you're about to start fixing.

Arguments:
  <pr>                 PR number (required)

Options:
  --repo <owner/name>  target repo (default: \`gh repo view\` of the cwd)
  --head <sha>         ack the review of this exact commit (default: the PR's
                       latest pass — must be reviewed)
  --by <label>         who is acking, free-form (default: \$USER@\$HOST)
  --clear              release a prior ack instead of recording one (agent bailed)
  --json               accepted for clarity; result JSON is always printed to stdout
  --quiet              suppress the stderr status line
  -h, --help           show this help

Exit codes:
  0    ack recorded (or cleared)
  2    nothing to ack — no reviewed pass for this PR/SHA yet, or PR merged/closed
  1    usage / connection error
`

function die(msg) {
  process.stderr.write(`prr ack: ${msg}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {
    pr: undefined,
    repo: undefined,
    head: undefined,
    by: undefined,
    clear: false,
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
    } else if (a === "--by") {
      opts.by = argv[++i]
    } else if (a === "--clear") {
      opts.clear = true
    } else if (a === "--json") {
      // result JSON is always printed; accepted for explicitness
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

// repo: explicit, else infer from the current repo
const repo =
  opts.repo ||
  (await ghText(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]))
if (!repo) {
  die("could not determine repo — pass --repo <owner/name> (gh repo view failed)")
}

if (!CONVEX_URL) {
  die(
    "no Convex URL. Set PRR_CONVEX_URL, config.convexUrl, or run `npx convex dev` first.",
  )
}

const by = opts.by || defaultBy()
const log = (...a) => {
  if (!opts.quiet) process.stderr.write(a.join(" ") + "\n")
}

const client = new ConvexHttpClient(CONVEX_URL)

const args = { repo, prNumber, by }
if (opts.head) args.headSha = opts.head
if (opts.clear) args.clear = true

const verb = opts.clear ? "clearing ack" : "acking"
log(`${verb} ${repo}#${prNumber}${opts.head ? ` @${opts.head.slice(0, 7)}` : ""} · ${CONVEX_URL}`)

let res
try {
  res = await client.mutation(ACK, args)
} catch (e) {
  process.stderr.write(
    `prr ack: mutation error: ${String(e)}\n` +
      `prr ack: (is reviews:ack deployed? this mutation is added by the PR — it won't exist until merge)\n`,
  )
  process.exit(1)
}

const out = {
  ok: res.ok,
  cleared: opts.clear ? true : undefined,
  repo,
  prNumber,
  headSha: res.headSha ?? opts.head ?? null,
  ackedAt: res.ackedAt ?? null,
  ackedBy: res.ackedBy ?? null,
  reason: res.reason ?? null,
}
process.stdout.write(JSON.stringify(out) + "\n")

if (res.ok) {
  log(opts.clear ? "ack cleared" : `acked @${(res.headSha ?? "?").slice(0, 7)} by ${by}`)
  process.exit(0)
}
log(`not acked: ${res.reason ?? "unknown"}`)
process.exit(2)
