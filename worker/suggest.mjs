#!/usr/bin/env node
// "Suggest follow-up issues" CLI: `node worker/suggest.mjs --pr <n>`
// (installed bin: `reviewloop-suggest`).
//
// The producer end of the PR-follow-ups loop. A reviewloop-feature agent, at the
// *unattended* wrap-up of a PR it built, flushes its running follow-ups list here
// instead of opening GitHub issues directly. Each proposal lands in the
// reviewloop Convex `suggestedIssues` table as a durable proposal; the console is
// the async approval inbox where a human decides which to open. Nothing is filed
// on GitHub by this CLI — opening happens worker-side off the human's approval,
// exactly like reviews.
//
// Input is a JSON array of proposals read from stdin (or --file), each:
//   { "category": "bug"|"enhancement"|"chore",
//     "source": "deferred-p2"|"disclosed-limitation"|"build-tangent",
//     "title": "...", "body": "markdown...", "files": ["path/a.ts", ...] }
//
// One-shot: it resolves the source-PR context from `gh`, calls the
// `suggestedIssues.suggest` mutation, prints the result JSON, and exits.
//
// Mirrors worker/ack.mjs's Convex-connection + config-loading + arg conventions.

import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import { readFileSync } from "node:fs"
import { loadConfig, resolveConvexUrl, ghText, defaultBy } from "./lib.mjs"

const cfg = loadConfig()
const CONVEX_URL = resolveConvexUrl(cfg)

// `api` is `anyApi` (a Proxy), so this resolves to the `suggestedIssues:suggest`
// reference regardless of codegen; whether it's *deployed* is decided at runtime.
const SUGGEST = api.suggestedIssues.suggest

const CATEGORIES = new Set(["bug", "enhancement", "chore"])
const SOURCES = new Set(["deferred-p2", "disclosed-limitation", "build-tangent"])

const HELP = `reviewloop-suggest — propose follow-up issues from a PR (the producer end)

Usage:
  node worker/suggest.mjs --pr <n> [options] < proposals.json
  reviewloop-suggest --pr <n> --file proposals.json

Flushes a reviewloop-feature agent's out-of-scope follow-ups into the reviewloop inbox as
durable proposals. Nothing is filed on GitHub — a human approves which to open from
the console, and the worker files those (exactly like reviews). Idempotent: a
re-run collapses onto existing proposals (counted as duplicates).

Input (stdin or --file): a JSON array of proposals, each:
  { "category": "bug"|"enhancement"|"chore",
    "source": "deferred-p2"|"disclosed-limitation"|"build-tangent",
    "title": "...", "body": "markdown...", "files": ["path/a.ts"] }   // files optional

Options:
  --pr <n>             source PR number (required)
  --repo <owner/name>  target repo (default: \`gh repo view\` of the cwd)
  --head <sha>         head SHA at proposal time (default: the PR's headRefOid)
  --file <path>        read proposals from a file instead of stdin
  --by <label>         who is proposing, free-form (default: \$USER@\$HOST)
  --json               accepted for clarity; result JSON is always printed to stdout
  --quiet              suppress the stderr status line
  -h, --help           show this help

Exit codes:
  0    proposals recorded (some enqueued and/or duplicates)
  2    repo isn't watched by reviewloop — nothing was recorded
  1    usage / connection / input error
`

function die(msg) {
  process.stderr.write(`reviewloop suggest: ${msg}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {
    pr: undefined,
    repo: undefined,
    head: undefined,
    file: undefined,
    by: undefined,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP)
      process.exit(0)
    } else if (a === "--pr") {
      opts.pr = argv[++i]
    } else if (a === "--repo") {
      opts.repo = argv[++i]
    } else if (a === "--head") {
      opts.head = argv[++i]
    } else if (a === "--file") {
      opts.file = argv[++i]
    } else if (a === "--by") {
      opts.by = argv[++i]
    } else if (a === "--json") {
      // result JSON is always printed; accepted for explicitness
    } else if (a === "--quiet") {
      opts.quiet = true
    } else if (a.startsWith("-")) {
      die(`unknown option: ${a}`)
    } else if (opts.pr === undefined) {
      // allow a bare positional PR number too, matching reviewloop-await/reviewloop-ack
      opts.pr = a
    } else {
      die(`unexpected argument: ${a}`)
    }
  }
  return opts
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString("utf8")
}

// Validate + normalise the proposal array into the mutation's `items` shape.
function parseItems(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    die(`proposals are not valid JSON: ${String(e)}`)
  }
  if (!Array.isArray(data)) die("proposals must be a JSON array")
  if (data.length === 0) die("no proposals given (empty array)")
  return data.map((it, i) => {
    if (!it || typeof it !== "object") die(`item ${i}: not an object`)
    const { category, source, title, body, files } = it
    if (!CATEGORIES.has(category))
      die(`item ${i}: category must be one of bug|enhancement|chore (got ${JSON.stringify(category)})`)
    if (!SOURCES.has(source))
      die(`item ${i}: source must be one of deferred-p2|disclosed-limitation|build-tangent (got ${JSON.stringify(source)})`)
    if (typeof title !== "string" || !title.trim()) die(`item ${i}: title must be a non-empty string`)
    if (typeof body !== "string" || !body.trim()) die(`item ${i}: body must be a non-empty string`)
    if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== "string")))
      die(`item ${i}: files must be an array of strings`)
    const item = { category, source, title: title.trim(), body: body.trim() }
    if (files && files.length) item.files = files
    return item
  })
}

const opts = parseArgs(process.argv.slice(2))

if (opts.pr === undefined) die("missing --pr <n> (try --help)")
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
  die("no Convex URL. Set REVIEWLOOP_CONVEX_URL, config.convexUrl, or run `npx convex dev` first.")
}

// Resolve the source-PR context (title/url/head) from gh, unless overridden. The
// agent just created the PR, so this is a cheap, reliable lookup.
let prMeta = {}
const prJson = await ghText(["pr", "view", String(prNumber), "--repo", repo, "--json", "title,url,headRefOid"])
if (prJson) {
  try {
    prMeta = JSON.parse(prJson)
  } catch {
    /* fall back to whatever was passed */
  }
}
const sourceHeadSha = opts.head || prMeta.headRefOid
if (!sourceHeadSha) {
  die("could not determine head SHA — pass --head <sha> (gh pr view failed)")
}
const sourcePrTitle = prMeta.title ?? ""
const sourcePrUrl = prMeta.url ?? `https://github.com/${repo}/pull/${prNumber}`

const by = opts.by || defaultBy()
const log = (...a) => {
  if (!opts.quiet) process.stderr.write(a.join(" ") + "\n")
}

const raw = opts.file ? readFileSync(opts.file, "utf8") : await readStdin()
const items = parseItems(raw)

const client = new ConvexHttpClient(CONVEX_URL)

log(`suggesting ${items.length} follow-up(s) for ${repo}#${prNumber} @${sourceHeadSha.slice(0, 7)} · ${CONVEX_URL}`)

let res
try {
  res = await client.mutation(SUGGEST, {
    repo,
    sourcePrNumber: prNumber,
    sourceHeadSha,
    sourcePrTitle,
    sourcePrUrl,
    proposedBy: by,
    items,
  })
} catch (e) {
  process.stderr.write(
    `reviewloop suggest: mutation error: ${String(e)}\n` +
      `reviewloop suggest: (is suggestedIssues:suggest deployed? this mutation is added by the PR — it won't exist until merge)\n`,
  )
  process.exit(1)
}

if (res.outcome === "unwatched") {
  const out = { ok: false, outcome: "unwatched", repo, prNumber }
  process.stdout.write(JSON.stringify(out) + "\n")
  log(`not recorded: ${repo} isn't watched by reviewloop (add it from the dashboard)`)
  process.exit(2)
}

const out = {
  ok: true,
  outcome: "ok",
  repo,
  prNumber,
  enqueued: res.enqueued,
  duplicate: res.duplicate,
  total: res.total,
}
process.stdout.write(JSON.stringify(out) + "\n")
log(`recorded ${res.enqueued} new, ${res.duplicate} duplicate(s) of ${res.total} — review them in the console inbox`)
process.exit(0)
